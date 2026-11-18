/**
 * Destinations de stockage « cloud grand public » : Google Drive et Dropbox.
 * - Connexion par OAuth 2.0 (bouton « Connecter ») : l'app ne voit jamais le mot de passe du compte,
 *   elle garde un jeton de rafraîchissement chiffré (refreshToken) et en tire des jetons d'accès courts.
 * - Même interface que les autres adaptateurs (src/storage.js) : put / get / remove / list / test,
 *   avec des clés en forme de chemin (« backups/t1/sgrhp_….sgbak », « files/t1/… »).
 * - Google Drive : portée drive.file (l'app ne voit que les fichiers qu'elle a créés). Les dossiers
 *   du chemin sont créés au besoin sous un dossier racine (par défaut « MBOKA Mon RH »).
 * - Dropbox : accès hors ligne (refresh token) ; fichiers sous un dossier (par défaut « /MBOKA Mon RH »,
 *   ou la racine du dossier d'application si l'app Dropbox est en mode « App folder »).
 * Les URL des fournisseurs peuvent être remplacées par variables d'environnement (tests locaux uniquement).
 */
const ENV = process.env;
const G = {
  auth: () => ENV.GDRIVE_AUTH_URL || "https://accounts.google.com/o/oauth2/v2/auth",
  token: () => ENV.GDRIVE_TOKEN_URL || "https://oauth2.googleapis.com/token",
  api: () => (ENV.GDRIVE_API_URL || "https://www.googleapis.com").replace(/\/$/, ""),
  scope: "https://www.googleapis.com/auth/drive.file openid email",
};
const D = {
  auth: () => ENV.DROPBOX_AUTH_URL || "https://www.dropbox.com/oauth2/authorize",
  api: () => (ENV.DROPBOX_API_URL || "https://api.dropboxapi.com").replace(/\/$/, ""),
  content: () => (ENV.DROPBOX_CONTENT_URL || "https://content.dropboxapi.com").replace(/\/$/, ""),
};
const FOLDER_MIME = "application/vnd.google-apps.folder";

function httpError(msg, status, code) { const e = new Error(msg); e.status = status; if (code) e.code = code; return e; }
async function readJson(r) { const t = await r.text(); try { return t ? JSON.parse(t) : {}; } catch (e) { return { raw: t }; } }
function provErr(prov, r, j) {
  const m = (j && (j.error_description || (j.error && (j.error.message || j.error[".tag"] || j.error)) || j.error_summary || j.raw)) || r.statusText;
  const err = httpError(`${prov} : ${typeof m === "string" ? m : JSON.stringify(m)} (HTTP ${r.status})`, r.status);
  if (r.status === 401 || /invalid_grant|expired|revoked/i.test(String(m))) err.code = "RECONNECT";
  return err;
}
const form = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== ""));
const splitKey = (key) => String(key || "").replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);

/* ---------- jetons d'accès (cache mémoire par compte connecté) ---------- */
const tokenCache = new Map();
async function accessToken(prov, cfg) {
  if (!cfg.refreshToken) throw httpError(`${prov === "gdrive" ? "Google Drive" : "Dropbox"} n'est pas encore connecté : cliquez sur « Connecter ».`, 400, "NOT_CONNECTED");
  const ck = prov + ":" + cfg.refreshToken.slice(-24);
  const hit = tokenCache.get(ck); if (hit && hit.exp > Date.now() + 60e3) return hit.token;
  const url = prov === "gdrive" ? G.token() : D.api() + "/oauth2/token";
  const body = prov === "gdrive"
    ? form({ grant_type: "refresh_token", refresh_token: cfg.refreshToken, client_id: cfg.clientId, client_secret: cfg.clientSecret })
    : form({ grant_type: "refresh_token", refresh_token: cfg.refreshToken, client_id: cfg.appKey, client_secret: cfg.appSecret });
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  const j = await readJson(r); if (!r.ok || !j.access_token) throw provErr(prov === "gdrive" ? "Google Drive" : "Dropbox", r, j);
  tokenCache.set(ck, { token: j.access_token, exp: Date.now() + (Number(j.expires_in) || 3600) * 1000 });
  return j.access_token;
}

/* ---------- OAuth : URL d'autorisation et échange du code ---------- */
function authUrl(type, cfg, redirectUri, state) {
  if (type === "gdrive") {
    if (!cfg.clientId) throw httpError("Renseignez l'identifiant client OAuth Google (Client ID).", 400);
    return G.auth() + "?" + form({ client_id: cfg.clientId, redirect_uri: redirectUri, response_type: "code", scope: G.scope,
      access_type: "offline", prompt: "consent", include_granted_scopes: "true", state }).toString();
  }
  if (type === "dropbox") {
    if (!cfg.appKey) throw httpError("Renseignez la clé de l'application Dropbox (App key).", 400);
    return D.auth() + "?" + form({ client_id: cfg.appKey, redirect_uri: redirectUri, response_type: "code", token_access_type: "offline", state }).toString();
  }
  throw httpError("Ce type de destination ne se connecte pas par OAuth.", 400);
}
/** Échange le code d'autorisation : renvoie { refreshToken, account }. */
async function exchangeCode(type, cfg, code, redirectUri) {
  if (type === "gdrive") {
    const r = await fetch(G.token(), { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: cfg.clientId, client_secret: cfg.clientSecret }) });
    const j = await readJson(r); if (!r.ok) throw provErr("Google", r, j);
    if (!j.refresh_token) throw httpError("Google n'a pas renvoyé de jeton hors ligne. Retirez l'accès de l'application dans votre compte Google puis reconnectez.", 400);
    let account = "";
    try { const p = JSON.parse(Buffer.from(String(j.id_token || "").split(".")[1] || "", "base64url").toString("utf8")); account = p.email || ""; } catch (e) {}
    return { refreshToken: j.refresh_token, account };
  }
  const r = await fetch(D.api() + "/oauth2/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: cfg.appKey, client_secret: cfg.appSecret }) });
  const j = await readJson(r); if (!r.ok) throw provErr("Dropbox", r, j);
  if (!j.refresh_token) throw httpError("Dropbox n'a pas renvoyé de jeton hors ligne (refresh token).", 400);
  let account = "";
  try { const a = await fetch(D.api() + "/2/users/get_current_account", { method: "POST", headers: { Authorization: "Bearer " + j.access_token } }); if (a.ok) { const aj = await a.json(); account = aj.email || (aj.name && aj.name.display_name) || ""; } } catch (e) {}
  return { refreshToken: j.refresh_token, account };
}

/* ============================== Google Drive ============================== */
function gdriveAdapter(cfg) {
  const rootName = String(cfg.folderName || "MBOKA Mon RH").trim() || "MBOKA Mon RH";
  const folderCache = new Map(); // "a/b" -> id
  const q = (s) => String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  async function call(method, url, opts) {
    opts = opts || {}; const tok = await accessToken("gdrive", cfg);
    const r = await fetch(url, { method, headers: Object.assign({ Authorization: "Bearer " + tok }, opts.headers || {}), body: opts.body });
    if (opts.raw) { if (!r.ok) throw provErr("Google Drive", r, await readJson(r)); return r; }
    const j = await readJson(r); if (!r.ok) throw provErr("Google Drive", r, j); return j;
  }
  async function findChild(parentId, name, folder) {
    const cond = [`name = '${q(name)}'`, `'${parentId}' in parents`, "trashed = false", folder ? `mimeType = '${FOLDER_MIME}'` : `mimeType != '${FOLDER_MIME}'`].join(" and ");
    const j = await call("GET", G.api() + "/drive/v3/files?" + form({ q: cond, fields: "files(id,name,size,modifiedTime)", pageSize: "10", spaces: "drive" }).toString());
    return (j.files || [])[0] || null;
  }
  async function folderId(segs, create) {
    let parent = "root", path = "";
    for (const seg of [rootName].concat(segs)) {
      path = path ? path + "/" + seg : seg;
      if (folderCache.has(path)) { parent = folderCache.get(path); continue; }
      let f = await findChild(parent, seg, true);
      if (!f) { if (!create) return null;
        f = await call("POST", G.api() + "/drive/v3/files?fields=id", { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: seg, mimeType: FOLDER_MIME, parents: [parent] }) }); }
      folderCache.set(path, f.id); parent = f.id;
    }
    return parent;
  }
  async function fileOf(key, create) { const segs = splitKey(key); const name = segs.pop(); const pid = await folderId(segs, create); if (!pid) return { pid: null, name, file: null }; return { pid, name, file: await findChild(pid, name, false) }; }
  return {
    async put(key, buf) {
      const { pid, name, file } = await fileOf(key, true);
      // téléversement « resumable » en une seule requête : convient aux gros fichiers (archives de sauvegarde)
      const init = file
        ? await call("PATCH", G.api() + "/upload/drive/v3/files/" + file.id + "?uploadType=resumable", { raw: true, headers: { "Content-Type": "application/json; charset=UTF-8", "X-Upload-Content-Type": "application/octet-stream" }, body: JSON.stringify({}) })
        : await call("POST", G.api() + "/upload/drive/v3/files?uploadType=resumable", { raw: true, headers: { "Content-Type": "application/json; charset=UTF-8", "X-Upload-Content-Type": "application/octet-stream" }, body: JSON.stringify({ name, parents: [pid] }) });
      const session = init.headers.get("location"); if (!session) throw httpError("Google Drive : session de téléversement non ouverte.", 502);
      const r = await fetch(session, { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: buf });
      if (!r.ok) throw provErr("Google Drive", r, await readJson(r));
      return { key };
    },
    async get(key) {
      const { file } = await fileOf(key, false); if (!file) throw httpError("Fichier introuvable sur Google Drive : " + key, 404);
      const r = await call("GET", G.api() + "/drive/v3/files/" + file.id + "?alt=media", { raw: true });
      return Buffer.from(await r.arrayBuffer());
    },
    async remove(key) { try { const { file } = await fileOf(key, false); if (file) await call("DELETE", G.api() + "/drive/v3/files/" + file.id, { raw: true }); } catch (e) {} },
    async list(prefix) {
      const segs = splitKey(prefix); const start = await folderId(segs, false); if (!start) return [];
      const out = []; const queue = [[start, segs.join("/")]];
      while (queue.length) {
        const [fid, rel] = queue.shift(); let pageToken;
        do {
          const j = await call("GET", G.api() + "/drive/v3/files?" + form({ q: `'${fid}' in parents and trashed = false`, fields: "nextPageToken,files(id,name,mimeType,size,modifiedTime)", pageSize: "1000", spaces: "drive", pageToken }).toString());
          for (const f of j.files || []) {
            const k = (rel ? rel + "/" : "") + f.name;
            if (f.mimeType === FOLDER_MIME) queue.push([f.id, k]); else out.push({ key: k, size: Number(f.size) || 0, mtime: f.modifiedTime ? Date.parse(f.modifiedTime) : 0 });
          }
          pageToken = j.nextPageToken;
        } while (pageToken);
      }
      return out;
    },
    async test() {
      await folderId([], true);
      let who = cfg.account || "";
      try { const a = await call("GET", G.api() + "/drive/v3/about?fields=user(emailAddress)"); who = (a.user && a.user.emailAddress) || who; } catch (e) {}
      return { ok: true, detail: `Connexion Google Drive OK${who ? " (" + who + ")" : ""} — dossier « ${rootName} »` };
    },
  };
}

/* ================================ Dropbox ================================ */
function dropboxAdapter(cfg) {
  const base = ("/" + String(cfg.folder == null ? "MBOKA Mon RH" : cfg.folder).trim().replace(/^\/+|\/+$/g, "")).replace(/^\/$/, "");
  const P = (key) => base + "/" + splitKey(key).join("/");
  // l'en-tête Dropbox-API-Arg doit rester en ASCII : on échappe les caractères accentués en \uXXXX
  const argHeader = (o) => JSON.stringify(o).replace(/[\u007f-￿]/g, c => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
  async function rpc(path, args) {
    const tok = await accessToken("dropbox", cfg);
    const r = await fetch(D.api() + "/2/" + path, { method: "POST", headers: { Authorization: "Bearer " + tok, "Content-Type": "application/json" }, body: JSON.stringify(args) });
    const j = await readJson(r); if (!r.ok) { const e = provErr("Dropbox", r, j); e.summary = j.error_summary || ""; throw e; } return j;
  }
  async function content(path, args, body) {
    const tok = await accessToken("dropbox", cfg);
    const r = await fetch(D.content() + "/2/" + path, { method: "POST", headers: Object.assign({ Authorization: "Bearer " + tok, "Dropbox-API-Arg": argHeader(args) }, body !== undefined ? { "Content-Type": "application/octet-stream" } : {}), body });
    if (!r.ok) { const j = await readJson(r); const e = provErr("Dropbox", r, j); e.summary = j.error_summary || ""; throw e; }
    return r;
  }
  const CHUNK = 8 * 1024 * 1024, SINGLE_MAX = 140 * 1024 * 1024;
  return {
    async put(key, buf) {
      const path = P(key);
      if (buf.length <= SINGLE_MAX) { await content("files/upload", { path, mode: "overwrite", mute: true }, buf); return { key }; }
      // gros fichier : session de téléversement par morceaux de 8 Mo
      const start = await (await content("files/upload_session/start", { close: false }, buf.subarray(0, CHUNK))).json();
      let off = CHUNK;
      while (buf.length - off > CHUNK) { await content("files/upload_session/append_v2", { cursor: { session_id: start.session_id, offset: off }, close: false }, buf.subarray(off, off + CHUNK)); off += CHUNK; }
      await content("files/upload_session/finish", { cursor: { session_id: start.session_id, offset: off }, commit: { path, mode: "overwrite", mute: true } }, buf.subarray(off));
      return { key };
    },
    async get(key) { const r = await content("files/download", { path: P(key) }); return Buffer.from(await r.arrayBuffer()); },
    async remove(key) { try { await rpc("files/delete_v2", { path: P(key) }); } catch (e) {} },
    async list(prefix) {
      const root = splitKey(prefix).length ? P(prefix) : base; const out = [];
      let j; try { j = await rpc("files/list_folder", { path: root, recursive: true }); } catch (e) { if (/not_found/.test(e.summary || e.message)) return []; throw e; }
      for (;;) {
        for (const en of j.entries || []) if (en[".tag"] === "file") {
          const rel = en.path_display.slice(base.length).replace(/^\/+/, "");
          out.push({ key: rel, size: en.size || 0, mtime: en.server_modified ? Date.parse(en.server_modified) : 0 });
        }
        if (!j.has_more) break; j = await rpc("files/list_folder/continue", { cursor: j.cursor });
      }
      return out;
    },
    async test() {
      let who = cfg.account || "";
      try { const tok = await accessToken("dropbox", cfg); const a = await fetch(D.api() + "/2/users/get_current_account", { method: "POST", headers: { Authorization: "Bearer " + tok } }); if (a.ok) { const aj = await a.json(); who = aj.email || who; } } catch (e) { if (e.code === "NOT_CONNECTED" || e.code === "RECONNECT") throw e; }
      if (base) { try { await rpc("files/create_folder_v2", { path: base, autorename: false }); } catch (e) { if (!/conflict/.test(e.summary || e.message)) throw e; } }
      await rpc("files/list_folder", { path: base, limit: 1 });
      return { ok: true, detail: `Connexion Dropbox OK${who ? " (" + who + ")" : ""} — dossier « ${base || "/"} »` };
    },
  };
}

module.exports = { gdriveAdapter, dropboxAdapter, authUrl, exchangeCode, OAUTH_TYPES: ["gdrive", "dropbox"] };
