const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { db } = require("./store");

const SECRET = process.env.JWT_SECRET || "dev-secret-change-in-production";

function hash(pw, salt = crypto.randomBytes(8).toString("hex")) {
  return salt + ":" + crypto.scryptSync(pw, salt, 32).toString("hex");
}
function verify(pw, stored) {
  const [salt, h] = stored.split(":");
  return crypto.timingSafeEqual(Buffer.from(h, "hex"), crypto.scryptSync(pw, salt, 32));
}

function login(req, res) {
  const { email, password } = req.body || {};
  const user = db.users.find(u => u.email === email && u.active);
  if (!user || !verify(password || "", user.password))
    return res.status(401).json({ error: "Invalid credentials" });
  const token = jwt.sign({ id: user.id, role: user.role, fullName: user.fullName }, SECRET, { expiresIn: "8h" });
  res.json({ token, user: { id: user.id, fullName: user.fullName, role: user.role, portfolioIds: user.portfolioIds } });
}

function authenticate(req, res, next) {
  const h = req.header("authorization") || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Missing token" });
  try { req.user = jwt.verify(token, SECRET); next(); }
  catch { return res.status(401).json({ error: "Invalid or expired token" }); }
}

function me(req, res) {
  const u = db.users.find(x => x.id === req.user.id);
  if (!u) return res.status(404).json({ error: "Not found" });
  const { password, totpSecret, ...safe } = u;
  res.json(safe);
}
module.exports = { login, authenticate, hash, me };
