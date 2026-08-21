/**
 * SGRHP — messagerie temps réel (WebSocket) pour messages directs entre utilisateurs.
 * Auth par JWT (?token=), routage par utilisateur, multi-onglets. Aucune entrée requise
 * du client pour la v1 : le serveur pousse les nouveaux messages.
 */
const url = require("url");
const { verifyToken } = require("./auth");

const clients = new Map();   // userId -> Set(ws)
let wss = null;

function attach(server) {
  let WebSocketServer;
  try { ({ WebSocketServer } = require("ws")); }
  catch (e) { console.warn("[chat] module 'ws' indisponible — messagerie temps réel désactivée"); return; }
  wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    let parsed; try { parsed = url.parse(req.url, true); } catch { socket.destroy(); return; }
    if (parsed.pathname !== "/ws") return;                     // ignore other upgrades
    const user = verifyToken((parsed.query && parsed.query.token) || "");
    if (!user) { try { socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n"); } catch {} socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws._uid = user.id; ws._tid = user.tenantId || "t1";
      if (!clients.has(user.id)) clients.set(user.id, new Set());
      clients.get(user.id).add(ws);
      ws.on("close", () => { const s = clients.get(user.id); if (s) { s.delete(ws); if (!s.size) clients.delete(user.id); } });
      ws.on("error", () => {});
      try { ws.send(JSON.stringify({ type: "ready" })); } catch {}
    });
  });
}
function deliver(userId, payload) {
  const s = clients.get(userId); if (!s) return;
  const data = JSON.stringify(payload);
  for (const ws of s) { try { ws.send(data); } catch {} }
}
function online(userId) { return clients.has(userId); }
module.exports = { attach, deliver, online };
