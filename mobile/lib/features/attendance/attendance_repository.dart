import 'dart:convert';
import 'package:drift/drift.dart' show Value;
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:geolocator/geolocator.dart';
import 'package:uuid/uuid.dart';
import '../../core/providers.dart';
import '../../core/network/api_client.dart';
import '../../core/db/local_db.dart';
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
    return Map<String, dynamic>.from(r.data as Map);
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
  Future<Map<String, dynamic>> punch({required bool checkIn, String? siteId}) async {
    final pos = await _position();
    final uuid = _uuid.v4();
    final type = checkIn ? 'IN' : 'OUT';
    final clientTs = DateTime.now().toIso8601String();

    await _db.enqueue(AttendanceQueueCompanion(
      uuid: Value(uuid), type: Value(type), lat: Value(pos.latitude), lng: Value(pos.longitude),
      accuracy: Value(pos.accuracy), siteId: Value(siteId), clientTs: Value(clientTs),
      syncStatus: const Value('PENDING_SYNC'),
    ));
    await _ref.read(syncServiceProvider).refreshCount();

    final body = {
      'attendance_uuid': uuid, 'latitude': pos.latitude, 'longitude': pos.longitude,
      'accuracy': pos.accuracy, 'client_timestamp': clientTs, 'site_id': siteId, 'app_version': '1.0.0',
    };
    try {
      final r = await _ref.read(apiClientProvider)
          .post(checkIn ? '/me/attendance/check-in' : '/me/attendance/check-out', data: body);
      final map = Map<String, dynamic>.from(r.data as Map);
      if (map['success'] == true) {
        await _db.markSynced(uuid, jsonEncode(map));
      } else {
        await _db.markReview(uuid, jsonEncode(map)); // rejected online (e.g. geofence-block)
      }
      await _ref.read(syncServiceProvider).refreshCount();
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

  Future<Map<String, dynamic>> history({int page = 1}) async {
    final r = await _ref.read(apiClientProvider).get('/me/attendance', query: {'page': page});
    return Map<String, dynamic>.from(r.data as Map);
  }
}

final attendanceRepoProvider = Provider((ref) => AttendanceRepository(ref));
final dashboardProvider = FutureProvider.autoDispose((ref) => ref.read(attendanceRepoProvider).dashboard());
final historyProvider = FutureProvider.autoDispose((ref) => ref.read(attendanceRepoProvider).history());
