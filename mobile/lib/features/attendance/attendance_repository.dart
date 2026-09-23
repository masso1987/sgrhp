import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:geolocator/geolocator.dart';
import 'package:uuid/uuid.dart';
import '../../core/providers.dart';

/// Attendance + dashboard data. Talks to /me/* on the SGRHP mobile API.
/// GPS is read ONLY at attendance time (no background tracking).
class AttendanceRepository {
  AttendanceRepository(this._ref);
  final Ref _ref;
  static const _uuid = Uuid();

  Future<Map<String, dynamic>> dashboard() async {
    final r = await _ref.read(apiClientProvider).get('/me/dashboard');
    return Map<String, dynamic>.from(r.data as Map);
  }

  Future<List<dynamic>> sites() async {
    final r = await _ref.read(apiClientProvider).get('/me/sites');
    return (r.data as List);
  }

  Future<Position> _position() async {
    if (!await Geolocator.isLocationServiceEnabled()) {
      throw 'Activez la localisation pour pointer.';
    }
    var perm = await Geolocator.checkPermission();
    if (perm == LocationPermission.denied) perm = await Geolocator.requestPermission();
    if (perm == LocationPermission.deniedForever || perm == LocationPermission.denied) {
      throw "L'autorisation de localisation est requise pour pointer.";
    }
    return Geolocator.getCurrentPosition(desiredAccuracy: LocationAccuracy.best);
  }

  Future<Map<String, dynamic>> punch({required bool checkIn, String? siteId}) async {
    final pos = await _position();
    final body = {
      'attendance_uuid': _uuid.v4(),
      'latitude': pos.latitude,
      'longitude': pos.longitude,
      'accuracy': pos.accuracy,
      'client_timestamp': DateTime.now().toIso8601String(),
      'site_id': siteId,
      'app_version': '1.0.0',
    };
    // NOTE: when offline, this call is queued to the local Drift store and
    // synced later via POST /me/sync (see offline module). Interface unchanged.
    final r = await _ref.read(apiClientProvider)
        .post(checkIn ? '/me/attendance/check-in' : '/me/attendance/check-out', data: body);
    return Map<String, dynamic>.from(r.data as Map);
  }

  Future<Map<String, dynamic>> history({int page = 1}) async {
    final r = await _ref.read(apiClientProvider).get('/me/attendance', query: {'page': page});
    return Map<String, dynamic>.from(r.data as Map);
  }
}

final attendanceRepoProvider = Provider((ref) => AttendanceRepository(ref));
final dashboardProvider = FutureProvider.autoDispose((ref) => ref.read(attendanceRepoProvider).dashboard());
final historyProvider = FutureProvider.autoDispose((ref) => ref.read(attendanceRepoProvider).history());
