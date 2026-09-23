import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../core/providers.dart';
import '../../core/theme/app_theme.dart';
import '../../shared/widgets/ui.dart';

final profileProvider = FutureProvider.autoDispose((ref) async {
  final r = await ref.read(apiClientProvider).get('/me');
  return Map<String, dynamic>.from(r.data as Map);
});

class ProfileScreen extends ConsumerWidget {
  const ProfileScreen({super.key});
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final p = ref.watch(profileProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Mon profil')),
      body: p.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => Center(child: Text('$e')),
        data: (d) => ListView(padding: const EdgeInsets.all(18), children: [
          Center(child: Column(children: [
            CircleAvatar(radius: 44, backgroundColor: AppColors.brand.withOpacity(.14),
              child: Text(_initials(d['name']), style: const TextStyle(fontSize: 30, fontWeight: FontWeight.w800, color: AppColors.brand))),
            const SizedBox(height: 12),
            Text(d['name'] ?? '', style: Theme.of(context).textTheme.titleLarge),
            Text('${d['position'] ?? ''} · ${d['matricule'] ?? ''}', style: const TextStyle(color: AppColors.mutedLight)),
          ])),
          const SizedBox(height: 20),
          GlassCard(padding: const EdgeInsets.symmetric(vertical: 4), child: Column(children: [
            _row(Icons.business_rounded, 'Entreprise', d['company']),
            _row(Icons.apartment_rounded, 'Département', d['department']),
            _row(Icons.badge_rounded, 'Poste', d['position']),
            _row(Icons.email_rounded, 'E-mail', d['email']),
            _row(Icons.phone_rounded, 'Téléphone', d['phone']),
            _row(Icons.supervisor_account_rounded, 'Superviseur', d['supervisor'], last: true),
          ])),
          const SizedBox(height: 24),
          OutlinedButton.icon(
            style: OutlinedButton.styleFrom(foregroundColor: AppColors.danger, minimumSize: const Size.fromHeight(52), side: const BorderSide(color: AppColors.danger)),
            onPressed: () => ref.read(authControllerProvider.notifier).logout(),
            icon: const Icon(Icons.logout_rounded),
            label: const Text('Se déconnecter'),
          ),
        ]),
      ),
    );
  }

  Widget _row(IconData i, String label, dynamic v, {bool last = false}) => Column(children: [
        ListTile(leading: Icon(i, color: AppColors.brand), title: Text(label, style: const TextStyle(fontSize: 13, color: AppColors.mutedLight)),
            subtitle: Text((v == null || '$v'.isEmpty) ? '—' : '$v', style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 15))),
        if (!last) const Divider(height: 1, indent: 56),
      ]);

  static String _initials(dynamic name) {
    final parts = '${name ?? '?'}'.trim().split(RegExp(r'\s+'));
    return (parts.length >= 2 ? parts[0][0] + parts[1][0] : (parts.first.isNotEmpty ? parts.first[0] : '?')).toUpperCase();
  }
}
