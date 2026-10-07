import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';
import 'package:intl/date_symbol_data_local.dart';
import 'core/config/env.dart';
import 'core/storage/secure_store.dart';
import 'core/push/push_service.dart';
import 'core/theme/app_theme.dart';
import 'core/router/app_router.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await initializeDateFormatting('fr_FR', null);
  Intl.defaultLocale = 'fr_FR';
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
    return MaterialApp.router(
      title: 'HR Employee Portal',
      scaffoldMessengerKey: rootMessengerKey,
      debugShowCheckedModeBanner: false,
      theme: AppTheme.light(),
      darkTheme: AppTheme.dark(),
      themeMode: ThemeMode.system,
      routerConfig: router,
    );
  }
}
