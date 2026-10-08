/* Heure de pointage fiable (ancre monotone) — reconstruction + garde-fous. */
const { resolveAttendanceTime } = require("./attendanceTime");
let pass = 0, fail = 0;
const eq = (n, g, e) => { const ok = g === e; console.log(`${ok ? "✓" : "✗"} ${n}: ${g} (exp ${e})`); ok ? pass++ : fail++; };

const T = Date.UTC(2026, 9, 8, 10, 0, 0); // "maintenant" serveur (réception)

// 1) En ligne : l'heure serveur fait foi.
let r = resolveAttendanceTime({ offline: false, nowMs: T });
eq("online source", r.source, "SERVER");
eq("online ms", r.ms, T);
eq("online flag", r.flag, null);

// 2) Hors ligne avec ancre valide : reconstruction monotone (pointage 3h avant la réception).
//    ancre prise il y a 3h05 : serveur=T-3h05, boot=100000ms ; pointage à boot=100000+5min.
const h3 = 3 * 3600 * 1000, m5 = 5 * 60 * 1000;
r = resolveAttendanceTime({ offline: true, nowMs: T,
  anchorServerMs: T - h3 - m5, anchorBootMs: 100000, bootMs: 100000 + m5 });
eq("anchored source", r.source, "OFFLINE_ANCHORED");
eq("anchored flag", r.flag, null);
eq("anchored reconstitue T-3h", r.ms, T - h3);

// 3) Redémarrage du téléphone (boot < ancre.boot) : bascule horloge appareil, signalée.
r = resolveAttendanceTime({ offline: true, nowMs: T,
  anchorServerMs: T - h3, anchorBootMs: 500000, bootMs: 1000, clientMs: T - h3 });
eq("reboot source", r.source, "OFFLINE_DEVICE");
eq("reboot flag", r.flag, "REVIEW");
eq("reboot ms = clientMs", r.ms, T - h3);

// 4) Pas d'ancre du tout, mais heure appareil plausible : OFFLINE_DEVICE (revue).
r = resolveAttendanceTime({ offline: true, nowMs: T, clientMs: T - 2 * 3600 * 1000 });
eq("no-anchor source", r.source, "OFFLINE_DEVICE");
eq("no-anchor flag", r.flag, "REVIEW");

// 5) Horloge appareil dans le futur (triche) : rejetée → OFFLINE_SYNC (heure de réception).
r = resolveAttendanceTime({ offline: true, nowMs: T, clientMs: T + 3600 * 1000 });
eq("future device source", r.source, "OFFLINE_SYNC");
eq("future device ms = now", r.ms, T);
eq("future device flag", r.flag, "REVIEW");

// 6) Ancre donnant un résultat dans le futur (incohérent) : ne pas faire confiance.
r = resolveAttendanceTime({ offline: true, nowMs: T,
  anchorServerMs: T, anchorBootMs: 1000, bootMs: 1000 + 3600 * 1000, clientMs: T - 60000 });
eq("anchor-future -> device", r.source, "OFFLINE_DEVICE");

// 7) Hors ligne trop ancien (> fenêtre max) : signalé.
r = resolveAttendanceTime({ offline: true, nowMs: T, clientMs: T - 30 * 24 * 3600 * 1000, maxOfflineDays: 14 });
eq("too-old -> sync", r.source, "OFFLINE_SYNC");

// 8) Tolérance futur : 1 min dans le futur reste accepté (skew 2 min par défaut).
r = resolveAttendanceTime({ offline: true, nowMs: T, clientMs: T + 60 * 1000 });
eq("1min future accepted", r.source, "OFFLINE_DEVICE");

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
