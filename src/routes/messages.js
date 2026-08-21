/**
 * SGRHP — messages directs (1-to-1) entre utilisateurs du même tenant.
 * Temps réel via src/chat.js (WebSocket) ; historique + envoi + non-lus via REST.
 */
const router = require("express").Router();
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const { db, save, id, mine, stamp } = require("../store");
const { audit } = require("../audit");
const chat = require("../chat");

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

const uName = (uid) => { const u = (db.users || []).find(x => x.id === uid); return u ? u.fullName : ""; };
const tenantUsers = (req) => mine(db.users, req).filter(u => u.role !== "SADM").map(({ password, totpSecret, pendingTotp, ...u }) => u);

// Liste des utilisateurs (contacts) + dernier message + non-lus par conversation.
router.get("/conversations", (req, res) => {
  const me = req.user.id;
  const msgs = mine(db.dmMessages, req);
  const users = tenantUsers(req).filter(u => u.id !== me);
  const rows = users.map(u => {
    const conv = msgs.filter(m => (m.fromId === me && m.toId === u.id) || (m.fromId === u.id && m.toId === me));
    conv.sort((a, b) => String(a.at).localeCompare(String(b.at)));
    const last = conv[conv.length - 1] || null;
    const unread = conv.filter(m => m.toId === me && !m.readAt).length;
    return { id: u.id, fullName: u.fullName, role: u.role, active: u.active, online: chat.online(u.id),
      last: last ? { text: last.text, at: last.at, fromMe: last.fromId === me, hasAttachment: !!(last.attachment) } : null, unread };
  }).sort((a, b) => (b.unread - a.unread) || String((b.last || {}).at || "").localeCompare(String((a.last || {}).at || "")));
  res.json(rows);
});

router.get("/unread", (req, res) => {
  const me = req.user.id;
  const n = mine(db.dmMessages, req).filter(m => m.toId === me && !m.readAt).length;
  res.json({ unread: n });
});

// Historique avec un utilisateur (200 derniers).
router.get("/with/:userId", (req, res) => {
  const me = req.user.id, other = req.params.userId;
  const conv = mine(db.dmMessages, req)
    .filter(m => (m.fromId === me && m.toId === other) || (m.fromId === other && m.toId === me))
    .sort((a, b) => String(a.at).localeCompare(String(b.at))).slice(-200);
  res.json(conv);
});

router.post("/with/:userId/read", (req, res) => {
  const me = req.user.id, other = req.params.userId; let n = 0;
  for (const m of mine(db.dmMessages, req)) if (m.fromId === other && m.toId === me && !m.readAt) { m.readAt = new Date().toISOString(); n++; }
  if (n) { save(); chat.deliver(other, { type: "read", by: me }); }
  res.json({ ok: true, marked: n });
});

router.post("/upload", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Fichier manquant" });
  res.json({ storedAs: req.file.filename, name: req.file.originalname, size: req.file.size });
});
router.get("/file/:msgId", (req, res) => {
  const me = req.user.id;
  const m = mine(db.dmMessages, req).find(x => x.id === req.params.msgId && (x.fromId === me || x.toId === me));
  if (!m || !m.attachment) return res.status(404).json({ error: "Pièce jointe introuvable" });
  res.download(path.join(MSG_DIR, m.attachment.storedAs), m.attachment.name || "piece-jointe");
});

// Envoi d'un message direct.
router.post("/with/:userId", (req, res) => {
  const me = req.user.id, other = req.params.userId;
  if (other === me) return res.status(400).json({ error: "Impossible de s'écrire à soi-même" });
  const target = mine(db.users, req).find(u => u.id === other && u.role !== "SADM");
  if (!target) return res.status(404).json({ error: "Destinataire introuvable" });
  const b = req.body || {};
  const text = (b.text || "").toString().slice(0, 5000);
  if (!text.trim() && !b.attachment && !b.link) return res.status(400).json({ error: "Message vide" });
  // @mentions : ids d'utilisateurs mentionnés par nom
  const mentions = [];
  if (text.includes("@")) for (const u of tenantUsers(req)) {
    const first = (u.fullName || "").split(" ")[0];
    if (first && new RegExp("@" + first.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(text)) mentions.push(u.id);
  }
  const msg = stamp({
    id: id("dm"), fromId: me, fromName: req.user.fullName, toId: other,
    text, at: new Date().toISOString(), readAt: null,
    attachment: b.attachment && b.attachment.storedAs ? { storedAs: b.attachment.storedAs, name: b.attachment.name, size: b.attachment.size } : null,
    link: b.link && b.link.type ? { type: b.link.type, id: b.link.id || "", label: (b.link.label || "").toString().slice(0, 120) } : null,
    mentions,
  }, req);
  db.dmMessages.push(msg); save();
  audit(req.user, "CREATED", "DirectMessage", msg.id, { to: other });
  chat.deliver(other, { type: "message", message: msg });
  chat.deliver(me, { type: "message", message: msg });   // sync des autres onglets
  res.status(201).json(msg);
});

module.exports = router;
