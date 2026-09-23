/// Environment configuration. Provide at build time with --dart-define, e.g.
/// flutter run --dart-define=API_BASE_URL=https://sgrhp.ciblerh-emploi.com
class Env {
  static const apiBaseUrl = String.fromEnvironment(
    'API_BASE_URL',
    defaultValue: 'https://sgrhp.ciblerh-emploi.com',
  );
  static const apiVersion = '/api/v1';
  static const googleMapsApiKey = String.fromEnvironment('GOOGLE_MAPS_API_KEY', defaultValue: '');
  static const selfieRequired = bool.fromEnvironment('SELFIE_REQUIRED', defaultValue: false);
}
