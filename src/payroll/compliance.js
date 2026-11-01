/**
 * Audit de conformité de la rémunération (analyse salariale, phase 1, mode 3).
 *
 * Simulation pure : à partir du bulletin simulé d'un salarié (structure de salaire seule),
 * compare le traitement IRPP / CNPS appliqué à chaque rubrique avec celui que sa nature légale
 * impose, et chiffre chaque écart en recalculant le bulletin avec le moteur de paie.
 * Ne modifie rien : les corrections sont appliquées sur des copies de l'entrée et de la config.
 */
"use strict";
const { computePayslip } = require("./engine");
const { NATURES, natureOf } = require("./legalNature");

const clone = (o) => JSON.parse(JSON.stringify(o));
const r0 = (n) => Math.round(n || 0);
const fmt = (n) => Math.round(Math.abs(n || 0)).toLocaleString("fr-FR").replace(/ | /g, " ");
const PCT = (r) => Math.round(r * 100) + " %";

// Traitement actuellement appliqué à une ligne de gain.
function currentTreatment(l, avMap) {
  const code = String(l.code);
  if (avMap[code] != null) return { impo: "CAP", capRate: avMap[code], cnps: !!l.cnps };
  if (l._transportTaxable !== undefined) return { impo: "PARTIAL", cnps: false, transport: true };
  return { impo: l.impo ? "FULL" : "EXEMPT", cnps: !!l.cnps };
}
const impoText = (t, transportCap) => t.impo === "CAP" ? "imposable dans la limite de " + PCT(t.capRate)
  : t.impo === "PARTIAL" ? "exonérée d'IRPP jusqu'à " + fmt(transportCap) + " F" : t.impo === "FULL" ? "imposable en totalité" : "exonérée d'IRPP";
const cnpsText = (v) => v ? "soumise à la CNPS" : "hors assiette CNPS";

// Corrections appliquées sur (input, cfg) clonés.
function findItem(input, code) {
  for (const k of ["gains", "nonTaxable"]) { const i = (input[k] || []).findIndex(x => String(x.code) === String(code)); if (i >= 0) return { list: k, i }; }
  return null;
}
function asGain(input, code) {
  const f = findItem(input, code); if (!f) return null;
  if (f.list === "nonTaxable") { const it = input.nonTaxable.splice(f.i, 1)[0]; it.cnps = false; it.impo = false; input.gains.push(it); return it; }
  return input.gains[f.i];
}
function setAv(cfg, code, rate) {
  cfg.avantagesNatureList = (cfg.avantagesNatureList || []).filter(a => String(a.rubriqueCode) !== String(code));
  if (rate != null) cfg.avantagesNatureList.push({ code: "AUDIT_" + code, rubriqueCode: String(code), rate, active: true });
}
function applyFix(input, cfg, fx) {
  if (fx.kind === "transportFull") { cfg.transportExemptionCap = 0; return; }
  if (fx.kind === "base") { input.baseSalary = fx.value; if (!(input.ancienneteBase > fx.value)) input.ancienneteBase = fx.value; input.tdlBase = fx.value; return; }
  const g = asGain(input, fx.code); if (!g) return;
  if (fx.kind === "impo") {
    if (fx.mode === "CAP") { setAv(cfg, fx.code, fx.capRate); g.impo = true; }
    else { setAv(cfg, fx.code, null); g.impo = fx.mode === "FULL"; }
  }
  if (fx.kind === "cnps") g.cnps = !!fx.value;
}
function impactOf(input, cfg, base, fixes) {
  const i2 = clone(input), c2 = clone(cfg);
  for (const fx of fixes) applyFix(i2, c2, fx);
  const t = computePayslip(i2, c2).totals, b = base.totals;
  return { irpp: (t.irpp + t.cac) - (b.irpp + b.cac), cnpsSal: t.cnpsSalarie - b.cnpsSalarie, cfc: t.cfcSalarie - b.cfcSalarie,
    autresImpots: (t.rav + t.tdl) - (b.rav + b.tdl), patronal: t.chargesPatronales - b.chargesPatronales,
    net: t.netAPayer - b.netAPayer, cout: t.coutTotalEmployeur - b.coutTotalEmployeur, totals: t };
}

// Explications des deux côtés, à partir de l'effet chiffré de la correction.
function texts(f, d) {
  const emp = [], er = [];
  const taxes = d.irpp + d.cfc + d.autresImpots;
  if (f.type === "SURIMPOSITION") {
    if (d.net > 0) emp.push(`Net +${fmt(d.net)} F/mois (+${fmt(d.net * 12)} F/an)` + (taxes < 0 ? `, impôts −${fmt(taxes)} F/mois.` : "."));
    if (d.cnpsSal < 0) emp.push(`Sa cotisation pension baisse de ${fmt(d.cnpsSal)} F/mois : la base de sa future pension CNPS baisse aussi.`);
    if (d.patronal < 0) er.push(`Charges patronales −${fmt(d.patronal)} F/mois (−${fmt(d.patronal * 12)} F/an).`);
    else er.push("Coût employeur inchangé.");
    er.push(f.level === "A_JUSTIFIER" ? `Exonération à justifier : conserver ${f.pieces ? f.pieces.charAt(0).toLowerCase() + f.pieces.slice(1) : "les justificatifs"}. Sans justificatif, l'avantage serait requalifié en salaire.` : "Correction fondée sur un texte explicite : pas de risque.");
  } else if (f.type === "RISQUE") {
    if (d.net < 0) emp.push(`Après régularisation, net −${fmt(d.net)} F/mois` + (taxes > 0 ? ` (impôts +${fmt(taxes)} F)` : "") + (d.cnpsSal > 0 ? ` (CNPS +${fmt(d.cnpsSal)} F)` : "") + ".");
    if (d.cnpsSal > 0) emp.push("Sa base CNPS augmente : meilleure future pension.");
    const due = Math.max(0, taxes + d.cnpsSal + d.patronal);
    er.push(`Risque de redressement : environ ${fmt(due)} F/mois non retenus ou non déclarés (${fmt(due * 12)} F/an), hors pénalités.`);
    if (d.patronal > 0) er.push(`La régularisation ajoute ${fmt(d.patronal)} F/mois de charges patronales.`);
    if (f.pieces) er.push(`À défaut de régulariser, conserver : ${f.pieces.charAt(0).toLowerCase() + f.pieces.slice(1)}.`);
  } else {
    emp.push("Pas d'effet direct sur le net tant que le paramétrage n'est pas corrigé.");
    er.push("Harmoniser le paramétrage des rubriques de même nature pour éviter une erreur de déclaration.");
  }
  if (!emp.length) emp.push("Pas d'effet sur son net.");
  return { employee: emp.join(" "), employer: er.join(" ") };
}

/**
 * @param input  entrée du moteur (structure seule)
 * @param cfg    config de paie de la société (avantagesNatureList, codeMap…)
 * @param ctx    { rubOf(code) -> rubrique|null, categoryMin, categoryLabel }
 */
function auditCompliance(input, cfg, ctx) {
  const base = computePayslip(clone(input), clone(cfg));
  const avMap = {};
  for (const a of (cfg.avantagesNatureList || [])) if (a.active !== false && a.rubriqueCode) avMap[String(a.rubriqueCode)] = Number(a.rate != null ? a.rate : (a.impoRate || 0));
  const transportCap = Number(cfg.transportExemptionCap || 0);
  const findings = [], rubriques = [];
  const push = (f, fixes) => {
    const d = impactOf(input, cfg, base, fixes);
    const { totals, ...imp } = d;
    // Écart sans aucun effet chiffré (ex. indemnité déjà sous la limite de l'art. 33) : conforme en pratique.
    if (Object.values(imp).every(v => !v)) return;
    findings.push(Object.assign(f, { impact: imp, annual: { net: imp.net * 12, cout: imp.cout * 12 }, fixes }, texts(f, d)));
  };

  for (const l of base.lines.filter(x => x.kind === "GAIN")) {
    const rub = ctx.rubOf ? ctx.rubOf(String(l.code)) : null;
    const { nature, suggested } = natureOf(rub, l.label);
    const N = NATURES[nature] || NATURES.PRIME;
    const cur = currentTreatment(l, avMap);
    const row = { code: String(l.code), label: (rub && rub.label) || l.label, amount: l.gain, nature, natureLabel: N.label, natureSuggested: suggested,
      current: impoText(cur, transportCap) + ", " + cnpsText(cur.cnps), legal: N.impo == null ? "hors analyse" :
        (N.impo === "CAP" ? "imposable dans la limite de " + PCT(N.capRate) : N.impo === "FULL" ? "imposable en totalité" : "exonérée d'IRPP") +
        ", " + (N.cnps == null ? "CNPS selon le profil de paie" : cnpsText(N.cnps)), conforme: true };
    rubriques.push(row);
    if (N.impo == null || !l.gain) continue;
    const common = { code: row.code, label: row.label, amount: l.gain, nature, natureLabel: N.label, natureSuggested: suggested, ref: N.ref, pieces: N.pieces || "" };

    // --- IRPP ---
    if (cur.transport) {
      if (nature === "TRANSPORT" && N.impo === "FULL" && transportCap > 0)
        push(Object.assign({}, common, { topic: "IRPP", type: "RISQUE", level: "A_CONFIRMER", current: impoText(cur, transportCap), legal: "imposable en totalité",
          title: `Prime de transport exonérée d'IRPP jusqu'à ${fmt(transportCap)} F`,
          action: "Aucun texte n'exonère expressément la prime de transport : confirmer la position avec l'expert-comptable, ou mettre l'exonération à 0 dans les paramètres de paie." }),
          [{ kind: "transportFull" }]);
    } else if (N.impo === "CAP") {
      if (cur.impo !== "CAP" || Math.abs(cur.capRate - N.capRate) > 1e-9) {
        const over = cur.impo === "FULL" || (cur.impo === "CAP" && cur.capRate > N.capRate);
        push(Object.assign({}, common, { topic: "IRPP", type: over ? "SURIMPOSITION" : "RISQUE", level: "SUR",
          current: impoText(cur, transportCap), legal: "imposable dans la limite de " + PCT(N.capRate) + " du salaire taxable",
          title: over ? `${row.label} imposée au-delà de la limite légale de ${PCT(N.capRate)}` : `${row.label} exonérée au-delà de ce que permet l'article 33`,
          action: `Lier la rubrique à l'avantage « ${N.label} » au taux de ${PCT(N.capRate)} (Paramètres paie › Avantages en nature).` }),
          [{ kind: "impo", code: row.code, mode: "CAP", capRate: N.capRate }]);
      }
    } else if (N.impo === "FULL" && cur.impo !== "FULL") {
      push(Object.assign({}, common, { topic: "IRPP", type: "RISQUE", level: "SUR", current: impoText(cur, transportCap), legal: "imposable en totalité",
        title: `${row.label} non imposée alors qu'elle est un élément de salaire`,
        action: "Cocher « Soumis IRPP » sur la rubrique (et retirer tout lien d'avantage en nature)." }),
        [{ kind: "impo", code: row.code, mode: "FULL" }]);
    } else if (N.impo === "EXEMPT" && cur.impo !== "EXEMPT") {
      push(Object.assign({}, common, { topic: "IRPP", type: "SURIMPOSITION", level: N.justify ? "A_JUSTIFIER" : "SUR", current: impoText(cur, transportCap), legal: "exonérée d'IRPP",
        title: `${row.label} imposée alors que la loi l'exonère` + (N.justify ? " (si les frais sont réels et justifiés)" : ""),
        action: "Décocher « Soumis IRPP » sur la rubrique" + (N.justify ? ", seulement si l'emploi justifie ces frais et que les pièces sont conservées." : ".") }),
        [{ kind: "impo", code: row.code, mode: "EXEMPT" }]);
    } else if (N.impo === "EXEMPT" && N.justify && cur.impo === "EXEMPT") {
      // Exonération correcte en droit, mais requalifiable sans justificatifs : exposition chiffrée.
      push(Object.assign({}, common, { topic: "IRPP", type: "RISQUE", level: "A_JUSTIFIER", current: impoText(cur, transportCap) + ", " + cnpsText(cur.cnps), legal: "exonérée si justifiée",
        title: `${row.label} exonérée : à justifier en cas de contrôle`,
        action: "Vérifier que l'emploi justifie ces frais, que le montant n'est pas exagéré et conserver les pièces." }),
        [{ kind: "impo", code: row.code, mode: "FULL" }, { kind: "cnps", code: row.code, value: true }]);
    }

    // --- CNPS ---
    if (!cur.transport && N.cnps != null && cur.cnps !== N.cnps) {
      const toExclude = N.cnps === false;
      push(Object.assign({}, common, { topic: "CNPS", type: toExclude ? (N.cnpsDefault ? "PARAMETRAGE" : "SURIMPOSITION") : "RISQUE",
        level: N.cnpsDefault ? "A_CONFIRMER" : (N.justify ? "A_JUSTIFIER" : "SUR"), current: cnpsText(cur.cnps), legal: cnpsText(N.cnps),
        title: toExclude ? `${row.label} soumise à la CNPS` + (N.cnpsDefault ? " (traitement par défaut : hors assiette)" : " alors qu'elle en est exclue")
          : `${row.label} hors assiette CNPS alors qu'elle y est soumise`,
        action: (toExclude ? "Décocher « Soumis CNPS »" : "Cocher « Soumis CNPS »") + " sur la rubrique" + (N.cnpsDefault ? ", après confirmation selon votre profil de paie." : ".") }),
        [{ kind: "cnps", code: row.code, value: N.cnps }]);
    }
  }

  // Salaire de base sous le minimum de la catégorie.
  if (ctx.categoryMin > 0 && Number(input.baseSalary) > 0 && Number(input.baseSalary) < ctx.categoryMin) {
    push({ code: "", label: "Salaire de base", amount: input.baseSalary, nature: "SALAIRE_BASE", natureLabel: "Salaire de base", natureSuggested: false,
      topic: "BASE", type: "RISQUE", level: "SUR", current: fmt(input.baseSalary) + " F", legal: "au moins " + fmt(ctx.categoryMin) + " F (minimum de la catégorie " + (ctx.categoryLabel || "") + ")",
      title: "Salaire de base inférieur au minimum de la catégorie", ref: "Convention collective applicable (grille des salaires minima)", pieces: "",
      action: "Porter le salaire de base au minimum de la catégorie (avenant au contrat)." }, [{ kind: "base", value: ctx.categoryMin }]);
  }

  // Paramétrage incohérent : même nature, traitements différents.
  const byNat = {};
  for (const r of rubriques) if (r.nature !== "HORS_ANALYSE") (byNat[r.nature] = byNat[r.nature] || []).push(r);
  for (const [nat, rows] of Object.entries(byNat)) {
    const kinds = new Set(rows.map(r => r.current));
    if (rows.length > 1 && kinds.size > 1)
      findings.push({ code: rows.map(r => r.code).join(", "), label: rows.map(r => r.label).join(" / "), nature: nat, natureLabel: NATURES[nat].label,
        topic: "PARAMETRAGE", type: "PARAMETRAGE", level: "A_CONFIRMER", current: rows.map(r => r.code + " : " + r.current).join(" ; "), legal: rows[0].legal,
        title: `Rubriques de même nature (${NATURES[nat].label}) traitées différemment`, ref: NATURES[nat].ref, pieces: "",
        action: "Aligner le paramétrage IRPP / CNPS de ces rubriques.", impact: { irpp: 0, cnpsSal: 0, cfc: 0, autresImpots: 0, patronal: 0, net: 0, cout: 0 },
        annual: { net: 0, cout: 0 }, fixes: [], ...texts({ type: "PARAMETRAGE" }, {}) });
  }

  for (const f of findings) for (const r of rubriques) if (f.code === r.code && f.type !== "PARAMETRAGE") r.conforme = false;
  // Bulletin conforme : toutes les corrections sûres appliquées (dans les deux sens).
  const sure = findings.filter(f => f.level === "SUR").flatMap(f => f.fixes);
  const compliant = sure.length ? impactOf(input, cfg, base, sure).totals : base.totals;
  const gain = findings.filter(f => f.type === "SURIMPOSITION");
  const risk = findings.filter(f => f.type === "RISQUE");
  // En risque = écart certain (texte explicite) ; les points à justifier ou à confirmer sont « à vérifier ».
  const status = risk.some(f => f.level === "SUR") ? "EN_RISQUE" : gain.length ? "A_OPTIMISER" : risk.length ? "A_JUSTIFIER" : "CONFORME";
  const order = { RISQUE: 0, SURIMPOSITION: 1, PARAMETRAGE: 2 };
  findings.sort((a, b) => (order[a.type] - order[b.type]) || (Math.abs(b.impact.net) + Math.abs(b.impact.cout)) - (Math.abs(a.impact.net) + Math.abs(a.impact.cout)));
  return {
    status, findings, rubriques,
    current: base.totals, compliant,
    summary: {
      findings: findings.length,
      surimpositions: gain.length, risques: risk.length, parametrage: findings.filter(f => f.type === "PARAMETRAGE").length,
      gainNetMensuel: r0(gain.filter(f => f.level === "SUR").reduce((s, f) => s + Math.max(0, f.impact.net), 0)),
      gainNetJustifiable: r0(gain.filter(f => f.level === "A_JUSTIFIER").reduce((s, f) => s + Math.max(0, f.impact.net), 0)),
      economieEmployeurMensuelle: r0(gain.reduce((s, f) => s + Math.max(0, -f.impact.patronal), 0)),
      expositionMensuelle: r0(risk.reduce((s, f) => s + Math.max(0, f.impact.irpp + f.impact.cfc + f.impact.autresImpots + f.impact.cnpsSal + f.impact.patronal), 0)),
    },
  };
}

module.exports = { auditCompliance };
