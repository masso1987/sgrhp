import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// Tokens and sensitive credentials live only in the platform keystore/keychain.
class SecureStore {
  static const _s = FlutterSecureStorage(
    aOptions: AndroidOptions(encryptedSharedPreferences: true),
    iOptions: IOSOptions(accessibility: KeychainAccessibility.first_unlock),
  );
  static const _kAccess = 'access_token';
  static const _kRefresh = 'refresh_token';
  static const _kDevice = 'device_id';

  Future<void> saveTokens(String access, String refresh) async {
    await _s.write(key: _kAccess, value: access);
    await _s.write(key: _kRefresh, value: refresh);
  }
  Future<String?> get access => _s.read(key: _kAccess);
  Future<String?> get refresh => _s.read(key: _kRefresh);
  Future<void> setDeviceId(String id) => _s.write(key: _kDevice, value: id);
  Future<String?> get deviceId => _s.read(key: _kDevice);
  Future<void> clear() async { await _s.delete(key: _kAccess); await _s.delete(key: _kRefresh); }
}
