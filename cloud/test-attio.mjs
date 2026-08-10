// Attio capture: inert without a key, correct request shape with one, and a CRM outage must never
// surface as an error on the sign-in path. Run: node cloud/test-attio.mjs
import http from 'node:http';
import { attioCapture } from './attio.mjs';

let fail = 0;
const ok = (n, c) => { if (!c) fail++; console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}`); };

// Stub Attio: records what it was sent.
const seen = [];
const srv = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: JSON.parse(body || '{}') });
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":{}}');
  });
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const baseUrl = `http://127.0.0.1:${srv.address().port}`;
const person = { email: 'player@example.com', name: 'Player One', provider: 'google' };

// 1. No key -> nothing happens at all (no request, no queue, no PII anywhere).
ok('no API key: returns null and sends nothing',
  attioCapture({ apiKey: '', baseUrl }, person) === null && seen.length === 0);

// 2. No email (a provider that withheld it) -> nothing sent.
ok('no email: sends nothing', attioCapture({ apiKey: 'k', baseUrl }, { name: 'x' }) === null && seen.length === 0);

// 3. With a key: one assert, keyed on email so repeats update rather than duplicate.
const sent = await attioCapture({ apiKey: 'secret-key', baseUrl }, person);
const r = seen[0] || {};
ok('sends exactly one request', seen.length === 1);
ok('PUT asserts on email_addresses', r.method === 'PUT' && String(r.url).includes('matching_attribute=email_addresses'));
ok('bearer auth', r.auth === 'Bearer secret-key');
ok('carries the email', r.body?.data?.values?.email_addresses?.[0]?.email_address === 'player@example.com');
ok('carries the display name', r.body?.data?.values?.name?.[0]?.full_name === 'Player One');
ok('only standard attributes', Object.keys(r.body?.data?.values || {}).every((k) => k === 'email_addresses' || k === 'name'));
ok('reports success', sent === true);

// 4. Repeat is the same assert (idempotent), which is what lets us skip a durable outbox.
await attioCapture({ apiKey: 'secret-key', baseUrl }, person);
ok('repeat sends the same assert, not a duplicate shape',
  JSON.stringify(seen[1].body) === JSON.stringify(seen[0].body));

// 5. CRM down: resolves false, never throws - the sign-in path cannot be broken by it.
let threw = false;
const down = await attioCapture({ apiKey: 'k', baseUrl: 'http://127.0.0.1:1' }, person).catch(() => { threw = true; });
ok('CRM unreachable: resolves false and never throws', down === false && !threw);

srv.close();
console.log(fail ? `\n${fail} FAILED` : '\nall attio checks passed');
process.exit(fail ? 1 : 0);
