import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:image_picker/image_picker.dart';
import 'package:intl/intl.dart';
import '../../core/providers.dart';
import '../../core/theme/app_theme.dart';
import '../../shared/widgets/ui.dart';

/// Supervisor punches in/out for members of their team. A photo of the employee
/// is captured as proof (SUPERVISOR source server-side). The server decides the
/// timestamp; geofence still applies to the supervisor's position.
final teamProvider = FutureProvider.autoDispose<Map<String, dynamic>>((ref) async {
  final r = await ref.read(apiClientProvider).get('/me/team');
  return Map<String, dynamic>.from(r.data as Map);
});

class TeamPointageScreen extends ConsumerWidget {
  const TeamPointageScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final a = ref.watch(teamProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Pointage équipe')),
      body: a.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => ErrorView(error: e, onRetry: () async => ref.refresh(teamProvider.future)),
        data: (d) {
          final members = (d['members'] as List? ?? []);
          return RefreshIndicator(
            onRefresh: () async => ref.refresh(teamProvider.future),
            child: members.isEmpty
                ? ListView(children: const [
                    SizedBox(height: 80),
                    EmptyState(icon: Icons.groups_outlined, title: 'Aucun membre', subtitle: "Aucun employé ne vous est rattaché comme superviseur."),
                  ])
                : ListView(
                    padding: const EdgeInsets.all(16),
                    children: [
                      const Padding(
                        padding: EdgeInsets.only(bottom: 10, left: 4),
                        child: Text('Pointez l\'arrivée ou la sortie de vos équipiers. Une photo est prise comme preuve.',
                            style: TextStyle(color: AppColors.mutedLight, fontSize: 13)),
                      ),
                      ...members.map((m) => _MemberTile(member: Map<String, dynamic>.from(m as Map))),
                    ],
                  ),
          );
        },
      ),
    );
  }
}

class _MemberTile extends ConsumerStatefulWidget {
  final Map<String, dynamic> member;
  const _MemberTile({required this.member});
  @override
  ConsumerState<_MemberTile> createState() => _MemberTileState();
}

class _MemberTileState extends ConsumerState<_MemberTile> {
  final _picker = ImagePicker();
  bool _busy = false;

  Future<void> _punch(bool checkIn) async {
    setState(() => _busy = true);
    final eid = widget.member['id'];
    try {
      XFile? photo;
      try {
        photo = await _picker.pickImage(source: ImageSource.camera, imageQuality: 55, maxWidth: 1080);
      } catch (_) {}
      final path = checkIn ? '/me/team/$eid/attendance/check-in' : '/me/team/$eid/attendance/check-out';
      final body = {'client_timestamp': DateTime.now().toIso8601String(), 'app_version': '1.0.0'};
      final api = ref.read(apiClientProvider);
      final Response r;
      if (photo != null) {
        final fd = FormData.fromMap(body);
        fd.files.add(MapEntry('photo', await MultipartFile.fromFile(photo.path, filename: 'proof.jpg')));
        r = await api.postMultipart(path, fd);
      } else {
        r = await api.post(path, data: body);
      }
      final map = Map<String, dynamic>.from(r.data as Map);
      if (!mounted) return;
      if (map['success'] == true) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text('${checkIn ? 'Arrivée' : 'Sortie'} enregistrée pour ${widget.member['name']}.'),
          backgroundColor: AppColors.success,
        ));
        ref.invalidate(teamProvider);
      } else {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text(map['message']?.toString() ?? 'Pointage refusé.'),
          backgroundColor: AppColors.danger,
        ));
      }
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$e'), backgroundColor: AppColors.danger));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final m = widget.member;
    final status = (m['status'] ?? 'NONE').toString();
    final checkedIn = status == 'CHECKED_IN';
    final pill = checkedIn
        ? const StatusPill('Présent', color: AppColors.success, icon: Icons.check_circle)
        : status == 'CHECKED_OUT'
            ? const StatusPill('Sorti', color: AppColors.info, icon: Icons.logout)
            : const StatusPill('Absent', color: AppColors.warning, icon: Icons.schedule);
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: GlassCard(
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            CircleAvatar(
              radius: 20, backgroundColor: AppColors.brand.withOpacity(.15),
              child: Text(_initials(m['name']), style: const TextStyle(color: AppColors.brand, fontWeight: FontWeight.w700)),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text((m['name'] ?? '').toString(), style: const TextStyle(fontWeight: FontWeight.w700)),
                if ((m['matricule'] ?? '').toString().isNotEmpty)
                  Text('Mat. ${m['matricule']}', style: const TextStyle(color: AppColors.mutedLight, fontSize: 12)),
                if (m['last_in'] != null)
                  Text('Arrivée ${_hm(m['last_in'])}${m['last_out'] != null ? ' · Sortie ${_hm(m['last_out'])}' : ''}',
                      style: const TextStyle(color: AppColors.mutedLight, fontSize: 11.5)),
              ]),
            ),
            pill,
          ]),
          const SizedBox(height: 12),
          Row(children: [
            Expanded(
              child: FilledButton.tonalIcon(
                onPressed: _busy || checkedIn ? null : () => _punch(true),
                icon: const Icon(Icons.login_rounded, size: 18),
                label: const Text('Arrivée'),
              ),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: FilledButton.icon(
                style: FilledButton.styleFrom(backgroundColor: AppColors.danger),
                onPressed: _busy || !checkedIn ? null : () => _punch(false),
                icon: _busy
                    ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2.2, color: Colors.white))
                    : const Icon(Icons.logout_rounded, size: 18),
                label: const Text('Sortie'),
              ),
            ),
          ]),
        ]),
      ),
    );
  }

  static String _initials(dynamic name) {
    final parts = (name ?? '').toString().trim().split(RegExp(r'\s+')).where((p) => p.isNotEmpty).toList();
    if (parts.isEmpty) return '?';
    return (parts.first[0] + (parts.length > 1 ? parts.last[0] : '')).toUpperCase();
  }

  static String _hm(dynamic iso) {
    try { return DateFormat('HH:mm').format(DateTime.parse(iso).toLocal()); } catch (_) { return '--:--'; }
  }
}
