#!/usr/bin/env node
// Headless-Chrome CDP driver for the JA2 wasm port — independent of the
// claude-in-chrome extension. Persistent Chrome on a debug port; each
// invocation connects, runs one command, disconnects.
//
//   node harness.mjs launch [url]      launch headless Chrome + navigate
//   node harness.mjs shot <file.png>   screenshot the page
//   node harness.mjs click <x> <y>     dispatch a real mouse click
//   node harness.mjs eval "<expr>"     evaluate JS, print JSON result
//   node harness.mjs title             print document.title
//   node harness.mjs ls <key>          print localStorage[key]
//   node harness.mjs kill              kill the launched Chrome
import { execFile, spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';

const PORT = 9333;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PROFILE = '/tmp/ja2-cdp-profile';
const PIDFILE = '/tmp/ja2-cdp.pid';
const cmd = process.argv[2];

const httpGet = (path) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: PORT, path }, r => {
    let d = ''; r.on('data', c => d += c); r.on('end', () => res(d));
  }).on('error', rej);
});
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getPageWs() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = JSON.parse(await httpGet('/json'));
      const page = list.find(t => t.type === 'page' && /localhost/.test(t.url)) || list.find(t => t.type === 'page');
      if (page && page.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch (e) {}
    await sleep(250);
  }
  throw new Error('no page target');
}

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  const ready = new Promise(r => ws.addEventListener('open', () => r()));
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, m => m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result));
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  return { ready, send, close: () => ws.close() };
}

async function withPage(fn) {
  const wsUrl = await getPageWs();
  const c = cdp(wsUrl);
  await c.ready;
  try { return await fn(c); } finally { c.close(); }
}

async function evalExpr(c, expr) {
  const r = await c.send('Runtime.evaluate', {
    expression: expr, returnByValue: true, awaitPromise: true, timeout: 60000,
  });
  if (r.exceptionDetails) return { __error: r.exceptionDetails.text || 'exception' };
  return r.result.value;
}

if (cmd === 'wipe') {
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) {}
  console.log('wiped profile'); process.exit(0);
}

if (cmd === 'launch') {
  const url = process.argv[3] || 'http://localhost:8790/test.html';
  // NB: profile is NOT wiped here — localStorage (crash log) must survive a
  // renderer crash so we can read it after relaunch. Use `wipe` explicitly.
  // HEADED (not --headless): headless Chrome's SharedArrayBuffer/pthreads path
  // is flaky and hard-crashes the renderer; a real headed window is as stable
  // as the extension's Chrome but under our own reliable CDP control.
  const headless = process.env.JA2_HEADLESS === '1';
  const child = spawn(CHROME, [
    `--remote-debugging-port=${PORT}`, ...(headless ? ['--headless=new'] : []),
    '--no-first-run', '--no-default-browser-check',
    '--window-size=1280,960', `--user-data-dir=${PROFILE}`,
    '--enable-features=SharedArrayBuffer',
    url,
  ], { detached: true, stdio: 'ignore' });
  child.unref();
  fs.writeFileSync(PIDFILE, String(child.pid));
  // wait until a page target answers
  await getPageWs();
  console.log('launched pid', child.pid, '->', url);
  process.exit(0);
}

if (cmd === 'kill') {
  try { const pid = +fs.readFileSync(PIDFILE, 'utf8'); process.kill(-pid, 'SIGKILL'); } catch (e) {}
  try { execFile('pkill', ['-f', 'ja2-cdp-profile']); } catch (e) {}
  console.log('killed'); process.exit(0);
}

if (cmd === 'logs') {
  // Stream ALL console output + JS/wasm exceptions + browser log entries to a
  // file, live, until killed. This is how we see real engine errors instead of
  // guessing. Run in background:  node harness.mjs logs /tmp/ja2-console.log &
  const out = process.argv[3] || '/tmp/ja2-console.log';
  const stream = fs.createWriteStream(out, { flags: 'a' });
  const wsUrl = await getPageWs();
  const c = cdp(wsUrl);
  await c.ready;
  const line = (t) => { stream.write(`[${new Date().toISOString().slice(11,19)}] ${t}\n`); };
  // wire events before enabling
  const wsRaw = c; // reuse send; but we need raw events -> re-open a listener
  // Simpler: use a fresh socket with an event handler.
  const sock = new WebSocket(wsUrl);
  let idn = 0;
  const call = (m, p={}) => sock.send(JSON.stringify({ id: ++idn, method: m, params: p }));
  sock.addEventListener('open', () => { call('Runtime.enable'); call('Log.enable'); });
  sock.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.consoleAPICalled') {
      const txt = (m.params.args||[]).map(a => a.value ?? a.description ?? a.type).join(' ');
      line(`console.${m.params.type}: ${txt}`);
    } else if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      line(`EXCEPTION: ${d.text} ${d.exception?.description||''}`);
    } else if (m.method === 'Log.entryAdded') {
      const e = m.params.entry;
      line(`log[${e.level}/${e.source}]: ${e.text}`);
    }
  });
  sock.addEventListener('close', () => { line('=== socket closed (renderer likely crashed) ==='); stream.end(); process.exit(0); });
  line('=== log capture started ===');
  // keep alive
  await new Promise(() => {});
}

await withPage(async c => {
  if (cmd === 'shot') {
    const file = process.argv[3] || '/tmp/ja2-shot.png';
    // Capture in CSS pixels (clip scale=1) so screenshot coords == click coords,
    // regardless of the display's device-pixel ratio.
    const m = await evalExpr(c, 'JSON.stringify({w:window.innerWidth,h:window.innerHeight})');
    const { w, h } = JSON.parse(m);
    // Force device-scale-factor 1 so the PNG is CSS-sized (px == click coords).
    await c.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    const r = await c.send('Page.captureScreenshot', { format: 'png' });
    await c.send('Emulation.clearDeviceMetricsOverride');
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    console.log('saved', file, `${w}x${h}`);
  } else if (cmd === 'click') {
    const x = +process.argv[3], y = +process.argv[4];
    // JA2 tracks the cursor via MOUSE_POS events, so move there first (twice, to
    // ensure the button's hover region registers) before pressing.
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await sleep(40);
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await sleep(40);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await c.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, buttons: 1 });
      await sleep(50);
    }
    console.log('click', x, y);
  } else if (cmd === 'batch') {
    // One CDP connection, many clicks. Each arg is "x,y[,delayMs]".
    const clickAt = async (x, y) => {
      await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }); await sleep(40);
      await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }); await sleep(40);
      await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 }); await sleep(50);
      await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 1 });
    };
    for (const arg of process.argv.slice(3)) {
      const [x, y, d] = arg.split(',').map(Number);
      await clickAt(x, y);
      await sleep(d || 1500);
    }
    console.log('batch done', process.argv.length - 3, 'clicks');
  } else if (cmd === 'move') {
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: +process.argv[3], y: +process.argv[4] });
    console.log('moved');
  } else if (cmd === 'key') {
    // Real key events via CDP so SDL2 receives them (synthetic DOM events don't).
    // Usage: key <keyName> [char]   e.g. key Escape   |   key Enter \n   |  key a a
    const keyName = process.argv[3];
    const text = process.argv[4];
    const codeMap = { Escape: 'Escape', Enter: 'Enter', Backspace: 'Backspace', Tab: 'Tab', Space: 'Space' };
    const windowsVK = { Escape: 27, Enter: 13, Backspace: 8, Tab: 9, Space: 32 };
    const isChar = keyName.length === 1;
    const base = {
      key: keyName,
      code: isChar ? 'Key' + keyName.toUpperCase() : (codeMap[keyName] || keyName),
      windowsVirtualKeyCode: isChar ? keyName.toUpperCase().charCodeAt(0) : (windowsVK[keyName] || 0),
    };
    await c.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, text: text ?? (isChar ? keyName : undefined) });
    await sleep(30);
    await c.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    console.log('key', keyName);
  } else if (cmd === 'type') {
    for (const ch of (process.argv[3] || '')) {
      await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, text: ch, windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0), code: 'Key' + ch.toUpperCase() });
      await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code: 'Key' + ch.toUpperCase() });
      await sleep(40);
    }
    console.log('typed');
  } else if (cmd === 'eval') {
    console.log(JSON.stringify(await evalExpr(c, process.argv[3])));
  } else if (cmd === 'title') {
    console.log(await evalExpr(c, 'document.title'));
  } else if (cmd === 'ls') {
    console.log(await evalExpr(c, `localStorage.getItem(${JSON.stringify(process.argv[3])})`));
  } else {
    console.log('unknown command', cmd);
  }
});
process.exit(0);
