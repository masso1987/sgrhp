/**
 * SGRHP — messages directs (1-to-1).
 * - Utilisateurs normaux : contacts = utilisateurs de leur organisation (+ toute
 *   personne avec qui une conversation existe déjà, ex. le super-admin).
 * - Super-admin (SADM) : contacts = tous les utilisateurs, groupés par organisation.
 * La restriction d'accès repose sur les participants (expéditeur/destinataire),
 * ce qui permet des conversations inter-organisations avec le super-admin.
 * Temps réel via src/chat.js (WebSocket) ; historique + envoi + non-lus via REST.
 */
const router = require("express").Router();
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const { db, save, id } = require("../store");
const { audit } = require("../audit");
const chat = require("../chat");
const auth = require("../auth");

if (!db.dmMessages) db.dmMessages = [];
const MSG_DIR = path.join(__dirname, "..", "..", "uploads", "msg");
fs.mkdirSync(MSG_DIR, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({
    destination: MSG_DIR,
    filename: (req, file, cb) => cb(null, id("att") + path.extname(file.originalname || "").slice(0, 8)),
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
});

const isSADM = (req) => req.user && req.user.role === "SADM";
const tenantName = (tid) => {
  if (!tid || tid === "platform") return "Plateforme (SGRHP)";
  const t = (db.tenants || []).find(x => x.id === tid);
  return t ? (t.name || t.id) : (tid === "t1" ? "Organisation" : tid);
};
const pub = (u) => ({ id: u.id, fullName: u.fullName, role: u.role, active: u.active,
  tenantId: u.tenantId || "t1", tenantName: tenantName(u.tenantId || "t1"),
  online: chat.online(u.id) || auth.isRecentlyActive(u.id) });

// Peers with whom the caller already exchanged messages (to allow replies across tenants).
function historyPeerIds(meId) {
  const set = new Set();
  for (const m of db.dmMessages) {
    if (m.fromId === meId) set.add(m.toId);
    else if (m.toId === meId) set.add(m.fromId);
  }
  return set;
}

// Contact list the caller is allowed to see.
function contacts(req) {
  const me = req.user.id;
  const all = db.users || [];
  if (isSADM(req)) return all.filter(u => u.id !== me);            // SADM: everyone
  const myTid = req.user.tenantId || "t1";
  const hist = historyPeerIds(me);
  return all.filter(u => u.id !== me && (
    ((u.tenantId || "t1") === myTid && u.role !== "SADM") ||        // same org
    hist.has(u.id)                                                  // or existing conversation (e.g. SADM)
  ));
}
function canMessage(req, otherId) {
  if (otherId === req.user.id) return false;
  const other = (db.users || []).find(u => u.id === otherId);
  if (!other) return false;
  if (isSADM(req)) return true;                                     // SADM -> anyone
  if ((other.tenantId || "t1") === (req.user.tenantId || "t1") && other.role !== "SADM") return true;
  return historyPeerIds(req.user.id).has(otherId);                 // reply to an existing conversation
}
const between = (a, b) => db.dmMessages.filter(m =>
  (m.fromId === a && m.toId === b) || (m.fromId === b && m.toId === a));

// Liste des contacts + dernier message + non-lus par conversation.
router.get("/conversations", (req, res) => {
  const me = req.user.id;
  const rows = contacts(req).map(u => {
    const conv = between(me, u.id).sort((a, b) => String(a.at).localeCompare(String(b.at)));
    const last = conv[conv.length - 1] || null;
    const unread = conv.filter(m => m.toId === me && !m.readAt).length;
    const p = pub(u);
    return { ...p,
      last: last ? { text: last.text, at: last.at, fromMe: last.fromId === me, hasAttachment: !!last.attachment } : null,
      unread };
  }).sort((a, b) => (b.unread - a.unread) || String((b.last || {}).at || "").localeCompare(String((a.last || {}).at || "")));
  res.json(rows);
});

router.get("/unread", (req, res) => {
  const me = req.user.id;
  const n = db.dmMessages.filter(m => m.toId === me && !m.readAt).length;
  res.json({ unread: n });
});

// Historique avec un utilisateur (200 derniers).
router.get("/with/:userId", (req, res) => {
  const me = req.user.id, other = req.params.userId;
  if (!canMessage(req, other) && !historyPeerIds(me).has(other))
    return res.status(403).json({ error: "Accès refusé" });
  const conv = between(me, other).sort((a, b) => String(a.at).localeCompare(String(b.at))).slice(-200);
  res.json(conv);
});

router.post("/with/:userId/read", (req, res) => {
  const me = req.user.id, other = req.params.userId; let n = 0;
  for (const m of db.dmMessages) if (m.fromId === other && m.toId === me && !m.readAt) { m.readAt = new Date().toISOString(); n++; }
  if (n) { save(); chat.deliver(other, { type: "read", by: me }); }
  res.json({ ok: true, marked: n });
});

router.post("/upload", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Fichier manquant" });
  res.json({ storedAs: req.file.filename, name: req.file.originalname, size: req.file.size });
});
router.get("/file/:msgId", (req, res) => {
  const me = req.user.id;
  const m = db.dmMessages.find(x => x.id === req.params.msgId && (x.fromId === me || x.toId === me));
  if (!m || !m.attachment) return res.status(404).json({ error: "Pièce jointe introuvable" });
  res.download(path.join(MSG_DIR, m.attachment.storedAs), m.attachment.name || "piece-jointe");
});

// Envoi d'un message direct.
router.post("/with/:userId", (req, res) => {
  const me = req.user.id, other = req.params.userId;
  if (!canMessage(req, other)) return res.status(403).json({ error: "Destinataire non autorisé" });
  const b = req.body || {};
  const text = (b.text || "").toString().slice(0, 5000);
  if (!text.trim() && !b.attachment && !b.link) return res.status(400).json({ error: "Message vide" });
  const mentions = [];
  if (text.includes("@")) for (const u of contacts(req)) {
    const first = (u.fullName || "").split(" ")[0];
    if (first && new RegExp("@" + first.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(text)) mentions.push(u.id);
  }
  const msg = {
    id: id("dm"), tenantId: req.user.tenantId || "t1",
    fromId: me, fromName: req.user.fullName, toId: other,
    text, at: new Date().toISOString(), readAt: null,
    attachment: b.attachment && b.attachment.storedAs ? { storedAs: b.attachment.storedAs, name: b.attachment.name, size: b.attachment.size } : null,
    link: b.link && b.link.type ? { type: b.link.type, id: b.link.id || "", label: (b.link.label || "").toString().slice(0, 120) } : null,
    mentions,
  };
  db.dmMessages.push(msg); save();
  audit(req.user, "CREATED", "DirectMessage", msg.id, { to: other });
  chat.deliver(other, { type: "message", message: msg });
  chat.deliver(me, { type: "message", message: msg });
  res.status(201).json(msg);
});

module.exports = router;
