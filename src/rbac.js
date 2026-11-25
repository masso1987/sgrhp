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
module.exports = { allow };
