import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';
import '../../core/i18n/l10n.dart';
import '../../core/providers.dart';
import '../../core/theme/app_theme.dart';

/// Platform maintenance status, read from the public GET /api/v1/maintenance.
class MaintenanceInfo {
  final bool active;
  final bool upcoming;
  final String message;
  final String? scheduledStart;
  final String? scheduledEnd;
  const MaintenanceInfo({
    this.active = false,
    this.upcoming = false,
    this.message = '',
    this.scheduledStart,
    this.scheduledEnd,
  });
  factory MaintenanceInfo.fromJson(Map j) => MaintenanceInfo(
        active: j['active'] == true,
        upcoming: j['upcoming'] == true,
        message: (j['message'] ?? '').toString(),
        scheduledStart: j['scheduledStart']?.toString(),
        scheduledEnd: j['scheduledEnd']?.toString(),
      );
}

/// Polls maintenance status on start and every 60s (in-app polling; no Firebase needed).
class MaintenanceNotifier extends StateNotifier<MaintenanceInfo> {
  MaintenanceNotifier(this._ref) : super(const MaintenanceInfo()) {
    _poll();
    _timer = Timer.periodic(const Duration(seconds: 60), (_) => _poll());
  }
  final Ref _ref;
  Timer? _timer;

  Future<void> _poll() async {
    try {
      final r = await _ref.read(apiClientProvider).get('/maintenance');
      final d = r.data;
      if (d is Map) state = MaintenanceInfo.fromJson(d);
    } catch (_) {
      // Network errors are ignored; the app keeps working on the last known status.
    }
  }

  Future<void> refresh() => _poll();

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }
}

final maintenanceProvider =
    StateNotifierProvider<MaintenanceNotifier, MaintenanceInfo>((ref) => MaintenanceNotifier(ref));

String _fmt(String? iso) {
  if (iso == null) return '';
  try {
    final loc = appLang == 'en' ? 'en' : 'fr';
    final pat = appLang == 'en' ? "d MMM yyyy 'at' HH:mm" : "d MMM yyyy 'à' HH:mm";
    return DateFormat(pat, loc).format(DateTime.parse(iso).toLocal());
  } catch (_) {
    return '';
  }
}

/// Full-screen shown while maintenance is active (employees are blocked by the API).
class MaintenanceScreen extends ConsumerWidget {
  const MaintenanceScreen({super.key});
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final m = ref.watch(maintenanceProvider);
    ref.watch(localeProvider);
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(28),
            child: Column(mainAxisSize: MainAxisSize.min, children: [
              Container(
                width: 92,
                height: 92,
                decoration: BoxDecoration(color: AppColors.accent.withOpacity(.14), shape: BoxShape.circle),
                child: const Icon(Icons.build_rounded, size: 44, color: AppColors.brand),
              ),
              const SizedBox(height: 22),
              Text(tr('maint.title'),
                  textAlign: TextAlign.center, style: Theme.of(context).textTheme.headlineSmall),
              const SizedBox(height: 10),
              Text(
                m.message.isNotEmpty ? m.message : tr('maint.body'),
                textAlign: TextAlign.center,
                style: const TextStyle(color: AppColors.mutedLight, fontSize: 14, height: 1.4),
              ),
              if (m.scheduledEnd != null && _fmt(m.scheduledEnd).isNotEmpty) ...[
                const SizedBox(height: 16),
                Text('${tr('maint.back')} ${_fmt(m.scheduledEnd)}',
                    textAlign: TextAlign.center,
                    style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 13.5)),
              ],
              const SizedBox(height: 24),
              FilledButton.tonalIcon(
                onPressed: () => ref.read(maintenanceProvider.notifier).refresh(),
                icon: const Icon(Icons.refresh_rounded, size: 18),
                label: Text(tr('maint.again')),
              ),
            ]),
          ),
        ),
      ),
    );
  }
}

/// Slim amber banner shown above the shell when a maintenance window is upcoming.
class MaintenanceBanner extends StatelessWidget {
  final MaintenanceInfo info;
  const MaintenanceBanner({super.key, required this.info});
  @override
  Widget build(BuildContext context) {
    final when = _fmt(info.scheduledStart);
    final txt = info.message.isNotEmpty
        ? info.message
        : (when.isNotEmpty ? '${tr('maint.planned')} $when' : tr('maint.plannedSoon'));
    return Material(
      color: AppColors.warning.withOpacity(.14),
      child: SafeArea(
        bottom: false,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
          child: Row(children: [
            const Icon(Icons.schedule_rounded, size: 16, color: AppColors.warning),
            const SizedBox(width: 8),
            Expanded(
              child: Text(txt,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(color: AppColors.warning, fontWeight: FontWeight.w600, fontSize: 12.5)),
            ),
          ]),
        ),
      ),
    );
  }
}
