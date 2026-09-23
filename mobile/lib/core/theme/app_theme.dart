import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';

/// Centralised, modern Material 3 design system for the HR Employee Portal.
/// Brand echoes MBOKA Mon RH (emerald → mint gradient). No colours are hard-coded
/// in screens — everything reads from [AppColors] / Theme.
class AppColors {
  // Brand
  static const brand = Color(0xFF0B7A4B); // emerald (primary)
  static const brandDark = Color(0xFF065F46);
  static const accent = Color(0xFF10B981); // mint
  static const brandGradient = LinearGradient(
    begin: Alignment.topLeft, end: Alignment.bottomRight,
    colors: [brandDark, accent],
  );

  // Semantic status
  static const success = Color(0xFF16A34A);
  static const warning = Color(0xFFF59E0B);
  static const danger = Color(0xFFEF4444);
  static const info = Color(0xFF2563EB);

  // Neutrals (light)
  static const bgLight = Color(0xFFF4F7F5);
  static const surfaceLight = Color(0xFFFFFFFF);
  static const inkLight = Color(0xFF0F172A);
  static const mutedLight = Color(0xFF64748B);
  static const borderLight = Color(0xFFE6EBE8);

  // Neutrals (dark)
  static const bgDark = Color(0xFF0B1220);
  static const surfaceDark = Color(0xFF141C2B);
  static const inkDark = Color(0xFFE8EDF2);
  static const mutedDark = Color(0xFF94A3B8);
  static const borderDark = Color(0xFF223046);
}

class AppRadius {
  static const sm = 10.0;
  static const md = 16.0;
  static const lg = 22.0;
  static const xl = 28.0;
}

class AppSpace {
  static const xs = 6.0, sm = 10.0, md = 16.0, lg = 22.0, xl = 30.0;
}

class AppTheme {
  static ThemeData light() => _base(Brightness.light);
  static ThemeData dark() => _base(Brightness.dark);

  static ThemeData _base(Brightness b) {
    final dark = b == Brightness.dark;
    final scheme = ColorScheme.fromSeed(
      seedColor: AppColors.brand,
      brightness: b,
      primary: AppColors.brand,
      secondary: AppColors.accent,
      surface: dark ? AppColors.surfaceDark : AppColors.surfaceLight,
    );
    final ink = dark ? AppColors.inkDark : AppColors.inkLight;
    final muted = dark ? AppColors.mutedDark : AppColors.mutedLight;
    final text = GoogleFonts.interTextTheme().apply(bodyColor: ink, displayColor: ink);

    return ThemeData(
      useMaterial3: true,
      brightness: b,
      colorScheme: scheme,
      scaffoldBackgroundColor: dark ? AppColors.bgDark : AppColors.bgLight,
      textTheme: text.copyWith(
        headlineSmall: GoogleFonts.inter(fontWeight: FontWeight.w800, letterSpacing: -.5, color: ink),
        titleLarge: GoogleFonts.inter(fontWeight: FontWeight.w700, color: ink),
        titleMedium: GoogleFonts.inter(fontWeight: FontWeight.w600, color: ink),
        bodyMedium: GoogleFonts.inter(color: ink),
        labelLarge: GoogleFonts.inter(fontWeight: FontWeight.w600),
      ),
      cardTheme: CardTheme(
        elevation: 0,
        color: dark ? AppColors.surfaceDark : AppColors.surfaceLight,
        surfaceTintColor: Colors.transparent,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(AppRadius.lg),
          side: BorderSide(color: dark ? AppColors.borderDark : AppColors.borderLight),
        ),
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: dark ? const Color(0xFF0F1826) : const Color(0xFFF1F5F3),
        hintStyle: TextStyle(color: muted),
        contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 16),
        border: OutlineInputBorder(borderRadius: BorderRadius.circular(AppRadius.md), borderSide: BorderSide.none),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(AppRadius.md),
          borderSide: const BorderSide(color: AppColors.brand, width: 1.6),
        ),
      ),
      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(
          backgroundColor: AppColors.brand,
          foregroundColor: Colors.white,
          minimumSize: const Size.fromHeight(54),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(AppRadius.md)),
          textStyle: GoogleFonts.inter(fontWeight: FontWeight.w700, fontSize: 16),
        ),
      ),
      navigationBarTheme: NavigationBarThemeData(
        height: 66,
        backgroundColor: dark ? AppColors.surfaceDark : AppColors.surfaceLight,
        indicatorColor: AppColors.accent.withOpacity(.16),
        labelTextStyle: WidgetStatePropertyAll(GoogleFonts.inter(fontSize: 11.5, fontWeight: FontWeight.w600)),
      ),
      dividerColor: dark ? AppColors.borderDark : AppColors.borderLight,
    );
  }
}
