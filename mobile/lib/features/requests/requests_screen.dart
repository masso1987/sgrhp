import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:image_picker/image_picker.dart';
import 'package:intl/intl.dart';
import '../../core/providers.dart';
import '../../core/theme/app_theme.dart';
import '../../shared/widgets/ui.dart';

final requestsProvider = FutureProvider.autoDispose<List<dynamic>>((ref) async {
  final r = await ref.read(apiClientProvider).get('/me/requests');
  return (r.data as List);
});

String _money(dynamic n) {
  final v = (n is num) ? n : num.tryParse('$n') ?? 0;
  return NumberFormat('#,##0', 'fr').format(v).replaceAll(',', ' ');
}

class RequestsScreen extends ConsumerWidget {
  const RequestsScreen({super.key});
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final a = ref.watch(requestsProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Mes demandes')),
      body: a.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => ErrorView(error: e, onRetry: () async => ref.refresh(requestsProvider.future)),
        data: (list) => RefreshIndicator(
          onRefresh: () async => ref.refresh(requestsProvider.future),
          child: ListView(padding: const EdgeInsets.all(16), children: [
            Row(children: [
              Expanded(child: OutlinedButton.icon(onPressed: () => _sheet(context, ref, 'AVI'), icon: const Icon(Icons.description_outlined), label: const Text('AVI'))),
              const SizedBox(width: 10),
              Expanded(child: OutlinedButton.icon(onPressed: () => _sheet(context, ref, 'ACOMPTE'), icon: const Icon(Icons.payments_outlined), label: const Text('Acompte'))),
            ]),
            const SizedBox(height: 14),
            if (list.isEmpty)
              const Padding(padding: EdgeInsets.symmetric(vertical: 40), child: EmptyState(icon: Icons.inbox_outlined, title: 'Aucune demande', subtitle: 'Vos demandes d\'AVI et d\'acompte apparaîtront ici.')),
            ...list.map((x) => _tile(Map<String, dynamic>.from(x as Map))),
          ]),
        ),
      ),
    );
  }

  Widget _tile(Map<String, dynamic> r) {
    final st = (r['status'] ?? '').toString();
    final pill = st == 'HANDLED'
        ? const StatusPill('Traitée', color: AppColors.success, icon: Icons.check_circle)
        : st == 'REJECTED'
            ? const StatusPill('Rejetée', color: AppColors.danger, icon: Icons.cancel)
            : const StatusPill('En attente', color: AppColors.warning, icon: Icons.schedule);
    final isAcompte = r['type'] == 'ACOMPTE';
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: GlassCard(
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            Expanded(child: Text(isAcompte ? 'Acompte sur salaire' : 'AVI (attestation bancaire)', style: const TextStyle(fontWeight: FontWeight.w700))),
            pill,
          ]),
          if (isAcompte && r['amount'] != null) ...[const SizedBox(height: 4), Text('${_money(r['amount'])} FCFA', style: const TextStyle(fontWeight: FontWeight.w800))],
          if ((r['bank_name'] ?? '').toString().isNotEmpty) Text('Banque : ${r['bank_name']}', style: const TextStyle(color: AppColors.mutedLight, fontSize: 12.5)),
          if ((r['reason'] ?? '').toString().isNotEmpty) Padding(padding: const EdgeInsets.only(top: 4), child: Text(r['reason'].toString(), style: const TextStyle(fontSize: 13))),
          if ((r['decision_note'] ?? '').toString().isNotEmpty) Padding(padding: const EdgeInsets.only(top: 4), child: Text('Réponse : ${r['decision_note']}', style: const TextStyle(color: AppColors.info, fontSize: 12.5))),
          const SizedBox(height: 4),
          Text(_date(r['created_at']), style: const TextStyle(color: AppColors.mutedLight, fontSize: 11.5)),
        ]),
      ),
    );
  }

  static String _date(dynamic iso) {
    try { return DateFormat('d MMM yyyy', 'fr').format(DateTime.parse(iso).toLocal()); } catch (_) { return ''; }
  }

  Future<void> _sheet(BuildContext context, WidgetRef ref, String type) {
    return showModalBottomSheet(context: context, isScrollControlled: true, showDragHandle: true, builder: (_) => _RequestForm(type: type));
  }
}

class _RequestForm extends ConsumerStatefulWidget {
  final String type; // 'AVI' | 'ACOMPTE'
  const _RequestForm({required this.type});
  @override
  ConsumerState<_RequestForm> createState() => _RequestFormState();
}

class _RequestFormState extends ConsumerState<_RequestForm> {
  final _bank = TextEditingController();
  final _reason = TextEditingController();
  final _amount = TextEditingController();
  final _picker = ImagePicker();
  XFile? _letter;
  bool _busy = false;
  String? _error;

  @override
  void dispose() { _bank.dispose(); _reason.dispose(); _amount.dispose(); super.dispose(); }

  Future<void> _pickLetter() async {
    final x = await _picker.pickImage(source: ImageSource.gallery, imageQuality: 75);
    if (x != null) setState(() => _letter = x);
  }

  Future<void> _submit() async {
    setState(() { _busy = true; _error = null; });
    try {
      final api = ref.read(apiClientProvider);
      if (widget.type == 'AVI') {
        if (_letter == null) { setState(() { _error = 'Joignez la lettre manuscrite (photo).'; _busy = false; }); return; }
        final fd = FormData.fromMap({'bankName': _bank.text.trim(), 'reason': _reason.text.trim()});
        fd.files.add(MapEntry('letter', await MultipartFile.fromFile(_letter!.path, filename: _letter!.name)));
        await api.postMultipart('/me/requests/avi', fd);
      } else {
        final amt = int.tryParse(_amount.text.replaceAll(RegExp(r'[^0-9]'), '')) ?? 0;
        if (amt <= 0) { setState(() { _error = 'Montant invalide.'; _busy = false; }); return; }
        await api.post('/me/requests/acompte', data: {'amount': amt, 'reason': _reason.text.trim()});
      }
      ref.invalidate(requestsProvider);
      if (mounted) {
        Navigator.pop(context);
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Demande envoyée au GPF.')));
      }
    } catch (e) {
      setState(() { _error = e.toString(); _busy = false; });
    }
  }

  @override
  Widget build(BuildContext context) {
    final isAvi = widget.type == 'AVI';
    return Padding(
      padding: EdgeInsets.fromLTRB(20, 4, 20, MediaQuery.of(context).viewInsets.bottom + 20),
      child: SingleChildScrollView(
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Text(isAvi ? 'Demande d\'AVI' : 'Demande d\'acompte', style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 18)),
          const SizedBox(height: 14),
          if (isAvi) ...[
            TextField(controller: _bank, decoration: const InputDecoration(labelText: 'Banque (optionnel)')),
            const SizedBox(height: 10),
            TextField(controller: _reason, maxLines: 2, decoration: const InputDecoration(labelText: 'Objet / motif (optionnel)')),
            const SizedBox(height: 12),
            const Text('Joignez la lettre de demande manuscrite (photo ou scan).', style: TextStyle(color: AppColors.mutedLight, fontSize: 12.5)),
            const SizedBox(height: 8),
            Row(children: [
              Icon(_letter != null ? Icons.check_circle_rounded : Icons.attach_file_rounded, size: 18, color: _letter != null ? AppColors.success : AppColors.mutedLight),
              const SizedBox(width: 8),
              Expanded(child: Text(_letter != null ? _letter!.name : 'Aucun fichier', maxLines: 1, overflow: TextOverflow.ellipsis)),
              TextButton(onPressed: _pickLetter, child: Text(_letter != null ? 'Changer' : 'Joindre')),
            ]),
          ] else ...[
            TextField(controller: _amount, keyboardType: TextInputType.number, inputFormatters: [FilteringTextInputFormatter.digitsOnly],
                decoration: const InputDecoration(labelText: 'Montant demandé (FCFA)')),
            const SizedBox(height: 10),
            TextField(controller: _reason, maxLines: 2, decoration: const InputDecoration(labelText: 'Motif (optionnel)')),
          ],
          if (_error != null) Padding(padding: const EdgeInsets.only(top: 10), child: Text(_error!, style: const TextStyle(color: AppColors.danger))),
          const SizedBox(height: 16),
          FilledButton(
            onPressed: _busy ? null : _submit,
            child: _busy ? const SizedBox(height: 20, width: 20, child: CircularProgressIndicator(strokeWidth: 2.4, color: Colors.white)) : const Text('Envoyer au GPF'),
          ),
        ]),
      ),
    );
  }
}
