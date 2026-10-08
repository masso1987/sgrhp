import 'dart:io';
import 'package:drift/drift.dart';
import 'package:drift/native.dart';
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';

part 'local_db.g.dart'; // generated: `dart run build_runner build`

/// Offline attendance queue. Every punch is written here FIRST (durability),
/// then pushed to the server. Idempotency key = [uuid]; the server dedupes,
/// so re-sending the same row can never create a duplicate attendance.
class AttendanceQueue extends Table {
  TextColumn get uuid => text()();
  TextColumn get type => text()();                 // IN | OUT
  RealColumn get lat => real().nullable()();
  RealColumn get lng => real().nullable()();
  RealColumn get accuracy => real().nullable()();
  TextColumn get siteId => text().nullable()();
  TextColumn get clientTs => text()();
  TextColumn get appVersion => text().withDefault(const Constant('1.0.0'))();
  // PENDING_SYNC | SYNCING | SYNCED | FAILED | REQUIRES_REVIEW
  TextColumn get syncStatus => text().withDefault(const Constant('PENDING_SYNC'))();
  IntColumn get attempts => integer().withDefault(const Constant(0))();
  TextColumn get lastError => text().nullable()();
  TextColumn get serverResult => text().nullable()();
  DateTimeColumn get nextAttemptAt => dateTime().nullable()();
  DateTimeColumn get createdAt => dateTime().withDefault(currentDateAndTime)();

  @override
  Set<Column> get primaryKey => {uuid};
}

@DriftDatabase(tables: [AttendanceQueue])
class LocalDb extends _$LocalDb {
  LocalDb() : super(_open());
  @override
  int get schemaVersion => 1;

  @override
  MigrationStrategy get migration => MigrationStrategy(
        onCreate: (m) async {
          await m.createAll();
          await _ensureTrustTable();
        },
        beforeOpen: (details) async {
          // Side-table for trusted-time fields (monotonic anchor), managed with raw
          // SQL so it needs no Drift codegen. Lives in the same durable DB file.
          await _ensureTrustTable();
        },
      );

  Future<void> _ensureTrustTable() => customStatement(
        'CREATE TABLE IF NOT EXISTS punch_trust ('
        'uuid TEXT PRIMARY KEY, boot_ms INTEGER, anchor_server_ms INTEGER, anchor_boot_ms INTEGER)');

  /// Persist the trusted-time snapshot captured at punch time (durable for offline).
  Future<void> saveTrust(String uuid, {int? bootMs, int? anchorServerMs, int? anchorBootMs}) =>
      customStatement(
        'INSERT OR REPLACE INTO punch_trust(uuid,boot_ms,anchor_server_ms,anchor_boot_ms) VALUES(?,?,?,?)',
        [uuid, bootMs, anchorServerMs, anchorBootMs]);

  /// Read the trusted-time snapshot for a queued punch (null fields if absent).
  Future<Map<String, int?>> readTrust(String uuid) async {
    final rows = await customSelect(
      'SELECT boot_ms, anchor_server_ms, anchor_boot_ms FROM punch_trust WHERE uuid = ?',
      variables: [Variable<String>(uuid)],
    ).get();
    if (rows.isEmpty) return {'boot_ms': null, 'anchor_server_ms': null, 'anchor_boot_ms': null};
    final r = rows.first;
    return {
      'boot_ms': r.read<int?>('boot_ms'),
      'anchor_server_ms': r.read<int?>('anchor_server_ms'),
      'anchor_boot_ms': r.read<int?>('anchor_boot_ms'),
    };
  }

  Future<void> enqueue(AttendanceQueueCompanion row) =>
      into(attendanceQueue).insertOnConflictUpdate(row);

  Future<int> pendingCount() async {
    final q = selectOnly(attendanceQueue)
      ..addColumns([attendanceQueue.uuid.count()])
      ..where(attendanceQueue.syncStatus.isIn(['PENDING_SYNC', 'FAILED', 'SYNCING']));
    final r = await q.getSingle();
    return r.read(attendanceQueue.uuid.count()) ?? 0;
  }

  /// Rows ready to send now (pending, or failed whose backoff window elapsed).
  Future<List<AttendanceQueueData>> due() {
    final now = DateTime.now();
    return (select(attendanceQueue)
          ..where((t) =>
              t.syncStatus.equals('PENDING_SYNC') |
              (t.syncStatus.equals('FAILED') &
                  (t.nextAttemptAt.isSmallerOrEqualValue(now) | t.nextAttemptAt.isNull())))
          ..orderBy([(t) => OrderingTerm.asc(t.createdAt)]))
        .get();
  }

  Future<void> markSyncing(List<String> uuids) => (update(attendanceQueue)
        ..where((t) => t.uuid.isIn(uuids)))
      .write(const AttendanceQueueCompanion(syncStatus: Value('SYNCING')));

  Future<void> markSynced(String uuid, String result) =>
      (update(attendanceQueue)..where((t) => t.uuid.equals(uuid))).write(
          AttendanceQueueCompanion(syncStatus: const Value('SYNCED'), serverResult: Value(result)));

  Future<void> markReview(String uuid, String result) =>
      (update(attendanceQueue)..where((t) => t.uuid.equals(uuid))).write(
          AttendanceQueueCompanion(syncStatus: const Value('REQUIRES_REVIEW'), serverResult: Value(result)));

  Future<void> markFailed(String uuid, int attempts, String error) {
    // exponential backoff: 5s, 20s, 80s, 320s … capped at 30 min
    final delay = Duration(seconds: (5 * (1 << (attempts.clamp(0, 8)))).clamp(5, 1800));
    return (update(attendanceQueue)..where((t) => t.uuid.equals(uuid))).write(AttendanceQueueCompanion(
      syncStatus: const Value('FAILED'),
      attempts: Value(attempts),
      lastError: Value(error),
      nextAttemptAt: Value(DateTime.now().add(delay)),
    ));
  }

  Future<void> purgeSyncedBefore(Duration age) =>
      (delete(attendanceQueue)
            ..where((t) => t.syncStatus.equals('SYNCED') & t.createdAt.isSmallerThanValue(DateTime.now().subtract(age))))
          .go();
}

LazyDatabase _open() => LazyDatabase(() async {
      final dir = await getApplicationDocumentsDirectory();
      return NativeDatabase.createInBackground(File(p.join(dir.path, 'hr_portal.sqlite')));
    });
