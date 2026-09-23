import 'package:dio/dio.dart';
import '../config/env.dart';
import '../storage/secure_store.dart';

/// Thin Dio wrapper. Adds the bearer token, transparently refreshes an expired
/// access token using the rotating refresh token, and maps errors to friendly
/// messages. Never logs tokens.
class ApiException implements Exception {
  final int? status;
  final String message;
  final String? reason;
  ApiException(this.message, {this.status, this.reason});
  @override
  String toString() => message;
}

class ApiClient {
  ApiClient(this._store) {
    _dio = Dio(BaseOptions(
      baseUrl: '${Env.apiBaseUrl}${Env.apiVersion}',
      connectTimeout: const Duration(seconds: 15),
      receiveTimeout: const Duration(seconds: 20),
      headers: {'Content-Type': 'application/json'},
    ));
    _dio.interceptors.add(InterceptorsWrapper(
      onRequest: (o, h) async {
        final t = await _store.access;
        if (t != null) o.headers['Authorization'] = 'Bearer $t';
        h.next(o);
      },
      onError: (e, h) async {
        if (e.response?.statusCode == 401 && !_isAuthPath(e.requestOptions.path) && !_retried(e)) {
          final ok = await _refresh();
          if (ok) {
            final t = await _store.access;
            final r = e.requestOptions;
            r.headers['Authorization'] = 'Bearer $t';
            r.extra['retried'] = true;
            try {
              final resp = await _dio.fetch(r);
              return h.resolve(resp);
            } catch (_) {}
          }
        }
        h.next(e);
      },
    ));
  }

  late final Dio _dio;
  final SecureStore _store;
  bool _isAuthPath(String p) => p.contains('/auth/login') || p.contains('/auth/refresh');
  bool _retried(DioException e) => e.requestOptions.extra['retried'] == true;

  Future<bool> _refresh() async {
    final rt = await _store.refresh;
    if (rt == null) return false;
    try {
      final resp = await Dio().post('${Env.apiBaseUrl}${Env.apiVersion}/auth/refresh',
          data: {'refresh_token': rt});
      await _store.saveTokens(resp.data['access_token'], resp.data['refresh_token']);
      return true;
    } catch (_) {
      await _store.clear();
      return false;
    }
  }

  Future<Response<T>> get<T>(String path, {Map<String, dynamic>? query}) =>
      _guard(() => _dio.get<T>(path, queryParameters: query));
  Future<Response<T>> post<T>(String path, {Object? data}) =>
      _guard(() => _dio.post<T>(path, data: data));

  Future<Response<T>> _guard<T>(Future<Response<T>> Function() run) async {
    try {
      return await run();
    } on DioException catch (e) {
      throw _map(e);
    }
  }

  ApiException _map(DioException e) {
    if (e.type == DioExceptionType.connectionTimeout ||
        e.type == DioExceptionType.receiveTimeout ||
        e.type == DioExceptionType.connectionError) {
      return ApiException('Connexion indisponible. Réessayez.', status: null);
    }
    final code = e.response?.statusCode;
    final data = e.response?.data;
    final msg = (data is Map && data['error'] != null)
        ? data['error'].toString()
        : (data is Map && data['message'] != null ? data['message'].toString() : 'Une erreur est survenue.');
    return ApiException(msg, status: code, reason: data is Map ? data['reason']?.toString() : null);
  }
}
