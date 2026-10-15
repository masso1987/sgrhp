import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../core/providers.dart';
import '../../core/theme/app_theme.dart';
import '../../shared/widgets/ui.dart';

/// Sites the employee is affected to (many-to-many). Read-only list fed by
/// /me/my-sites — distinct from the punch picker (/me/sites) which falls back
/// to all sites when there's no assignment.
final mySitesProvider = FutureProvider.autoDispose<List<dynamic>>((ref) async {
  final r = await ref.read(apiClientProvider).get('/me/my-sites');
  return (r.data as List);
});

class MySitesScreen extends ConsumerWidget {
  const MySitesScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final a = ref.watch(mySitesProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Mes sites')),
      body: a.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => ErrorView(error: e, onRetry: () async => ref.refresh(mySitesProvider.future)),
        data: (list) => RefreshIndicator(
          onRefresh: () async => ref.refresh(mySitesProvider.future),
          child: list.isEmpty
              ? ListView(children: const [
                  SizedBox(height: 80),
                  EmptyState(
                    icon: Icons.place_outlined,
                    title: 'Aucun site affecté',
                    subtitle: "Vous n'êtes affecté à aucun site pour le moment. Contactez votre responsable RH.",
                  ),
                ])
              : ListView(
                  padding: const EdgeInsets.all(16),
                  children: [
                    Padding(
                      padding: const EdgeInsets.only(bottom: 10, left: 4),
                      child: Text('${list.length} site${list.length > 1 ? 's' : ''} affecté${list.length > 1 ? 's' : ''}',
                          style: const TextStyle(color: AppColors.mutedLight, fontSize: 13)),
                    ),
                    ...list.map((x) => _tile(Map<String, dynamic>.from(x as Map))),
                  ],
                ),
        ),
      ),
    );
  }

  Widget _tile(Map<String, dynamic> s) {
    final addr = (s['address'] ?? '').toString();
    final hasGeo = s['latitude'] != null && s['longitude'] != null;
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: GlassCard(
        child: Row(children: [
          Container(
            padding: const EdgeInsets.all(10),
            decoration: BoxDecoration(color: AppColors.brand.withOpacity(.14), borderRadius: BorderRadius.circular(12)),
            child: const Icon(Icons.place_rounded, color: AppColors.brand),
          ),
          const SizedBox(width: 14),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text((s['name'] ?? '').toString(), style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 15)),
              if (addr.isNotEmpty) ...[
                const SizedBox(height: 2),
                Text(addr, style: const TextStyle(color: AppColors.mutedLight, fontSize: 12.5)),
              ],
              if (hasGeo) ...[
                const SizedBox(height: 4),
                Row(children: [
                  const Icon(Icons.my_location_rounded, size: 13, color: AppColors.mutedLight),
                  const SizedBox(width: 4),
                  Text('Rayon ${s['radius_m'] ?? 100} m', style: const TextStyle(color: AppColors.mutedLight, fontSize: 11.5)),
                ]),
              ],
            ]),
          ),
        ]),
      ),
    );
  }
}
