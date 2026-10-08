/// Environment configuration. Provide at build time with --dart-define, e.g.
/// flutter run --dart-define=API_BASE_URL=https://portal.mboketech.com
class Env {
  static const apiBaseUrl = String.fromEnvironment(
    'API_BASE_URL',
    defaultValue: 'https://portal.mboketech.com',
  );
  static const apiVersion = '/api/v1';
  static const googleMapsApiKey = String.fromEnvironment('GOOGLE_MAPS_API_KEY', defaultValue: '');
  static const selfieRequired = bool.fromEnvironment('SELFIE_REQUIRED', defaultValue: false);
  /// Support/admin code that unlocks the hidden "Serveur" (base URL) override in
  /// release builds. Bake a per-deployment value with --dart-define=SUPPORT_CODE=...
  static const supportCode = String.fromEnvironment('SUPPORT_CODE', defaultValue: '246810');
}

/// Effective runtime configuration. The API base URL defaults to the build-time
/// value but can be overridden at runtime (persisted) so a domain change does NOT
/// require rebuilding and redistributing the app. See SecureStore.apiBaseOverride
/// and the "Serveur" option on the login screen.
class AppConfig {
  static String _baseUrl = Env.apiBaseUrl;
  static String get baseUrl => _baseUrl;
  static set baseUrl(String v) {
    final t = v.trim();
    _baseUrl = t.isEmpty ? Env.apiBaseUrl : t.replaceAll(RegExp(r'/+$'), '');
  }

  /// Full API root (base + /api/v1) used by the HTTP client.
  static String get apiRoot => '$baseUrl${Env.apiVersion}';

  /// The compiled-in default, for "reset to default".
  static String get defaultBaseUrl => Env.apiBaseUrl;
}
