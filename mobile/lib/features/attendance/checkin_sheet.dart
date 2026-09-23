import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../core/theme/app_theme.dart';
import '../../core/providers.dart';
import 'attendance_repository.dart';
import 'package:go_router/go_router.dart';

/// Modern check-in/out sheet: pick site, acquire GPS, submit, show a clear
/// success / geofence-rejection / exception result. Server timestamp is truth.
Future<void> showCheckInSheet(BuildContext context, WidgetRef ref, {required bool checkIn}) {
  return showModalBottomSheet(
    context: context,
    isScrollControlled: true,
    backgroundColor: Colors.transparent,
    builder: (_) => _CheckInSheet(checkIn: checkIn),
  );
}

class _CheckInSheet extends ConsumerStatefulWidget {
  final bool checkIn;
  const _CheckInSheet({required this.checkIn});
  @override
  ConsumerState<_CheckInSheet> createState() => _St();
}

class _St extends ConsumerState<_CheckInSheet> {
  List<dynamic> _sites = [];
  String? _siteId;
  bool _loading = true, _busy = false;
  Map<String, dynamic>? _result;
  String? _error;

  @override
  void initState() { super.initState(); _load(); }

  Future<void> _load() async {
    try {
      _sites = await ref.read(attendanceRepoProvider).sites();
      if (_sites.isNotEmpty) _siteId = _sites.first['id'];
    } catch (e) { _error = '$e'; }
    if (mounted) setState(() => _loading = false);
  }

  Future<void> _submit() async {
    setState(() { _busy = true; _error = null; });
    try {
      final r = await ref.read(attendanceRepoProvider).punch(checkIn: widget.checkIn, siteId: _siteId);
      setState(() => _result = r);
      ref.invalidate(dashboardProvider);
    } catch (e) {
      setState(() => _error = '$e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: EdgeInsets.only(bottom: MediaQuery.of(context).viewInsets.bottom),
      decoration: BoxDecoration(
        color: Theme.of(context).colorScheme.surface,
        borderRadius: const BorderRadius.vertical(top: Radius.circular(28)),
      ),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(22, 14, 22, 28),
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Container(width: 42, height: 5, decoration: BoxDecoration(color: Theme.of(context).dividerColor, borderRadius: BorderRadius.circular(3))),
          const SizedBox(height: 18),
          if (_result != null) _resultView()
          else if (_loading) const Padding(padding: EdgeInsets.all(30), child: CircularProgressIndicator())
          else _formView(),
        ]),
      ),
    );
  }

  Widget _formView() => Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Text(widget.checkIn ? "Pointer l'arrivée" : 'Pointer la sortie',
            style: Theme.of(context).textTheme.headlineSmall, textAlign: TextAlign.center),
        const SizedBox(height: 6),
        const Text('Votre position GPS sera vérifiée par rapport à votre site.',
            textAlign: TextAlign.center, style: TextStyle(color: AppColors.mutedLight)),
        const SizedBox(height: 20),
        if (_sites.isNotEmpty) ...[
          const Align(alignment: Alignment.centerLeft, child: Text('Site', style: TextStyle(fontWeight: FontWeight.w600))),
          const SizedBox(height: 6),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 14),
            decoration: BoxDecoration(color: Theme.of(context).inputDecorationTheme.fillColor, borderRadius: BorderRadius.circular(AppRadius.md)),
            child: DropdownButtonHideUnderline(
              child: DropdownButton<String>(
                isExpanded: true, value: _siteId,
                items: _sites.map<DropdownMenuItem<String>>((s) => DropdownMenuItem(value: s['id'], child: Text(s['name']))).toList(),
                onChanged: (v) => setState(() => _siteId = v),
              ),
            ),
          ),
          const SizedBox(height: 20),
        ],
        if (_error != null) Padding(padding: const EdgeInsets.only(bottom: 12), child: Text(_error!, style: const TextStyle(color: AppColors.danger), textAlign: TextAlign.center)),
        FilledButton.icon(
          style: FilledButton.styleFrom(backgroundColor: widget.checkIn ? AppColors.brand : AppColors.danger),
          onPressed: _busy ? null : _submit,
          icon: _busy ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2.4, color: Colors.white)) : const Icon(Icons.my_location_rounded),
          label: Text(_busy ? 'Localisation…' : (widget.checkIn ? "Confirmer l'arrivée" : 'Confirmer la sortie')),
        ),
      ]);

  Widget _resultView() {
    final r = _result!;
    final ok = r['success'] == true;
    final status = (r['status'] ?? '').toString();
    final queued = r['queued'] == true || status == 'PENDING_SYNC';
    final isException = status == 'EXCEPTION';
    final color = !ok ? AppColors.danger : (queued ? AppColors.info : (isException ? AppColors.warning : AppColors.success));
    final icon = !ok ? Icons.location_off_rounded : (queued ? Icons.cloud_off_rounded : (isException ? Icons.report_gmailerrorred_rounded : Icons.check_circle_rounded));
    final title = !ok ? 'Pointage refusé' : (queued ? 'Enregistré hors-ligne' : (isException ? 'Enregistré — à vérifier' : (widget.checkIn ? 'Arrivée enregistrée' : 'Sortie enregistrée')));
    final sub = !ok
        ? (r['message'] ?? 'En dehors de la zone autorisée.').toString()
        : (queued ? 'Pas de connexion : votre pointage est sauvegardé et sera synchronisé automatiquement.' :
           (isException ? 'Motif : ${r['exception_reason']}. Votre RH examinera ce pointage.' : 'Horodatage officiel du serveur enregistré.'));
    return Column(children: [
      Container(width: 76, height: 76, decoration: BoxDecoration(color: color.withOpacity(.14), shape: BoxShape.circle), child: Icon(icon, color: color, size: 40)),
      const SizedBox(height: 16),
      Text(title, style: Theme.of(context).textTheme.titleLarge),
      const SizedBox(height: 6),
      Text(sub, textAlign: TextAlign.center, style: const TextStyle(color: AppColors.mutedLight)),
      if (ok && r['server_timestamp'] != null) Padding(
        padding: const EdgeInsets.only(top: 10),
        child: Text('${r['site']?['name'] ?? ''}', style: const TextStyle(fontWeight: FontWeight.w600)),
      ),
      const SizedBox(height: 22),
      FilledButton(onPressed: () => Navigator.of(context).pop(), child: const Text('Terminé')),
    ]);
  }
}
