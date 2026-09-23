import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

/// Bottom-nav shell — Home · Attendance · Payslips · Leave · Profile.
class AppShell extends StatelessWidget {
  final Widget child;
  const AppShell({super.key, required this.child});

  static const _tabs = ['/home', '/attendance', '/payslips', '/leave', '/profile'];

  int _index(BuildContext c) {
    final loc = GoRouterState.of(c).matchedLocation;
    final i = _tabs.indexWhere((t) => loc.startsWith(t));
    return i < 0 ? 0 : i;
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: child,
      bottomNavigationBar: NavigationBar(
        selectedIndex: _index(context),
        onDestinationSelected: (i) => context.go(_tabs[i]),
        destinations: const [
          NavigationDestination(icon: Icon(Icons.home_outlined), selectedIcon: Icon(Icons.home_rounded), label: 'Accueil'),
          NavigationDestination(icon: Icon(Icons.pin_drop_outlined), selectedIcon: Icon(Icons.pin_drop_rounded), label: 'Présence'),
          NavigationDestination(icon: Icon(Icons.receipt_long_outlined), selectedIcon: Icon(Icons.receipt_long_rounded), label: 'Bulletins'),
          NavigationDestination(icon: Icon(Icons.beach_access_outlined), selectedIcon: Icon(Icons.beach_access_rounded), label: 'Congés'),
          NavigationDestination(icon: Icon(Icons.person_outline_rounded), selectedIcon: Icon(Icons.person_rounded), label: 'Profil'),
        ],
      ),
    );
  }
}
