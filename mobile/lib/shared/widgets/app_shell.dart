import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../core/providers.dart';
import '../../core/i18n/l10n.dart';
import '../../core/push/push_service.dart';
import '../../core/theme/app_theme.dart';
import '../../features/attendance/sync_service.dart';
import '../../features/maintenance/maintenance.dart';

/// Bottom-nav shell — Home · Attendance · Payslips · Leave · Profile.
/// Boots the offline SyncService and shows a slim banner when punches are queued.
class AppShell extends ConsumerStatefulWidget {
  final Widget child;
  const AppShell({super.key, required this.child});
  @override
  ConsumerState<AppShell> createState() => _AppShellState();
}

class _AppShellState extends ConsumerState<AppShell> {
  static const _tabs = ['/home', '/attendance', '/payslips', '/leave', '/profile'];

  @override
  void initState() {
    super.initState();
    // Start listening for connectivity and flush any queued punches.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      ref.read(syncServiceProvider).flush();
      PushService.registerToken(ref.read(apiClientProvider), ref.read(secureStoreProvider));
    });
  }

  int _index() {
    final loc = GoRouterState.of(context).matchedLocation;
    final i = _tabs.indexWhere((t) => loc.startsWith(t));
    return i < 0 ? 0 : i;
  }

  @override
  Widget build(BuildContext context) {
    final maint = ref.watch(maintenanceProvider);
    if (maint.active) return const MaintenanceScreen();
    ref.watch(localeProvider); // rebuild nav labels on language change
    final pending = ref.watch(pendingCountProvider);
    return Scaffold(
      body: Column(children: [
        if (maint.upcoming) MaintenanceBanner(info: maint),
        if (pending > 0)
          Material(
            color: AppColors.warning.withOpacity(.14),
            child: SafeArea(
              bottom: false,
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
                child: Row(children: [
                  const Icon(Icons.cloud_upload_rounded, size: 16, color: AppColors.warning),
                  const SizedBox(width: 8),
                  Expanded(child: Text('$pending ${tr('common.syncPending')}',
                      style: const TextStyle(color: AppColors.warning, fontWeight: FontWeight.w600, fontSize: 12.5))),
                  TextButton(onPressed: () => ref.read(syncServiceProvider).flush(), child: Text(tr('common.sync'))),
                ]),
              ),
            ),
          ),
        Expanded(child: widget.child),
      ]),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _index(),
        onDestinationSelected: (i) => context.go(_tabs[i]),
        destinations: [
          NavigationDestination(icon: const Icon(Icons.home_outlined), selectedIcon: const Icon(Icons.home_rounded), label: tr('nav.home')),
          NavigationDestination(icon: const Icon(Icons.pin_drop_outlined), selectedIcon: const Icon(Icons.pin_drop_rounded), label: tr('nav.attendance')),
          NavigationDestination(icon: const Icon(Icons.receipt_long_outlined), selectedIcon: const Icon(Icons.receipt_long_rounded), label: tr('nav.payslips')),
          NavigationDestination(icon: const Icon(Icons.beach_access_outlined), selectedIcon: const Icon(Icons.beach_access_rounded), label: tr('nav.leave')),
          NavigationDestination(icon: const Icon(Icons.person_outline_rounded), selectedIcon: const Icon(Icons.person_rounded), label: tr('nav.profile')),
        ],
      ),
    );
  }
}
