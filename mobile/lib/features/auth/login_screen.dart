import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../core/providers.dart';
import '../../core/theme/app_theme.dart';

class LoginScreen extends ConsumerStatefulWidget {
  const LoginScreen({super.key});
  @override
  ConsumerState<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends ConsumerState<LoginScreen> {
  final _login = TextEditingController();
  final _pwd = TextEditingController();
  bool _loading = false, _obscure = true;
  String? _error;

  Future<void> _submit() async {
    setState(() { _loading = true; _error = null; });
    try {
      await ref.read(authControllerProvider.notifier).login(_login.text.trim(), _pwd.text);
    } catch (e) {
      setState(() => _error = e.toString());
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final size = MediaQuery.of(context).size;
    return Scaffold(
      body: Stack(children: [
        // Brand gradient header
        Container(
          height: size.height * .46,
          decoration: const BoxDecoration(
            gradient: AppColors.brandGradient,
            borderRadius: BorderRadius.only(bottomLeft: Radius.circular(40), bottomRight: Radius.circular(40)),
          ),
          child: SafeArea(
            child: Padding(
              padding: const EdgeInsets.fromLTRB(28, 40, 28, 0),
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                _logoMark(),
                const SizedBox(height: 22),
                const Text('MBOKA Mon RH', style: TextStyle(color: Colors.white, fontSize: 26, fontWeight: FontWeight.w800, letterSpacing: -.5)),
                const SizedBox(height: 6),
                Text('Portail employé — présence & self-service',
                    style: TextStyle(color: Colors.white.withOpacity(.85), fontSize: 14)),
              ]),
            ),
          ),
        ),
        // Card
        Align(
          alignment: Alignment.bottomCenter,
          child: SingleChildScrollView(
            padding: EdgeInsets.fromLTRB(22, 0, 22, MediaQuery.of(context).viewInsets.bottom + 28),
            child: Container(
              margin: EdgeInsets.only(top: size.height * .36),
              padding: const EdgeInsets.all(24),
              decoration: BoxDecoration(
                color: Theme.of(context).colorScheme.surface,
                borderRadius: BorderRadius.circular(AppRadius.xl),
                boxShadow: [BoxShadow(color: Colors.black.withOpacity(.08), blurRadius: 30, offset: const Offset(0, 12))],
              ),
              child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                Text('Connexion', style: Theme.of(context).textTheme.headlineSmall),
                const SizedBox(height: 4),
                Text('Entrez votre matricule et votre mot de passe.',
                    style: TextStyle(color: AppColors.mutedLight)),
                const SizedBox(height: 22),
                TextField(controller: _login, textInputAction: TextInputAction.next,
                    decoration: const InputDecoration(hintText: 'Matricule ou e-mail', prefixIcon: Icon(Icons.badge_outlined))),
                const SizedBox(height: 14),
                TextField(controller: _pwd, obscureText: _obscure,
                    onSubmitted: (_) => _submit(),
                    decoration: InputDecoration(
                      hintText: 'Mot de passe', prefixIcon: const Icon(Icons.lock_outline),
                      suffixIcon: IconButton(
                        icon: Icon(_obscure ? Icons.visibility_outlined : Icons.visibility_off_outlined),
                        onPressed: () => setState(() => _obscure = !_obscure),
                      ),
                    )),
                if (_error != null) Padding(
                  padding: const EdgeInsets.only(top: 12),
                  child: Text(_error!, style: const TextStyle(color: AppColors.danger, fontWeight: FontWeight.w600)),
                ),
                const SizedBox(height: 22),
                FilledButton(
                  onPressed: _loading ? null : _submit,
                  child: _loading
                      ? const SizedBox(height: 22, width: 22, child: CircularProgressIndicator(strokeWidth: 2.4, color: Colors.white))
                      : const Text('Se connecter'),
                ),
                const SizedBox(height: 10),
                Center(child: TextButton(onPressed: () {}, child: const Text('Mot de passe oublié ?'))),
              ]),
            ),
          ),
        ),
      ]),
    );
  }

  Widget _logoMark() => Container(
        width: 58, height: 58,
        decoration: BoxDecoration(color: Colors.white.withOpacity(.16), borderRadius: BorderRadius.circular(18)),
        child: const Icon(Icons.groups_2_rounded, color: Colors.white, size: 32),
      );
}
