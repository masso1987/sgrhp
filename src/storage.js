/**
 * Unified file-storage layer over Local disk, SFTP, Amazon S3 and Azure Blob.
 * Cloud/SFTP SDKs are lazy-required so the app boots even if a dependency isn't installed;
 * a missing dependency only surfaces when that backend is actually used.
 * Backend config comes from db.storageBackends; secrets are decrypted on read.
 */
const fs = require("fs");
const path = require("path");
const { decryptSecret } = require("./crypto");

function needDep(name) {
  try { return require(name); }
  catch (e) { const err = new Error(`Dépendance « ${name} » non installée sur le serveur. Ajoutez-la puis redéployez.`); err.code = "DEP_MISSING"; throw err; }
}

/* ---------------- Local disk ---------------- */
function localAdapter(cfg) {
  const base = path.resolve(cfg.basePath || path.join(__dirname, "..", "data", "storage"));
  const full = (key) => path.join(base, key.replace(/^\/+/, ""));
  return {
    async put(key, buf) { const f = full(key); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, buf); return { key }; },
    async get(key) { return fs.readFileSync(full(key)); },
    async remove(key) { try { fs.unlinkSync(full(key)); } catch (e) {} },
    async list(prefix) {
      const dir = full(prefix || ""); const out = [];
      const walk = (d, rel) => { let ents = []; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
        for (const e of ents) { const p = path.join(d, e.name), r = (rel ? rel + "/" : "") + e.name;
          if (e.isDirectory()) walk(p, r); else { const st = fs.statSync(p); out.push({ key: (prefix ? prefix.replace(/\/$/, "") + "/" : "") + r, size: st.size, mtime: st.mtimeMs }); } } };
      walk(dir, ""); return out;
    },
    async test() { fs.mkdirSync(base, { recursive: true }); const t = path.join(base, ".probe"); fs.writeFileSync(t, "ok"); fs.unlinkSync(t); return { ok: true, detail: "Écriture locale OK (" + base + ")" }; },
  };
}

/* ---------------- SFTP (client's own server) ---------------- */
function sftpAdapter(cfg) {
  const Client = needDep("ssh2-sftp-client");
  const base = (cfg.basePath || "/").replace(/\/$/, "");
  const rp = (key) => (base + "/" + key.replace(/^\/+/, "")).replace(/\/+/g, "/");
  const conn = () => { const opt = { host: cfg.host, port: Number(cfg.port) || 22, username: cfg.user };
    if (cfg.privateKey) opt.privateKey = cfg.privateKey; else opt.password = cfg.password; return opt; };
  const withClient = async (fn) => { const c = new Client(); try { await c.connect(conn()); return await fn(c); } finally { try { await c.end(); } catch (e) {} } };
  return {
    async put(key, buf) { return withClient(async c => { const f = rp(key); const d = f.slice(0, f.lastIndexOf("/")); try { await c.mkdir(d, true); } catch (e) {} await c.put(buf, f); return { key }; }); },
    async get(key) { return withClient(c => c.get(rp(key))); },
    async remove(key) { return withClient(async c => { try { await c.delete(rp(key)); } catch (e) {} }); },
    async list(prefix) { return withClient(async c => { const d = rp(prefix || ""); let items = []; try { items = await c.list(d); } catch (e) { return []; }
      return items.filter(i => i.type === "-").map(i => ({ key: (prefix ? prefix.replace(/\/$/, "") + "/" : "") + i.name, size: i.size, mtime: i.modifyTime })); }); },
    async test() { return withClient(async c => { await c.list(base || "/"); return { ok: true, detail: "Connexion SFTP OK (" + cfg.host + ")" }; }); },
  };
}

/* ---------------- Amazon S3 (and S3-compatible: MinIO, R2, B2) ---------------- */
function s3Adapter(cfg) {
  const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, ListObjectsV2Command } = needDep("@aws-sdk/client-s3");
  const client = new S3Client({ region: cfg.region || "us-east-1",
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    ...(cfg.endpoint ? { endpoint: cfg.endpoint, forcePathStyle: true } : {}) });
  const pre = (cfg.prefix || "").replace(/^\/|\/$/g, "");
  const K = (key) => (pre ? pre + "/" : "") + key.replace(/^\/+/, "");
  const stream2buf = async (s) => { const chunks = []; for await (const c of s) chunks.push(c); return Buffer.concat(chunks); };
  return {
    async put(key, buf) { await client.send(new PutObjectCommand({ Bucket: cfg.bucket, Key: K(key), Body: buf })); return { key }; },
    async get(key) { const r = await client.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: K(key) })); return stream2buf(r.Body); },
    async remove(key) { await client.send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: K(key) })); },
    async list(prefix) { const r = await client.send(new ListObjectsV2Command({ Bucket: cfg.bucket, Prefix: K(prefix || "") }));
      return (r.Contents || []).map(o => ({ key: o.Key.replace(pre ? pre + "/" : "", ""), size: o.Size, mtime: o.LastModified ? o.LastModified.getTime() : 0 })); },
    async test() { await client.send(new ListObjectsV2Command({ Bucket: cfg.bucket, MaxKeys: 1, Prefix: pre })); return { ok: true, detail: "Connexion S3 OK (bucket " + cfg.bucket + ")" }; },
  };
}

/* ---------------- Azure Blob ---------------- */
function azureAdapter(cfg) {
  const { BlobServiceClient, StorageSharedKeyCredential } = needDep("@azure/storage-blob");
  const svc = cfg.connectionString ? BlobServiceClient.fromConnectionString(cfg.connectionString)
    : new BlobServiceClient(`https://${cfg.accountName}.blob.core.windows.net`, new StorageSharedKeyCredential(cfg.accountName, cfg.accountKey));
  const container = svc.getContainerClient(cfg.container);
  const pre = (cfg.prefix || "").replace(/^\/|\/$/g, "");
  const K = (key) => (pre ? pre + "/" : "") + key.replace(/^\/+/, "");
  return {
    async put(key, buf) { await container.createIfNotExists(); await container.getBlockBlobClient(K(key)).uploadData(buf); return { key }; },
    async get(key) { return container.getBlockBlobClient(K(key)).downloadToBuffer(); },
    async remove(key) { try { await container.getBlockBlobClient(K(key)).deleteIfExists(); } catch (e) {} },
    async list(prefix) { const out = []; for await (const b of container.listBlobsFlat({ prefix: K(prefix || "") })) out.push({ key: b.name.replace(pre ? pre + "/" : "", ""), size: (b.properties && b.properties.contentLength) || 0, mtime: b.properties && b.properties.lastModified ? b.properties.lastModified.getTime() : 0 }); return out; },
    async test() { await container.createIfNotExists(); return { ok: true, detail: "Connexion Azure OK (container " + cfg.container + ")" }; },
  };
}

const ADAPTERS = { local: localAdapter, sftp: sftpAdapter, s3: s3Adapter, azure: azureAdapter };

/** Decrypt the secret fields of a stored backend config into a usable plain config. */
function decryptConfig(type, config) {
  const c = Object.assign({}, config || {});
  for (const f of ["password", "secretAccessKey", "accountKey", "connectionString", "privateKey"]) if (c[f]) c[f] = decryptSecret(c[f]);
  return c;
}

/** Build an adapter for a stored backend record { type, config }. */
function adapterFor(backend) {
  if (!backend || !ADAPTERS[backend.type]) throw new Error("Type de stockage inconnu: " + (backend && backend.type));
  return ADAPTERS[backend.type](decryptConfig(backend.type, backend.config));
}

module.exports = { adapterFor, decryptConfig, TYPES: Object.keys(ADAPTERS) };
