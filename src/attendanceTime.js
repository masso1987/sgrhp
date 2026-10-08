/**
 * Heure de pointage fiable — reconstruction côté serveur (logique pure, testable).
 *
 * Problème : hors ligne, le téléphone ne peut pas joindre le serveur, et son
 * horloge murale (wall clock) est modifiable par l'utilisateur. On ne peut donc
 * pas lui faire confiance telle quelle.
 *
 * Solution (horloge monotone d'amorçage) : à chaque passage en ligne, l'app
 * enregistre une « ancre » = { heure serveur (fiable), compteur monotone depuis
 * le démarrage du téléphone (elapsedRealtime, non modifiable par l'horloge) }.
 * Pour un pointage hors ligne, l'app lit de nouveau le compteur monotone ; on
 * reconstitue alors l'heure réelle :
 *     heure_effective = ancre.serveur + (monotone_pointage − ancre.monotone)
 *
 * Garde-fous :
 *   - redémarrage du téléphone entre l'ancre et le pointage (le compteur monotone
 *     est remis à zéro) → reconstruction impossible, on retombe sur l'horloge de
 *     l'appareil en la signalant pour revue RH ;
 *   - heure dans le futur (au-delà d'une tolérance) ou trop ancienne (au-delà de
 *     la fenêtre hors-ligne max) → signalée pour revue ;
 *   - en ligne, l'heure serveur fait foi (inchangé).
 *
 * Sources d'heure retournées :
 *   SERVER            en ligne, horodatée par le serveur (fiable)
 *   OFFLINE_ANCHORED  hors ligne, reconstituée via l'ancre monotone (fiable)
 *   OFFLINE_DEVICE    hors ligne, horloge de l'appareil (à revoir)
 *   OFFLINE_SYNC      hors ligne, aucune heure exploitable → heure de réception (à revoir)
 */

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

/**
 * @param {Object} o
 * @param {boolean} o.offline        true si le pointage provient de la file hors-ligne (/me/sync)
 * @param {number}  o.nowMs          heure serveur de réception (Date.now())
 * @param {number}  [o.bootMs]       compteur monotone au moment du pointage (ms depuis boot)
 * @param {number}  [o.anchorServerMs] heure serveur de la dernière ancre (ms epoch)
 * @param {number}  [o.anchorBootMs] compteur monotone au moment de l'ancre (ms depuis boot)
 * @param {number}  [o.clientMs]     heure murale de l'appareil au pointage (ms epoch)
 * @param {number}  [o.skewMs]       tolérance "futur" (défaut 2 min)
 * @param {number}  [o.maxOfflineDays] fenêtre hors-ligne max en jours (défaut 14)
 * @returns {{ms:number, source:string, flag:(string|null)}}
 */
function resolveAttendanceTime(o) {
  const nowMs = num(o.nowMs);
  const skew = num(o.skewMs) != null ? o.skewMs : 2 * MINUTE;
  const maxOff = (num(o.maxOfflineDays) != null ? o.maxOfflineDays : 14) * DAY;

  // En ligne : l'heure serveur fait foi.
  if (!o.offline) return { ms: nowMs, source: "SERVER", flag: null };

  const bootMs = num(o.bootMs);
  const aServer = num(o.anchorServerMs);
  const aBoot = num(o.anchorBootMs);
  const clientMs = num(o.clientMs);

  // Reconstruction via l'ancre monotone (pas de redémarrage depuis l'ancre).
  if (aServer != null && aBoot != null && bootMs != null && bootMs >= aBoot) {
    const eff = aServer + (bootMs - aBoot);
    if (eff <= nowMs + skew && eff >= nowMs - maxOff) {
      return { ms: eff, source: "OFFLINE_ANCHORED", flag: null };
    }
    // Ancre présente mais résultat hors bornes → suspect, on bascule en revue.
  }

  // Pas d'ancre exploitable (ou redémarrage) : horloge de l'appareil, signalée.
  if (clientMs != null && clientMs <= nowMs + skew && clientMs >= nowMs - maxOff) {
    return { ms: clientMs, source: "OFFLINE_DEVICE", flag: "REVIEW" };
  }

  // Rien d'exploitable : heure de réception, signalée.
  return { ms: nowMs, source: "OFFLINE_SYNC", flag: "REVIEW" };
}

module.exports = { resolveAttendanceTime };
