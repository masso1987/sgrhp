/**
 * SGRHP — registre de métriques qualité (SMQ Phase 4bis).
 * Chaque métrique est une fonction NOMMÉE et SÛRE (pas d'évaluation de code arbitraire)
 * qui calcule une valeur à partir des autres modules pour une période 'YYYY-MM'.
 * Un indicateur « auto » référence une clé de ce catalogue ; le moteur écrit la mesure.
 */
const { db } = require("./store");

const mine = (col, tid) => (db[col] || []).filter(x => (x.tenantId || "t1") === (tid || "t1"));
const inPeriod = (v, period) => String(v || "").slice(0, 7) === period;
const pct = (num, den) => ({ value: den ? Math.round((num / den) * 1000) / 10 : 0, num, den });

/* Catalogue : clé → { label, module, periodless?, fn(tid, period) } */
const METRICS = {
  // ---------------- Facturation ----------------
  "facturation.nb_factures": {
    label: "Nombre de factures", module: "Facturation",
    fn: (tid, p) => { const n = mine("billingInvoices", tid).filter(i => inPeriod(i.period, p)).length; return { value: n, num: n }; },
  },
  "facturation.taux_validation": {
    label: "Taux de factures validées (%)", module: "Facturation",
    fn: (tid, p) => { const f = mine("billingInvoices", tid).filter(i => inPeriod(i.period, p)); return pct(f.filter(i => i.status === "validated").length, f.length); },
  },
  "facturation.nb_modif_apres_validation": {
    label: "Factures modifiées après validation", module: "Facturation",
    fn: (tid, p) => { const n = mine("smqEvents", tid).filter(e => e.objectType === "Facture" && e.action === "modif_apres_validation" && e.changed && inPeriod(e.at, p)).length; return { value: n, num: n }; },
  },
  "facturation.taux_modif_apres_validation": {
    label: "Taux de factures modifiées après validation (%)", module: "Facturation",
    fn: (tid, p) => {
      const den = mine("billingInvoices", tid).filter(i => i.status === "validated" && inPeriod(i.period, p)).length;
      const num = mine("smqEvents", tid).filter(e => e.objectType === "Facture" && e.action === "modif_apres_validation" && e.changed && inPeriod(e.at, p)).length;
      return pct(num, den);
    },
  },
  // ---------------- Comptabilité ----------------
  "compta.nb_ecritures": {
    label: "Nombre d'écritures", module: "Comptabilité",
    fn: (tid, p) => { const n = mine("acctEntries", tid).filter(e => inPeriod(e.period, p)).length; return { value: n, num: n }; },
  },
  "compta.taux_ecritures_validees": {
    label: "Taux d'écritures validées/verrouillées (%)", module: "Comptabilité",
    fn: (tid, p) => { const e = mine("acctEntries", tid).filter(x => inPeriod(x.period, p)); return pct(e.filter(x => x.status === "validated" || x.status === "locked").length, e.length); },
  },
  "compta.nb_modif_apres_verrouillage": {
    label: "Écritures modifiées après verrouillage", module: "Comptabilité",
    fn: (tid, p) => { const n = mine("smqEvents", tid).filter(e => e.objectType === "Écriture" && e.changed && inPeriod(e.at, p)).length; return { value: n, num: n }; },
  },
  // ---------------- Paie ----------------
  "paie.nb_bulletins": {
    label: "Nombre de bulletins", module: "Paie",
    fn: (tid, p) => { const n = mine("payslips", tid).filter(s => inPeriod(s.period, p)).length; return { value: n, num: n }; },
  },
  "paie.nb_runs_clotures": {
    label: "Runs de paie clôturés", module: "Paie",
    fn: (tid, p) => { const n = mine("payRuns", tid).filter(r => inPeriod(r.period, p) && r.status === "CLOSED").length; return { value: n, num: n }; },
  },
  // ---------------- RH ----------------
  "rh.effectif_actif": {
    label: "Effectif actif (instantané)", module: "RH", periodless: true,
    fn: (tid) => { const n = mine("employees", tid).filter(e => String(e.status || "").toUpperCase() === "ACTIVE").length; return { value: n, num: n }; },
  },
  "rh.nb_embauches": {
    label: "Embauches (créations d'employés) du mois", module: "RH",
    fn: (tid, p) => { const n = mine("employees", tid).filter(e => inPeriod(e.createdAt, p)).length; return { value: n, num: n }; },
  },
  // ---------------- Écoute client ----------------
  "client.satisfaction_moyenne": {
    label: "Satisfaction client moyenne (%)", module: "Écoute client",
    fn: (tid, p) => { const rows = mine("smqSatisfaction", tid).filter(r => String(r.periode || r.date || "").slice(0,7) === p);
      if (!rows.length) return { value: 0, num: 0, den: 0 };
      const norm = r => { const mx = Number(r.scoreMax) || 100; return mx ? (Number(r.score)||0)/mx*100 : 0; };
      const avg = rows.reduce((a,r)=>a+norm(r),0)/rows.length; return { value: Math.round(avg*10)/10, num: rows.length }; },
  },
  "client.nb_reclamations": {
    label: "Réclamations reçues", module: "Écoute client",
    fn: (tid, p) => { const n = mine("smqClaims", tid).filter(c => String(c.date||"").slice(0,7) === p).length; return { value: n, num: n }; },
  },
  "client.taux_reclamations_resolues": {
    label: "Taux de réclamations résolues (%)", module: "Écoute client",
    fn: (tid, p) => { const c = mine("smqClaims", tid).filter(x => String(x.date||"").slice(0,7) === p);
      return pct(c.filter(x => ["resolue","cloturee"].includes(x.statut)).length, c.length); },
  },
  // ---------------- Ressources ----------------
  "ressources.habilitations_expirees": {
    label: "Habilitations expirées (instantané)", module: "Ressources", periodless: true,
    fn: (tid) => { const today = new Date().toISOString().slice(0,10);
      const n = mine("smqCompetences", tid).filter(c => c.habilitation && c.dateExpiration && c.dateExpiration < today).length; return { value: n, num: n }; },
  },
  "ressources.taux_fournisseurs_agrees": {
    label: "Taux de fournisseurs agréés (%)", module: "Ressources", periodless: true,
    fn: (tid) => { const r = mine("smqSupplierEvals", tid); return pct(r.filter(x => ["agréé","sous conditions"].includes(x.decision)).length, r.length); },
  },
  "ressources.taux_equipements_conformes": {
    label: "Taux d'équipements conformes (%)", module: "Ressources", periodless: true,
    fn: (tid) => { const rows = mine("smqEquipment", tid);
      const conf = rows.filter(e => { let p = e.prochainEtalonnage; if (!p && e.dernierEtalonnage && e.frequenceEtalonnageMois){const d=new Date(e.dernierEtalonnage);d.setMonth(d.getMonth()+(Number(e.frequenceEtalonnageMois)||12));p=d.toISOString().slice(0,10);} return !p || (new Date(p)-new Date())/86400000 > 30; }).length;
      return pct(conf, rows.length); },
  },
  // ---------------- Qualité (auto-diagnostic) ----------------
  "qualite.nc_ouvertes": {
    label: "Fiches d'amélioration ouvertes (instantané)", module: "Qualité", periodless: true,
    fn: (tid) => { const n = mine("smqImprovements", tid).filter(f => f.statut !== "cloturee").length; return { value: n, num: n }; },
  },
  "qualite.taux_cloture_capa": {
    label: "Taux de clôture des fiches (%)", module: "Qualité", periodless: true,
    fn: (tid) => { const f = mine("smqImprovements", tid); return pct(f.filter(x => x.statut === "cloturee").length, f.length); },
  },
  "qualite.actions_en_retard": {
    label: "Actions correctives en retard (instantané)", module: "Qualité", periodless: true,
    fn: (tid) => { const today = new Date().toISOString().slice(0, 10); let n = 0;
      for (const f of mine("smqImprovements", tid)) for (const a of (f.actions || []))
        if (a.echeance && a.echeance < today && !["cloturee", "verifiee", "faite"].includes(a.statut)) n++;
      return { value: n, num: n }; },
  },
  "certification.taux_conformite": {
    label: "Taux de conformité ISO 9001 (%)", module: "Qualité", periodless: true,
    fn: (tid) => {
      const clauses = mine("smqClauses", tid).filter(c => String(c.code).includes("."));
      const assess = mine("smqConformity", tid);
      const scope = mine("smqScope", tid)[0] || {}; const excl = new Set((scope.exclusions||[]).map(e=>String(e.clause)));
      const W = { conforme:1, partiel:0.5, non_conforme:0, non_evalue:0 };
      let score=0, n=0;
      for (const c of clauses) { const a = assess.find(x=>x.clauseCode===c.code)||{}; let st=a.statut||(excl.has(c.code)?"non_applicable":"non_evalue");
        if (st==="non_applicable") continue; score += (W[st]!=null?W[st]:0); n++; }
      return { value: n ? Math.round(score/n*1000)/10 : 0, num: n };
    },
  },
  "qualite.constats_nc_audit": {
    label: "Constats de non-conformité (audits, instantané)", module: "Qualité", periodless: true,
    fn: (tid) => { const n = mine("smqAuditItems", tid).filter(i => i.conformite === "NC").length; return { value: n, num: n }; },
  },
};

function catalog() {
  return Object.keys(METRICS).map(k => ({ key: k, label: METRICS[k].label, module: METRICS[k].module, periodless: !!METRICS[k].periodless }));
}
function compute(tid, key, period) {
  const m = METRICS[key];
  if (!m) return { error: "Métrique inconnue : " + key };
  try {
    const r = m.fn(tid, period) || {};
    return { key, value: Number(r.value) || 0, num: r.num, den: r.den, periodless: !!m.periodless, label: m.label };
  } catch (e) { return { error: e.message }; }
}

module.exports = { catalog, compute, METRICS };
