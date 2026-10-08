import 'dart:convert';
import 'package:dio/dio.dart';
import 'package:drift/drift.dart' show Value;
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:geolocator/geolocator.dart';
import 'package:uuid/uuid.dart';
import '../../core/providers.dart';
import '../../core/network/api_client.dart';
import '../../core/db/local_db.dart';
import '../../core/time/boot_clock.dart';
import 'sync_service.dart';

/// Attendance + dashboard data. GPS is read ONLY at punch time (no background
/// tracking). Every punch is written to the local Drift queue first, then sent;
/// if the network is down it stays PENDING_SYNC and the SyncService flushes it
/// later (idempotent by attendance_uuid).
class AttendanceRepository {
  AttendanceRepository(this._ref);
  final Ref _ref;
  static const _uuid = Uuid();
  LocalDb get _db => _ref.read(localDbProvider);

  Future<Map<String, dynamic>> dashboard() async {
    final r = await _ref.read(apiClientProvider).get('/me/dashboard');
    // Opportunistically refresh the trusted-time anchor while we're online.
    refreshAnchor();
    return Map<String, dynamic>.from(r.data as Map);
  }

  /// Capture a trusted-time anchor from the server: server epoch ms + the boot
  /// clock reading at (approximately) the same instant. Persisted and reused to
  /// timestamp offline punches. No-op if the boot clock isn't available.
  Future<void> refreshAnchor() async {
    try {
      final boot = await BootClock.elapsedRealtimeMs();
      if (boot == null) return;
      final r = await _ref.read(apiClientProvider).get('/me/time');
      final serverMs = (r.data['server_ms'] as num?)?.toInt();
      if (serverMs == null) return;
      final anchor = TimeAnchor(serverMs: serverMs, bootMs: boot);
      await _ref.read(secureStoreProvider).setTimeAnchor(jsonEncode(anchor.toJson()));
    } catch (_) {}
  }

  Future<TimeAnchor?> _anchor() async {
    try {
      final s = await _ref.read(secureStoreProvider).timeAnchor;
      if (s == null) return null;
      return TimeAnchor.fromJson(Map<String, dynamic>.from(jsonDecode(s) as Map));
    } catch (_) { return null; }
  }

  Future<List<dynamic>> sites() async {
    final r = await _ref.read(apiClientProvider).get('/me/sites');
    return (r.data as List);
  }

  Future<Position> _position() async {
    if (!await Geolocator.isLocationServiceEnabled()) throw 'Activez la localisation pour pointer.';
    var perm = await Geolocator.checkPermission();
    if (perm == LocationPermission.denied) perm = await Geolocator.requestPermission();
    if (perm == LocationPermission.deniedForever || perm == LocationPermission.denied) {
      throw "L'autorisation de localisation est requise pour pointer.";
    }
    return Geolocator.getCurrentPosition(desiredAccuracy: LocationAccuracy.best);
  }

  /// Durable punch: enqueue → try to send now → fall back to offline queue.
  /// [photoPath] is an optional selfie attached as proof (online punches only).
  Future<Map<String, dynamic>> punch({required bool checkIn, String? siteId, String? photoPath}) async {
    final pos = await _position();
    final uuid = _uuid.v4();
    final type = checkIn ? 'IN' : 'OUT';
    final clientTs = DateTime.now().toIso8601String();
    // Trusted-time snapshot: monotonic boot clock at punch + the last server anchor.
    final bootMs = await BootClock.elapsedRealtimeMs();
    final anchor = await _anchor();

    await _db.enqueue(AttendanceQueueCompanion(
      uuid: Value(uuid), type: Value(type), lat: Value(pos.latitude), lng: Value(pos.longitude),
      accuracy: Value(pos.accuracy), siteId: Value(siteId), clientTs: Value(clientTs),
      syncStatus: const Value('PENDING_SYNC'),
    ));
    await _db.saveTrust(uuid, bootMs: bootMs, anchorServerMs: anchor?.serverMs, anchorBootMs: anchor?.bootMs);
    await _ref.read(syncServiceProvider).refreshCount();

    final body = {
      'attendance_uuid': uuid, 'latitude': pos.latitude, 'longitude': pos.longitude,
      'accuracy': pos.accuracy, 'client_timestamp': clientTs, 'site_id': siteId, 'app_version': '1.0.0',
      if (bootMs != null) 'boot_ms': bootMs,
      if (anchor != null) 'anchor_server_ms': anchor.serverMs,
      if (anchor != null) 'anchor_boot_ms': anchor.bootMs,
    };
    final path = checkIn ? '/me/attendance/check-in' : '/me/attendance/check-out';
    try {
      final api = _ref.read(apiClientProvider);
      final Response r;
      if (photoPath != null) {
        final fd = FormData.fromMap(body.map((k, v) => MapEntry(k, v?.toString() ?? '')));
        fd.files.add(MapEntry('photo', await MultipartFile.fromFile(photoPath, filename: 'selfie.jpg')));
        r = await api.postMultipart(path, fd);
      } else {
        r = await api.post(path, data: body);
      }
      final map = Map<String, dynamic>.from(r.data as Map);
      if (map['success'] == true) {
        await _db.markSynced(uuid, jsonEncode(map));
      } else {
        await _db.markReview(uuid, jsonEncode(map)); // rejected online (e.g. geofence-block)
      }
      await _ref.read(syncServiceProvider).refreshCount();
      refreshAnchor(); // we're online — refresh the trusted-time anchor for future offline punches
      return {...map, 'queued': false};
    } on ApiException catch (e) {
      if (e.status == null) {
        // offline / unreachable -> keep it, sync later
        return {'success': true, 'queued': true, 'status': 'PENDING_SYNC', 'type': type};
      }
      await _db.markFailed(uuid, 1, e.message);
      await _ref.read(syncServiceProvider).refreshCount();
      rethrow;
    }
  }

  Future<Map<String, dynamic>> history({int page = 1, String? month}) async {
    final q = <String, dynamic>{'page': page};
    if (month != null) q['month'] = month;
    final r = await _ref.read(apiClientProvider).get('/me/attendance', query: q);
    return Map<String, dynamic>.from(r.data as Map);
  }
}

final attendanceRepoProvider = Provider((ref) => AttendanceRepository(ref));
final dashboardProvider = FutureProvider.autoDispose((ref) => ref.read(attendanceRepoProvider).dashboard());

/// Selected month for the presence screen, as "YYYY-MM" (null = all history).
final presenceMonthProvider = StateProvider<String?>((ref) => null);

final historyProvider = FutureProvider.autoDispose((ref) {
  final month = ref.watch(presenceMonthProvider);
  return ref.read(attendanceRepoProvider).history(month: month);
});
