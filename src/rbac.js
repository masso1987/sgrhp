/** RBAC (§8.2) - enforced server-side on every route. */
function allow(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "Unauthenticated" });
    // Rôle principal OU un des rôles supplémentaires accordés par l'administrateur (ex. GPF + RC comptabilité).
    if (!roles.includes(req.user.role) && !(req.user.extraRoles || []).some(r => roles.includes(r)))
      return res.status(403).json({ error: `Access denied for role ${req.user.role}` });
    next();
  };
}
/* Rôles (principal + supplémentaires) d un utilisateur, et modules qu ils ouvrent d office :
 * RC = comptabilité, RP = paie, RS = stock, RQ = qualité (si l organisation a le module). */
const ROLE_MODULE = { RC: "accounting", RP: "payroll", RS: "stock", RQ: "quality" };
function rolesOf(u) { return [u && u.role].concat((u && Array.isArray(u.extraRoles)) ? u.extraRoles : []).filter(Boolean); }
function isAdminUser(u) { const r = rolesOf(u); return r.includes("ADM") || r.includes("SADM"); }
function hasModule(u, key) { return ((u && u.modules) || []).includes(key) || rolesOf(u).some(r => ROLE_MODULE[r] === key); }
module.exports = { allow, ROLE_MODULE, rolesOf, isAdminUser, hasModule };
