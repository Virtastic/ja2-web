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
import { attioCapture } from './attio.mjs';
import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const env = process.env;
const BASE_URL = env.BASE_URL || 'http://localhost:8080';
const COOKIE_SECURE = env.COOKIE_SECURE !== '0' && BASE_URL.startsWith('https');
// Dormant-until-configured: with no JWT_SECRET we mint an ephemeral one and run anyway rather than
// crash-looping. Sessions won't survive a restart, but that only matters once OAuth env is provided.
const JWT_SECRET = env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
if (!env.JWT_SECRET) console.warn('JWT_SECRET unset - using an ephemeral key (sessions reset on restart)');
// ---- Attio CRM capture (see cloud/attio.mjs for the design + privacy note) ----------------------
const ATTIO = { apiKey: env.ATTIO_API_KEY || '', baseUrl: env.ATTIO_BASE_URL || 'https://api.attio.com' };

const DEV_AUTH = env.DEV_AUTH === '1';            // enables /api/auth/dev/login for headless E2E
// Sessions last one BROWSER session, like openmw-web: the cookie carries no Max-Age so it dies when
// the browser closes, and the JWT expires after a day as the backstop for browsers that restore
// session cookies (Chrome's "continue where you left off"). Sign-in is one Google click, so the
// cost of asking again is low and a stolen cookie ages out fast.
const SESSION_TTL = 60 * 60 * 24;                 // 1 day (JWT backstop; cookie is session-scoped)
// Root prefix inside the bucket. Prod and dev MUST NOT share one: they issue sessions from different
// JWT secrets and dev may run with DEV_AUTH, so a shared root would let a dev login read production
// lockers. Set S3_PREFIX=dev/ (or use separate buckets) for any non-production instance.
const ROOT_PREFIX = env.S3_PREFIX ? `${env.S3_PREFIX.replace(/^\/+|\/+$/g, '')}/` : '';
const userPrefix = (uid) => `${ROOT_PREFIX}users/${uid}/`;

// ---- Storage backend: S3 when configured, else local disk ---------------------------------------
// S3 needs ALL of endpoint+bucket+credentials. A half-filled config (bucket set, keys still blank)
// would otherwise select S3 and fail every request at runtime, so it falls back to local disk with
// a loud warning instead - a working locker beats a broken one.
const S3_PARTIAL = Boolean(env.S3_BUCKET || env.S3_ENDPOINT || env.S3_ACCESS_KEY || env.S3_SECRET_KEY);
const USE_S3 = Boolean(env.S3_BUCKET && env.S3_ENDPOINT && env.S3_ACCESS_KEY && env.S3_SECRET_KEY);
if (S3_PARTIAL && !USE_S3) console.warn('S3 is only partly configured (need endpoint+bucket+access+secret) - using local disk storage');
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
// Data files must look like game data. Blocks using the locker as a general file host. The set is
// DERIVED from the editions manifest below (every extension some edition actually ships) rather than
// hand-listed: a guessed list silently rejected the 109 .jsd files in a real install's TILECACHE as
// "bad path" while the very same files were on the known-file list. The literal is only the fallback
// for when the manifest is missing (VERIFY_DATA off / file absent).
let DATA_EXT_OK = /\.(slf|dat|edt|jsd|gap|bin|sti|npc|wav|lua|json|txt|ini|xml|mp3|ogg|pcx|tga|bmp|dds|emi|dlg)$/i;

// ---- "Is this actually JA2 data?" ---------------------------------------------------------------
// Two tiers, because Jagged Alliance 2 shipped in many builds while the engine's resource packs
// record hashes for only five of them (cloud/build-editions.mjs generates the list; installs we
// have confirmed genuine can contribute variants via cloud/add-observed.mjs):
//
//   1. the client's hash matches a recorded build  -> accepted and marked verified.
//   2. the name is one some edition ships AND the size is within SIZE_TOLERANCE of a recorded size
//      -> accepted as an unrecognised build. This is what lets a patched or regional copy work.
//
// Anything else is refused. Demanding tier 1 outright rejected a real GOG copy over a single
// patched archive, and no public hash list exists to close that gap, so tier 2 is the pragmatic
// floor. The bytes land in a private, per-account, quota-bounded prefix, so a wrong file only ever
// costs its owner space. VERIFY_DATA=0 turns both tiers off (unlisted or heavily modded installs).
const VERIFY_DATA = env.VERIFY_DATA !== '0';
const SIZE_TOLERANCE = Number.isFinite(Number(env.SIZE_TOLERANCE)) && Number(env.SIZE_TOLERANCE) > 0
  ? Number(env.SIZE_TOLERANCE) : 0.05;                       // +/- 5%
let EDITIONS = { files: {} };
try { EDITIONS = JSON.parse(await fs.readFile(new URL('./ja2-editions.json', import.meta.url), 'utf8')); }
catch { console.warn('ja2-editions.json missing - game-data verification disabled'); }
const EDITION_PATHS = Object.keys(EDITIONS.files).length;
if (EDITION_PATHS) {                                          // keep the gate in step with the data
  const exts = new Set();
  for (const p of Object.keys(EDITIONS.files)) { const m = /\.([a-z0-9]+)$/.exec(p); if (m) exts.add(m[1]); }
  if (exts.size) DATA_EXT_OK = new RegExp('\\.(' + [...exts].join('|') + ')$', 'i');
}
const variantsOf = (rel) => EDITIONS.files[String(rel).toLowerCase()] || [];
// Returns how a file was accepted: 'exact' (hash matches a recorded build), 'size' (known name,
// plausible size), or null when it is not game data we know at all. `hash` is client-supplied, so
// it can only ever UPGRADE trust - a wrong or absent hash simply falls through to the size tier.
function classify(rel, size, hash) {
  const variants = variantsOf(rel);
  if (!variants.length) return null;
  if (hash && variants.some((v) => v.md5 === String(hash).toLowerCase())) return 'exact';
  const ok = variants.some((v) => Math.abs(v.size - size) <= v.size * SIZE_TOLERANCE);
  return ok ? 'size' : null;
}
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
    // ETag of a single-part PUT is the object's MD5 - that is how S3 mode verifies contents it never
    // saw. Multipart ETags carry a "-<parts>" suffix and are NOT an MD5; the caller must treat those
    // as unverifiable rather than trusting them.
    async head(key) {
      try {
        const r = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
        return { size: r.ContentLength, etag: String(r.ETag || '').replace(/"/g, '') };
      } catch (e) { if (e?.$metadata?.httpStatusCode === 404 || e?.name === 'NotFound') return null; throw e; }
    },
    del(key) { return s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key })); },
    size(key) { return this.head(key).then((h) => h?.size ?? null); },
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
  // Reject tokens minted under an older, longer TTL (the 30-day cookies): their lifespan gives
  // them away, so nobody has to clear cookies by hand when the policy tightens.
  if (body.exp - body.iat > SESSION_TTL) return null;
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
    // MICROSOFT_TENANT defaults to "common" (any Microsoft account). A single-tenant app registration
    // rejects /common with AADSTS50194, so point it at the directory (tenant) ID in that case.
    authorize: `https://login.microsoftonline.com/${env.MICROSOFT_TENANT || 'common'}/oauth2/v2.0/authorize`,
    token: `https://login.microsoftonline.com/${env.MICROSOFT_TENANT || 'common'}/oauth2/v2.0/token`,
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
  httpOnly: true, secure: COOKIE_SECURE, sameSite: 'lax', path: '/' });   // no maxAge: session cookie
const currentUser = (req) => jwtVerify(req.cookies?.ja2_session);
function requireUser(req, reply) {
  const u = currentUser(req);
  if (!u) { reply.code(401).send({ error: 'not signed in' }); return null; }
  // Sliding renewal: any request in the back half of the token's life gets a fresh cookie, so an
  // ACTIVE player never expires mid-game (save sync fires every few minutes) - only a browser left
  // idle for the full TTL does. Renewal is capped by the session cookie itself dying on close.
  if (u.exp - Math.floor(Date.now() / 1000) < SESSION_TTL / 2) setSession(reply, u.uid, u.name);
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
// hold space forever, so entries expire. The TTL is deliberately short: once the upload lands, the
// next usage refresh counts the real bytes, and a long-lived reservation would double-count them
// and spuriously exhaust the quota partway through a legitimate multi-file upload.
const RESERVE_TTL = 120_000;
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
// `reserve` holds the space until the write finishes. Only S3 mode needs it: there the server never
// sees the upload, so the reservation is the only record until usage refreshes. In local mode the
// blob PUT does the real accounting - reserving at presign too would double-count every file.
async function checkQuota(uid, incoming, replacingKey, reserve = false) {
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
  if (!reserve) return { remaining, release: () => {} };
  const token = { bytes: Math.max(0, incoming), at: Date.now() };
  reserved.set(uid, [...(reserved.get(uid) || []), token]);
  return { remaining, release: () => release(uid, token) };
}
let totalCache = { bytes: 0, at: 0 };
async function totalUsage() {
  if (Date.now() - totalCache.at < 30_000) return totalCache.bytes;
  const { bytes } = await store.usage(`${ROOT_PREFIX}users/`);
  totalCache = { bytes, at: Date.now() };
  return bytes;
}

app.get('/api/health', async () => ({ ok: true, storage: store.kind,
  verifyData: Boolean(VERIFY_DATA && EDITION_PATHS), knownFiles: EDITION_PATHS, sizeTolerance: SIZE_TOLERANCE, crm: Boolean(ATTIO.apiKey),
  limits: { maxFileBytes: MAX_FILE_BYTES, maxSaveBytes: MAX_SAVE_BYTES, maxUserBytes: MAX_USER_BYTES, maxUserFiles: MAX_USER_FILES },
  providers: Object.fromEntries(Object.entries(PROVIDERS).map(([k, v]) => [k, Boolean(v.id && v.secret)])) }));

app.get('/api/me', async (req, reply) => {
  const u = requireUser(req, reply); if (!u) return;   // same 401 + the sliding renewal
  // Deliberately does NOT compute usage: that is a full bucket listing per call (~1.2s against S3),
  // and this endpoint is on the launcher's first paint. Ask for it explicitly with ?usage=1.
  const m = await store.getJson(`${userPrefix(u.uid)}data/manifest.json`);
  const out = { uid: u.uid, name: u.name, hasData: Boolean(m?.files?.length),
    maxBytes: MAX_USER_BYTES, maxFiles: MAX_USER_FILES };
  if (req.query?.usage === '1') {
    const use = await usageFor(u.uid).catch(() => ({ bytes: 0, files: 0 }));
    out.usedBytes = use.bytes; out.usedFiles = use.files;
  }
  return out;
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
    // Not awaited: sign-in must not wait on the CRM.
    attioCapture({ ...ATTIO, log: (lvl, msg, meta) => app.log[lvl](meta, msg) },
      { email: info.email, name: info.name, provider: name });
    setSession(reply, uid, info.name || 'player');
    return reply.redirect('/index.html?src=cloud');   // straight into the game - the launcher was just the door
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
    return reply.redirect('/index.html?src=cloud');   // straight into the game - the launcher was just the door
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
    const room = await checkQuota(u.uid, size, `${userPrefix(u.uid)}saves/${clean}`, store.kind === "s3");
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
  const { path: rel, manifest, size, md5 } = req.body || {};

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
      let how = 'unchecked';
      if (VERIFY_DATA && EDITION_PATHS) {
        how = classify(p, sz, f?.md5);
        if (!how) return reply.code(422).send({ error: `not a recognized Jagged Alliance 2 data file: ${p}`, notGameData: true });
      }
      // Keep the hash: the client caches uploaded bytes by content, so this is what lets a later
      // session recognise a file it already has instead of pulling it back out of storage.
      const hex = /^[a-f0-9]{32}$/i.test(String(f?.md5 || '')) ? String(f.md5).toLowerCase() : undefined;
      total += sz; files.push({ path: p, size: sz, verified: how === 'exact', ...(hex ? { md5: hex } : {}) });
    }
    if (total > MAX_USER_BYTES) return reply.code(413).send({ error: `over quota (max ${MAX_USER_BYTES} bytes)`, maxBytes: MAX_USER_BYTES });

    // S3 mode never sees the bytes, so confirm here that every listed object actually exists and is
    // the size the client claimed - a manifest must not point at objects that were never uploaded.
    // Contents are not hashed: see the note on editions above (many builds, few recorded hashes).
    if (store.kind === 's3') {
      const missing = [];
      await Promise.all(files.map(async (f) => {
        const h = await store.head(`${userPrefix(u.uid)}data/${f.path}`).catch(() => null);
        if (!h || h.size !== f.size) missing.push(f.path);
      }));
      if (missing.length) return reply.code(422).send({
        error: `these files were not uploaded: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ` (+${missing.length - 5} more)` : ''}`,
        files: missing });
    }
    await store.putJson(`${userPrefix(u.uid)}data/manifest.json`, { files, updated: new Date().toISOString() });
    return { ok: true };
  }

  const clean = safeRelPath(String(rel ?? ''), { requireDataExt: true });
  if (!clean) return reply.code(400).send({ error: 'bad path' });
  const sz = Number(size);
  if (!Number.isInteger(sz) || sz < 0 || sz > MAX_FILE_BYTES)
    return reply.code(413).send({ error: `file too large (max ${MAX_FILE_BYTES} bytes)`, maxBytes: MAX_FILE_BYTES });
  // Tier 1 (hash matches a recorded build) or tier 2 (known name, size within tolerance).
  let how = 'unchecked';
  if (VERIFY_DATA && EDITION_PATHS) {
    how = classify(clean, sz, md5);
    if (!how) return reply.code(422).send({
      error: `not a recognized Jagged Alliance 2 data file: ${clean}`, notGameData: true });
  }
  const room = await checkQuota(u.uid, sz, `${userPrefix(u.uid)}data/${clean}`, store.kind === "s3");
  if (room.error) return reply.code(413).send(room);
  // ContentLength is still bound into the signature, so a presigned PUT cannot be used to write
  // more than it asked for. No Content-MD5: that would pin the upload to one known build.
  return { url: await store.urlFor(`${userPrefix(u.uid)}data/${clean}`, 'put', sz), verified: how === 'exact' };
});

// --- Blob endpoint (local storage only): the browser PUTs/GETs/DELETEs here instead of S3. The key
//     comes from the URL, so EVERY constraint is re-checked here (there is no presign signature to
//     trust): the key must be inside the caller's own users/<uid>/ prefix, the path must pass the
//     same rules as presign, and the body is streamed under a hard byte ceiling. ---
if (store.kind === 'local') {
  app.route({ method: ['GET', 'PUT', 'DELETE'], url: '/api/blob/*', handler: async (req, reply) => {
    const u = requireUser(req, reply); if (!u) return;
    const key = req.params['*'] || '';
    const mine = userPrefix(u.uid);
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
      // Game data must be a file some supported edition ships. Contents are not hashed (many builds);
      // saves are the user's own bytes anyway. Size + quota are the bounds for both.
      if (isData && VERIFY_DATA && EDITION_PATHS
          && !classify(clean, Number(req.headers['content-length']) || 0, req.headers['x-ja2-md5']))
        return reply.code(422).send({ error: `not a recognized Jagged Alliance 2 data file: ${clean}`, notGameData: true });
      const room = await checkQuota(u.uid, Number.isFinite(declared) ? declared : 0, safeKey, true);
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
