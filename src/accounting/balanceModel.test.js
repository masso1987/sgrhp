/* Balance des comptes — format Sage : aucun solde négatif, ventilation Débit/Crédit. */
const { buildBalanceModel } = require("./balanceModel");
let pass = 0, fail = 0;
const eq = (n, g, e) => { const ok = g === e; console.log(`${ok ? "✓" : "✗"} ${n}: ${g} (exp ${e})`); ok ? pass++ : fail++; };

// Jeu d'essai : 3 comptes, exercice équilibré (ΣD = ΣC = 1 500 000).
const rows = [
  { account: "601000", label: "Achats", debit: 1500000, credit: 300000 }, // net +1 200 000 -> débiteur
  { account: "401100", label: "Fournisseurs", debit: 0, credit: 1200000 }, // net -1 200 000 -> créditeur
  { account: "512000", label: "Banque", debit: 0, credit: 0 },             // net 0 -> aucun
];
const { rows: m, totals } = buildBalanceModel(rows);

// Compte débiteur : solde dans la colonne Débit uniquement, jamais de négatif.
eq("601000 soldeDebit", m[0].soldeDebit, 1200000);
eq("601000 soldeCredit", m[0].soldeCredit, 0);
// Compte créditeur : valeur absolue en colonne Crédit, pas de signe négatif.
eq("401100 soldeDebit", m[1].soldeDebit, 0);
eq("401100 soldeCredit", m[1].soldeCredit, 1200000);
// Compte à zéro : deux colonnes à 0.
eq("512000 soldeDebit", m[2].soldeDebit, 0);
eq("512000 soldeCredit", m[2].soldeCredit, 0);

// Aucun solde négatif nulle part.
const anyNeg = m.some(r => r.soldeDebit < 0 || r.soldeCredit < 0 || r.debit < 0 || r.credit < 0);
eq("aucun montant négatif", anyNeg, false);

// Totaux équilibrés (mouvements et soldes).
eq("total mouvement débit", totals.debit, 1500000);
eq("total mouvement crédit", totals.credit, 1500000);
eq("total solde débiteur", totals.soldeDebit, 1200000);
eq("total solde créditeur", totals.soldeCredit, 1200000);
eq("balance équilibrée", totals.balanced, true);

// Arrondi au centime (R2) : 0.1 + 0.2 ne doit pas fuir.
const r2 = buildBalanceModel([{ account: "x", debit: 0.1, credit: 0, label: "" }, { account: "y", debit: 0.2, credit: 0, label: "" }]);
eq("arrondi total débit", r2.totals.debit, 0.3);

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
