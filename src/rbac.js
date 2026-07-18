/** RBAC (§8.2) — enforced server-side on every route. */
function allow(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "Unauthenticated" });
    if (!roles.includes(req.user.role))
      return res.status(403).json({ error: `Access denied for role ${req.user.role}` });
    next();
  };
}
module.exports = { allow };
