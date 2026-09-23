import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';
import '../../core/theme/app_theme.dart';
import '../../shared/widgets/ui.dart';
import 'attendance_repository.dart';

class HistoryScreen extends ConsumerWidget {
  const HistoryScreen({super.key});
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final h = ref.watch(historyProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Présence'), centerTitle: false),
      body: h.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => Center(child: Text('$e')),
        data: (d) {
          final days = (d['days'] as List);
          if (days.isEmpty) return const _Empty();
          return RefreshIndicator(
            onRefresh: () async => ref.refresh(historyProvider.future),
            child: ListView.separated(
              padding: const EdgeInsets.all(18),
              itemCount: days.length,
              itemBuilder: (_, i) => _row(context, days[i]),
              separatorBuilder: (_, __) => const SizedBox(height: 10),
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
  static String _date(dynamic d) { try { return DateFormat('EEE d MMM', 'fr').format(DateTime.parse(d)); } catch (_) { return '$d'; } }
  static String _dur(int ms) { final h = ms ~/ 3600000, m = (ms % 3600000) ~/ 60000; return '${h}h${m.toString().padLeft(2, '0')}'; }
  static String _reason(dynamic r) => {
        'OUTSIDE_GEOFENCE': 'Hors zone', 'LOW_ACCURACY': 'GPS imprécis',
        'DUPLICATE_CHECKIN': 'Doublon', 'CHECKOUT_WITHOUT_CHECKIN': 'Sortie sans entrée', 'NO_SITE': 'Sans site',
      }[r] ?? 'Exception';
}

class _Empty extends StatelessWidget {
  const _Empty();
  @override
  Widget build(BuildContext context) => const Center(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Icon(Icons.pin_drop_outlined, size: 54, color: AppColors.mutedLight),
          SizedBox(height: 12), Text('Aucun pointage pour le moment.'),
        ]),
      );
}
