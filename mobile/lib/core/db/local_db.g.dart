// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'local_db.dart';

// ignore_for_file: type=lint
class $AttendanceQueueTable extends AttendanceQueue
    with TableInfo<$AttendanceQueueTable, AttendanceQueueData> {
  @override
  final GeneratedDatabase attachedDatabase;
  final String? _alias;
  $AttendanceQueueTable(this.attachedDatabase, [this._alias]);
  static const VerificationMeta _uuidMeta = const VerificationMeta('uuid');
  @override
  late final GeneratedColumn<String> uuid = GeneratedColumn<String>(
      'uuid', aliasedName, false,
      type: DriftSqlType.string, requiredDuringInsert: true);
  static const VerificationMeta _typeMeta = const VerificationMeta('type');
  @override
  late final GeneratedColumn<String> type = GeneratedColumn<String>(
      'type', aliasedName, false,
      type: DriftSqlType.string, requiredDuringInsert: true);
  static const VerificationMeta _latMeta = const VerificationMeta('lat');
  @override
  late final GeneratedColumn<double> lat = GeneratedColumn<double>(
      'lat', aliasedName, true,
      type: DriftSqlType.double, requiredDuringInsert: false);
  static const VerificationMeta _lngMeta = const VerificationMeta('lng');
  @override
  late final GeneratedColumn<double> lng = GeneratedColumn<double>(
      'lng', aliasedName, true,
      type: DriftSqlType.double, requiredDuringInsert: false);
  static const VerificationMeta _accuracyMeta =
      const VerificationMeta('accuracy');
  @override
  late final GeneratedColumn<double> accuracy = GeneratedColumn<double>(
      'accuracy', aliasedName, true,
      type: DriftSqlType.double, requiredDuringInsert: false);
  static const VerificationMeta _siteIdMeta = const VerificationMeta('siteId');
  @override
  late final GeneratedColumn<String> siteId = GeneratedColumn<String>(
      'site_id', aliasedName, true,
      type: DriftSqlType.string, requiredDuringInsert: false);
  static const VerificationMeta _clientTsMeta =
      const VerificationMeta('clientTs');
  @override
  late final GeneratedColumn<String> clientTs = GeneratedColumn<String>(
      'client_ts', aliasedName, false,
      type: DriftSqlType.string, requiredDuringInsert: true);
  static const VerificationMeta _appVersionMeta =
      const VerificationMeta('appVersion');
  @override
  late final GeneratedColumn<String> appVersion = GeneratedColumn<String>(
      'app_version', aliasedName, false,
      type: DriftSqlType.string,
      requiredDuringInsert: false,
      defaultValue: const Constant('1.0.0'));
  static const VerificationMeta _syncStatusMeta =
      const VerificationMeta('syncStatus');
  @override
  late final GeneratedColumn<String> syncStatus = GeneratedColumn<String>(
      'sync_status', aliasedName, false,
      type: DriftSqlType.string,
      requiredDuringInsert: false,
      defaultValue: const Constant('PENDING_SYNC'));
  static const VerificationMeta _attemptsMeta =
      const VerificationMeta('attempts');
  @override
  late final GeneratedColumn<int> attempts = GeneratedColumn<int>(
      'attempts', aliasedName, false,
      type: DriftSqlType.int,
      requiredDuringInsert: false,
      defaultValue: const Constant(0));
  static const VerificationMeta _lastErrorMeta =
      const VerificationMeta('lastError');
  @override
  late final GeneratedColumn<String> lastError = GeneratedColumn<String>(
      'last_error', aliasedName, true,
      type: DriftSqlType.string, requiredDuringInsert: false);
  static const VerificationMeta _serverResultMeta =
      const VerificationMeta('serverResult');
  @override
  late final GeneratedColumn<String> serverResult = GeneratedColumn<String>(
      'server_result', aliasedName, true,
      type: DriftSqlType.string, requiredDuringInsert: false);
  static const VerificationMeta _nextAttemptAtMeta =
      const VerificationMeta('nextAttemptAt');
  @override
  late final GeneratedColumn<DateTime> nextAttemptAt =
      GeneratedColumn<DateTime>('next_attempt_at', aliasedName, true,
          type: DriftSqlType.dateTime, requiredDuringInsert: false);
  static const VerificationMeta _createdAtMeta =
      const VerificationMeta('createdAt');
  @override
  late final GeneratedColumn<DateTime> createdAt = GeneratedColumn<DateTime>(
      'created_at', aliasedName, false,
      type: DriftSqlType.dateTime,
      requiredDuringInsert: false,
      defaultValue: currentDateAndTime);
  @override
  List<GeneratedColumn> get $columns => [
        uuid,
        type,
        lat,
        lng,
        accuracy,
        siteId,
        clientTs,
        appVersion,
        syncStatus,
        attempts,
        lastError,
        serverResult,
        nextAttemptAt,
        createdAt
      ];
  @override
  String get aliasedName => _alias ?? actualTableName;
  @override
  String get actualTableName => $name;
  static const String $name = 'attendance_queue';
  @override
  VerificationContext validateIntegrity(
      Insertable<AttendanceQueueData> instance,
      {bool isInserting = false}) {
    final context = VerificationContext();
    final data = instance.toColumns(true);
    if (data.containsKey('uuid')) {
      context.handle(
          _uuidMeta, uuid.isAcceptableOrUnknown(data['uuid']!, _uuidMeta));
    } else if (isInserting) {
      context.missing(_uuidMeta);
    }
    if (data.containsKey('type')) {
      context.handle(
          _typeMeta, type.isAcceptableOrUnknown(data['type']!, _typeMeta));
    } else if (isInserting) {
      context.missing(_typeMeta);
    }
    if (data.containsKey('lat')) {
      context.handle(
          _latMeta, lat.isAcceptableOrUnknown(data['lat']!, _latMeta));
    }
    if (data.containsKey('lng')) {
      context.handle(
          _lngMeta, lng.isAcceptableOrUnknown(data['lng']!, _lngMeta));
    }
    if (data.containsKey('accuracy')) {
      context.handle(_accuracyMeta,
          accuracy.isAcceptableOrUnknown(data['accuracy']!, _accuracyMeta));
    }
    if (data.containsKey('site_id')) {
      context.handle(_siteIdMeta,
          siteId.isAcceptableOrUnknown(data['site_id']!, _siteIdMeta));
    }
    if (data.containsKey('client_ts')) {
      context.handle(_clientTsMeta,
          clientTs.isAcceptableOrUnknown(data['client_ts']!, _clientTsMeta));
    } else if (isInserting) {
      context.missing(_clientTsMeta);
    }
    if (data.containsKey('app_version')) {
      context.handle(
          _appVersionMeta,
          appVersion.isAcceptableOrUnknown(
              data['app_version']!, _appVersionMeta));
    }
    if (data.containsKey('sync_status')) {
      context.handle(
          _syncStatusMeta,
          syncStatus.isAcceptableOrUnknown(
              data['sync_status']!, _syncStatusMeta));
    }
    if (data.containsKey('attempts')) {
      context.handle(_attemptsMeta,
          attempts.isAcceptableOrUnknown(data['attempts']!, _attemptsMeta));
    }
    if (data.containsKey('last_error')) {
      context.handle(_lastErrorMeta,
          lastError.isAcceptableOrUnknown(data['last_error']!, _lastErrorMeta));
    }
    if (data.containsKey('server_result')) {
      context.handle(
          _serverResultMeta,
          serverResult.isAcceptableOrUnknown(
              data['server_result']!, _serverResultMeta));
    }
    if (data.containsKey('next_attempt_at')) {
      context.handle(
          _nextAttemptAtMeta,
          nextAttemptAt.isAcceptableOrUnknown(
              data['next_attempt_at']!, _nextAttemptAtMeta));
    }
    if (data.containsKey('created_at')) {
      context.handle(_createdAtMeta,
          createdAt.isAcceptableOrUnknown(data['created_at']!, _createdAtMeta));
    }
    return context;
  }

  @override
  Set<GeneratedColumn> get $primaryKey => {uuid};
  @override
  AttendanceQueueData map(Map<String, dynamic> data, {String? tablePrefix}) {
    final effectivePrefix = tablePrefix != null ? '$tablePrefix.' : '';
    return AttendanceQueueData(
      uuid: attachedDatabase.typeMapping
          .read(DriftSqlType.string, data['${effectivePrefix}uuid'])!,
      type: attachedDatabase.typeMapping
          .read(DriftSqlType.string, data['${effectivePrefix}type'])!,
      lat: attachedDatabase.typeMapping
          .read(DriftSqlType.double, data['${effectivePrefix}lat']),
      lng: attachedDatabase.typeMapping
          .read(DriftSqlType.double, data['${effectivePrefix}lng']),
      accuracy: attachedDatabase.typeMapping
          .read(DriftSqlType.double, data['${effectivePrefix}accuracy']),
      siteId: attachedDatabase.typeMapping
          .read(DriftSqlType.string, data['${effectivePrefix}site_id']),
      clientTs: attachedDatabase.typeMapping
          .read(DriftSqlType.string, data['${effectivePrefix}client_ts'])!,
      appVersion: attachedDatabase.typeMapping
          .read(DriftSqlType.string, data['${effectivePrefix}app_version'])!,
      syncStatus: attachedDatabase.typeMapping
          .read(DriftSqlType.string, data['${effectivePrefix}sync_status'])!,
      attempts: attachedDatabase.typeMapping
          .read(DriftSqlType.int, data['${effectivePrefix}attempts'])!,
      lastError: attachedDatabase.typeMapping
          .read(DriftSqlType.string, data['${effectivePrefix}last_error']),
      serverResult: attachedDatabase.typeMapping
          .read(DriftSqlType.string, data['${effectivePrefix}server_result']),
      nextAttemptAt: attachedDatabase.typeMapping.read(
          DriftSqlType.dateTime, data['${effectivePrefix}next_attempt_at']),
      createdAt: attachedDatabase.typeMapping
          .read(DriftSqlType.dateTime, data['${effectivePrefix}created_at'])!,
    );
  }

  @override
  $AttendanceQueueTable createAlias(String alias) {
    return $AttendanceQueueTable(attachedDatabase, alias);
  }
}

class AttendanceQueueData extends DataClass
    implements Insertable<AttendanceQueueData> {
  final String uuid;
  final String type;
  final double? lat;
  final double? lng;
  final double? accuracy;
  final String? siteId;
  final String clientTs;
  final String appVersion;
  final String syncStatus;
  final int attempts;
  final String? lastError;
  final String? serverResult;
  final DateTime? nextAttemptAt;
  final DateTime createdAt;
  const AttendanceQueueData(
      {required this.uuid,
      required this.type,
      this.lat,
      this.lng,
      this.accuracy,
      this.siteId,
      required this.clientTs,
      required this.appVersion,
      required this.syncStatus,
      required this.attempts,
      this.lastError,
      this.serverResult,
      this.nextAttemptAt,
      required this.createdAt});
  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    map['uuid'] = Variable<String>(uuid);
    map['type'] = Variable<String>(type);
    if (!nullToAbsent || lat != null) {
      map['lat'] = Variable<double>(lat);
    }
    if (!nullToAbsent || lng != null) {
      map['lng'] = Variable<double>(lng);
    }
    if (!nullToAbsent || accuracy != null) {
      map['accuracy'] = Variable<double>(accuracy);
    }
    if (!nullToAbsent || siteId != null) {
      map['site_id'] = Variable<String>(siteId);
    }
    map['client_ts'] = Variable<String>(clientTs);
    map['app_version'] = Variable<String>(appVersion);
    map['sync_status'] = Variable<String>(syncStatus);
    map['attempts'] = Variable<int>(attempts);
    if (!nullToAbsent || lastError != null) {
      map['last_error'] = Variable<String>(lastError);
    }
    if (!nullToAbsent || serverResult != null) {
      map['server_result'] = Variable<String>(serverResult);
    }
    if (!nullToAbsent || nextAttemptAt != null) {
      map['next_attempt_at'] = Variable<DateTime>(nextAttemptAt);
    }
    map['created_at'] = Variable<DateTime>(createdAt);
    return map;
  }

  AttendanceQueueCompanion toCompanion(bool nullToAbsent) {
    return AttendanceQueueCompanion(
      uuid: Value(uuid),
      type: Value(type),
      lat: lat == null && nullToAbsent ? const Value.absent() : Value(lat),
      lng: lng == null && nullToAbsent ? const Value.absent() : Value(lng),
      accuracy: accuracy == null && nullToAbsent
          ? const Value.absent()
          : Value(accuracy),
      siteId:
          siteId == null && nullToAbsent ? const Value.absent() : Value(siteId),
      clientTs: Value(clientTs),
      appVersion: Value(appVersion),
      syncStatus: Value(syncStatus),
      attempts: Value(attempts),
      lastError: lastError == null && nullToAbsent
          ? const Value.absent()
          : Value(lastError),
      serverResult: serverResult == null && nullToAbsent
          ? const Value.absent()
          : Value(serverResult),
      nextAttemptAt: nextAttemptAt == null && nullToAbsent
          ? const Value.absent()
          : Value(nextAttemptAt),
      createdAt: Value(createdAt),
    );
  }

  factory AttendanceQueueData.fromJson(Map<String, dynamic> json,
      {ValueSerializer? serializer}) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return AttendanceQueueData(
      uuid: serializer.fromJson<String>(json['uuid']),
      type: serializer.fromJson<String>(json['type']),
      lat: serializer.fromJson<double?>(json['lat']),
      lng: serializer.fromJson<double?>(json['lng']),
      accuracy: serializer.fromJson<double?>(json['accuracy']),
      siteId: serializer.fromJson<String?>(json['siteId']),
      clientTs: serializer.fromJson<String>(json['clientTs']),
      appVersion: serializer.fromJson<String>(json['appVersion']),
      syncStatus: serializer.fromJson<String>(json['syncStatus']),
      attempts: serializer.fromJson<int>(json['attempts']),
      lastError: serializer.fromJson<String?>(json['lastError']),
      serverResult: serializer.fromJson<String?>(json['serverResult']),
      nextAttemptAt: serializer.fromJson<DateTime?>(json['nextAttemptAt']),
      createdAt: serializer.fromJson<DateTime>(json['createdAt']),
    );
  }
  @override
  Map<String, dynamic> toJson({ValueSerializer? serializer}) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return <String, dynamic>{
      'uuid': serializer.toJson<String>(uuid),
      'type': serializer.toJson<String>(type),
      'lat': serializer.toJson<double?>(lat),
      'lng': serializer.toJson<double?>(lng),
      'accuracy': serializer.toJson<double?>(accuracy),
      'siteId': serializer.toJson<String?>(siteId),
      'clientTs': serializer.toJson<String>(clientTs),
      'appVersion': serializer.toJson<String>(appVersion),
      'syncStatus': serializer.toJson<String>(syncStatus),
      'attempts': serializer.toJson<int>(attempts),
      'lastError': serializer.toJson<String?>(lastError),
      'serverResult': serializer.toJson<String?>(serverResult),
      'nextAttemptAt': serializer.toJson<DateTime?>(nextAttemptAt),
      'createdAt': serializer.toJson<DateTime>(createdAt),
    };
  }

  AttendanceQueueData copyWith(
          {String? uuid,
          String? type,
          Value<double?> lat = const Value.absent(),
          Value<double?> lng = const Value.absent(),
          Value<double?> accuracy = const Value.absent(),
          Value<String?> siteId = const Value.absent(),
          String? clientTs,
          String? appVersion,
          String? syncStatus,
          int? attempts,
          Value<String?> lastError = const Value.absent(),
          Value<String?> serverResult = const Value.absent(),
          Value<DateTime?> nextAttemptAt = const Value.absent(),
          DateTime? createdAt}) =>
      AttendanceQueueData(
        uuid: uuid ?? this.uuid,
        type: type ?? this.type,
        lat: lat.present ? lat.value : this.lat,
        lng: lng.present ? lng.value : this.lng,
        accuracy: accuracy.present ? accuracy.value : this.accuracy,
        siteId: siteId.present ? siteId.value : this.siteId,
        clientTs: clientTs ?? this.clientTs,
        appVersion: appVersion ?? this.appVersion,
        syncStatus: syncStatus ?? this.syncStatus,
        attempts: attempts ?? this.attempts,
        lastError: lastError.present ? lastError.value : this.lastError,
        serverResult:
            serverResult.present ? serverResult.value : this.serverResult,
        nextAttemptAt:
            nextAttemptAt.present ? nextAttemptAt.value : this.nextAttemptAt,
        createdAt: createdAt ?? this.createdAt,
      );
  AttendanceQueueData copyWithCompanion(AttendanceQueueCompanion data) {
    return AttendanceQueueData(
      uuid: data.uuid.present ? data.uuid.value : this.uuid,
      type: data.type.present ? data.type.value : this.type,
      lat: data.lat.present ? data.lat.value : this.lat,
      lng: data.lng.present ? data.lng.value : this.lng,
      accuracy: data.accuracy.present ? data.accuracy.value : this.accuracy,
      siteId: data.siteId.present ? data.siteId.value : this.siteId,
      clientTs: data.clientTs.present ? data.clientTs.value : this.clientTs,
      appVersion:
          data.appVersion.present ? data.appVersion.value : this.appVersion,
      syncStatus:
          data.syncStatus.present ? data.syncStatus.value : this.syncStatus,
      attempts: data.attempts.present ? data.attempts.value : this.attempts,
      lastError: data.lastError.present ? data.lastError.value : this.lastError,
      serverResult: data.serverResult.present
          ? data.serverResult.value
          : this.serverResult,
      nextAttemptAt: data.nextAttemptAt.present
          ? data.nextAttemptAt.value
          : this.nextAttemptAt,
      createdAt: data.createdAt.present ? data.createdAt.value : this.createdAt,
    );
  }

  @override
  String toString() {
    return (StringBuffer('AttendanceQueueData(')
          ..write('uuid: $uuid, ')
          ..write('type: $type, ')
          ..write('lat: $lat, ')
          ..write('lng: $lng, ')
          ..write('accuracy: $accuracy, ')
          ..write('siteId: $siteId, ')
          ..write('clientTs: $clientTs, ')
          ..write('appVersion: $appVersion, ')
          ..write('syncStatus: $syncStatus, ')
          ..write('attempts: $attempts, ')
          ..write('lastError: $lastError, ')
          ..write('serverResult: $serverResult, ')
          ..write('nextAttemptAt: $nextAttemptAt, ')
          ..write('createdAt: $createdAt')
          ..write(')'))
        .toString();
  }

  @override
  int get hashCode => Object.hash(
      uuid,
      type,
      lat,
      lng,
      accuracy,
      siteId,
      clientTs,
      appVersion,
      syncStatus,
      attempts,
      lastError,
      serverResult,
      nextAttemptAt,
      createdAt);
  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      (other is AttendanceQueueData &&
          other.uuid == this.uuid &&
          other.type == this.type &&
          other.lat == this.lat &&
          other.lng == this.lng &&
          other.accuracy == this.accuracy &&
          other.siteId == this.siteId &&
          other.clientTs == this.clientTs &&
          other.appVersion == this.appVersion &&
          other.syncStatus == this.syncStatus &&
          other.attempts == this.attempts &&
          other.lastError == this.lastError &&
          other.serverResult == this.serverResult &&
          other.nextAttemptAt == this.nextAttemptAt &&
          other.createdAt == this.createdAt);
}

class AttendanceQueueCompanion extends UpdateCompanion<AttendanceQueueData> {
  final Value<String> uuid;
  final Value<String> type;
  final Value<double?> lat;
  final Value<double?> lng;
  final Value<double?> accuracy;
  final Value<String?> siteId;
  final Value<String> clientTs;
  final Value<String> appVersion;
  final Value<String> syncStatus;
  final Value<int> attempts;
  final Value<String?> lastError;
  final Value<String?> serverResult;
  final Value<DateTime?> nextAttemptAt;
  final Value<DateTime> createdAt;
  final Value<int> rowid;
  const AttendanceQueueCompanion({
    this.uuid = const Value.absent(),
    this.type = const Value.absent(),
    this.lat = const Value.absent(),
    this.lng = const Value.absent(),
    this.accuracy = const Value.absent(),
    this.siteId = const Value.absent(),
    this.clientTs = const Value.absent(),
    this.appVersion = const Value.absent(),
    this.syncStatus = const Value.absent(),
    this.attempts = const Value.absent(),
    this.lastError = const Value.absent(),
    this.serverResult = const Value.absent(),
    this.nextAttemptAt = const Value.absent(),
    this.createdAt = const Value.absent(),
    this.rowid = const Value.absent(),
  });
  AttendanceQueueCompanion.insert({
    required String uuid,
    required String type,
    this.lat = const Value.absent(),
    this.lng = const Value.absent(),
    this.accuracy = const Value.absent(),
    this.siteId = const Value.absent(),
    required String clientTs,
    this.appVersion = const Value.absent(),
    this.syncStatus = const Value.absent(),
    this.attempts = const Value.absent(),
    this.lastError = const Value.absent(),
    this.serverResult = const Value.absent(),
    this.nextAttemptAt = const Value.absent(),
    this.createdAt = const Value.absent(),
    this.rowid = const Value.absent(),
  })  : uuid = Value(uuid),
        type = Value(type),
        clientTs = Value(clientTs);
  static Insertable<AttendanceQueueData> custom({
    Expression<String>? uuid,
    Expression<String>? type,
    Expression<double>? lat,
    Expression<double>? lng,
    Expression<double>? accuracy,
    Expression<String>? siteId,
    Expression<String>? clientTs,
    Expression<String>? appVersion,
    Expression<String>? syncStatus,
    Expression<int>? attempts,
    Expression<String>? lastError,
    Expression<String>? serverResult,
    Expression<DateTime>? nextAttemptAt,
    Expression<DateTime>? createdAt,
    Expression<int>? rowid,
  }) {
    return RawValuesInsertable({
      if (uuid != null) 'uuid': uuid,
      if (type != null) 'type': type,
      if (lat != null) 'lat': lat,
      if (lng != null) 'lng': lng,
      if (accuracy != null) 'accuracy': accuracy,
      if (siteId != null) 'site_id': siteId,
      if (clientTs != null) 'client_ts': clientTs,
      if (appVersion != null) 'app_version': appVersion,
      if (syncStatus != null) 'sync_status': syncStatus,
      if (attempts != null) 'attempts': attempts,
      if (lastError != null) 'last_error': lastError,
      if (serverResult != null) 'server_result': serverResult,
      if (nextAttemptAt != null) 'next_attempt_at': nextAttemptAt,
      if (createdAt != null) 'created_at': createdAt,
      if (rowid != null) 'rowid': rowid,
    });
  }

  AttendanceQueueCompanion copyWith(
      {Value<String>? uuid,
      Value<String>? type,
      Value<double?>? lat,
      Value<double?>? lng,
      Value<double?>? accuracy,
      Value<String?>? siteId,
      Value<String>? clientTs,
      Value<String>? appVersion,
      Value<String>? syncStatus,
      Value<int>? attempts,
      Value<String?>? lastError,
      Value<String?>? serverResult,
      Value<DateTime?>? nextAttemptAt,
      Value<DateTime>? createdAt,
      Value<int>? rowid}) {
    return AttendanceQueueCompanion(
      uuid: uuid ?? this.uuid,
      type: type ?? this.type,
      lat: lat ?? this.lat,
      lng: lng ?? this.lng,
      accuracy: accuracy ?? this.accuracy,
      siteId: siteId ?? this.siteId,
      clientTs: clientTs ?? this.clientTs,
      appVersion: appVersion ?? this.appVersion,
      syncStatus: syncStatus ?? this.syncStatus,
      attempts: attempts ?? this.attempts,
      lastError: lastError ?? this.lastError,
      serverResult: serverResult ?? this.serverResult,
      nextAttemptAt: nextAttemptAt ?? this.nextAttemptAt,
      createdAt: createdAt ?? this.createdAt,
      rowid: rowid ?? this.rowid,
    );
  }

  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    if (uuid.present) {
      map['uuid'] = Variable<String>(uuid.value);
    }
    if (type.present) {
      map['type'] = Variable<String>(type.value);
    }
    if (lat.present) {
      map['lat'] = Variable<double>(lat.value);
    }
    if (lng.present) {
      map['lng'] = Variable<double>(lng.value);
    }
    if (accuracy.present) {
      map['accuracy'] = Variable<double>(accuracy.value);
    }
    if (siteId.present) {
      map['site_id'] = Variable<String>(siteId.value);
    }
    if (clientTs.present) {
      map['client_ts'] = Variable<String>(clientTs.value);
    }
    if (appVersion.present) {
      map['app_version'] = Variable<String>(appVersion.value);
    }
    if (syncStatus.present) {
      map['sync_status'] = Variable<String>(syncStatus.value);
    }
    if (attempts.present) {
      map['attempts'] = Variable<int>(attempts.value);
    }
    if (lastError.present) {
      map['last_error'] = Variable<String>(lastError.value);
    }
    if (serverResult.present) {
      map['server_result'] = Variable<String>(serverResult.value);
    }
    if (nextAttemptAt.present) {
      map['next_attempt_at'] = Variable<DateTime>(nextAttemptAt.value);
    }
    if (createdAt.present) {
      map['created_at'] = Variable<DateTime>(createdAt.value);
    }
    if (rowid.present) {
      map['rowid'] = Variable<int>(rowid.value);
    }
    return map;
  }

  @override
  String toString() {
    return (StringBuffer('AttendanceQueueCompanion(')
          ..write('uuid: $uuid, ')
          ..write('type: $type, ')
          ..write('lat: $lat, ')
          ..write('lng: $lng, ')
          ..write('accuracy: $accuracy, ')
          ..write('siteId: $siteId, ')
          ..write('clientTs: $clientTs, ')
          ..write('appVersion: $appVersion, ')
          ..write('syncStatus: $syncStatus, ')
          ..write('attempts: $attempts, ')
          ..write('lastError: $lastError, ')
          ..write('serverResult: $serverResult, ')
          ..write('nextAttemptAt: $nextAttemptAt, ')
          ..write('createdAt: $createdAt, ')
          ..write('rowid: $rowid')
          ..write(')'))
        .toString();
  }
}

abstract class _$LocalDb extends GeneratedDatabase {
  _$LocalDb(QueryExecutor e) : super(e);
  $LocalDbManager get managers => $LocalDbManager(this);
  late final $AttendanceQueueTable attendanceQueue =
      $AttendanceQueueTable(this);
  @override
  Iterable<TableInfo<Table, Object?>> get allTables =>
      allSchemaEntities.whereType<TableInfo<Table, Object?>>();
  @override
  List<DatabaseSchemaEntity> get allSchemaEntities => [attendanceQueue];
}

typedef $$AttendanceQueueTableCreateCompanionBuilder = AttendanceQueueCompanion
    Function({
  required String uuid,
  required String type,
  Value<double?> lat,
  Value<double?> lng,
  Value<double?> accuracy,
  Value<String?> siteId,
  required String clientTs,
  Value<String> appVersion,
  Value<String> syncStatus,
  Value<int> attempts,
  Value<String?> lastError,
  Value<String?> serverResult,
  Value<DateTime?> nextAttemptAt,
  Value<DateTime> createdAt,
  Value<int> rowid,
});
typedef $$AttendanceQueueTableUpdateCompanionBuilder = AttendanceQueueCompanion
    Function({
  Value<String> uuid,
  Value<String> type,
  Value<double?> lat,
  Value<double?> lng,
  Value<double?> accuracy,
  Value<String?> siteId,
  Value<String> clientTs,
  Value<String> appVersion,
  Value<String> syncStatus,
  Value<int> attempts,
  Value<String?> lastError,
  Value<String?> serverResult,
  Value<DateTime?> nextAttemptAt,
  Value<DateTime> createdAt,
  Value<int> rowid,
});

class $$AttendanceQueueTableFilterComposer
    extends Composer<_$LocalDb, $AttendanceQueueTable> {
  $$AttendanceQueueTableFilterComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnFilters<String> get uuid => $composableBuilder(
      column: $table.uuid, builder: (column) => ColumnFilters(column));

  ColumnFilters<String> get type => $composableBuilder(
      column: $table.type, builder: (column) => ColumnFilters(column));

  ColumnFilters<double> get lat => $composableBuilder(
      column: $table.lat, builder: (column) => ColumnFilters(column));

  ColumnFilters<double> get lng => $composableBuilder(
      column: $table.lng, builder: (column) => ColumnFilters(column));

  ColumnFilters<double> get accuracy => $composableBuilder(
      column: $table.accuracy, builder: (column) => ColumnFilters(column));

  ColumnFilters<String> get siteId => $composableBuilder(
      column: $table.siteId, builder: (column) => ColumnFilters(column));

  ColumnFilters<String> get clientTs => $composableBuilder(
      column: $table.clientTs, builder: (column) => ColumnFilters(column));

  ColumnFilters<String> get appVersion => $composableBuilder(
      column: $table.appVersion, builder: (column) => ColumnFilters(column));

  ColumnFilters<String> get syncStatus => $composableBuilder(
      column: $table.syncStatus, builder: (column) => ColumnFilters(column));

  ColumnFilters<int> get attempts => $composableBuilder(
      column: $table.attempts, builder: (column) => ColumnFilters(column));

  ColumnFilters<String> get lastError => $composableBuilder(
      column: $table.lastError, builder: (column) => ColumnFilters(column));

  ColumnFilters<String> get serverResult => $composableBuilder(
      column: $table.serverResult, builder: (column) => ColumnFilters(column));

  ColumnFilters<DateTime> get nextAttemptAt => $composableBuilder(
      column: $table.nextAttemptAt, builder: (column) => ColumnFilters(column));

  ColumnFilters<DateTime> get createdAt => $composableBuilder(
      column: $table.createdAt, builder: (column) => ColumnFilters(column));
}

class $$AttendanceQueueTableOrderingComposer
    extends Composer<_$LocalDb, $AttendanceQueueTable> {
  $$AttendanceQueueTableOrderingComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnOrderings<String> get uuid => $composableBuilder(
      column: $table.uuid, builder: (column) => ColumnOrderings(column));

  ColumnOrderings<String> get type => $composableBuilder(
      column: $table.type, builder: (column) => ColumnOrderings(column));

  ColumnOrderings<double> get lat => $composableBuilder(
      column: $table.lat, builder: (column) => ColumnOrderings(column));

  ColumnOrderings<double> get lng => $composableBuilder(
      column: $table.lng, builder: (column) => ColumnOrderings(column));

  ColumnOrderings<double> get accuracy => $composableBuilder(
      column: $table.accuracy, builder: (column) => ColumnOrderings(column));

  ColumnOrderings<String> get siteId => $composableBuilder(
      column: $table.siteId, builder: (column) => ColumnOrderings(column));

  ColumnOrderings<String> get clientTs => $composableBuilder(
      column: $table.clientTs, builder: (column) => ColumnOrderings(column));

  ColumnOrderings<String> get appVersion => $composableBuilder(
      column: $table.appVersion, builder: (column) => ColumnOrderings(column));

  ColumnOrderings<String> get syncStatus => $composableBuilder(
      column: $table.syncStatus, builder: (column) => ColumnOrderings(column));

  ColumnOrderings<int> get attempts => $composableBuilder(
      column: $table.attempts, builder: (column) => ColumnOrderings(column));

  ColumnOrderings<String> get lastError => $composableBuilder(
      column: $table.lastError, builder: (column) => ColumnOrderings(column));

  ColumnOrderings<String> get serverResult => $composableBuilder(
      column: $table.serverResult,
      builder: (column) => ColumnOrderings(column));

  ColumnOrderings<DateTime> get nextAttemptAt => $composableBuilder(
      column: $table.nextAttemptAt,
      builder: (column) => ColumnOrderings(column));

  ColumnOrderings<DateTime> get createdAt => $composableBuilder(
      column: $table.createdAt, builder: (column) => ColumnOrderings(column));
}

class $$AttendanceQueueTableAnnotationComposer
    extends Composer<_$LocalDb, $AttendanceQueueTable> {
  $$AttendanceQueueTableAnnotationComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  GeneratedColumn<String> get uuid =>
      $composableBuilder(column: $table.uuid, builder: (column) => column);

  GeneratedColumn<String> get type =>
      $composableBuilder(column: $table.type, builder: (column) => column);

  GeneratedColumn<double> get lat =>
      $composableBuilder(column: $table.lat, builder: (column) => column);

  GeneratedColumn<double> get lng =>
      $composableBuilder(column: $table.lng, builder: (column) => column);

  GeneratedColumn<double> get accuracy =>
      $composableBuilder(column: $table.accuracy, builder: (column) => column);

  GeneratedColumn<String> get siteId =>
      $composableBuilder(column: $table.siteId, builder: (column) => column);

  GeneratedColumn<String> get clientTs =>
      $composableBuilder(column: $table.clientTs, builder: (column) => column);

  GeneratedColumn<String> get appVersion => $composableBuilder(
      column: $table.appVersion, builder: (column) => column);

  GeneratedColumn<String> get syncStatus => $composableBuilder(
      column: $table.syncStatus, builder: (column) => column);

  GeneratedColumn<int> get attempts =>
      $composableBuilder(column: $table.attempts, builder: (column) => column);

  GeneratedColumn<String> get lastError =>
      $composableBuilder(column: $table.lastError, builder: (column) => column);

  GeneratedColumn<String> get serverResult => $composableBuilder(
      column: $table.serverResult, builder: (column) => column);

  GeneratedColumn<DateTime> get nextAttemptAt => $composableBuilder(
      column: $table.nextAttemptAt, builder: (column) => column);

  GeneratedColumn<DateTime> get createdAt =>
      $composableBuilder(column: $table.createdAt, builder: (column) => column);
}

class $$AttendanceQueueTableTableManager extends RootTableManager<
    _$LocalDb,
    $AttendanceQueueTable,
    AttendanceQueueData,
    $$AttendanceQueueTableFilterComposer,
    $$AttendanceQueueTableOrderingComposer,
    $$AttendanceQueueTableAnnotationComposer,
    $$AttendanceQueueTableCreateCompanionBuilder,
    $$AttendanceQueueTableUpdateCompanionBuilder,
    (
      AttendanceQueueData,
      BaseReferences<_$LocalDb, $AttendanceQueueTable, AttendanceQueueData>
    ),
    AttendanceQueueData,
    PrefetchHooks Function()> {
  $$AttendanceQueueTableTableManager(_$LocalDb db, $AttendanceQueueTable table)
      : super(TableManagerState(
          db: db,
          table: table,
          createFilteringComposer: () =>
              $$AttendanceQueueTableFilterComposer($db: db, $table: table),
          createOrderingComposer: () =>
              $$AttendanceQueueTableOrderingComposer($db: db, $table: table),
          createComputedFieldComposer: () =>
              $$AttendanceQueueTableAnnotationComposer($db: db, $table: table),
          updateCompanionCallback: ({
            Value<String> uuid = const Value.absent(),
            Value<String> type = const Value.absent(),
            Value<double?> lat = const Value.absent(),
            Value<double?> lng = const Value.absent(),
            Value<double?> accuracy = const Value.absent(),
            Value<String?> siteId = const Value.absent(),
            Value<String> clientTs = const Value.absent(),
            Value<String> appVersion = const Value.absent(),
            Value<String> syncStatus = const Value.absent(),
            Value<int> attempts = const Value.absent(),
            Value<String?> lastError = const Value.absent(),
            Value<String?> serverResult = const Value.absent(),
            Value<DateTime?> nextAttemptAt = const Value.absent(),
            Value<DateTime> createdAt = const Value.absent(),
            Value<int> rowid = const Value.absent(),
          }) =>
              AttendanceQueueCompanion(
            uuid: uuid,
            type: type,
            lat: lat,
            lng: lng,
            accuracy: accuracy,
            siteId: siteId,
            clientTs: clientTs,
            appVersion: appVersion,
            syncStatus: syncStatus,
            attempts: attempts,
            lastError: lastError,
            serverResult: serverResult,
            nextAttemptAt: nextAttemptAt,
            createdAt: createdAt,
            rowid: rowid,
          ),
          createCompanionCallback: ({
            required String uuid,
            required String type,
            Value<double?> lat = const Value.absent(),
            Value<double?> lng = const Value.absent(),
            Value<double?> accuracy = const Value.absent(),
            Value<String?> siteId = const Value.absent(),
            required String clientTs,
            Value<String> appVersion = const Value.absent(),
            Value<String> syncStatus = const Value.absent(),
            Value<int> attempts = const Value.absent(),
            Value<String?> lastError = const Value.absent(),
            Value<String?> serverResult = const Value.absent(),
            Value<DateTime?> nextAttemptAt = const Value.absent(),
            Value<DateTime> createdAt = const Value.absent(),
            Value<int> rowid = const Value.absent(),
          }) =>
              AttendanceQueueCompanion.insert(
            uuid: uuid,
            type: type,
            lat: lat,
            lng: lng,
            accuracy: accuracy,
            siteId: siteId,
            clientTs: clientTs,
            appVersion: appVersion,
            syncStatus: syncStatus,
            attempts: attempts,
            lastError: lastError,
            serverResult: serverResult,
            nextAttemptAt: nextAttemptAt,
            createdAt: createdAt,
            rowid: rowid,
          ),
          withReferenceMapper: (p0) => p0
              .map((e) => (
                    e.readTable<$AttendanceQueueTable, AttendanceQueueData>(
                        table),
                    BaseReferences<_$LocalDb, $AttendanceQueueTable,
                        AttendanceQueueData>(db, table, e)
                  ))
              .toList(),
          prefetchHooksCallback: null,
        ));
}

typedef $$AttendanceQueueTableProcessedTableManager = ProcessedTableManager<
    _$LocalDb,
    $AttendanceQueueTable,
    AttendanceQueueData,
    $$AttendanceQueueTableFilterComposer,
    $$AttendanceQueueTableOrderingComposer,
    $$AttendanceQueueTableAnnotationComposer,
    $$AttendanceQueueTableCreateCompanionBuilder,
    $$AttendanceQueueTableUpdateCompanionBuilder,
    (
      AttendanceQueueData,
      BaseReferences<_$LocalDb, $AttendanceQueueTable, AttendanceQueueData>
    ),
    AttendanceQueueData,
    PrefetchHooks Function()>;

class $LocalDbManager {
  final _$LocalDb _db;
  $LocalDbManager(this._db);
  $$AttendanceQueueTableTableManager get attendanceQueue =>
      $$AttendanceQueueTableTableManager(_db, _db.attendanceQueue);
}
