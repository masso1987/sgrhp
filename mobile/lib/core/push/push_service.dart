import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/material.dart';
import '../network/api_client.dart';
import '../storage/secure_store.dart';

/// Global messenger so foreground push can show an in-app banner from anywhere.
final GlobalKey<ScaffoldMessengerState> rootMessengerKey = GlobalKey<ScaffoldMessengerState>();

/// Firebase Cloud Messaging wrapper. Entirely optional: if Firebase isn't
/// configured on the device (no google-services.json / FlutterFire setup),
/// init() fails quietly and the app keeps working with no push.
class PushService {
  static bool _ready = false;

  static Future<void> init() async {
    try {
      await Firebase.initializeApp();
      _ready = true;
      try { await FirebaseMessaging.instance.requestPermission(); } catch (_) {}
      FirebaseMessaging.onMessage.listen(_onForeground);
    } catch (_) {
      _ready = false; // Firebase not set up — push disabled, app continues.
    }
  }

  static void _onForeground(RemoteMessage m) {
    final n = m.notification;
    if (n == null) return;
    final text = [n.title, n.body].where((x) => (x ?? '').toString().isNotEmpty).join(' — ');
    if (text.isEmpty) return;
    rootMessengerKey.currentState?.showSnackBar(SnackBar(content: Text(text)));
  }

  /// Register this device's FCM token with the backend (call once authenticated).
  static Future<void> registerToken(ApiClient api, SecureStore store) async {
    if (!_ready) return;
    try {
      final token = await FirebaseMessaging.instance.getToken();
      if (token == null) return;
      await api.post('/devices/register', data: {
        'device_id': (await store.deviceId) ?? '',
        'fcm_token': token,
        'os': 'android',
      });
    } catch (_) {}
  }
}
