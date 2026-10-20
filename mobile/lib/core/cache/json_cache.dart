import 'dart:convert';
import 'dart:io';
import 'package:path_provider/path_provider.dart';

/// Cache JSON simple sur disque pour le mode hors-ligne. Chaque réponse réseau
/// réussie est écrite ici ; quand l'appareil est hors-ligne, l'écran peut relire
/// la dernière valeur connue et afficher « en attente de synchronisation ».
/// Tout est protégé : une erreur de cache ne doit jamais casser l'app.
class JsonCache {
  static Directory? _dir;

  static Future<Directory> _ensureDir() async {
    if (_dir != null) return _dir!;
    final base = await getApplicationDocumentsDirectory();
    final d = Directory('${base.path}/cache');
    if (!await d.exists()) await d.create(recursive: true);
    _dir = d;
    return d;
  }

  static String _safe(String key) => key.replaceAll(RegExp(r'[^a-zA-Z0-9_-]'), '_');

  /// Écrit une valeur (déjà sérialisable JSON) sous une clé, avec l'horodatage.
  static Future<void> write(String key, dynamic value) async {
    try {
      final d = await _ensureDir();
      final f = File('${d.path}/${_safe(key)}.json');
      await f.writeAsString(jsonEncode({'at': DateTime.now().toIso8601String(), 'value': value}));
    } catch (_) {/* best-effort */}
  }

  /// Relit une valeur mise en cache, ou null si absente / illisible.
  static Future<CachedValue?> read(String key) async {
    try {
      final d = await _ensureDir();
      final f = File('${d.path}/${_safe(key)}.json');
      if (!await f.exists()) return null;
      final m = jsonDecode(await f.readAsString()) as Map<String, dynamic>;
      return CachedValue(m['value'], DateTime.tryParse('${m['at']}'));
    } catch (_) {
      return null;
    }
  }
}

class CachedValue {
  final dynamic value;
  final DateTime? at;
  CachedValue(this.value, this.at);
}
