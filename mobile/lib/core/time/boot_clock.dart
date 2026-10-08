import 'package:flutter/services.dart';

/// Monotonic "since boot" clock (Android `SystemClock.elapsedRealtime`).
///
/// The wall clock (`DateTime.now()`) can be changed by the user, so it can't be
/// trusted to time an offline punch. The boot clock cannot be moved by changing
/// the device time, so we pair it with a trusted server time (an "anchor") to
/// reconstruct the real punch time once the phone is back online.
///
/// Returns null on platforms/devices where the channel isn't available (e.g.
/// iOS before the native side is added) — callers degrade gracefully.
class BootClock {
  static const _ch = MethodChannel('sgrhp/boot_clock');

  static Future<int?> elapsedRealtimeMs() async {
    try {
      final v = await _ch.invokeMethod<int>('elapsedRealtime');
      return v;
    } catch (_) {
      return null;
    }
  }
}

/// A trust anchor captured while online: server epoch ms + the boot-clock
/// reading at (approximately) the same instant.
class TimeAnchor {
  final int serverMs;
  final int bootMs;
  const TimeAnchor({required this.serverMs, required this.bootMs});

  Map<String, dynamic> toJson() => {'serverMs': serverMs, 'bootMs': bootMs};
  static TimeAnchor? fromJson(Map<String, dynamic>? j) {
    if (j == null) return null;
    final s = (j['serverMs'] as num?)?.toInt(), b = (j['bootMs'] as num?)?.toInt();
    if (s == null || b == null) return null;
    return TimeAnchor(serverMs: s, bootMs: b);
  }
}
