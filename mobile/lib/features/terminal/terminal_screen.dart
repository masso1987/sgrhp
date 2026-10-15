import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:geolocator/geolocator.dart';
import 'package:image_picker/image_picker.dart';
import 'package:uuid/uuid.dart';
import '../../core/config/env.dart';
import '../../core/providers.dart';
import '../../core/theme/app_theme.dart';
import '../../shared/widgets/ui.dart';

/// On-site terminal (kiosk). A device is activated once with an admin code,
/// receives a device-bound token, then any employee affected to the terminal's
/// site identifies themselves and punches with a photo. Independent of the
/// employee login — uses its own Dio with the terminal bearer.
class TerminalScreen extends ConsumerStatefulWidget {
  const TerminalScreen({super.key});
  @override
  ConsumerState<TerminalScreen> createState() => _TerminalScreenState();
}

class _TerminalScreenState extends ConsumerState<TerminalScreen> {
  late final Dio _dio;
  String? _token;
  Map<String, dynamic>? _terminal; // {id,label,site:{...}}
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _dio = Dio(BaseOptions(
      baseUrl: AppConfig.apiRoot,
      connectTimeout: const Duration(seconds: 15),
      receiveTimeout: const Duration(seconds: 20),
    ));
    _restore();
  }

  Future<void> _restore() async {
    final t = await ref.read(secureStoreProvider).terminalToken;
    if (t != null) {
      _token = t;
      _dio.options.headers['Authorization'] = 'Bearer $t';
    }
    if (mounted) setState(() => _loading = false);
  }

  Future<void> _onActivated(String token, Map<String, dynamic> terminal) async {
    await ref.read(secureStoreProvider).setTerminalToken(token);
    _dio.options.headers['Authorization'] = 'Bearer $token';
    setState(() { _token = token; _terminal = terminal; });
  }

  Future<void> _deactivate() async {
    await ref.read(secureStoreProvider).setTerminalToken(null);
    _dio.options.headers.remove('Authorization');
    setState(() { _token = null; _terminal = null; });
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) return const Scaffold(body: Center(child: CircularProgressIndicator()));
    return Scaffold(
      appBar: AppBar(
        title: const Text('Borne de pointage'),
        actions: [
          if (_token != null)
            IconButton(
              tooltip: 'Désactiver la borne',
              icon: const Icon(Icons.logout_rounded),
              onPressed: () async {
                final ok = await showDialog<bool>(
                  context: context,
                  builder: (_) => AlertDialog(
                    title: const Text('Désactiver la borne ?'),
                    content: const Text('Il faudra ressaisir le code d\'activation pour réutiliser cet appareil comme borne.'),
                    actions: [
                      TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Annuler')),
                      FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('Désactiver')),
                    ],
                  ),
                );
                if (ok == true) _deactivate();
              },
            ),
        ],
      ),
      body: _token == null
          ? _ActivateView(dio: _dio, onActivated: _onActivated)
          : _TerminalPunchView(dio: _dio, onExpired: _deactivate),
    );
  }
}

class _ActivateView extends StatefulWidget {
  final Dio dio;
  final Future<void> Function(String token, Map<String, dynamic> terminal) onActivated;
  const _ActivateView({required this.dio, required this.onActivated});
  @override
  State<_ActivateView> createState() => _ActivateViewState();
}

class _ActivateViewState extends State<_ActivateView> {
  final _code = TextEditingController();
  bool _busy = false;
  String? _error;

  @override
  void dispose() { _code.dispose(); super.dispose(); }

  Future<void> _activate() async {
    final code = _code.text.trim();
    if (code.isEmpty) { setState(() => _error = 'Saisissez le code d\'activation.'); return; }
    setState(() { _busy = true; _error = null; });
    try {
      final r = await widget.dio.post('/terminal/activate', data: {'code': code});
      final d = Map<String, dynamic>.from(r.data as Map);
      await widget.onActivated(d['token'] as String, Map<String, dynamic>.from(d['terminal'] as Map));
    } on DioException catch (e) {
      final data = e.response?.data;
      setState(() => _error = (data is Map && data['error'] != null) ? data['error'].toString() : 'Activation impossible. Vérifiez le code.');
    } catch (_) {
      setState(() => _error = 'Activation impossible. Vérifiez votre connexion.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Center(
      child: SingleChildScrollView(
        padding: const EdgeInsets.all(28),
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Container(
            padding: const EdgeInsets.all(18),
            decoration: BoxDecoration(color: AppColors.brand.withOpacity(.14), shape: BoxShape.circle),
            child: const Icon(Icons.point_of_sale_rounded, size: 40, color: AppColors.brand),
          ),
          const SizedBox(height: 18),
          const Text('Activer cette borne', style: TextStyle(fontWeight: FontWeight.w800, fontSize: 20)),
          const SizedBox(height: 8),
          const Text(
            'Saisissez le code à 6 chiffres fourni par votre administrateur. Cet appareil sera lié à un site et servira de borne de pointage.',
            textAlign: TextAlign.center, style: TextStyle(color: AppColors.mutedLight, fontSize: 13.5),
          ),
          const SizedBox(height: 22),
          TextField(
            controller: _code,
            textAlign: TextAlign.center,
            keyboardType: TextInputType.number,
            inputFormatters: [FilteringTextInputFormatter.digitsOnly, LengthLimitingTextInputFormatter(6)],
            style: const TextStyle(fontSize: 26, fontWeight: FontWeight.w800, letterSpacing: 8),
            decoration: const InputDecoration(hintText: '••••••'),
          ),
          if (_error != null) Padding(padding: const EdgeInsets.only(top: 12), child: Text(_error!, style: const TextStyle(color: AppColors.danger), textAlign: TextAlign.center)),
          const SizedBox(height: 20),
          SizedBox(
            width: double.infinity,
            child: FilledButton(
              onPressed: _busy ? null : _activate,
              child: _busy ? const SizedBox(height: 20, width: 20, child: CircularProgressIndicator(strokeWidth: 2.4, color: Colors.white)) : const Text('Activer'),
            ),
          ),
        ]),
      ),
    );
  }
}

class _TerminalPunchView extends StatefulWidget {
  final Dio dio;
  final VoidCallback onExpired;
  const _TerminalPunchView({required this.dio, required this.onExpired});
  @override
  State<_TerminalPunchView> createState() => _TerminalPunchViewState();
}

class _TerminalPunchViewState extends State<_TerminalPunchView> {
  final _picker = ImagePicker();
  static const _uuid = Uuid();
  List<dynamic> _employees = [];
  bool _loading = true;
  String? _error;
  String _query = '';
  String? _busyId;

  @override
  void initState() { super.initState(); _load(); }

  Future<void> _load() async {
    setState(() { _loading = true; _error = null; });
    try {
      final r = await widget.dio.get('/terminal/employees');
      _employees = (r.data as List);
    } on DioException catch (e) {
      if (e.response?.statusCode == 401) { widget.onExpired(); return; }
      _error = 'Chargement impossible.';
    } catch (_) {
      _error = 'Chargement impossible.';
    }
    if (mounted) setState(() => _loading = false);
  }

  Future<void> _punch(Map<String, dynamic> e, bool checkIn) async {
    setState(() => _busyId = e['id'] as String);
    try {
      // Photo is proof; GPS is best-effort (the terminal is on-site).
      XFile? photo;
      try { photo = await _picker.pickImage(source: ImageSource.camera, imageQuality: 55, maxWidth: 1080); } catch (_) {}
      double? lat, lng, acc;
      try {
        if (await Geolocator.isLocationServiceEnabled()) {
          var p = await Geolocator.checkPermission();
          if (p == LocationPermission.denied) p = await Geolocator.requestPermission();
          if (p != LocationPermission.denied && p != LocationPermission.deniedForever) {
            final pos = await Geolocator.getCurrentPosition(desiredAccuracy: LocationAccuracy.best);
            lat = pos.latitude; lng = pos.longitude; acc = pos.accuracy;
          }
        }
      } catch (_) {}
      final body = <String, dynamic>{
        'employee_id': e['id'], 'type': checkIn ? 'IN' : 'OUT',
        'attendance_uuid': _uuid.v4(), 'client_timestamp': DateTime.now().toIso8601String(), 'app_version': '1.0.0',
        if (lat != null) 'latitude': lat, if (lng != null) 'longitude': lng, if (acc != null) 'accuracy': acc,
      };
      Response r;
      if (photo != null) {
        final fd = FormData.fromMap(body.map((k, v) => MapEntry(k, v?.toString() ?? '')));
        fd.files.add(MapEntry('photo', await MultipartFile.fromFile(photo.path, filename: 'proof.jpg')));
        r = await widget.dio.post('/terminal/attendance', data: fd, options: Options(contentType: 'multipart/form-data'));
      } else {
        r = await widget.dio.post('/terminal/attendance', data: body);
      }
      final map = Map<String, dynamic>.from(r.data as Map);
      if (!mounted) return;
      if (map['success'] == true) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text('${checkIn ? 'Arrivée' : 'Sortie'} enregistrée — ${e['name']}.'),
          backgroundColor: AppColors.success,
        ));
        await _load();
      } else {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(map['message']?.toString() ?? 'Pointage refusé.'), backgroundColor: AppColors.danger));
      }
    } on DioException catch (e2) {
      final data = e2.response?.data;
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content: Text((data is Map && data['error'] != null) ? data['error'].toString() : 'Pointage impossible.'),
        backgroundColor: AppColors.danger,
      ));
    } finally {
      if (mounted) setState(() => _busyId = null);
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) return const Center(child: CircularProgressIndicator());
    if (_error != null) {
      return Center(child: Column(mainAxisSize: MainAxisSize.min, children: [
        Text(_error!), const SizedBox(height: 12),
        FilledButton.tonal(onPressed: _load, child: const Text('Réessayer')),
      ]));
    }
    final q = _query.toLowerCase();
    final list = _employees.where((e) {
      final m = Map<String, dynamic>.from(e as Map);
      return q.isEmpty || (m['name'] ?? '').toString().toLowerCase().contains(q) || (m['matricule'] ?? '').toString().toLowerCase().contains(q);
    }).toList();
    return Column(children: [
      Padding(
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 8),
        child: TextField(
          onChanged: (v) => setState(() => _query = v),
          decoration: const InputDecoration(prefixIcon: Icon(Icons.search_rounded), hintText: 'Rechercher un employé (nom ou matricule)'),
        ),
      ),
      Expanded(
        child: list.isEmpty
            ? const EmptyState(icon: Icons.badge_outlined, title: 'Aucun employé', subtitle: 'Aucun employé affecté à ce site, ou recherche sans résultat.')
            : RefreshIndicator(
                onRefresh: _load,
                child: ListView.separated(
                  padding: const EdgeInsets.all(16),
                  itemCount: list.length,
                  separatorBuilder: (_, __) => const SizedBox(height: 10),
                  itemBuilder: (_, i) {
                    final e = Map<String, dynamic>.from(list[i] as Map);
                    final checkedIn = (e['status'] ?? 'NONE') == 'CHECKED_IN';
                    final busy = _busyId == e['id'];
                    return GlassCard(
                      child: Row(children: [
                        CircleAvatar(
                          radius: 22, backgroundColor: AppColors.brand.withOpacity(.15),
                          child: Text(_initials(e['name']), style: const TextStyle(color: AppColors.brand, fontWeight: FontWeight.w700)),
                        ),
                        const SizedBox(width: 12),
                        Expanded(
                          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                            Text((e['name'] ?? '').toString(), style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 15)),
                            Row(children: [
                              if ((e['matricule'] ?? '').toString().isNotEmpty)
                                Text('Mat. ${e['matricule']}  ', style: const TextStyle(color: AppColors.mutedLight, fontSize: 12)),
                              Text(checkedIn ? 'Présent' : (e['status'] == 'CHECKED_OUT' ? 'Sorti' : 'Absent'),
                                  style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: checkedIn ? AppColors.success : AppColors.mutedLight)),
                            ]),
                          ]),
                        ),
                        busy
                            ? const Padding(padding: EdgeInsets.all(8), child: SizedBox(width: 22, height: 22, child: CircularProgressIndicator(strokeWidth: 2.4)))
                            : FilledButton.icon(
                                style: FilledButton.styleFrom(backgroundColor: checkedIn ? AppColors.danger : AppColors.brand),
                                onPressed: () => _punch(e, !checkedIn),
                                icon: Icon(checkedIn ? Icons.logout_rounded : Icons.login_rounded, size: 18),
                                label: Text(checkedIn ? 'Sortie' : 'Arrivée'),
                              ),
                      ]),
                    );
                  },
                ),
              ),
      ),
    ]);
  }

  static String _initials(dynamic name) {
    final parts = (name ?? '').toString().trim().split(RegExp(r'\s+')).where((p) => p.isNotEmpty).toList();
    if (parts.isEmpty) return '?';
    return (parts.first[0] + (parts.length > 1 ? parts.last[0] : '')).toUpperCase();
  }
}
