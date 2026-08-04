// ja2-cloud - OAuth login + S3 presign for ja2-web game-data & save sync.
// SPDX-License-Identifier: GPL-3.0-or-later | part of ja2-web
//
// Same-origin under ja2.virtastic.app/api/* (the edge Caddy routes /api/* here). The browser
// transfers game data + saves DIRECTLY to S3 via presigned URLs; this service only authenticates
// and mints those URLs, plus a tiny per-user record/manifest stored as S3 JSON (no DB in v1).
import crypto from 'node:crypto';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const env = process.env;
const BASE_URL = env.BASE_URL || 'http://localhost:8080';
const COOKIE_SECURE = env.COOKIE_SECURE !== '0' && BASE_URL.startsWith('https');
// Dormant-until-configured: with no JWT_SECRET we mint an ephemeral one and run anyway (health + a
// disabled feature), rather than crash-looping. Sessions won't survive a restart, but that only
// matters once real OAuth/S3 env is provided - at which point JWT_SECRET is set too.
const JWT_SECRET = env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
if (!env.JWT_SECRET) console.warn('JWT_SECRET unset - using an ephemeral key (Cloud Locker is dormant until configured)');
const DEV_AUTH = env.DEV_AUTH === '1';            // enables /api/auth/dev/login for headless E2E
const SESSION_TTL = 60 * 60 * 24 * 30;            // 30 days

// ---- S3 (OVH Object Storage, S3-compatible) -----------------------------------------------------
const BUCKET = env.S3_BUCKET;
const s3 = new S3Client({
  endpoint: env.S3_ENDPOINT,                       // e.g. https://s3.gra.io.cloud.ovh.net
  region: env.S3_REGION || 'gra',
  forcePathStyle: env.S3_FORCE_PATH_STYLE === '1',
  credentials: (env.S3_ACCESS_KEY && env.S3_SECRET_KEY)
    ? { accessKeyId: env.S3_ACCESS_KEY, secretAccessKey: env.S3_SECRET_KEY } : undefined,
});
const s3Ready = () => Boolean(BUCKET && env.S3_ENDPOINT);
const userPrefix = (uid) => `users/${uid}/`;

async function s3GetJson(key) {
  try {
    const r = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    return JSON.parse(await r.Body.transformToString());
  } catch (e) { if (e?.$metadata?.httpStatusCode === 404 || e?.name === 'NoSuchKey') return null; throw e; }
}
async function s3PutJson(key, obj) {
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: JSON.stringify(obj), ContentType: 'application/json' }));
}
function presign(cmd, expires = 900) { return getSignedUrl(s3, cmd, { expiresIn: expires }); }

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
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
  const body = JSON.parse(Buffer.from(p, 'base64url').toString());
  if (body.exp && body.exp < Math.floor(Date.now() / 1000)) return null;
  return body;
}

// ---- OAuth providers ----------------------------------------------------------------------------
// Each: authorize + token + userinfo endpoints, scopes, and how to pull a stable sub + display name.
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
const app = Fastify({ trustProxy: true, logger: { level: env.LOG_LEVEL || 'info' } });
await app.register(cookie);

const setSession = (reply, uid, name) => reply.setCookie('ja2_session', jwtSign({ uid, name }), {
  httpOnly: true, secure: COOKIE_SECURE, sameSite: 'lax', path: '/', maxAge: SESSION_TTL });
const currentUser = (req) => jwtVerify(req.cookies?.ja2_session);
function requireUser(req, reply) {
  const u = currentUser(req);
  if (!u) { reply.code(401).send({ error: 'not signed in' }); return null; }
  return u;
}

app.get('/api/health', async () => ({ ok: true, s3: s3Ready(),
  providers: Object.fromEntries(Object.entries(PROVIDERS).map(([k, v]) => [k, Boolean(v.id && v.secret)])) }));

app.get('/api/me', async (req, reply) => {
  const u = currentUser(req);
  if (!u) return reply.code(401).send({ error: 'not signed in' });
  let hasData = false;
  if (s3Ready()) { const m = await s3GetJson(`${userPrefix(u.uid)}data/manifest.json`); hasData = Boolean(m?.files?.length); }
  return { uid: u.uid, name: u.name, hasData };
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
    if (s3Ready()) await s3PutJson(`${userPrefix(uid)}user.json`,
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
    if (s3Ready()) await s3PutJson(`${userPrefix(uid)}user.json`, { uid, provider: 'dev', name: 'Dev User' });
    setSession(reply, uid, 'Dev User');
    return reply.redirect('/launcher.html');
  });
}

app.post('/api/auth/logout', async (req, reply) => { reply.clearCookie('ja2_session', { path: '/' }); return { ok: true }; });

// --- Saves: list + presigned put/get/delete (browser transfers directly to S3) ---
app.get('/api/saves', async (req, reply) => {
  const u = requireUser(req, reply); if (!u) return; if (!s3Ready()) return reply.code(503).send({ error: 'storage not configured' });
  const prefix = `${userPrefix(u.uid)}saves/`;
  const r = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix }));
  return { saves: (r.Contents || []).map((o) => ({ name: o.Key.slice(prefix.length), size: o.Size, mtime: o.LastModified })) };
});
app.post('/api/saves/presign', async (req, reply) => {
  const u = requireUser(req, reply); if (!u) return; if (!s3Ready()) return reply.code(503).send({ error: 'storage not configured' });
  const { name, op = 'get' } = req.body || {};
  if (!name || /[/\\]/.test(name)) return reply.code(400).send({ error: 'bad name' });
  const Key = `${userPrefix(u.uid)}saves/${name}`;
  const cmd = op === 'put' ? new PutObjectCommand({ Bucket: BUCKET, Key })
    : op === 'delete' ? new DeleteObjectCommand({ Bucket: BUCKET, Key })
    : new GetObjectCommand({ Bucket: BUCKET, Key });
  return { url: await presign(cmd) };
});

// --- Game data: manifest (with presigned GETs) + presigned upload PUT ---
app.get('/api/data/manifest', async (req, reply) => {
  const u = requireUser(req, reply); if (!u) return; if (!s3Ready()) return reply.code(503).send({ error: 'storage not configured' });
  const m = await s3GetJson(`${userPrefix(u.uid)}data/manifest.json`) || { files: [] };
  const files = await Promise.all(m.files.map(async (f) => ({ ...f,
    url: await presign(new GetObjectCommand({ Bucket: BUCKET, Key: `${userPrefix(u.uid)}data/${f.path}` }), 3600) })));
  return { files };
});
app.post('/api/data/presign', async (req, reply) => {
  const u = requireUser(req, reply); if (!u) return; if (!s3Ready()) return reply.code(503).send({ error: 'storage not configured' });
  const { path, manifest } = req.body || {};
  if (manifest) { await s3PutJson(`${userPrefix(u.uid)}data/manifest.json`, manifest); return { ok: true }; }
  if (!path || path.includes('..')) return reply.code(400).send({ error: 'bad path' });
  return { url: await presign(new PutObjectCommand({ Bucket: BUCKET, Key: `${userPrefix(u.uid)}data/${path}` }), 3600) };
});

const port = Number(env.PORT || 8080);
app.listen({ port, host: '0.0.0.0' }).then(() => app.log.info(`ja2-cloud on :${port} (base ${BASE_URL}, s3=${s3Ready()}, dev-auth=${DEV_AUTH})`));
