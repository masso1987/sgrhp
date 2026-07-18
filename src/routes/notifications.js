const router = require("express").Router();
const { db, save } = require("../store");

router.get("/", (req, res) => {
  const mine = db.notifications.filter(n => n.userId === req.user.id).reverse().slice(0, 50);
  res.json({ unread: mine.filter(n => !n.readAt).length, items: mine });
});
router.post("/read-all", (req, res) => {
  db.notifications.filter(n => n.userId === req.user.id && !n.readAt)
    .forEach(n => n.readAt = new Date().toISOString());
  save(); res.json({ ok: true });
});
module.exports = router;
