import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';
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
        error: (e, _) => Center(child: Text('$e')),
        data: (list) => list.isEmpty
            ? const Center(child: Text('Aucun bulletin disponible.'))
            : ListView.separated(
                padding: const EdgeInsets.all(18),
                itemCount: list.length,
                separatorBuilder: (_, __) => const SizedBox(height: 10),
                itemBuilder: (_, i) {
                  final s = list[i];
                  return GlassCard(
                    onTap: () {/* open PDF via /me/payslips/:id/pdf (authenticated stream) */},
                    child: Row(children: [
                      Container(padding: const EdgeInsets.all(11), decoration: BoxDecoration(color: AppColors.brand.withOpacity(.12), borderRadius: BorderRadius.circular(12)), child: const Icon(Icons.description_rounded, color: AppColors.brand)),
                      const SizedBox(width: 14),
                      Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                        Text(_period(s['period']), style: const TextStyle(fontWeight: FontWeight.w700)),
                        if (s['net'] != null) Text('Net : ${NumberFormat.decimalPattern('fr').format(s['net'])} FCFA', style: const TextStyle(color: AppColors.mutedLight, fontSize: 12.5)),
                      ])),
                      const Icon(Icons.download_rounded, color: AppColors.mutedLight),
                    ]),
                  );
                },
              ),
      ),
    );
  }
  static String _period(dynamic p) { try { final d = DateTime.parse('$p-01'); return DateFormat('MMMM yyyy', 'fr').format(d); } catch (_) { return '$p'; } }
}
