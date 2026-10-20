const router = require("express").Router();
const { db, save } = require("../store");

router.get("/", (req, res) => {
  const mine = db.notifications.filter(n => n.userId === req.user.id).reverse().slice(0, 50);
  res.json({ unread: mine.filter(n => !n.readAt).length, items: mine });
});
router.post("/read-all", (req, res) => {
  db.notifications.filter(n => n.userId === req.user.id && !n.readAt)
    .forEach(n => n.readAt = new Date().toISOString());
  save();
  res.json({ ok: true, unread: 0 });
});
/* Marquer UNE notification comme lue / non lue (le compteur se met à jour côté client). */
router.post("/:id/read", (req, res) => {
  const n = db.notifications.find(x => x.id === req.params.id && x.userId === req.user.id);
  if (!n) return res.status(404).json({ error: "Notification introuvable" });
  n.readAt = new Date().toISOString(); save();
  res.json({ ok: true, unread: db.notifications.filter(x => x.userId === req.user.id && !x.readAt).length });
});
router.post("/:id/unread", (req, res) => {
  const n = db.notifications.find(x => x.id === req.params.id && x.userId === req.user.id);
  if (!n) return res.status(404).json({ error: "Notification introuvable" });
  n.readAt = null; save();
  res.json({ ok: true, unread: db.notifications.filter(x => x.userId === req.user.id && !x.readAt).length });
});
/* Compteur seul (pour rafraîchir la pastille). */
router.get("/count", (req, res) => {
  res.json({ unread: db.notifications.filter(n => n.userId === req.user.id && !n.readAt).length });
});
module.exports = router;
