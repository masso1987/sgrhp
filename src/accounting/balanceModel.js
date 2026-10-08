/**
 * Balance des comptes — modèle "format Sage".
 *
 * Règle OHABA/Sage : une balance ne présente JAMAIS de solde négatif.
 * Pour chaque compte on calcule le net = Σdébit − Σcrédit, puis on le ventile :
 *   - net > 0  → colonne « Solde débiteur »  (le crédit reste 0)
 *   - net < 0  → colonne « Solde créditeur » (valeur absolue)
 *   - net = 0  → les deux colonnes à 0
 *
 * Un exercice équilibré vérifie :  ΣsoldeDébiteur === ΣsoldeCréditeur
 * (et ΣmouvementDébit === ΣmouvementCrédit).
 *
 * Fonction pure, sans effet de bord : réutilisée par la route /balance,
 * le PDF et les tests, pour qu'il n'existe qu'une seule implémentation.
 */
const R2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * @param {Array<{account:string,label?:string,debit:number,credit:number}>} rows
 *        lignes déjà agrégées par compte (mouvements cumulés).
 * @returns {{rows:Array, totals:Object}}
 */
function buildBalanceModel(rows) {
  const out = (Array.isArray(rows) ? rows : []).map((r) => {
    const debit = R2(r.debit);
    const credit = R2(r.credit);
    const net = R2(debit - credit);
    return {
      account: String(r.account || ""),
      label: r.label || "",
      debit,                       // mouvement débit cumulé
      credit,                      // mouvement crédit cumulé
      soldeDebit: net > 0 ? net : 0,   // solde débiteur (jamais négatif)
      soldeCredit: net < 0 ? R2(-net) : 0, // solde créditeur (jamais négatif)
    };
  });
  const totals = out.reduce(
    (t, r) => {
      t.debit = R2(t.debit + r.debit);
      t.credit = R2(t.credit + r.credit);
      t.soldeDebit = R2(t.soldeDebit + r.soldeDebit);
      t.soldeCredit = R2(t.soldeCredit + r.soldeCredit);
      return t;
    },
    { debit: 0, credit: 0, soldeDebit: 0, soldeCredit: 0 }
  );
  totals.balanced = totals.debit === totals.credit && totals.soldeDebit === totals.soldeCredit;
  return { rows: out, totals };
}

module.exports = { buildBalanceModel, R2 };
