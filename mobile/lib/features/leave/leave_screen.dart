import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';
import '../../core/providers.dart';
import '../../core/theme/app_theme.dart';
import '../../shared/widgets/ui.dart';

final leaveProvider = FutureProvider.autoDispose((ref) async {
  final r = await ref.read(apiClientProvider).get('/me/leave');
  return Map<String, dynamic>.from(r.data as Map);
});

class LeaveScreen extends ConsumerWidget {
  const LeaveScreen({super.key});
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l = ref.watch(leaveProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Congés')),
      floatingActionButton: FloatingActionButton.extended(
        backgroundColor: AppColors.brand,
        onPressed: () => _requestSheet(context, ref),
        icon: const Icon(Icons.add, color: Colors.white),
        label: const Text('Demande', style: TextStyle(color: Colors.white)),
      ),
      body: l.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => Center(child: Text('$e')),
        data: (d) {
          final reqs = (d['requests'] as List);
          return ListView(padding: const EdgeInsets.all(18), children: [
            GlassCard(
              padding: const EdgeInsets.all(20),
              child: Row(children: [
                const Icon(Icons.beach_access_rounded, color: AppColors.info, size: 34),
                const SizedBox(width: 16),
                Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text('${d['balance_days'] ?? '—'}', style: const TextStyle(fontSize: 30, fontWeight: FontWeight.w800)),
                  const Text('jours de congé disponibles', style: TextStyle(color: AppColors.mutedLight)),
                ]),
              ]),
            ),
            const SectionHeader('Mes demandes'),
            if (reqs.isEmpty) const Padding(padding: EdgeInsets.all(20), child: Center(child: Text('Aucune demande.'))),
            ...reqs.map((r) => Padding(padding: const EdgeInsets.only(bottom: 10), child: _reqCard(r))),
          ]);
        },
      ),
    );
  }

  Widget _reqCard(Map r) {
    final st = r['status'];
    final col = st == 'APPROVED' ? AppColors.success : st == 'REJECTED' ? AppColors.danger : st == 'CANCELLED' ? AppColors.mutedLight : AppColors.warning;
    final lbl = {'APPROVED': 'Approuvé', 'REJECTED': 'Refusé', 'PENDING': 'En attente', 'CANCELLED': 'Annulé'}[st] ?? st;
    return GlassCard(child: Row(children: [
      Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text(r['type'] ?? 'Congé', style: const TextStyle(fontWeight: FontWeight.w700)),
        const SizedBox(height: 3),
        Text('${_d(r['start'])} → ${_d(r['end'])} · ${r['days']} j', style: const TextStyle(color: AppColors.mutedLight, fontSize: 12.5)),
      ])),
      StatusPill(lbl, color: col),
    ]));
  }

  static String _d(dynamic s) { try { return DateFormat('d MMM', 'fr').format(DateTime.parse(s)); } catch (_) { return '$s'; } }

  void _requestSheet(BuildContext context, WidgetRef ref) {
    DateTime? start, end; final comment = TextEditingController(); String type = 'Congé annuel';
    showModalBottomSheet(context: context, isScrollControlled: true, backgroundColor: Colors.transparent, builder: (ctx) {
      return StatefulBuilder(builder: (ctx, setSt) {
        Future<void> pick(bool isStart) async {
          final d = await showDatePicker(context: ctx, firstDate: DateTime.now(), lastDate: DateTime.now().add(const Duration(days: 365)), initialDate: DateTime.now());
          if (d != null) setSt(() { if (isStart) start = d; else end = d; });
        }
        return Container(
          padding: EdgeInsets.only(bottom: MediaQuery.of(ctx).viewInsets.bottom),
          decoration: BoxDecoration(color: Theme.of(ctx).colorScheme.surface, borderRadius: const BorderRadius.vertical(top: Radius.circular(28))),
          child: Padding(padding: const EdgeInsets.fromLTRB(22, 18, 22, 28), child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Text('Nouvelle demande de congé', style: Theme.of(ctx).textTheme.titleLarge, textAlign: TextAlign.center),
            const SizedBox(height: 18),
            Row(children: [
              Expanded(child: OutlinedButton.icon(onPressed: () => pick(true), icon: const Icon(Icons.calendar_today, size: 16), label: Text(start == null ? 'Début' : _d(start!.toIso8601String())))),
              const SizedBox(width: 12),
              Expanded(child: OutlinedButton.icon(onPressed: () => pick(false), icon: const Icon(Icons.event, size: 16), label: Text(end == null ? 'Fin' : _d(end!.toIso8601String())))),
            ]),
            const SizedBox(height: 12),
            TextField(controller: comment, maxLines: 2, decoration: const InputDecoration(hintText: 'Commentaire (optionnel)')),
            const SizedBox(height: 18),
            FilledButton(onPressed: () async {
              if (start == null || end == null) return;
              try {
                await ref.read(apiClientProvider).post('/me/leave', data: {'type': type, 'start': start!.toIso8601String().substring(0, 10), 'end': end!.toIso8601String().substring(0, 10), 'comment': comment.text});
                if (ctx.mounted) Navigator.pop(ctx);
                ref.invalidate(leaveProvider);
              } catch (e) {
                if (ctx.mounted) ScaffoldMessenger.of(ctx).showSnackBar(SnackBar(content: Text('$e')));
              }
            }, child: const Text('Envoyer la demande')),
          ])),
        );
      });
    });
  }
}
