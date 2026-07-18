// SLA unit test: backdate a step, run scan, expect warning + breach flags + notifications
process.chdir("/tmp/sgrhp-app");
const { db, save, id } = require("/tmp/sgrhp-app/src/store");
const wf = require("/tmp/sgrhp-app/src/workflow");
const hoursAgoBusiness = (h) => { // walk back h business hours
  const d = new Date(); let left = h;
  while (left > 0) { d.setTime(d.getTime() - 3600e3);
    if (d.getDay() >= 1 && d.getDay() <= 5 && d.getHours() > 8 && d.getHours() <= 17) left--; }
  return d.toISOString();
};
db.documents.push({ id: "doc_sla", type: "TEST", refId: "x", title: "SLA test doc",
  createdById: db.users[0].id, createdAt: new Date().toISOString(), status: "SUBMITTED", cycle: 1,
  steps: [{ id: "stp_sla", stage: "CD", assignedAt: hoursAgoBusiness(50), warnedAt: null, breachedAt: null, decidedAt: null }] });
save();
wf.slaScan();
const s = db.documents.find(d => d.id === "doc_sla").steps[0];
console.log(s.warnedAt ? "PASS: 36h warning set" : "FAIL: warning not set");
console.log(s.breachedAt ? "PASS: 48h breach set (imputed to CD)" : "FAIL: breach not set");
const cdUser = db.users.find(u => u.role === "CD");
const n = db.notifications.filter(x => x.userId === cdUser.id && x.ref === "doc_sla");
console.log(n.length >= 2 ? "PASS: CD notified (warning + breach)" : "FAIL: CD notifications " + n.length);
// cleanup
db.documents = db.documents.filter(d => d.id !== "doc_sla"); save();
