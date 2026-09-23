import 'package:flutter/material.dart';
import '../../core/theme/app_theme.dart';

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
