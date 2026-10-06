import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';
import '../../core/providers.dart';
import '../../core/theme/app_theme.dart';
import '../../shared/widgets/ui.dart';

final tipsProvider = FutureProvider.autoDispose<List<dynamic>>((ref) async {
  final r = await ref.read(apiClientProvider).get('/me/tips');
  return (r.data as List);
});

class AstucesScreen extends ConsumerWidget {
  const AstucesScreen({super.key});
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final a = ref.watch(tipsProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Astuces RH')),
      body: a.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => ErrorView(error: e, onRetry: () async => ref.refresh(tipsProvider.future)),
        data: (list) {
          if (list.isEmpty) {
            return const EmptyState(icon: Icons.lightbulb_outline_rounded, title: 'Aucune astuce pour le moment', subtitle: 'Les conseils RH publiés par votre entreprise apparaîtront ici.');
          }
          return RefreshIndicator(
            onRefresh: () async => ref.refresh(tipsProvider.future),
            child: ListView.separated(
              padding: const EdgeInsets.all(16),
              itemCount: list.length,
              separatorBuilder: (_, __) => const SizedBox(height: 10),
              itemBuilder: (_, i) => _tipCard(Map<String, dynamic>.from(list[i] as Map)),
            ),
          );
        },
      ),
    );
  }

  Widget _tipCard(Map<String, dynamic> t) {
    return GlassCard(
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          const Icon(Icons.lightbulb_rounded, color: AppColors.warning, size: 20),
          const SizedBox(width: 8),
          Expanded(child: Text(t['title']?.toString() ?? '', style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 15.5))),
        ]),
        const SizedBox(height: 8),
        Text(t['body']?.toString() ?? '', style: const TextStyle(fontSize: 13.5, height: 1.45)),
        const SizedBox(height: 8),
        Text([t['author'], _date(t['created_at'])].where((x) => (x ?? '').toString().isNotEmpty).join(' · '),
            style: const TextStyle(color: AppColors.mutedLight, fontSize: 11.5)),
      ]),
    );
  }

  static String _date(dynamic iso) {
    try { return DateFormat('d MMM yyyy', 'fr').format(DateTime.parse(iso).toLocal()); } catch (_) { return ''; }
  }
}
