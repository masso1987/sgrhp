import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';
import '../../core/i18n/l10n.dart';
import '../../core/theme/app_theme.dart';
import '../../shared/widgets/ui.dart';
import 'attendance_repository.dart';

class HistoryScreen extends ConsumerWidget {
  const HistoryScreen({super.key});
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    ref.watch(localeProvider);
    final month = ref.watch(presenceMonthProvider);
    final h = ref.watch(historyProvider);
    return Scaffold(
      appBar: AppBar(
        title: Text(tr('pres.title')),
        centerTitle: false,
        actions: [
          _MonthMenu(
            value: month,
            onChanged: (m) => ref.read(presenceMonthProvider.notifier).state = m,
          ),
        ],
      ),
      body: h.when(
        loading: () => const _Skeleton(),
        error: (e, _) => _ErrorState(onRetry: () => ref.refresh(historyProvider)),
        data: (d) {
          final days = (d['days'] as List? ?? []);
          final summary = d['summary'] as Map?;
          return RefreshIndicator(
            onRefresh: () async => ref.refresh(historyProvider.future),
            child: ListView(
              padding: const EdgeInsets.all(18),
              children: [
                if (summary != null) ...[_SummaryCard(s: summary), const SizedBox(height: 14)],
                if (days.isEmpty)
                  _Empty(all: month == null)
                else
                  ...days.expand((e) => [_row(context, e as Map), const SizedBox(height: 10)]),
              ],
            ),
          );
        },
      ),
    );
  }

  Widget _row(BuildContext c, Map d) {
    final exc = d['status'] == 'EXCEPTION';
    final ci = _t(d['check_in']), co = _t(d['check_out']);
    final dur = d['duration_ms'] != null ? _dur(d['duration_ms']) : '—';
    return GlassCard(
      child: Row(children: [
        Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(_date(d['date']), style: const TextStyle(fontWeight: FontWeight.w700)),
          const SizedBox(height: 4),
          Text(d['site'] ?? '', style: const TextStyle(color: AppColors.mutedLight, fontSize: 12.5)),
        ]),
        const Spacer(),
        Column(crossAxisAlignment: CrossAxisAlignment.end, children: [
          Text('$ci → $co', style: const TextStyle(fontWeight: FontWeight.w600)),
          const SizedBox(height: 4),
          exc
              ? StatusPill(_reason(d['exception_reason']), color: AppColors.warning, icon: Icons.error_outline)
              : Text(dur, style: const TextStyle(color: AppColors.mutedLight, fontSize: 12.5)),
        ]),
      ]),
    );
  }

  static String _t(dynamic iso) { try { return DateFormat('HH:mm').format(DateTime.parse(iso).toLocal()); } catch (_) { return '--:--'; } }
  static String _date(dynamic d) { try { return DateFormat('EEE d MMM', appLang == 'en' ? 'en' : 'fr').format(DateTime.parse(d)); } catch (_) { return '$d'; } }
  static String _dur(int ms) { final h = ms ~/ 3600000, m = (ms % 3600000) ~/ 60000; return '${h}h${m.toString().padLeft(2, '0')}'; }
  static String _reason(dynamic r) => {
        'OUTSIDE_GEOFENCE': tr('pres.outsideZone'), 'LOW_ACCURACY': tr('pres.lowGps'),
        'DUPLICATE_CHECKIN': tr('pres.duplicate'), 'CHECKOUT_WITHOUT_CHECKIN': tr('pres.checkoutNoCheckin'), 'NO_SITE': tr('pres.noSite'),
      }[r] ?? tr('pres.exception');
}

/// Month dropdown: "All history" + the last 12 months.
class _MonthMenu extends StatelessWidget {
  final String? value;
  final ValueChanged<String?> onChanged;
  const _MonthMenu({required this.value, required this.onChanged});
  @override
  Widget build(BuildContext context) {
    final now = DateTime.now();
    final months = List.generate(12, (i) {
      final d = DateTime(now.year, now.month - i, 1);
      return '${d.year.toString().padLeft(4, '0')}-${d.month.toString().padLeft(2, '0')}';
    });
    final loc = appLang == 'en' ? 'en' : 'fr';
    String label(String ym) {
      try { final p = ym.split('-'); return DateFormat('MMM yyyy', loc).format(DateTime(int.parse(p[0]), int.parse(p[1]))); }
      catch (_) { return ym; }
    }
    return PopupMenuButton<String?>(
      icon: const Icon(Icons.calendar_month_rounded),
      initialValue: value,
      onSelected: (v) => onChanged(v == '__all__' ? null : v),
      itemBuilder: (_) => [
        PopupMenuItem(value: '__all__', child: Text(tr('pres.allMonths'))),
        const PopupMenuDivider(),
        ...months.map((m) => PopupMenuItem(value: m, child: Text(label(m)))),
      ],
    );
  }
}

class _SummaryCard extends StatelessWidget {
  final Map s;
  const _SummaryCard({required this.s});
  @override
  Widget build(BuildContext context) {
    final totalMs = (s['total_ms'] as num?)?.toInt() ?? 0;
    final h = totalMs ~/ 3600000, m = (totalMs % 3600000) ~/ 60000;
    Widget cell(String v, String l, Color c) => Expanded(
          child: Column(children: [
            Text(v, style: TextStyle(fontSize: 20, fontWeight: FontWeight.w800, color: c)),
            const SizedBox(height: 2),
            Text(l, textAlign: TextAlign.center, style: const TextStyle(fontSize: 11.5, color: AppColors.mutedLight)),
          ]),
        );
    return GlassCard(
      child: Row(children: [
        cell('${s['days_present'] ?? 0}', tr('pres.daysPresent'), AppColors.success),
        cell('${s['exceptions'] ?? 0}', tr('pres.exceptions'), (s['exceptions'] ?? 0) == 0 ? AppColors.mutedLight : AppColors.warning),
        cell('${h}h${m.toString().padLeft(2, '0')}', tr('pres.totalHours'), AppColors.brand),
      ]),
    );
  }
}

class _Skeleton extends StatelessWidget {
  const _Skeleton();
  @override
  Widget build(BuildContext context) => ListView(
        padding: const EdgeInsets.all(18),
        children: List.generate(6, (_) => Padding(
          padding: const EdgeInsets.only(bottom: 10),
          child: Container(
            height: 68,
            decoration: BoxDecoration(
              color: AppColors.mutedLight.withOpacity(.10),
              borderRadius: BorderRadius.circular(AppRadius.lg),
            ),
          ),
        )),
      );
}

class _ErrorState extends StatelessWidget {
  final VoidCallback onRetry;
  const _ErrorState({required this.onRetry});
  @override
  Widget build(BuildContext context) => Center(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          const Icon(Icons.cloud_off_rounded, size: 54, color: AppColors.mutedLight),
          const SizedBox(height: 12),
          Text(tr('pres.error')),
          const SizedBox(height: 16),
          FilledButton(onPressed: onRetry, child: Text(tr('common.retry'))),
        ]),
      );
}

class _Empty extends StatelessWidget {
  final bool all;
  const _Empty({required this.all});
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(top: 80),
        child: Center(
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            const Icon(Icons.pin_drop_outlined, size: 54, color: AppColors.mutedLight),
            const SizedBox(height: 12),
            Text(all ? tr('pres.emptyAll') : tr('pres.empty')),
          ]),
        ),
      );
}
