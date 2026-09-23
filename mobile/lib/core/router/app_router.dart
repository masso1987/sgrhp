import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../providers.dart';
import '../../features/auth/login_screen.dart';
import '../../features/auth/set_password_screen.dart';
import '../../shared/widgets/app_shell.dart';
import '../../features/dashboard/dashboard_screen.dart';
import '../../features/attendance/history_screen.dart';
import '../../features/payslips/payslips_screen.dart';
import '../../features/leave/leave_screen.dart';
import '../../features/profile/profile_screen.dart';

final routerProvider = Provider<GoRouter>((ref) {
  final auth = ref.watch(authControllerProvider);
  return GoRouter(
    initialLocation: '/home',
    redirect: (context, state) {
      final s = auth.status;
      final loc = state.matchedLocation;
      if (s == AuthStatus.unknown) return null;
      final onAuth = loc == '/login';
      final onSet = loc == '/set-password';
      if (s == AuthStatus.unauthenticated) return onAuth ? null : '/login';
      if (s == AuthStatus.mustChangePassword) return onSet ? null : '/set-password';
      if (onAuth || onSet) return '/home';
      return null;
    },
    routes: [
      GoRoute(path: '/login', builder: (_, __) => const LoginScreen()),
      GoRoute(path: '/set-password', builder: (_, __) => const SetPasswordScreen()),
      ShellRoute(
        builder: (_, __, child) => AppShell(child: child),
        routes: [
          GoRoute(path: '/home', builder: (_, __) => const DashboardScreen()),
          GoRoute(path: '/attendance', builder: (_, __) => const HistoryScreen()),
          GoRoute(path: '/payslips', builder: (_, __) => const PayslipsScreen()),
          GoRoute(path: '/leave', builder: (_, __) => const LeaveScreen()),
          GoRoute(path: '/profile', builder: (_, __) => const ProfileScreen()),
        ],
      ),
    ],
  );
});
