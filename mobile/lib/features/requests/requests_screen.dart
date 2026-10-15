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
            const SizedBox(height: 10),
            SizedBox(
              width: double.infinity,
              child: OutlinedButton.icon(
                onPressed: () => _permissionSheet(context, ref),
                icon: const Icon(Icons.event_busy_outlined),
                label: const Text('Demande de permission / absence'),
              ),
            ),
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

  Future<void> _permissionSheet(BuildContext context, WidgetRef ref) {
    return showModalBottomSheet(context: context, isScrollControlled: true, showDragHandle: true, builder: (_) => const _PermissionForm());
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
  Map<String, dynamic>? _window;

  @override
  void initState() {
    super.initState();
    if (widget.type == 'ACOMPTE') _loadWindow();
  }

  Future<void> _loadWindow() async {
    try {
      final r = await ref.read(apiClientProvider).get('/me/acompte-window');
      if (mounted) setState(() => _window = Map<String, dynamic>.from(r.data as Map));
    } catch (_) {}
  }

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
            if (_window != null) ...[
              Row(children: [
                const Icon(Icons.calendar_month_rounded, size: 16, color: AppColors.mutedLight),
                const SizedBox(width: 6),
                Text('Mois : ${_window!['period'] ?? ''}', style: const TextStyle(color: AppColors.mutedLight, fontSize: 12.5)),
              ]),
              if (_window!['open'] != true)
                Padding(
                  padding: const EdgeInsets.only(top: 8),
                  child: Text('Période fermée : les acomptes ne sont acceptés que du 1er au ${_window!['deadline_day']} du mois.',
                      style: const TextStyle(color: AppColors.danger, fontSize: 12.5)),
                ),
              const SizedBox(height: 10),
            ],
            TextField(controller: _amount, keyboardType: TextInputType.number, inputFormatters: [FilteringTextInputFormatter.digitsOnly],
                decoration: const InputDecoration(labelText: 'Montant demandé (FCFA)')),
            const SizedBox(height: 10),
            TextField(controller: _reason, maxLines: 2, decoration: const InputDecoration(labelText: 'Motif (optionnel)')),
          ],
          if (_error != null) Padding(padding: const EdgeInsets.only(top: 10), child: Text(_error!, style: const TextStyle(color: AppColors.danger))),
          const SizedBox(height: 16),
          FilledButton(
            onPressed: (_busy || (widget.type == 'ACOMPTE' && _window != null && _window!['open'] != true)) ? null : _submit,
            child: _busy ? const SizedBox(height: 20, width: 20, child: CircularProgressIndicator(strokeWidth: 2.4, color: Colors.white)) : const Text('Envoyer au GPF'),
          ),
        ]),
      ),
    );
  }
}

/// Demande de permission / absence. Types et champs sont configurés côté admin
/// (/me/permission-types). La demande crée un document de congé qui part dans le
/// circuit de validation (notification web). Suivi sous l'onglet « Congés ».
class _PermissionForm extends ConsumerStatefulWidget {
  const _PermissionForm();
  @override
  ConsumerState<_PermissionForm> createState() => _PermissionFormState();
}

class _PermissionFormState extends ConsumerState<_PermissionForm> {
  List<dynamic> _types = [];
  Map<String, dynamic>? _type; // selected type
  DateTime? _start, _end;
  final _reason = TextEditingController();
  final Map<String, TextEditingController> _fieldCtl = {};
  final Map<String, String?> _fieldSel = {}; // for select fields
  bool _loading = true, _busy = false;
  String? _error;

  @override
  void initState() { super.initState(); _load(); }

  Future<void> _load() async {
    try {
      final r = await ref.read(apiClientProvider).get('/me/permission-types');
      _types = (r.data as List);
      if (_types.isNotEmpty) _selectType(Map<String, dynamic>.from(_types.first as Map));
    } catch (e) { _error = '$e'; }
    if (mounted) setState(() => _loading = false);
  }

  void _selectType(Map<String, dynamic> t) {
    _type = t;
    _fieldCtl.clear(); _fieldSel.clear();
    for (final f in (t['fields'] as List? ?? [])) {
      final key = (f['key'] ?? '').toString();
      if ((f['type'] ?? 'text') == 'select') {
        final opts = (f['options'] as List? ?? []);
        _fieldSel[key] = opts.isNotEmpty ? opts.first.toString() : null;
      } else {
        _fieldCtl[key] = TextEditingController();
      }
    }
  }

  @override
  void dispose() {
    _reason.dispose();
    for (final c in _fieldCtl.values) { c.dispose(); }
    super.dispose();
  }

  int get _days {
    if (_start == null || _end == null) return 0;
    return _end!.difference(_start!).inDays + 1;
  }

  Future<void> _pickDate(bool start) async {
    final now = DateTime.now();
    final init = start ? (_start ?? now) : (_end ?? _start ?? now);
    final d = await showDatePicker(
      context: context,
      initialDate: init,
      firstDate: DateTime(now.year - 1),
      lastDate: DateTime(now.year + 2),
      locale: const Locale('fr'),
    );
    if (d == null) return;
    setState(() {
      if (start) { _start = d; if (_end != null && _end!.isBefore(d)) _end = d; }
      else { _end = d; }
    });
  }

  Future<void> _submit() async {
    if (_type == null) { setState(() => _error = 'Choisissez un type de permission.'); return; }
    if (_start == null || _end == null) { setState(() => _error = 'Indiquez les dates de début et de fin.'); return; }
    // Required custom fields
    for (final f in (_type!['fields'] as List? ?? [])) {
      if (f['required'] == true) {
        final key = (f['key'] ?? '').toString();
        final v = (f['type'] ?? 'text') == 'select' ? _fieldSel[key] : _fieldCtl[key]?.text.trim();
        if (v == null || v.isEmpty) { setState(() => _error = 'Champ requis : ${f['label']}'); return; }
      }
    }
    setState(() { _busy = true; _error = null; });
    try {
      final values = <String, dynamic>{};
      for (final f in (_type!['fields'] as List? ?? [])) {
        final key = (f['key'] ?? '').toString();
        values[key] = (f['type'] ?? 'text') == 'select' ? _fieldSel[key] : _fieldCtl[key]?.text.trim();
      }
      await ref.read(apiClientProvider).post('/me/permission', data: {
        'typeId': _type!['id'],
        'start': _start!.toIso8601String().slice10(),
        'end': _end!.toIso8601String().slice10(),
        'reason': _reason.text.trim(),
        'values': values,
      });
      ref.invalidate(requestsProvider);
      if (mounted) {
        Navigator.pop(context);
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Demande de permission envoyée pour validation.')));
      }
    } catch (e) {
      setState(() { _error = e.toString(); _busy = false; });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.fromLTRB(20, 4, 20, MediaQuery.of(context).viewInsets.bottom + 20),
      child: SingleChildScrollView(
        child: _loading
            ? const Padding(padding: EdgeInsets.all(40), child: Center(child: CircularProgressIndicator()))
            : _types.isEmpty
                ? const Padding(
                    padding: EdgeInsets.symmetric(vertical: 30),
                    child: EmptyState(icon: Icons.event_busy_outlined, title: 'Aucun type de permission', subtitle: "Votre administrateur n'a pas encore configuré de types de permission."),
                  )
                : Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                    const Text('Demande de permission', style: TextStyle(fontWeight: FontWeight.w800, fontSize: 18)),
                    const SizedBox(height: 14),
                    const Text('Type', style: TextStyle(fontWeight: FontWeight.w600)),
                    const SizedBox(height: 6),
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 14),
                      decoration: BoxDecoration(color: Theme.of(context).inputDecorationTheme.fillColor, borderRadius: BorderRadius.circular(AppRadius.md)),
                      child: DropdownButtonHideUnderline(
                        child: DropdownButton<String>(
                          isExpanded: true,
                          value: _type?['id'] as String?,
                          items: _types.map<DropdownMenuItem<String>>((t) {
                            final m = Map<String, dynamic>.from(t as Map);
                            return DropdownMenuItem(value: m['id'] as String, child: Text(m['label']?.toString() ?? ''));
                          }).toList(),
                          onChanged: (v) {
                            final m = _types.map((e) => Map<String, dynamic>.from(e as Map)).firstWhere((e) => e['id'] == v);
                            setState(() => _selectType(m));
                          },
                        ),
                      ),
                    ),
                    if (_type != null && _type!['deductible'] == true)
                      const Padding(padding: EdgeInsets.only(top: 6), child: Text('Déductible du solde de congés.', style: TextStyle(color: AppColors.warning, fontSize: 12))),
                    const SizedBox(height: 12),
                    Row(children: [
                      Expanded(child: _dateField('Du', _start, () => _pickDate(true))),
                      const SizedBox(width: 10),
                      Expanded(child: _dateField('Au', _end, () => _pickDate(false))),
                    ]),
                    if (_days > 0) Padding(padding: const EdgeInsets.only(top: 6), child: Text('$_days jour${_days > 1 ? 's' : ''}', style: const TextStyle(color: AppColors.mutedLight, fontSize: 12.5))),
                    const SizedBox(height: 12),
                    ..._dynamicFields(),
                    TextField(controller: _reason, maxLines: 2, decoration: const InputDecoration(labelText: 'Motif (optionnel)')),
                    if (_error != null) Padding(padding: const EdgeInsets.only(top: 10), child: Text(_error!, style: const TextStyle(color: AppColors.danger))),
                    const SizedBox(height: 16),
                    FilledButton(
                      onPressed: _busy ? null : _submit,
                      child: _busy ? const SizedBox(height: 20, width: 20, child: CircularProgressIndicator(strokeWidth: 2.4, color: Colors.white)) : const Text('Envoyer pour validation'),
                    ),
                  ]),
      ),
    );
  }

  List<Widget> _dynamicFields() {
    final out = <Widget>[];
    for (final raw in (_type?['fields'] as List? ?? [])) {
      final f = Map<String, dynamic>.from(raw as Map);
      final key = (f['key'] ?? '').toString();
      final label = (f['label'] ?? key).toString() + (f['required'] == true ? ' *' : '');
      final type = (f['type'] ?? 'text').toString();
      if (type == 'select') {
        final opts = (f['options'] as List? ?? []);
        out.add(Padding(
          padding: const EdgeInsets.only(bottom: 10),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(label, style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 13)),
            const SizedBox(height: 4),
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 14),
              decoration: BoxDecoration(color: Theme.of(context).inputDecorationTheme.fillColor, borderRadius: BorderRadius.circular(AppRadius.md)),
              child: DropdownButtonHideUnderline(
                child: DropdownButton<String>(
                  isExpanded: true,
                  value: _fieldSel[key],
                  items: opts.map<DropdownMenuItem<String>>((o) => DropdownMenuItem(value: o.toString(), child: Text(o.toString()))).toList(),
                  onChanged: (v) => setState(() => _fieldSel[key] = v),
                ),
              ),
            ),
          ]),
        ));
      } else {
        out.add(Padding(
          padding: const EdgeInsets.only(bottom: 10),
          child: TextField(
            controller: _fieldCtl[key],
            keyboardType: type == 'number' ? TextInputType.number : TextInputType.text,
            inputFormatters: type == 'number' ? [FilteringTextInputFormatter.digitsOnly] : null,
            decoration: InputDecoration(labelText: label),
          ),
        ));
      }
    }
    return out;
  }

  Widget _dateField(String label, DateTime? v, VoidCallback onTap) => InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(AppRadius.md),
        child: InputDecorator(
          decoration: InputDecoration(labelText: label),
          child: Text(v == null ? 'Choisir' : DateFormat('d MMM yyyy', 'fr').format(v),
              style: TextStyle(color: v == null ? AppColors.mutedLight : null)),
        ),
      );
}

extension _Slice on String {
  String slice10() => length >= 10 ? substring(0, 10) : this;
}
