// ja2-cloud - OAuth login + game-data & save sync for ja2-web.
// SPDX-License-Identifier: GPL-3.0-or-later | part of ja2-web
//
// Same-origin under ja2.virtastic.app/api/*. Two storage backends, chosen by env:
//   - S3 (OVH Object Storage etc.): the browser transfers DIRECTLY to S3 via presigned URLs; this
//     service only authenticates and mints them, so huge game-data never proxies through it.
//   - local disk (no S3 configured): this service stores blobs itself under DATA_DIR and streams
//     them back on /api/blob/*. Same-origin, so it also sidesteps S3 CORS under COEP. This is the
//     zero-dependency default - a self-hoster with a volume gets the full feature with no object store.
// Either way the client is identical: a presign endpoint returns a URL, the client PUTs/GETs it.
// User records + manifests are small JSON objects; no database.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import path from 'node:path';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const env = process.env;
const BASE_URL = env.BASE_URL || 'http://localhost:8080';
const COOKIE_SECURE = env.COOKIE_SECURE !== '0' && BASE_URL.startsWith('https');
// Dormant-until-configured: with no JWT_SECRET we mint an ephemeral one and run anyway rather than
// crash-looping. Sessions won't survive a restart, but that only matters once OAuth env is provided.
const JWT_SECRET = env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
if (!env.JWT_SECRET) console.warn('JWT_SECRET unset - using an ephemeral key (sessions reset on restart)');
const DEV_AUTH = env.DEV_AUTH === '1';            // enables /api/auth/dev/login for headless E2E
const SESSION_TTL = 60 * 60 * 24 * 30;            // 30 days
const userPrefix = (uid) => `users/${uid}/`;

// ---- Storage backend: S3 when configured, else local disk ---------------------------------------
const USE_S3 = Boolean(env.S3_BUCKET && env.S3_ENDPOINT);
const DATA_DIR = env.DATA_DIR || '/data';

// ---- Abuse limits -------------------------------------------------------------------------------
// Every one of these is enforced SERVER-SIDE. The launcher's "verify against known editions" check is
// a UX nicety only - anyone can call /api/data/presign directly, so nothing here may trust the client.
// Defaults sized for a real JA2 Gold install (~1.5 GB, ~180 files) with headroom, not for hoarding.
const num = (k, d) => (Number.isFinite(Number(env[k])) && Number(env[k]) > 0 ? Number(env[k]) : d);
const MAX_FILE_BYTES  = num('MAX_FILE_BYTES', 512 * 1024 * 1024);        // one object
const MAX_USER_BYTES  = num('MAX_USER_BYTES', 4 * 1024 * 1024 * 1024);   // per account, data + saves
const MAX_USER_FILES  = num('MAX_USER_FILES', 4000);                     // per account
const MAX_SAVE_BYTES  = num('MAX_SAVE_BYTES', 64 * 1024 * 1024);         // one savegame
const MAX_TOTAL_BYTES = num('MAX_TOTAL_BYTES', 100 * 1024 * 1024 * 1024);// whole install (local mode)
// Data files must look like game data. Blocks using the locker as a general file host.
const DATA_EXT_OK = /\.(slf|dat|edt|lua|json|txt|ini|xml|wav|mp3|ogg|sti|pcx|tga|bmp|dds|npc|emi|dlg)$/i;

// A path is only ever accepted if it round-trips through this: no traversal, no absolute, no
// backslashes (Windows separators would smuggle segments past a naive split), no dotfiles, bounded
// depth/length, and a conservative charset. Returns the clean relative path or null.
function safeRelPath(p, { requireDataExt = false } = {}) {
  if (typeof p !== 'string' || !p || p.length > 255) return null;
  if (p.includes('\\') || p.includes('\0')) return null;
  const segs = p.split('/');
  if (segs.length > 8) return null;
  for (const s of segs) {
    if (!s || s === '.' || s === '..' || s.startsWith('.')) return null;
    if (!/^[A-Za-z0-9 ._'()\[\]&+-]+$/.test(s)) return null;
  }
  const clean = segs.join('/');
  if (path.posix.normalize(clean) !== clean) return null;
  if (requireDataExt && !DATA_EXT_OK.test(clean)) return null;
  return clean;
}

// Each backend implements: getJson/putJson/list(prefix)/urlFor(key,op). Local also implements
// readStream/writeStream/del for the /api/blob/* endpoint (S3 clients hit S3 directly instead).
function s3Store() {
  const BUCKET = env.S3_BUCKET;
  const s3 = new S3Client({
    endpoint: env.S3_ENDPOINT, region: env.S3_REGION || 'gra',
    forcePathStyle: env.S3_FORCE_PATH_STYLE === '1',
    credentials: (env.S3_ACCESS_KEY && env.S3_SECRET_KEY)
      ? { accessKeyId: env.S3_ACCESS_KEY, secretAccessKey: env.S3_SECRET_KEY } : undefined,
  });
  return {
    kind: 's3',
    async getJson(key) {
      try { const r = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
            return JSON.parse(await r.Body.transformToString()); }
      catch (e) { if (e?.$metadata?.httpStatusCode === 404 || e?.name === 'NoSuchKey') return null; throw e; }
    },
    putJson(key, obj) {
      return s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: JSON.stringify(obj), ContentType: 'application/json' }));
    },
    async list(prefix) {
      const r = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix }));
      return (r.Contents || []).map((o) => ({ name: o.Key.slice(prefix.length), size: o.Size, mtime: o.LastModified }));
    },
    // A presigned PUT is a capability the browser uses unsupervised, so the SIZE is baked into the
    // signature (ContentLength). S3 then rejects any upload that isn't exactly that many bytes -
    // without this, a presigned PUT is an unlimited write and the quota check below is decorative.
    urlFor(key, op, size) {
      const cmd = op === 'put' ? new PutObjectCommand({ Bucket: BUCKET, Key: key, ContentLength: size })
        : op === 'delete' ? new DeleteObjectCommand({ Bucket: BUCKET, Key: key })
        : new GetObjectCommand({ Bucket: BUCKET, Key: key });
      return getSignedUrl(s3, cmd, { expiresIn: op === 'get' ? 3600 : 900 });
    },
    async usage(prefix) {                                    // {bytes,files} across ALL pages
      let bytes = 0, files = 0, ContinuationToken;
      do {
        const r = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix, ContinuationToken }));
        for (const o of r.Contents || []) { bytes += o.Size || 0; files++; }
        ContinuationToken = r.IsTruncated ? r.NextContinuationToken : undefined;
      } while (ContinuationToken);
      return { bytes, files };
    },
  };
}
function localStore() {
  const abs = (key) => path.join(DATA_DIR, key);
  return {
    kind: 'local',
    async getJson(key) {
      try { return JSON.parse(await fs.readFile(abs(key), 'utf8')); }
      catch (e) { if (e.code === 'ENOENT') return null; throw e; }
    },
    async putJson(key, obj) { await fs.mkdir(path.dirname(abs(key)), { recursive: true }); await fs.writeFile(abs(key), JSON.stringify(obj)); },
    async list(prefix) {                                     // flat listing (saves are flat)
      try {
        const out = [];
        for (const n of await fs.readdir(abs(prefix))) {
          const st = await fs.stat(abs(prefix + n));
          if (st.isFile()) out.push({ name: n, size: st.size, mtime: st.mtime });
        }
        return out;
      } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
    },
    // Encode each segment (JA2 filenames contain spaces) but keep the / separators; Fastify decodes
    // the wildcard param back. op is carried by the HTTP method on the blob route.
    urlFor(key) { return `/api/blob/${key.split('/').map(encodeURIComponent).join('/')}`; },
    readStream(key) { return createReadStream(abs(key)); },
    // Streams to disk with a HARD byte ceiling. Content-Length is a client claim, so the limit is
    // enforced on the bytes actually seen: past `max` we destroy the stream and unlink the partial,
    // so a lying or chunked (no length) upload can't run the disk out.
    async writeStream(key, stream, max) {
      await fs.mkdir(path.dirname(abs(key)), { recursive: true });
      let seen = 0;
      const guard = new Transform({ transform(chunk, _enc, cb) {
        seen += chunk.length;
        if (seen > max) { cb(Object.assign(new Error('too large'), { code: 'ETOOBIG' })); return; }
        cb(null, chunk);
      } });
      try { await pipeline(stream, guard, createWriteStream(abs(key))); }
      catch (e) { await this.del(key).catch(() => {}); throw e; }
      return seen;
    },
    size(key) { return fs.stat(abs(key)).then((s) => s.size).catch(() => null); },
    async del(key) { try { await fs.unlink(abs(key)); } catch (e) { if (e.code !== 'ENOENT') throw e; } },
    async usage(prefix) {                                    // recursive {bytes,files}
      let bytes = 0, files = 0;
      async function walk(dir) {
        let ents; try { ents = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
        for (const e of ents) {
          const p = path.join(dir, e.name);
          if (e.isDirectory()) await walk(p);
          else { const st = await fs.stat(p).catch(() => null); if (st) { bytes += st.size; files++; } }
        }
      }
      await walk(abs(prefix));
      return { bytes, files };
    },
  };
}
const store = USE_S3 ? s3Store() : localStore();

// ---- Minimal HS256 JWT (no extra dep) -----------------------------------------------------------
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const b64uJson = (o) => b64u(JSON.stringify(o));
function jwtSign(payload) {
  const body = { ...payload, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + SESSION_TTL };
  const head = b64uJson({ alg: 'HS256', typ: 'JWT' });
  const data = `${head}.${b64uJson(body)}`;
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(data).digest('base64url');
  return `${data}.${sig}`;
}
function jwtVerify(token) {
  if (!token || token.split('.').length !== 3) return null;
  const [h, p, sig] = token.split('.');
  const expect = crypto.createHmac('sha256', JWT_SECRET).update(`${h}.${p}`).digest('base64url');
  if (sig.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
  const body = JSON.parse(Buffer.from(p, 'base64url').toString());
  if (body.exp && body.exp < Math.floor(Date.now() / 1000)) return null;
  return body;
}

// ---- OAuth providers ----------------------------------------------------------------------------
const PROVIDERS = {
  discord: {
    authorize: 'https://discord.com/oauth2/authorize', token: 'https://discord.com/api/oauth2/token',
    userinfo: 'https://discord.com/api/users/@me', scope: 'identify email',
    id: env.DISCORD_CLIENT_ID, secret: env.DISCORD_CLIENT_SECRET,
    parse: (u) => ({ sub: u.id, name: u.global_name || u.username, email: u.email }),
  },
  google: {
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token',
    userinfo: 'https://openidconnect.googleapis.com/v1/userinfo', scope: 'openid email profile',
    id: env.GOOGLE_CLIENT_ID, secret: env.GOOGLE_CLIENT_SECRET,
    parse: (u) => ({ sub: u.sub, name: u.name || u.email, email: u.email }),
  },
  microsoft: {
    authorize: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    token: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    userinfo: 'https://graph.microsoft.com/oidc/userinfo', scope: 'openid email profile',
    id: env.MICROSOFT_CLIENT_ID, secret: env.MICROSOFT_CLIENT_SECRET,
    parse: (u) => ({ sub: u.sub, name: u.name || u.email, email: u.email }),
  },
};
const redirectUri = (p) => `${BASE_URL}/api/auth/${p}/callback`;
const uidFor = (provider, sub) => crypto.createHash('sha256').update(`${provider}:${sub}`).digest('hex').slice(0, 24);

// ---- Fastify ------------------------------------------------------------------------------------
// Raw-stream body for anything that isn't JSON (the blob PUTs). JSON routes keep the default parser,
// so presign/manifest POSTs are unaffected. bodyLimit high because game-data blobs stream to disk.
// bodyLimit is a backstop for JSON routes; blob PUTs stream and are bounded by MAX_FILE_BYTES.
const app = Fastify({ trustProxy: true, bodyLimit: MAX_FILE_BYTES, logger: { level: env.LOG_LEVEL || 'info' } });
app.addContentTypeParser('*', (req, payload, done) => done(null, payload));
await app.register(cookie);

const setSession = (reply, uid, name) => reply.setCookie('ja2_session', jwtSign({ uid, name }), {
  httpOnly: true, secure: COOKIE_SECURE, sameSite: 'lax', path: '/', maxAge: SESSION_TTL });
const currentUser = (req) => jwtVerify(req.cookies?.ja2_session);
function requireUser(req, reply) {
  const u = currentUser(req);
  if (!u) { reply.code(401).send({ error: 'not signed in' }); return null; }
  return u;
}

// ---- Quota accounting ---------------------------------------------------------------------------
// Walking storage on every presign would be wasteful, so usage is cached briefly per user. Because a
// stale cache would let parallel uploads race past the limit, in-flight bytes are RESERVED at check
// time and released when the write finishes - so N concurrent uploads can't each see the same free
// space. The streaming guard in writeStream is still the last word: this layer is for good errors.
const usageCache = new Map();                                // uid -> {bytes, files, at}
const reserved = new Map();                                  // uid -> [{bytes, at}] in flight
const USAGE_TTL = 10_000;
// A reservation is only a promise to upload soon; a client that presigns and never PUTs must not
// hold space forever. Entries expire with the presigned URL itself (15 min), so this self-heals.
const RESERVE_TTL = 15 * 60_000;
function reservedBytes(uid) {
  const list = (reserved.get(uid) || []).filter((r) => Date.now() - r.at < RESERVE_TTL);
  if (list.length) reserved.set(uid, list); else reserved.delete(uid);
  return list.reduce((n, r) => n + r.bytes, 0);
}
async function usageFor(uid) {
  const hit = usageCache.get(uid);
  if (hit && Date.now() - hit.at < USAGE_TTL) return hit;
  const u = await store.usage(userPrefix(uid));
  const rec = { ...u, at: Date.now() };
  usageCache.set(uid, rec);
  return rec;
}
const bumpUsage = (uid, bytes) => {                          // keep the cache warm after a write
  const h = usageCache.get(uid);
  if (h) { h.bytes += bytes; h.files += bytes > 0 ? 1 : 0; }
};
function release(uid, token) {                                // drop one reservation once its write ends
  const list = (reserved.get(uid) || []).filter((r) => r !== token);
  if (list.length) reserved.set(uid, list); else reserved.delete(uid);
}
// Returns {remaining} when there is room for `incoming` more bytes, else {error,...}. `replacingKey`
// is the object about to be overwritten - its current size doesn't count against the new total.
async function checkQuota(uid, incoming, replacingKey) {
  const u = await usageFor(uid);
  const existing = replacingKey ? ((await store.size?.(replacingKey)) ?? 0) : 0;
  const used = Math.max(0, u.bytes - existing) + reservedBytes(uid);
  if (u.files >= MAX_USER_FILES && !existing)
    return { error: `too many files (max ${MAX_USER_FILES})`, maxFiles: MAX_USER_FILES };
  const remaining = MAX_USER_BYTES - used;
  if (remaining <= 0 || incoming > remaining)
    return { error: `over quota (${MAX_USER_BYTES} bytes per account)`, maxBytes: MAX_USER_BYTES, usedBytes: used };
  if (store.kind === 'local') {                              // whole-install guard: protect the disk
    const total = await totalUsage();
    if (total + incoming > MAX_TOTAL_BYTES) return { error: 'server storage is full', serverFull: true };
  }
  const token = { bytes: Math.max(0, incoming), at: Date.now() };
  reserved.set(uid, [...(reserved.get(uid) || []), token]);
  return { remaining, release: () => release(uid, token) };
}
let totalCache = { bytes: 0, at: 0 };
async function totalUsage() {
  if (Date.now() - totalCache.at < 30_000) return totalCache.bytes;
  const { bytes } = await store.usage('users/');
  totalCache = { bytes, at: Date.now() };
  return bytes;
}

app.get('/api/health', async () => ({ ok: true, storage: store.kind,
  limits: { maxFileBytes: MAX_FILE_BYTES, maxSaveBytes: MAX_SAVE_BYTES, maxUserBytes: MAX_USER_BYTES, maxUserFiles: MAX_USER_FILES },
  providers: Object.fromEntries(Object.entries(PROVIDERS).map(([k, v]) => [k, Boolean(v.id && v.secret)])) }));

app.get('/api/me', async (req, reply) => {
  const u = currentUser(req);
  if (!u) return reply.code(401).send({ error: 'not signed in' });
  const m = await store.getJson(`${userPrefix(u.uid)}data/manifest.json`);
  const use = await usageFor(u.uid).catch(() => ({ bytes: 0, files: 0 }));
  return { uid: u.uid, name: u.name, hasData: Boolean(m?.files?.length),
    usedBytes: use.bytes, usedFiles: use.files, maxBytes: MAX_USER_BYTES, maxFiles: MAX_USER_FILES };
});

// --- OAuth login: redirect to the provider with a signed state cookie (CSRF) ---
app.get('/api/auth/:provider/login', async (req, reply) => {
  const p = PROVIDERS[req.params.provider];
  if (!p) return reply.code(404).send({ error: 'unknown provider' });
  if (!p.id || !p.secret) return reply.code(503).send({ error: `${req.params.provider} OAuth not configured` });
  const state = crypto.randomBytes(16).toString('hex');
  reply.setCookie('ja2_oauth_state', state, { httpOnly: true, secure: COOKIE_SECURE, sameSite: 'lax', path: '/', maxAge: 600 });
  const q = new URLSearchParams({ client_id: p.id, redirect_uri: redirectUri(req.params.provider),
    response_type: 'code', scope: p.scope, state });
  return reply.redirect(`${p.authorize}?${q}`);
});

// --- OAuth callback: verify state, exchange code, fetch userinfo, upsert user, set session ---
app.get('/api/auth/:provider/callback', async (req, reply) => {
  const name = req.params.provider, p = PROVIDERS[name];
  if (!p) return reply.code(404).send({ error: 'unknown provider' });
  const { code, state } = req.query;
  if (!code || !state || state !== req.cookies?.ja2_oauth_state) return reply.code(400).send({ error: 'bad oauth state' });
  reply.clearCookie('ja2_oauth_state', { path: '/' });
  try {
    const tokRes = await fetch(p.token, { method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ client_id: p.id, client_secret: p.secret, grant_type: 'authorization_code',
        code, redirect_uri: redirectUri(name) }) });
    if (!tokRes.ok) throw new Error(`token exchange ${tokRes.status}: ${await tokRes.text()}`);
    const tok = await tokRes.json();
    const uiRes = await fetch(p.userinfo, { headers: { authorization: `Bearer ${tok.access_token}` } });
    if (!uiRes.ok) throw new Error(`userinfo ${uiRes.status}`);
    const info = p.parse(await uiRes.json());
    if (!info.sub) throw new Error('no subject in userinfo');
    const uid = uidFor(name, info.sub);
    await store.putJson(`${userPrefix(uid)}user.json`,
      { uid, provider: name, name: info.name, email: info.email, updated: new Date().toISOString() });
    setSession(reply, uid, info.name || 'player');
    return reply.redirect('/launcher.html');
  } catch (e) {
    app.log.error(e); return reply.code(502).send({ error: 'oauth failed' });
  }
});

// --- Dev-only auth stub for headless E2E (never enabled in prod) ---
if (DEV_AUTH) {
  app.get('/api/auth/dev/login', async (req, reply) => {
    const uid = uidFor('dev', String(req.query.uid || 'test'));
    await store.putJson(`${userPrefix(uid)}user.json`, { uid, provider: 'dev', name: 'Dev User' });
    setSession(reply, uid, 'Dev User');
    return reply.redirect('/launcher.html');
  });
}

app.post('/api/auth/logout', async (req, reply) => { reply.clearCookie('ja2_session', { path: '/' }); return { ok: true }; });

// --- Saves: list + a URL per op (presigned S3, or same-origin /api/blob in local mode) ---
app.get('/api/saves', async (req, reply) => {
  const u = requireUser(req, reply); if (!u) return;
  return { saves: await store.list(`${userPrefix(u.uid)}saves/`) };
});
app.post('/api/saves/presign', async (req, reply) => {
  const u = requireUser(req, reply); if (!u) return;
  const { name, op = 'get' } = req.body || {};
  const clean = safeRelPath(String(name ?? ''));
  if (!clean || clean.includes('/')) return reply.code(400).send({ error: 'bad name' });
  if (op === 'put') {
    const size = Number(req.body?.size);
    if (!Number.isInteger(size) || size < 0 || size > MAX_SAVE_BYTES)
      return reply.code(413).send({ error: `save too large (max ${MAX_SAVE_BYTES} bytes)`, maxBytes: MAX_SAVE_BYTES });
    const room = await checkQuota(u.uid, size, `${userPrefix(u.uid)}saves/${clean}`);
    if (room.error) return reply.code(413).send(room);
  }
  return { url: await store.urlFor(`${userPrefix(u.uid)}saves/${clean}`, op, Number(req.body?.size) || 0) };
});

// --- Game data: manifest (a URL per file) + upload URL + manifest write ---
app.get('/api/data/manifest', async (req, reply) => {
  const u = requireUser(req, reply); if (!u) return;
  const m = await store.getJson(`${userPrefix(u.uid)}data/manifest.json`) || { files: [] };
  const files = await Promise.all(m.files.map(async (f) => ({ ...f,
    url: await store.urlFor(`${userPrefix(u.uid)}data/${f.path}`, 'get') })));
  return { files };
});
app.post('/api/data/presign', async (req, reply) => {
  const u = requireUser(req, reply); if (!u) return;
  const { path: rel, manifest, size } = req.body || {};

  // Manifest write: bounded list of {path,size} that all pass the same path rules, and whose total
  // fits the quota. Stored normalized so a hostile manifest can't smuggle fields or fake sizes.
  if (manifest) {
    const list = Array.isArray(manifest.files) ? manifest.files : null;
    if (!list) return reply.code(400).send({ error: 'bad manifest' });
    if (list.length > MAX_USER_FILES) return reply.code(413).send({ error: `too many files (max ${MAX_USER_FILES})` });
    let total = 0; const files = [];
    for (const f of list) {
      const p = safeRelPath(String(f?.path ?? ''), { requireDataExt: true });
      const sz = Number(f?.size);
      if (!p || !Number.isInteger(sz) || sz < 0 || sz > MAX_FILE_BYTES) return reply.code(400).send({ error: `bad manifest entry: ${String(f?.path).slice(0, 80)}` });
      total += sz; files.push({ path: p, size: sz });
    }
    if (total > MAX_USER_BYTES) return reply.code(413).send({ error: `over quota (max ${MAX_USER_BYTES} bytes)`, maxBytes: MAX_USER_BYTES });
    await store.putJson(`${userPrefix(u.uid)}data/manifest.json`, { files, updated: new Date().toISOString() });
    return { ok: true };
  }

  const clean = safeRelPath(String(rel ?? ''), { requireDataExt: true });
  if (!clean) return reply.code(400).send({ error: 'bad path' });
  const sz = Number(size);
  if (!Number.isInteger(sz) || sz < 0 || sz > MAX_FILE_BYTES)
    return reply.code(413).send({ error: `file too large (max ${MAX_FILE_BYTES} bytes)`, maxBytes: MAX_FILE_BYTES });
  const room = await checkQuota(u.uid, sz, `${userPrefix(u.uid)}data/${clean}`);
  if (room.error) return reply.code(413).send(room);
  return { url: await store.urlFor(`${userPrefix(u.uid)}data/${clean}`, 'put', sz) };
});

// --- Blob endpoint (local storage only): the browser PUTs/GETs/DELETEs here instead of S3. The key
//     comes from the URL, so EVERY constraint is re-checked here (there is no presign signature to
//     trust): the key must be inside the caller's own users/<uid>/ prefix, the path must pass the
//     same rules as presign, and the body is streamed under a hard byte ceiling. ---
if (store.kind === 'local') {
  app.route({ method: ['GET', 'PUT', 'DELETE'], url: '/api/blob/*', handler: async (req, reply) => {
    const u = requireUser(req, reply); if (!u) return;
    const key = req.params['*'] || '';
    const mine = `users/${u.uid}/`;
    if (!key.startsWith(mine)) return reply.code(403).send({ error: 'forbidden' });
    const rest = key.slice(mine.length);                                  // "data/<rel>" | "saves/<name>"
    const m = /^(data|saves)\/(.+)$/s.exec(rest);
    if (!m) return reply.code(403).send({ error: 'forbidden' });
    const isData = m[1] === 'data';
    const clean = safeRelPath(m[2], { requireDataExt: isData });
    if (!clean || (!isData && clean.includes('/'))) return reply.code(400).send({ error: 'bad path' });
    const safeKey = `${mine}${m[1]}/${clean}`;

    if (req.method === 'PUT') {
      if (!req.body || typeof req.body.pipe !== 'function') return reply.code(400).send({ error: 'no body' });
      const cap = isData ? MAX_FILE_BYTES : MAX_SAVE_BYTES;
      // Reject on the declared length first (cheap), then enforce for real while streaming.
      const declared = Number(req.headers['content-length']);
      if (Number.isFinite(declared) && declared > cap) return reply.code(413).send({ error: `too large (max ${cap} bytes)` });
      const room = await checkQuota(u.uid, Number.isFinite(declared) ? declared : 0, safeKey);
      if (room.error) return reply.code(413).send(room);
      try {
        const written = await store.writeStream(safeKey, req.body, Math.min(cap, room.remaining));
        bumpUsage(u.uid, written);
        return { ok: true, size: written };
      } catch (e) {
        if (e?.code === 'ETOOBIG') return reply.code(413).send({ error: 'too large / over quota' });
        throw e;
      } finally { room.release(); }
    }
    if (req.method === 'DELETE') { await store.del(safeKey); return { ok: true }; }
    const size = await store.size(safeKey);
    if (size === null) return reply.code(404).send({ error: 'not found' });
    reply.header('content-type', 'application/octet-stream').header('content-length', size);
    return reply.send(store.readStream(safeKey));
  } });
}

const port = Number(env.PORT || 8080);
app.listen({ port, host: '0.0.0.0' }).then(() =>
  app.log.info(`ja2-cloud on :${port} (base ${BASE_URL}, storage=${store.kind}${store.kind === 'local' ? ` ${DATA_DIR}` : ''}, dev-auth=${DEV_AUTH})`));
