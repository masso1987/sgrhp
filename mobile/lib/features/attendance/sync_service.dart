import 'dart:async';
import 'dart:convert';
import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../core/providers.dart';
import '../../core/db/local_db.dart';
import 'package:drift/drift.dart' show Value;

/// Watches connectivity and flushes the offline attendance queue to the server
/// via POST /me/sync (batch, idempotent by attendance_uuid). Exposes the live
/// count of not-yet-synced punches so the UI can show an offline badge.
class SyncService {
  SyncService(this._ref) {
    _sub = Connectivity().onConnectivityChanged.listen((r) {
      _online = !r.contains(ConnectivityResult.none);
      if (_online) flush();
    });
    // periodic safety net (backoff-aware; the DB decides what's actually due)
    _timer = Timer.periodic(const Duration(seconds: 45), (_) => flush());
    refreshCount();
  }

  final Ref _ref;
  StreamSubscription? _sub;
  Timer? _timer;
  bool _online = true;
  bool _busy = false;

  LocalDb get _db => _ref.read(localDbProvider);

  Future<void> refreshCount() async {
    try {
      _ref.read(pendingCountProvider.notifier).state = await _db.pendingCount();
    } catch (_) {}
  }

  Future<void> flush() async {
    if (_busy || !_online) return;
    _busy = true;
    try {
      final due = await _db.due();
      if (due.isEmpty) return;
      await _db.markSyncing(due.map((e) => e.uuid).toList());
      final payload = due
          .map((e) => {
                'attendance_uuid': e.uuid,
                'type': e.type,
                'latitude': e.lat,
                'longitude': e.lng,
                'accuracy': e.accuracy,
                'site_id': e.siteId,
                'client_timestamp': e.clientTs,
                'app_version': e.appVersion,
              })
          .toList();
      final resp = await _ref.read(apiClientProvider).post('/me/sync', data: {'attendance': payload});
      final results = (resp.data['results'] as List?) ?? [];
      final byUuid = {for (final r in results) r['uuid'] ?? r['attendance_uuid']: r};
      for (final e in due) {
        final r = byUuid[e.uuid];
        if (r == null) {
          await _db.markFailed(e.uuid, e.attempts + 1, 'no result');
          continue;
        }
        final j = jsonEncode(r);
        if (r['success'] == true && r['status'] == 'EXCEPTION') {
          await _db.markReview(e.uuid, j);
        } else if (r['success'] == true) {
          await _db.markSynced(e.uuid, j);
        } else {
          await _db.markReview(e.uuid, j); // rejected (e.g. geofence) -> surfaced for review
        }
      }
    } catch (e) {
      // network/server failure -> bump attempts with backoff on the syncing rows
      final syncing = await _db.due();
      for (final e2 in syncing) {
        await _db.markFailed(e2.uuid, e2.attempts + 1, '$e');
      }
    } finally {
      _busy = false;
      await refreshCount();
    }
  }

  void dispose() { _sub?.cancel(); _timer?.cancel(); }
}

final localDbProvider = Provider<LocalDb>((ref) {
  final db = LocalDb();
  ref.onDispose(db.close);
  return db;
});
final pendingCountProvider = StateProvider<int>((_) => 0);
final syncServiceProvider = Provider<SyncService>((ref) {
  final s = SyncService(ref);
  ref.onDispose(s.dispose);
  return s;
});
