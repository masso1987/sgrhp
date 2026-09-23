import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'network/api_client.dart';
import 'storage/secure_store.dart';

final secureStoreProvider = Provider((_) => SecureStore());
final apiClientProvider = Provider((ref) => ApiClient(ref.read(secureStoreProvider)));

/// Whole-app auth state.
enum AuthStatus { unknown, unauthenticated, mustChangePassword, authenticated }

class AuthState {
  final AuthStatus status;
  final String? name;
  final String? company;
  const AuthState(this.status, {this.name, this.company});
}

class AuthController extends StateNotifier<AuthState> {
  AuthController(this._ref) : super(const AuthState(AuthStatus.unknown)) {
    _bootstrap();
  }
  final Ref _ref;

  Future<void> _bootstrap() async {
    final t = await _ref.read(secureStoreProvider).access;
    state = AuthState(t == null ? AuthStatus.unauthenticated : AuthStatus.authenticated);
  }

  Future<void> login(String login, String password) async {
    final api = _ref.read(apiClientProvider);
    final store = _ref.read(secureStoreProvider);
    final res = await api.post('/auth/login', data: {'login': login, 'password': password, 'deviceId': await store.deviceId});
    final d = res.data as Map;
    await store.saveTokens(d['access_token'], d['refresh_token']);
    final emp = d['employee'] as Map?;
    state = AuthState(
      d['must_change_password'] == true ? AuthStatus.mustChangePassword : AuthStatus.authenticated,
      name: emp?['name'], company: emp?['company'],
    );
  }

  Future<void> setPassword(String newPassword) async {
    await _ref.read(apiClientProvider).post('/auth/password', data: {'new_password': newPassword});
    state = AuthState(AuthStatus.authenticated, name: state.name, company: state.company);
  }

  Future<void> logout() async {
    try { await _ref.read(apiClientProvider).post('/auth/logout'); } catch (_) {}
    await _ref.read(secureStoreProvider).clear();
    state = const AuthState(AuthStatus.unauthenticated);
  }
}

final authControllerProvider = StateNotifierProvider<AuthController, AuthState>((ref) => AuthController(ref));
