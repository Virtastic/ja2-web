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
    urlFor(key, op) {
      const cmd = op === 'put' ? new PutObjectCommand({ Bucket: BUCKET, Key: key })
        : op === 'delete' ? new DeleteObjectCommand({ Bucket: BUCKET, Key: key })
        : new GetObjectCommand({ Bucket: BUCKET, Key: key });
      return getSignedUrl(s3, cmd, { expiresIn: op === 'get' ? 3600 : 900 });
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
    async writeStream(key, stream) { await fs.mkdir(path.dirname(abs(key)), { recursive: true }); await pipeline(stream, createWriteStream(abs(key))); },
    size(key) { return fs.stat(abs(key)).then((s) => s.size).catch(() => null); },
    async del(key) { try { await fs.unlink(abs(key)); } catch (e) { if (e.code !== 'ENOENT') throw e; } },
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
const app = Fastify({ trustProxy: true, bodyLimit: 2 * 1024 * 1024 * 1024, logger: { level: env.LOG_LEVEL || 'info' } });
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

app.get('/api/health', async () => ({ ok: true, storage: store.kind,
  providers: Object.fromEntries(Object.entries(PROVIDERS).map(([k, v]) => [k, Boolean(v.id && v.secret)])) }));

app.get('/api/me', async (req, reply) => {
  const u = currentUser(req);
  if (!u) return reply.code(401).send({ error: 'not signed in' });
  const m = await store.getJson(`${userPrefix(u.uid)}data/manifest.json`);
  return { uid: u.uid, name: u.name, hasData: Boolean(m?.files?.length) };
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
  if (!name || /[/\\]/.test(name)) return reply.code(400).send({ error: 'bad name' });
  return { url: await store.urlFor(`${userPrefix(u.uid)}saves/${name}`, op) };
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
  const { path: rel, manifest } = req.body || {};
  if (manifest) { await store.putJson(`${userPrefix(u.uid)}data/manifest.json`, manifest); return { ok: true }; }
  if (!rel || rel.includes('..')) return reply.code(400).send({ error: 'bad path' });
  return { url: await store.urlFor(`${userPrefix(u.uid)}data/${rel}`, 'put') };
});

// --- Blob endpoint (local storage only): the browser PUTs/GETs/DELETEs here instead of S3. The key
//     is taken from the URL, so it MUST be re-checked against the session uid (no presign signature
//     to rely on) - a user can only touch their own users/<uid>/ prefix. ---
if (store.kind === 'local') {
  app.route({ method: ['GET', 'PUT', 'DELETE'], url: '/api/blob/*', handler: async (req, reply) => {
    const u = requireUser(req, reply); if (!u) return;
    const key = req.params['*'];
    if (!key || key.includes('..') || !key.startsWith(`users/${u.uid}/`)) return reply.code(403).send({ error: 'forbidden' });
    if (req.method === 'PUT') {
      if (!req.body || typeof req.body.pipe !== 'function') return reply.code(400).send({ error: 'no body' });
      await store.writeStream(key, req.body); return { ok: true };
    }
    if (req.method === 'DELETE') { await store.del(key); return { ok: true }; }
    const size = await store.size(key);
    if (size === null) return reply.code(404).send({ error: 'not found' });
    reply.header('content-type', 'application/octet-stream').header('content-length', size);
    return reply.send(store.readStream(key));
  } });
}

const port = Number(env.PORT || 8080);
app.listen({ port, host: '0.0.0.0' }).then(() =>
  app.log.info(`ja2-cloud on :${port} (base ${BASE_URL}, storage=${store.kind}${store.kind === 'local' ? ` ${DATA_DIR}` : ''}, dev-auth=${DEV_AUTH})`));
