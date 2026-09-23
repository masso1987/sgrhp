import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';
import '../../core/providers.dart';
import '../../core/theme/app_theme.dart';
import '../../shared/widgets/ui.dart';
import '../attendance/attendance_repository.dart';
import '../attendance/checkin_sheet.dart';

class DashboardScreen extends ConsumerWidget {
  const DashboardScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final data = ref.watch(dashboardProvider);
    return Scaffold(
      body: RefreshIndicator(
        onRefresh: () async => ref.refresh(dashboardProvider.future),
        child: data.when(
          loading: () => const _DashSkeleton(),
          error: (e, _) => _ErrorState(message: '$e', onRetry: () => ref.refresh(dashboardProvider)),
          data: (d) => _Content(d: d),
        ),
      ),
    );
  }
}

class _Content extends ConsumerWidget {
  final Map<String, dynamic> d;
  const _Content({required this.d});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final today = Map<String, dynamic>.from(d['today'] ?? {});
    final status = today['status'] ?? 'NOT_CHECKED_IN';
    final checkedIn = status == 'CHECKED_IN';
    final name = (d['greeting_name'] ?? '').toString();
    final hour = DateTime.now().hour;
    final salut = hour < 12 ? 'Bonjour' : (hour < 18 ? 'Bon après-midi' : 'Bonsoir');

    return ListView(
      padding: const EdgeInsets.fromLTRB(18, 0, 18, 24),
      children: [
        // Gradient header
        Container(
          margin: const EdgeInsets.only(bottom: 6),
          padding: const EdgeInsets.fromLTRB(22, 60, 22, 26),
          decoration: const BoxDecoration(
            gradient: AppColors.brandGradient,
            borderRadius: BorderRadius.vertical(bottom: Radius.circular(34)),
          ),
          child: Row(children: [
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text('$salut,', style: TextStyle(color: Colors.white.withOpacity(.85), fontSize: 15)),
                const SizedBox(height: 2),
                Text(name.isEmpty ? 'Employé' : name,
                    style: const TextStyle(color: Colors.white, fontSize: 26, fontWeight: FontWeight.w800, letterSpacing: -.5)),
                const SizedBox(height: 4),
                Text(DateFormat('EEEE d MMMM', 'fr').format(DateTime.now()),
                    style: TextStyle(color: Colors.white.withOpacity(.8), fontSize: 13)),
              ]),
            ),
            _bell(context, d['notifications_unread'] ?? 0),
          ]),
        ),
        Transform.translate(offset: const Offset(0, -14), child: _attendanceCard(context, ref, today, checkedIn)),
        const SizedBox(height: 4),
        Row(children: [
          Expanded(child: _statTile(context, Icons.beach_access_rounded, 'Solde congés',
              d['leave_balance_days'] == null ? '—' : '${d['leave_balance_days']} j', AppColors.info, () => context.go('/leave'))),
          const SizedBox(width: 12),
          Expanded(child: _statTile(context, Icons.receipt_long_rounded, 'Dernier bulletin',
              (d['latest_payslip']?['period'] ?? '—').toString(), AppColors.brand, () => context.go('/payslips'))),
        ]),
        const SectionHeader('Raccourcis'),
        GlassCard(
          padding: const EdgeInsets.symmetric(vertical: 6),
          child: Column(children: [
            _link(context, Icons.pin_drop_rounded, 'Historique de présence', () => context.go('/attendance')),
            const Divider(height: 1),
            _link(context, Icons.event_available_rounded, 'Demander un congé', () => context.go('/leave')),
            const Divider(height: 1),
            _link(context, Icons.person_rounded, 'Mon profil', () => context.go('/profile')),
          ]),
        ),
      ],
    );
  }

  Widget _attendanceCard(BuildContext c, WidgetRef ref, Map today, bool checkedIn) {
    final t = (today['check_in'] != null) ? _fmt(today['check_in']) : null;
    return GlassCard(
      padding: const EdgeInsets.all(20),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Text("Présence du jour", style: Theme.of(c).textTheme.titleMedium),
          const Spacer(),
          StatusPill(
            checkedIn ? 'Pointé' : (today['status'] == 'CHECKED_OUT' ? 'Sorti' : 'Non pointé'),
            color: checkedIn ? AppColors.success : (today['status'] == 'CHECKED_OUT' ? AppColors.info : AppColors.warning),
            icon: checkedIn ? Icons.check_circle : Icons.schedule,
          ),
        ]),
        const SizedBox(height: 16),
        Row(children: [
          _clock('Arrivée', t ?? '--:--'),
          Container(width: 1, height: 36, color: Theme.of(c).dividerColor),
          _clock('Départ', today['check_out'] != null ? _fmt(today['check_out']) : '--:--'),
          const Spacer(),
          if ((today['site'] ?? '').toString().isNotEmpty)
            Flexible(child: Row(mainAxisSize: MainAxisSize.min, children: [
              const Icon(Icons.place_outlined, size: 16, color: AppColors.mutedLight),
              const SizedBox(width: 4),
              Flexible(child: Text(today['site'], overflow: TextOverflow.ellipsis, style: const TextStyle(color: AppColors.mutedLight))),
            ])),
        ]),
        const SizedBox(height: 18),
        FilledButton.icon(
          style: FilledButton.styleFrom(backgroundColor: checkedIn ? AppColors.danger : AppColors.brand),
          onPressed: () => showCheckInSheet(c, ref, checkIn: !checkedIn),
          icon: Icon(checkedIn ? Icons.logout_rounded : Icons.fingerprint_rounded),
          label: Text(checkedIn ? 'POINTER LA SORTIE' : 'POINTER L\'ARRIVÉE'),
        ),
      ]),
    );
  }

  Widget _clock(String label, String value) => Padding(
        padding: const EdgeInsets.only(right: 20),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(label, style: const TextStyle(color: AppColors.mutedLight, fontSize: 12)),
          const SizedBox(height: 2),
          Text(value, style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w800)),
        ]),
      );

  Widget _statTile(BuildContext c, IconData i, String label, String value, Color color, VoidCallback onTap) => GlassCard(
        onTap: onTap,
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Container(padding: const EdgeInsets.all(9), decoration: BoxDecoration(color: color.withOpacity(.14), borderRadius: BorderRadius.circular(12)), child: Icon(i, color: color, size: 20)),
          const SizedBox(height: 12),
          Text(value, style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w800)),
          Text(label, style: const TextStyle(color: AppColors.mutedLight, fontSize: 12.5)),
        ]),
      );

  Widget _link(BuildContext c, IconData i, String label, VoidCallback onTap) => ListTile(
        onTap: onTap,
        leading: Icon(i, color: AppColors.brand),
        title: Text(label, style: const TextStyle(fontWeight: FontWeight.w600)),
        trailing: const Icon(Icons.chevron_right_rounded, color: AppColors.mutedLight),
      );

  Widget _bell(BuildContext c, int count) => Stack(children: [
        IconButton(onPressed: () {}, icon: const Icon(Icons.notifications_none_rounded, color: Colors.white, size: 28)),
        if (count > 0) Positioned(right: 8, top: 8, child: Container(
          padding: const EdgeInsets.all(4),
          decoration: const BoxDecoration(color: AppColors.danger, shape: BoxShape.circle),
          child: Text('$count', style: const TextStyle(color: Colors.white, fontSize: 10, fontWeight: FontWeight.bold)),
        )),
      ]);

  static String _fmt(dynamic iso) {
    try { return DateFormat('HH:mm').format(DateTime.parse(iso).toLocal()); } catch (_) { return '--:--'; }
  }
}

class _DashSkeleton extends StatelessWidget {
  const _DashSkeleton();
  @override
  Widget build(BuildContext context) => const Center(child: CircularProgressIndicator());
}

class _ErrorState extends StatelessWidget {
  final String message; final VoidCallback onRetry;
  const _ErrorState({required this.message, required this.onRetry});
  @override
  Widget build(BuildContext context) => ListView(children: [
        const SizedBox(height: 120),
        const Icon(Icons.cloud_off_rounded, size: 54, color: AppColors.mutedLight),
        const SizedBox(height: 12),
        Center(child: Text(message, textAlign: TextAlign.center)),
        const SizedBox(height: 16),
        Center(child: FilledButton(onPressed: onRetry, child: const Text('Réessayer'))),
      ]);
}
