import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../core/providers.dart';
import '../../core/theme/app_theme.dart';
import '../../shared/widgets/ui.dart';

final surveysProvider = FutureProvider.autoDispose<List<dynamic>>((ref) async {
  final r = await ref.read(apiClientProvider).get('/me/surveys');
  return (r.data as List);
});

class SurveysScreen extends ConsumerWidget {
  const SurveysScreen({super.key});
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final a = ref.watch(surveysProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Enquêtes & évaluations')),
      body: a.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => ErrorView(error: e, onRetry: () async => ref.refresh(surveysProvider.future)),
        data: (list) {
          if (list.isEmpty) {
            return const EmptyState(icon: Icons.fact_check_outlined, title: 'Aucune enquête', subtitle: 'Les enquêtes de satisfaction apparaîtront ici.');
          }
          return RefreshIndicator(
            onRefresh: () async => ref.refresh(surveysProvider.future),
            child: ListView.separated(
              padding: const EdgeInsets.all(16),
              itemCount: list.length,
              separatorBuilder: (_, __) => const SizedBox(height: 10),
              itemBuilder: (_, i) {
                final s = Map<String, dynamic>.from(list[i] as Map);
                return GlassCard(
                  onTap: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => SurveyFormScreen(survey: s))),
                  child: Row(children: [
                    const Icon(Icons.poll_outlined, color: AppColors.brand),
                    const SizedBox(width: 12),
                    Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Text(s['title']?.toString() ?? 'Enquête', style: const TextStyle(fontWeight: FontWeight.w700)),
                      if ((s['intro'] ?? '').toString().isNotEmpty)
                        Padding(padding: const EdgeInsets.only(top: 2), child: Text(s['intro'].toString(), maxLines: 2, overflow: TextOverflow.ellipsis, style: const TextStyle(color: AppColors.mutedLight, fontSize: 12.5))),
                    ])),
                    const Icon(Icons.chevron_right_rounded, color: AppColors.mutedLight),
                  ]),
                );
              },
            ),
          );
        },
      ),
    );
  }
}

class SurveyFormScreen extends ConsumerStatefulWidget {
  final Map<String, dynamic> survey;
  const SurveyFormScreen({super.key, required this.survey});
  @override
  ConsumerState<SurveyFormScreen> createState() => _SurveyFormScreenState();
}

class _SurveyFormScreenState extends ConsumerState<SurveyFormScreen> {
  final Map<String, dynamic> _answers = {};
  final _comment = TextEditingController();
  bool _anonymous = false;
  bool _busy = false;
  String? _error;

  @override
  void dispose() { _comment.dispose(); super.dispose(); }

  Future<void> _submit() async {
    setState(() { _busy = true; _error = null; });
    try {
      await ref.read(apiClientProvider).post('/me/surveys/${widget.survey['token']}/respond',
          data: {'answers': _answers, 'comment': _comment.text.trim(), 'anonymous': _anonymous});
      ref.invalidate(surveysProvider);
      if (mounted) {
        Navigator.pop(context);
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Merci ! Votre réponse a été enregistrée.')));
      }
    } catch (e) {
      setState(() { _error = e.toString(); _busy = false; });
    }
  }

  @override
  Widget build(BuildContext context) {
    final max = (widget.survey['scale_max'] is num) ? (widget.survey['scale_max'] as num).toInt() : 5;
    final questions = (widget.survey['questions'] as List?) ?? const [];
    return Scaffold(
      appBar: AppBar(title: Text(widget.survey['title']?.toString() ?? 'Enquête')),
      body: ListView(padding: const EdgeInsets.all(18), children: [
        if ((widget.survey['intro'] ?? '').toString().isNotEmpty)
          Padding(padding: const EdgeInsets.only(bottom: 12), child: Text(widget.survey['intro'].toString(), style: const TextStyle(color: AppColors.mutedLight))),
        ...questions.map((q) => _question(Map<String, dynamic>.from(q as Map), max)),
        const SizedBox(height: 8),
        TextField(controller: _comment, maxLines: 3, decoration: const InputDecoration(labelText: 'Commentaire (optionnel)')),
        const SizedBox(height: 10),
        SwitchListTile(
          contentPadding: EdgeInsets.zero,
          title: const Text('Réponse anonyme'),
          value: _anonymous,
          onChanged: (v) => setState(() => _anonymous = v),
        ),
        if (_error != null) Padding(padding: const EdgeInsets.only(bottom: 10), child: Text(_error!, style: const TextStyle(color: AppColors.danger))),
        FilledButton(
          onPressed: _busy ? null : _submit,
          child: _busy ? const SizedBox(height: 20, width: 20, child: CircularProgressIndicator(strokeWidth: 2.4, color: Colors.white)) : const Text('Envoyer mon évaluation'),
        ),
      ]),
    );
  }

  Widget _question(Map<String, dynamic> q, int max) {
    final id = q['id'].toString();
    final label = q['label']?.toString() ?? '';
    if (q['kind'] == 'rating') {
      return Padding(
        padding: const EdgeInsets.only(bottom: 16),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(label, style: const TextStyle(fontWeight: FontWeight.w600)),
          const SizedBox(height: 8),
          Wrap(spacing: 8, children: List.generate(max, (i) {
            final v = i + 1;
            final sel = _answers[id] == v;
            return ChoiceChip(
              label: Text('$v'),
              selected: sel,
              onSelected: (_) => setState(() => _answers[id] = v),
              selectedColor: AppColors.brand,
              labelStyle: TextStyle(color: sel ? Colors.white : null, fontWeight: FontWeight.w700),
            );
          })),
        ]),
      );
    }
    return Padding(
      padding: const EdgeInsets.only(bottom: 16),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text(label, style: const TextStyle(fontWeight: FontWeight.w600)),
        const SizedBox(height: 6),
        TextField(
          maxLines: 2,
          decoration: const InputDecoration(hintText: 'Votre réponse'),
          onChanged: (t) => _answers[id] = t,
        ),
      ]),
    );
  }
}
