import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';
import 'package:open_filex/open_filex.dart';
import 'package:path_provider/path_provider.dart';
import '../../core/providers.dart';
import '../../core/theme/app_theme.dart';
import '../../shared/widgets/ui.dart';

final payslipsProvider = FutureProvider.autoDispose((ref) async {
  final r = await ref.read(apiClientProvider).get('/me/payslips');
  return (r.data as List);
});

class PayslipsScreen extends ConsumerWidget {
  const PayslipsScreen({super.key});
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final p = ref.watch(payslipsProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Bulletins de paie')),
      body: p.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => ErrorView(error: e, onRetry: () async => ref.refresh(payslipsProvider.future)),
        data: (list) => list.isEmpty
            ? const EmptyState(icon: Icons.receipt_long_outlined, title: 'Aucun bulletin disponible', subtitle: 'Vos bulletins apparaîtront ici une fois la paie clôturée.')
            : RefreshIndicator(
                onRefresh: () async => ref.refresh(payslipsProvider.future),
                child: ListView.separated(
                  padding: const EdgeInsets.all(18),
                  itemCount: list.length,
                  separatorBuilder: (_, __) => const SizedBox(height: 10),
                  itemBuilder: (_, i) {
                    final s = Map<String, dynamic>.from(list[i] as Map);
                    return _PayslipTile(data: s);
                  },
                ),
              ),
      ),
    );
  }
}

class _PayslipTile extends ConsumerStatefulWidget {
  final Map<String, dynamic> data;
  const _PayslipTile({required this.data});
  @override
  ConsumerState<_PayslipTile> createState() => _PayslipTileState();
}

class _PayslipTileState extends ConsumerState<_PayslipTile> {
  bool _busy = false;

  Future<void> _download() async {
    if (_busy) return;
    setState(() => _busy = true);
    try {
      final id = widget.data['id'];
      final label = _period(widget.data['period']).replaceAll(' ', '_');
      final bytes = await ref.read(apiClientProvider).getBytes('/me/payslips/$id/pdf');
      if (bytes.isEmpty) throw Exception('Bulletin vide');
      final dir = await getTemporaryDirectory();
      final file = File('${dir.path}/Bulletin_$label.pdf');
      await file.writeAsBytes(bytes, flush: true);
      final res = await OpenFilex.open(file.path);
      if (res.type != ResultType.done && mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Installez un lecteur PDF pour ouvrir le bulletin.')));
      }
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Téléchargement impossible : $e')));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = widget.data;
    return GlassCard(
      onTap: _download,
      child: Row(children: [
        Container(padding: const EdgeInsets.all(11), decoration: BoxDecoration(color: AppColors.brand.withOpacity(.12), borderRadius: BorderRadius.circular(12)), child: const Icon(Icons.description_rounded, color: AppColors.brand)),
        const SizedBox(width: 14),
        Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(_period(s['period']), style: const TextStyle(fontWeight: FontWeight.w700)),
          if (s['net'] != null) Text('Net : ${NumberFormat.decimalPattern('fr').format(s['net'])} FCFA', style: const TextStyle(color: AppColors.mutedLight, fontSize: 12.5)),
        ])),
        _busy
            ? const SizedBox(width: 22, height: 22, child: CircularProgressIndicator(strokeWidth: 2.2))
            : const Icon(Icons.download_rounded, color: AppColors.brand),
      ]),
    );
  }

  static String _period(dynamic p) { try { final d = DateTime.parse('$p-01'); return DateFormat('MMMM yyyy', 'fr').format(d); } catch (_) { return '$p'; } }
}
