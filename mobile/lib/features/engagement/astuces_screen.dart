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
              itemBuilder: (_, i) => _TipTile(tip: Map<String, dynamic>.from(list[i] as Map)),
            ),
          );
        },
      ),
    );
  }
}

/// One astuce: collapsed shows title + preview; expanding reveals the full text
/// and marks it read (so HR sees who opened it).
class _TipTile extends ConsumerStatefulWidget {
  final Map<String, dynamic> tip;
  const _TipTile({required this.tip});
  @override
  ConsumerState<_TipTile> createState() => _TipTileState();
}

class _TipTileState extends ConsumerState<_TipTile> {
  bool _marked = false;

  Future<void> _markRead() async {
    if (_marked || widget.tip['read'] == true) return;
    _marked = true;
    try { await ref.read(apiClientProvider).post('/me/tips/${widget.tip['id']}/read'); } catch (_) {}
  }

  @override
  Widget build(BuildContext context) {
    final t = widget.tip;
    final body = (t['body'] ?? '').toString();
    final preview = body.replaceAll(RegExp(r'\s+'), ' ');
    return GlassCard(
      padding: EdgeInsets.zero,
      child: Theme(
        data: Theme.of(context).copyWith(dividerColor: Colors.transparent),
        child: ExpansionTile(
          tilePadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
          childrenPadding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
          onExpansionChanged: (open) { if (open) _markRead(); },
          leading: const Icon(Icons.lightbulb_rounded, color: AppColors.warning),
          title: Text(t['title']?.toString() ?? '', style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 15)),
          subtitle: Padding(
            padding: const EdgeInsets.only(top: 4),
            child: Text(preview, maxLines: 2, overflow: TextOverflow.ellipsis, style: const TextStyle(color: AppColors.mutedLight, fontSize: 12.5)),
          ),
          children: [
            Align(
              alignment: Alignment.centerLeft,
              child: Text(body, style: const TextStyle(fontSize: 13.5, height: 1.5)),
            ),
            const SizedBox(height: 10),
            Align(
              alignment: Alignment.centerLeft,
              child: Text([t['author'], _date(t['created_at'])].where((x) => (x ?? '').toString().isNotEmpty).join(' · '),
                  style: const TextStyle(color: AppColors.mutedLight, fontSize: 11.5)),
            ),
          ],
        ),
      ),
    );
  }

  static String _date(dynamic iso) {
    try { return DateFormat('d MMM yyyy', 'fr').format(DateTime.parse(iso).toLocal()); } catch (_) { return ''; }
  }
}
