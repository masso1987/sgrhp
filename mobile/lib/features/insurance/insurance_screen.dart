import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:image_picker/image_picker.dart';
import 'package:intl/intl.dart';
import 'package:url_launcher/url_launcher.dart';
import '../../core/providers.dart';
import '../../core/theme/app_theme.dart';
import '../../shared/widgets/ui.dart';

/* ------------------------- providers ------------------------- */
final insuranceProvider = FutureProvider.autoDispose<Map<String, dynamic>>((ref) async {
  final r = await ref.read(apiClientProvider).get('/me/insurance');
  return Map<String, dynamic>.from(r.data as Map);
});
final consumptionProvider = FutureProvider.autoDispose<Map<String, dynamic>>((ref) async {
  final r = await ref.read(apiClientProvider).get('/me/insurance/consumption');
  return Map<String, dynamic>.from(r.data as Map);
});
final networkProvider = FutureProvider.autoDispose.family<List<dynamic>, String>((ref, q) async {
  final r = await ref.read(apiClientProvider).get('/me/insurance/network', query: q.isEmpty ? null : {'q': q});
  return (r.data as List);
});

String _money(dynamic n) {
  final v = (n is num) ? n : num.tryParse('$n') ?? 0;
  return NumberFormat('#,##0', 'fr').format(v).replaceAll(',', ' ');
}

/* ------------------------- home (tabs) ------------------------- */
class InsuranceHomeScreen extends StatelessWidget {
  const InsuranceHomeScreen({super.key});
  @override
  Widget build(BuildContext context) {
    return DefaultTabController(
      length: 3,
      child: Scaffold(
        appBar: AppBar(
          title: const Text('Assurance maladie'),
          bottom: const TabBar(tabs: [
            Tab(text: 'Couverture'),
            Tab(text: 'Réseau'),
            Tab(text: 'Soins'),
          ]),
        ),
        body: const TabBarView(children: [_CoverageTab(), _NetworkTab(), _ConsumptionTab()]),
      ),
    );
  }
}

/* ------------------------- coverage + dependents ------------------------- */
class _CoverageTab extends ConsumerWidget {
  const _CoverageTab();
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final a = ref.watch(insuranceProvider);
    return a.when(
      loading: () => const Center(child: CircularProgressIndicator()),
      error: (e, _) => ErrorView(error: e, onRetry: () async => ref.refresh(insuranceProvider.future)),
      data: (d) {
        if (d['covered'] != true) {
          return const EmptyState(
            icon: Icons.health_and_safety_outlined,
            title: "Pas de couverture active",
            subtitle: "Votre portefeuille n'a pas d'assurance maladie configurée. Contactez votre gestionnaire (GPF).",
          );
        }
        final company = d['company'] as Map?;
        final deps = (d['dependents'] as List?) ?? const [];
        final canSpouse = d['can_add_spouse'] == true;
        final canChild = d['can_add_child'] == true;
        return RefreshIndicator(
          onRefresh: () async => ref.refresh(insuranceProvider.future),
          child: ListView(padding: const EdgeInsets.all(18), children: [
            GlassCard(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Row(children: [
                  const Icon(Icons.verified_user_rounded, color: AppColors.success, size: 20),
                  const SizedBox(width: 8),
                  const Expanded(child: Text('Vous êtes couvert', style: TextStyle(fontWeight: FontWeight.w800, fontSize: 16))),
                  if (d['coverage_pct'] != null)
                    StatusPill('${d['coverage_pct']}%', color: AppColors.brand, icon: Icons.percent_rounded),
                ]),
                if (company != null) ...[
                  const SizedBox(height: 14),
                  Row(children: [
                    const Icon(Icons.business_rounded, size: 18, color: AppColors.mutedLight),
                    const SizedBox(width: 8),
                    Expanded(child: Text(company['name']?.toString() ?? '', style: const TextStyle(fontWeight: FontWeight.w600))),
                    if ((company['phone'] ?? '').toString().isNotEmpty)
                      IconButton(
                        icon: const Icon(Icons.call_rounded, color: AppColors.brand),
                        onPressed: () => _dial(company['phone'].toString()),
                      ),
                  ]),
                ],
                const SizedBox(height: 6),
                Text('Enfants pris en charge : ${d['active_children'] ?? 0} / ${d['free_children'] ?? 0} gratuits',
                    style: const TextStyle(color: AppColors.mutedLight, fontSize: 12.5)),
              ]),
            ),
            const SectionHeader('Ayants droit'),
            if (deps.isEmpty)
              const Padding(padding: EdgeInsets.symmetric(vertical: 24), child: EmptyState(icon: Icons.group_outlined, title: 'Aucun ayant droit')),
            ...deps.map((x) => _depTile(Map<String, dynamic>.from(x as Map))),
            const SizedBox(height: 16),
            if (canSpouse || canChild)
              FilledButton.icon(
                onPressed: () => _openRequest(context, ref, canSpouse: canSpouse, canChild: canChild),
                icon: const Icon(Icons.person_add_alt_rounded),
                label: const Text('Demander l\'ajout d\'un ayant droit'),
              ),
          ]),
        );
      },
    );
  }

  Widget _depTile(Map<String, dynamic> d) {
    final rel = d['relation'] == 'SPOUSE' ? 'Conjoint' : 'Enfant';
    final st = (d['status'] ?? '').toString();
    final statusPill = st == 'ACTIVE'
        ? const StatusPill('Actif', color: AppColors.success, icon: Icons.check_circle)
        : st == 'PENDING'
            ? const StatusPill('En attente', color: AppColors.warning, icon: Icons.schedule)
            : const StatusPill('Rejeté', color: AppColors.danger, icon: Icons.cancel);
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: GlassCard(
        child: Row(children: [
          Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('${d['first_name'] ?? ''} ${d['last_name'] ?? ''}'.trim(), style: const TextStyle(fontWeight: FontWeight.w700)),
            const SizedBox(height: 2),
            Text(rel + (d['extra'] == true ? ' · supplémentaire (payant)' : ''),
                style: const TextStyle(color: AppColors.mutedLight, fontSize: 12.5)),
            if (st == 'REJECTED' && (d['note'] ?? '').toString().isNotEmpty)
              Padding(padding: const EdgeInsets.only(top: 4), child: Text('Motif : ${d['note']}', style: const TextStyle(color: AppColors.danger, fontSize: 12))),
          ]),
          const Spacer(),
          statusPill,
        ]),
      ),
    );
  }
}

Future<void> _dial(String phone) async {
  final uri = Uri(scheme: 'tel', path: phone.replaceAll(' ', ''));
  if (await canLaunchUrl(uri)) await launchUrl(uri);
}

Future<void> _openRequest(BuildContext context, WidgetRef ref, {required bool canSpouse, required bool canChild}) {
  return showModalBottomSheet(
    context: context,
    isScrollControlled: true,
    showDragHandle: true,
    builder: (_) => _RequestSheet(canSpouse: canSpouse, canChild: canChild),
  );
}

/* ------------------------- request sheet ------------------------- */
class _RequestSheet extends ConsumerStatefulWidget {
  final bool canSpouse, canChild;
  const _RequestSheet({required this.canSpouse, required this.canChild});
  @override
  ConsumerState<_RequestSheet> createState() => _RequestSheetState();
}

class _RequestSheetState extends ConsumerState<_RequestSheet> {
  late String _relation = widget.canChild ? 'CHILD' : 'SPOUSE';
  final _first = TextEditingController();
  final _last = TextEditingController();
  final _place = TextEditingController();
  DateTime? _birth;
  final _picker = ImagePicker();
  final Map<String, XFile> _files = {}; // fieldName -> file
  bool _busy = false;
  String? _error;

  @override
  void dispose() { _first.dispose(); _last.dispose(); _place.dispose(); super.dispose(); }

  Future<void> _pick(String field) async {
    final x = await _picker.pickImage(source: ImageSource.gallery, imageQuality: 70);
    if (x != null) setState(() => _files[field] = x);
  }

  Future<void> _submit() async {
    if (_first.text.trim().isEmpty || _last.text.trim().isEmpty) { setState(() => _error = 'Nom et prénom requis.'); return; }
    setState(() { _busy = true; _error = null; });
    try {
      final fd = FormData.fromMap({
        'relation': _relation,
        'firstName': _first.text.trim(),
        'lastName': _last.text.trim(),
        'birthDate': _birth != null ? DateFormat('yyyy-MM-dd').format(_birth!) : '',
        'birthPlace': _place.text.trim(),
      });
      for (final e in _files.entries) {
        fd.files.add(MapEntry(e.key, await MultipartFile.fromFile(e.value.path, filename: e.value.name)));
      }
      await ref.read(apiClientProvider).postMultipart('/me/insurance/dependent-request', fd);
      ref.invalidate(insuranceProvider);
      if (mounted) {
        Navigator.pop(context);
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Demande envoyée. Le GPF la validera.')));
      }
    } catch (e) {
      setState(() => _error = e.toString());
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final isSpouse = _relation == 'SPOUSE';
    return Padding(
      padding: EdgeInsets.fromLTRB(20, 4, 20, MediaQuery.of(context).viewInsets.bottom + 20),
      child: SingleChildScrollView(
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          const Text('Nouvel ayant droit', style: TextStyle(fontWeight: FontWeight.w800, fontSize: 18)),
          const SizedBox(height: 14),
          if (widget.canSpouse && widget.canChild)
            SegmentedButton<String>(
              segments: const [
                ButtonSegment(value: 'CHILD', label: Text('Enfant'), icon: Icon(Icons.child_care_rounded)),
                ButtonSegment(value: 'SPOUSE', label: Text('Conjoint'), icon: Icon(Icons.favorite_rounded)),
              ],
              selected: {_relation},
              onSelectionChanged: (s) => setState(() => _relation = s.first),
            ),
          const SizedBox(height: 14),
          TextField(controller: _first, decoration: const InputDecoration(labelText: 'Prénom')),
          const SizedBox(height: 10),
          TextField(controller: _last, decoration: const InputDecoration(labelText: 'Nom')),
          const SizedBox(height: 10),
          InkWell(
            onTap: () async {
              final d = await showDatePicker(context: context, initialDate: DateTime(2000), firstDate: DateTime(1940), lastDate: DateTime.now());
              if (d != null) setState(() => _birth = d);
            },
            child: InputDecorator(
              decoration: const InputDecoration(labelText: 'Date de naissance'),
              child: Text(_birth != null ? DateFormat('d MMMM yyyy', 'fr').format(_birth!) : 'Choisir une date',
                  style: TextStyle(color: _birth != null ? null : AppColors.mutedLight)),
            ),
          ),
          const SizedBox(height: 10),
          TextField(controller: _place, decoration: const InputDecoration(labelText: 'Lieu de naissance')),
          const SizedBox(height: 16),
          Text(isSpouse ? 'Pièces à joindre : certificat de mariage + acte de naissance.' : 'Pièces à joindre : acte de naissance + photo 4×4.',
              style: const TextStyle(color: AppColors.mutedLight, fontSize: 12.5)),
          const SizedBox(height: 8),
          _fileRow('Acte de naissance', 'birthCert'),
          if (isSpouse) _fileRow('Certificat de mariage', 'marriageCert') else _fileRow('Photo 4×4', 'photo'),
          if (_error != null) Padding(padding: const EdgeInsets.only(top: 10), child: Text(_error!, style: const TextStyle(color: AppColors.danger))),
          const SizedBox(height: 16),
          FilledButton(
            onPressed: _busy ? null : _submit,
            child: _busy ? const SizedBox(height: 20, width: 20, child: CircularProgressIndicator(strokeWidth: 2.4, color: Colors.white)) : const Text('Envoyer la demande'),
          ),
        ]),
      ),
    );
  }

  Widget _fileRow(String label, String field) {
    final f = _files[field];
    return Padding(
      padding: const EdgeInsets.only(top: 8),
      child: Row(children: [
        Icon(f != null ? Icons.check_circle_rounded : Icons.attach_file_rounded, size: 18, color: f != null ? AppColors.success : AppColors.mutedLight),
        const SizedBox(width: 8),
        Expanded(child: Text(f != null ? (f.name) : label, maxLines: 1, overflow: TextOverflow.ellipsis)),
        TextButton(onPressed: () => _pick(field), child: Text(f != null ? 'Changer' : 'Joindre')),
      ]),
    );
  }
}

/* ------------------------- network ------------------------- */
class _NetworkTab extends ConsumerStatefulWidget {
  const _NetworkTab();
  @override
  ConsumerState<_NetworkTab> createState() => _NetworkTabState();
}

class _NetworkTabState extends ConsumerState<_NetworkTab> {
  String _q = '';
  final _ctrl = TextEditingController();
  @override
  void dispose() { _ctrl.dispose(); super.dispose(); }

  @override
  Widget build(BuildContext context) {
    final a = ref.watch(networkProvider(_q));
    return Column(children: [
      Padding(
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 8),
        child: TextField(
          controller: _ctrl,
          decoration: InputDecoration(
            hintText: 'Rechercher (nom, ville, adresse)',
            prefixIcon: const Icon(Icons.search_rounded),
            suffixIcon: _q.isNotEmpty ? IconButton(icon: const Icon(Icons.clear), onPressed: () { _ctrl.clear(); setState(() => _q = ''); }) : null,
          ),
          textInputAction: TextInputAction.search,
          onSubmitted: (v) => setState(() => _q = v.trim()),
        ),
      ),
      Expanded(
        child: a.when(
          loading: () => const Center(child: CircularProgressIndicator()),
          error: (e, _) => ErrorView(error: e, onRetry: () async => ref.refresh(networkProvider(_q).future)),
          data: (list) {
            if (list.isEmpty) {
              return const EmptyState(icon: Icons.local_hospital_outlined, title: 'Aucun établissement', subtitle: 'Le réseau de votre assurance n\'est pas encore disponible.');
            }
            return ListView.separated(
              padding: const EdgeInsets.all(16),
              itemCount: list.length,
              separatorBuilder: (_, __) => const SizedBox(height: 10),
              itemBuilder: (_, i) => _netCard(Map<String, dynamic>.from(list[i] as Map)),
            );
          },
        ),
      ),
    ]);
  }

  Widget _netCard(Map<String, dynamic> n) {
    final phone = (n['phone'] ?? '').toString();
    final address = (n['address'] ?? '').toString();
    final ville = (n['ville'] ?? '').toString();
    return GlassCard(
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Expanded(child: Text(n['name']?.toString() ?? '', style: const TextStyle(fontWeight: FontWeight.w700))),
          if ((n['category'] ?? '').toString().isNotEmpty)
            StatusPill(n['category'].toString(), color: AppColors.info),
        ]),
        const SizedBox(height: 4),
        Text([n['type'], ville, n['region']].where((x) => (x ?? '').toString().isNotEmpty).join(' · '),
            style: const TextStyle(color: AppColors.mutedLight, fontSize: 12.5)),
        if (address.isNotEmpty) ...[
          const SizedBox(height: 8),
          InkWell(
            onTap: () => _openMaps(address, ville),
            child: Row(children: [
              const Icon(Icons.place_rounded, size: 18, color: AppColors.brand),
              const SizedBox(width: 6),
              Expanded(child: Text(address, style: const TextStyle(color: AppColors.brand, decoration: TextDecoration.underline))),
            ]),
          ),
        ],
        if (phone.isNotEmpty) ...[
          const SizedBox(height: 6),
          InkWell(
            onTap: () => _dial(phone),
            child: Row(children: [
              const Icon(Icons.call_rounded, size: 18, color: AppColors.brand),
              const SizedBox(width: 6),
              Text(phone, style: const TextStyle(color: AppColors.brand)),
            ]),
          ),
        ],
      ]),
    );
  }

  Future<void> _openMaps(String address, String ville) async {
    final q = Uri.encodeComponent([address, ville].where((x) => x.isNotEmpty).join(', '));
    final uri = Uri.parse('https://www.google.com/maps/search/?api=1&query=$q');
    if (await canLaunchUrl(uri)) await launchUrl(uri, mode: LaunchMode.externalApplication);
  }
}

/* ------------------------- consumption ------------------------- */
class _ConsumptionTab extends ConsumerWidget {
  const _ConsumptionTab();
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final a = ref.watch(consumptionProvider);
    return a.when(
      loading: () => const Center(child: CircularProgressIndicator()),
      error: (e, _) => ErrorView(error: e, onRetry: () async => ref.refresh(consumptionProvider.future)),
      data: (d) {
        final items = (d['items'] as List?) ?? const [];
        final totals = Map<String, dynamic>.from(d['totals'] ?? {});
        if (items.isEmpty) {
          return const EmptyState(icon: Icons.receipt_long_outlined, title: 'Aucune consommation', subtitle: 'Vos remboursements et prises en charge apparaîtront ici.');
        }
        return RefreshIndicator(
          onRefresh: () async => ref.refresh(consumptionProvider.future),
          child: ListView(padding: const EdgeInsets.all(16), children: [
            GlassCard(
              child: Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [
                _tot('Montant', totals['amount']),
                _tot('Pris en charge', totals['covered']),
                _tot('Ticket', totals['ticket']),
              ]),
            ),
            const SizedBox(height: 12),
            ...items.map((x) => _consTile(Map<String, dynamic>.from(x as Map))),
          ]),
        );
      },
    );
  }

  Widget _tot(String label, dynamic v) => Column(children: [
        Text(_money(v), style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 15)),
        const SizedBox(height: 2),
        Text(label, style: const TextStyle(color: AppColors.mutedLight, fontSize: 11.5)),
      ]);

  Widget _consTile(Map<String, dynamic> x) => Padding(
        padding: const EdgeInsets.only(bottom: 10),
        child: GlassCard(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              Expanded(child: Text(x['rubrique']?.toString() ?? '', style: const TextStyle(fontWeight: FontWeight.w700))),
              if ((x['mode'] ?? '').toString().isNotEmpty) StatusPill(x['mode'].toString(), color: AppColors.info),
            ]),
            const SizedBox(height: 4),
            Text([x['provider'], x['filiation'], x['date']].where((y) => (y ?? '').toString().isNotEmpty).join(' · '),
                style: const TextStyle(color: AppColors.mutedLight, fontSize: 12.5)),
            const SizedBox(height: 6),
            Row(children: [
              Text('Montant ${_money(x['amount'])}', style: const TextStyle(fontSize: 12.5)),
              const Spacer(),
              Text('PEC ${_money(x['covered'])}', style: const TextStyle(fontSize: 12.5, color: AppColors.success)),
              const SizedBox(width: 10),
              Text('Ticket ${_money(x['ticket'])}', style: const TextStyle(fontSize: 12.5, color: AppColors.warning)),
            ]),
          ]),
        ),
      );
}
