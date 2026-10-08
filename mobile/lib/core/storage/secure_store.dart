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
  static const _kApiBase = 'api_base_url';
  static const _kLang = 'lang';
  static const _kAnchor = 'time_anchor'; // JSON {serverMs,bootMs} for offline punch timing

  Future<void> saveTokens(String access, String refresh) async {
    await _s.write(key: _kAccess, value: access);
    await _s.write(key: _kRefresh, value: refresh);
  }
  Future<String?> get access => _s.read(key: _kAccess);
  Future<String?> get refresh => _s.read(key: _kRefresh);
  Future<void> setDeviceId(String id) => _s.write(key: _kDevice, value: id);
  Future<String?> get deviceId => _s.read(key: _kDevice);
  Future<String?> get lang => _s.read(key: _kLang);
  Future<void> setLang(String v) => _s.write(key: _kLang, value: v);
  Future<String?> get timeAnchor => _s.read(key: _kAnchor);
  Future<void> setTimeAnchor(String json) => _s.write(key: _kAnchor, value: json);
  Future<String?> get apiBaseOverride => _s.read(key: _kApiBase);
  Future<void> setApiBaseOverride(String? v) async {
    if (v == null || v.trim().isEmpty) { await _s.delete(key: _kApiBase); }
    else { await _s.write(key: _kApiBase, value: v.trim()); }
  }
  Future<void> clear() async { await _s.delete(key: _kAccess); await _s.delete(key: _kRefresh); }
}
