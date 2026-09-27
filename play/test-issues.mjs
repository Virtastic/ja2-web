// Regression checks for reported bugs. Run: node play/test-issues.mjs
import fs from 'node:fs';
import assert from 'node:assert';

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
const src = read('./index.html');

// #6: screens drawn across the whole framebuffer (tactical, shop, editor, ...) use the full-frame layout.
const consts = src.match(/var EDIT_SCREEN = [^\n]*/)[0] + '\n' + src.match(/var FULL_FRAME_DEV = [^\n]*/)[0];
const isFullFrame = new Function(`${consts}
${src.match(/function isFullFrame\(screen\)\{[^\n]*\}/)[0]}
return isFullFrame;`)();
for (const s of [5, 19, 0, 11]) assert(isFullFrame(s), `screen ${s} is full-frame`);           // tactical, shop, editor, editor file dialog
for (const s of [9, 10, 15, 16, 17, 18, 21, -1]) assert(!isFullFrame(s), `screen ${s} is centered UI`); // map, laptop, menu, autoresolve, save/load, options, init-options, pre-boot

// The engine clamps popups/tooltips to VisibleUIArea(); its full-frame list must match the page's.
let next = 0;
const ids = [...read('../source-ja2/src/game/ScreenIDs.h').matchAll(/^\s*(\w+_SCREEN)\s*(?:=\s*(\d+))?,/gm)]
  .map(([, name, v]) => { const id = v !== undefined ? +v : next; next = id + 1; return [name, id]; });
const vis = read('../source-ja2/src/game/UILayout.cc').match(/SGPBox VisibleUIArea\(\)[\s\S]*?return full;/)[0];
const engineFull = [...vis.matchAll(/case (\w+):/g)].map((m) => m[1]);
for (const [name, id] of ids)
  if (name !== 'MSG_BOX_SCREEN' && name !== 'FADE_SCREEN')   // overlays: keep the underlying mode
    assert.equal(isFullFrame(id), engineFull.includes(name), `${name} (${id}): page and engine disagree`);

// #8 / hosted data: only the engine's own files live in the versioned e/<hash>/ dir.
const __ENGINE_DIR = 'e/abc/';
const locateFile = eval('(' + src.match(/locateFile: (function\(path\)\{[^\n]*\}),/)[1] + ')');
assert.equal(locateFile('ja2.wasm'), 'e/abc/ja2.wasm');
assert.equal(locateFile('ja2.data'), 'e/abc/ja2.data');
assert.equal(locateFile('ja2.js'), 'e/abc/ja2.js');
assert.equal(locateFile('ja2-gamedata.data'), 'ja2-gamedata.data');

// #8: server.py must not bounce /index.html back to the launcher.
const py = read('./server.py');
assert(!/'\/index\.html'\)/.test(py.match(/if LAUNCHER and[^\n]*/)[0]), 'server.py gates only /');

console.log('ok');
