import 'package:flutter/material.dart';
import '../../core/theme/app_theme.dart';
import '../../core/network/api_client.dart';

/// Rounded status pill (green/orange/red/blue).
class StatusPill extends StatelessWidget {
  final String label;
  final Color color;
  final IconData? icon;
  const StatusPill(this.label, {super.key, this.color = AppColors.success, this.icon});
  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
        decoration: BoxDecoration(color: color.withOpacity(.14), borderRadius: BorderRadius.circular(999)),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          if (icon != null) ...[Icon(icon, size: 14, color: color), const SizedBox(width: 6)],
          Text(label, style: TextStyle(color: color, fontWeight: FontWeight.w700, fontSize: 12.5)),
        ]),
      );
}

class SectionHeader extends StatelessWidget {
  final String title;
  final Widget? trailing;
  const SectionHeader(this.title, {super.key, this.trailing});
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.fromLTRB(4, 20, 4, 10),
        child: Row(children: [
          Text(title, style: Theme.of(context).textTheme.titleMedium),
          const Spacer(),
          if (trailing != null) trailing!,
        ]),
      );
}

/// Card with a subtle brand-tinted glow — the "rich" surface used across the app.
class GlassCard extends StatelessWidget {
  final Widget child;
  final EdgeInsets padding;
  final VoidCallback? onTap;
  const GlassCard({super.key, required this.child, this.padding = const EdgeInsets.all(AppSpace.md), this.onTap});
  @override
  Widget build(BuildContext context) {
    final dark = Theme.of(context).brightness == Brightness.dark;
    return Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(AppRadius.lg),
        child: Container(
          padding: padding,
          decoration: BoxDecoration(
            color: dark ? AppColors.surfaceDark : AppColors.surfaceLight,
            borderRadius: BorderRadius.circular(AppRadius.lg),
            border: Border.all(color: dark ? AppColors.borderDark : AppColors.borderLight),
            boxShadow: [BoxShadow(color: Colors.black.withOpacity(dark ? .25 : .04), blurRadius: 18, offset: const Offset(0, 8))],
          ),
          child: child,
        ),
      ),
    );
  }
}

/// Reusable empty-state placeholder (icon + title + optional subtitle/action).
/// Use this everywhere a list can be empty, so empty screens stay consistent.
class EmptyState extends StatelessWidget {
  final IconData icon;
  final String title;
  final String? subtitle;
  final Widget? action;
  const EmptyState({super.key, this.icon = Icons.inbox_outlined, required this.title, this.subtitle, this.action});
  @override
  Widget build(BuildContext context) => Center(
        child: Padding(
          padding: const EdgeInsets.all(28),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            Icon(icon, size: 54, color: AppColors.mutedLight),
            const SizedBox(height: 14),
            Text(title, textAlign: TextAlign.center, style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 15.5)),
            if (subtitle != null) ...[
              const SizedBox(height: 6),
              Text(subtitle!, textAlign: TextAlign.center, style: const TextStyle(color: AppColors.mutedLight, fontSize: 13)),
            ],
            if (action != null) ...[const SizedBox(height: 16), action!],
          ]),
        ),
      );
}

class _ErrInfo {
  final IconData icon;
  final Color color;
  final String title;
  final String detail;
  _ErrInfo(this.icon, this.color, this.title, this.detail);
}

/// Friendly, typed error placeholder with an optional "Réessayer" button.
/// Maps [ApiException] status codes to readable French messages instead of
/// dumping the raw exception on screen.
class ErrorView extends StatelessWidget {
  final Object error;
  final Future<void> Function()? onRetry;
  const ErrorView({super.key, required this.error, this.onRetry});

  _ErrInfo _describe(Object e) {
    if (e is ApiException) {
      final s = e.status;
      if (s == null) return _ErrInfo(Icons.wifi_off_rounded, AppColors.warning, 'Pas de connexion', 'Vérifiez votre connexion internet puis réessayez.');
      if (s == 401) return _ErrInfo(Icons.lock_outline_rounded, AppColors.warning, 'Session expirée', 'Reconnectez-vous pour continuer.');
      if (s == 403) return _ErrInfo(Icons.block_rounded, AppColors.danger, 'Accès refusé', "Vous n'avez pas accès à cette ressource.");
      if (s == 404) return _ErrInfo(Icons.search_off_rounded, AppColors.mutedLight, 'Introuvable', e.message);
      if (s == 503) return _ErrInfo(Icons.build_rounded, AppColors.info, 'Maintenance', e.message);
      if (s >= 500) return _ErrInfo(Icons.cloud_off_rounded, AppColors.danger, 'Erreur serveur', 'Un problème est survenu côté serveur. Réessayez dans un instant.');
      return _ErrInfo(Icons.error_outline_rounded, AppColors.danger, 'Erreur', e.message);
    }
    return _ErrInfo(Icons.error_outline_rounded, AppColors.danger, 'Une erreur est survenue', e.toString());
  }

  @override
  Widget build(BuildContext context) {
    final info = _describe(error);
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(28),
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Icon(info.icon, size: 52, color: info.color),
          const SizedBox(height: 14),
          Text(info.title, textAlign: TextAlign.center, style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 15.5)),
          const SizedBox(height: 6),
          Text(info.detail, textAlign: TextAlign.center, style: const TextStyle(color: AppColors.mutedLight, fontSize: 13)),
          if (onRetry != null) ...[
            const SizedBox(height: 16),
            FilledButton.tonalIcon(onPressed: () => onRetry!(), icon: const Icon(Icons.refresh_rounded, size: 18), label: const Text('Réessayer')),
          ],
        ]),
      ),
    );
  }
}
