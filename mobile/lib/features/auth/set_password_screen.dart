import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../core/providers.dart';
import '../../core/theme/app_theme.dart';

class SetPasswordScreen extends ConsumerStatefulWidget {
  const SetPasswordScreen({super.key});
  @override
  ConsumerState<SetPasswordScreen> createState() => _S();
}

class _S extends ConsumerState<SetPasswordScreen> {
  final _p1 = TextEditingController(), _p2 = TextEditingController();
  bool _loading = false; String? _error;

  Future<void> _save() async {
    if (_p1.text.length < 6) { setState(() => _error = 'Au moins 6 caractères.'); return; }
    if (_p1.text != _p2.text) { setState(() => _error = 'Les mots de passe ne correspondent pas.'); return; }
    setState(() { _loading = true; _error = null; });
    try {
      await ref.read(authControllerProvider.notifier).setPassword(_p1.text);
    } catch (e) { setState(() => _error = e.toString()); }
    finally { if (mounted) setState(() => _loading = false); }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: const Text('Nouveau mot de passe')),
        body: Padding(
          padding: const EdgeInsets.all(22),
          child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            const SizedBox(height: 8),
            Text('Pour votre sécurité, choisissez un nouveau mot de passe.', style: TextStyle(color: AppColors.mutedLight)),
            const SizedBox(height: 22),
            TextField(controller: _p1, obscureText: true, decoration: const InputDecoration(hintText: 'Nouveau mot de passe', prefixIcon: Icon(Icons.lock_outline))),
            const SizedBox(height: 14),
            TextField(controller: _p2, obscureText: true, decoration: const InputDecoration(hintText: 'Confirmer', prefixIcon: Icon(Icons.lock_reset_outlined))),
            if (_error != null) Padding(padding: const EdgeInsets.only(top: 12), child: Text(_error!, style: const TextStyle(color: AppColors.danger))),
            const SizedBox(height: 24),
            FilledButton(onPressed: _loading ? null : _save, child: _loading ? const CircularProgressIndicator(color: Colors.white) : const Text('Enregistrer')),
          ]),
        ),
      );
}
