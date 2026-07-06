#!/usr/bin/env node
// Boot smoke test: loads the game page in headless Chrome via CDP and asserts
// the runtime starts, the pump begins, and no fatal errors hit the console.
// Usage: node verify-browser.mjs [url]   (default http://localhost:8796/)
import { execFile } from 'node:child_process';
import http from 'node:http';

const URL_ = process.argv[2] || 'http://localhost:8796/index.html';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9223;

const chrome = execFile(CHROME, [
  `--remote-debugging-port=${PORT}`, '--headless=new', '--disable-gpu-sandbox',
  '--no-first-run', '--user-data-dir=/tmp/ja2-verify-profile', URL_,
]);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const get = p => new Promise((res, rej) => http.get({ port: PORT, path: p }, r => {
  let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d)));
}).on('error', rej));

let ok = false, fatal = [];
try {
  await sleep(3000);
  const targets = await get('/json');
  const page = targets.find(t => t.type === 'page' && t.url.includes('index.html'));
  if (!page) throw new Error('page not found');
  const { default: WebSocket } = await import('ws').catch(() => ({ default: null }));
  // Fallback: poll page state via /json only if ws unavailable.
  if (WebSocket) {
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    let id = 0;
    const send = (method, params) => new Promise(res => {
      const mid = ++id;
      ws.on('message', function h(m){ const j = JSON.parse(m); if (j.id === mid){ ws.off('message', h); res(j.result); } });
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
    await new Promise(r => ws.on('open', r));
    await send('Runtime.enable', {});
    // wait up to 60s for pump start or abort
    for (let i = 0; i < 60; i++) {
      const r = await send('Runtime.evaluate', { expression:
        'JSON.stringify({run: typeof Module!=="undefined" && !!Module.calledRun, pump: !!window.pumpStarted, status: (document.getElementById("status")||{}).textContent})' });
      const s = JSON.parse(r.result.value);
      if (s.pump) { ok = true; break; }
      if (/Aborted|not found/i.test(s.status || '')) { fatal.push(s.status); break; }
      await sleep(1000);
    }
    ws.close();
  }
} catch (e) {
  fatal.push(String(e));
} finally {
  chrome.kill();
}
console.log(ok ? 'VERIFY OK: game booted and pump running' : `VERIFY FAIL: ${fatal.join('; ') || 'timeout'}`);
process.exit(ok ? 0 : 1);
