import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';
import 'package:intl/date_symbol_data_local.dart';
import 'core/config/env.dart';
import 'core/i18n/l10n.dart';
import 'core/storage/secure_store.dart';
import 'core/push/push_service.dart';
import 'core/theme/app_theme.dart';
import 'core/router/app_router.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  // Load saved language (default FR).
  try { final l = await SecureStore().lang; if (l != null && supportedLangs.contains(l)) appLang = l; } catch (_) {}
  final _loc = appLang == 'en' ? 'en_US' : 'fr_FR';
  await initializeDateFormatting(_loc, null);
  Intl.defaultLocale = _loc;
  // Apply a persisted API base URL override (domain change without a rebuild).
  try {
    final ov = await SecureStore().apiBaseOverride;
    if (ov != null && ov.trim().isNotEmpty) AppConfig.baseUrl = ov;
  } catch (_) {}
  await PushService.init(); // optional FCM; no-op if Firebase not configured
  SystemChrome.setPreferredOrientations([DeviceOrientation.portraitUp]);
  runApp(const ProviderScope(child: HrPortalApp()));
}

class HrPortalApp extends ConsumerWidget {
  const HrPortalApp({super.key});
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final router = ref.watch(routerProvider);
    final locale = ref.watch(localeProvider);
    return MaterialApp.router(
      title: 'MBOKA Mon RH',
      scaffoldMessengerKey: rootMessengerKey,
      debugShowCheckedModeBanner: false,
      locale: locale,
      localizationsDelegates: const [
        GlobalMaterialLocalizations.delegate,
        GlobalWidgetsLocalizations.delegate,
        GlobalCupertinoLocalizations.delegate,
      ],
      supportedLocales: const [Locale('fr'), Locale('en')],
      theme: AppTheme.light(),
      darkTheme: AppTheme.dark(),
      themeMode: ThemeMode.system,
      routerConfig: router,
    );
  }
}
