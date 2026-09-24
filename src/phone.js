/**
 * Numérotation téléphonique du Cameroun (plan à 9 chiffres depuis 2014).
 * Mobile : 9 chiffres commençant par 6.  Fixe : 9 chiffres commençant par 2.
 * Allocation opérateur usuelle (la portabilité peut faire exception) :
 *   - MTN     : 67x, 68x, 650–654
 *   - Orange  : 69x, 655–659
 *   - Nexttel : 66x
 *   - Camtel  : 62x  (mobile « Blue »)
 * Réf. : plan de numérotation du Cameroun (ART/TRB), Wikipedia, guides opérateurs.
 */
function normalizeCmPhone(raw) {
  let d = String(raw || "").replace(/[^\d]/g, "");
  if (d.startsWith("00237")) d = d.slice(5);
  else if (d.startsWith("237") && d.length > 9) d = d.slice(3);
  if (d.length === 10 && d.startsWith("0")) d = d.slice(1); // tolère un 0 en tête
  return d;
}
function isCmMobile(raw) { const d = normalizeCmPhone(raw); return /^6\d{8}$/.test(d); }
function isCmLandline(raw) { const d = normalizeCmPhone(raw); return /^2\d{8}$/.test(d); }
function isCmPhone(raw) { return isCmMobile(raw) || isCmLandline(raw); }

/** Opérateur d'après le préfixe : "MTN" | "ORANGE" | "NEXTTEL" | "CAMTEL" | "" (inconnu). */
function cmOperator(raw) {
  const d = normalizeCmPhone(raw);
  if (!/^6\d{8}$/.test(d)) return "";
  const p2 = d.slice(0, 2), p3 = d.slice(0, 3);
  if (p2 === "67" || p2 === "68") return "MTN";
  if (p3 >= "650" && p3 <= "654") return "MTN";
  if (p2 === "69") return "ORANGE";
  if (p3 >= "655" && p3 <= "659") return "ORANGE";
  if (p2 === "66") return "NEXTTEL";
  if (p2 === "62") return "CAMTEL";
  return "";
}
/** Canal mobile-money -> opérateur attendu. OM = Orange Money, MOMO = MTN Mobile Money. */
function channelOperator(channel) {
  const c = String(channel || "").toUpperCase();
  if (c === "OM") return "ORANGE";
  if (c === "MOMO") return "MTN";
  return "";
}
function operatorLabel(op) {
  return { MTN: "MTN", ORANGE: "Orange", NEXTTEL: "Nexttel", CAMTEL: "Camtel" }[op] || "inconnu";
}
/** Formatage lisible : 6XX XX XX XX. */
function formatCmPhone(raw) {
  const d = normalizeCmPhone(raw);
  if (d.length !== 9) return d;
  return d.replace(/(\d)(\d{2})(\d{2})(\d{2})(\d{2})/, "$1$2 $3 $4 $5");
}
module.exports = { normalizeCmPhone, isCmMobile, isCmLandline, isCmPhone, cmOperator, channelOperator, operatorLabel, formatCmPhone };
