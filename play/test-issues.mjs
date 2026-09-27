// Regression checks for reported bugs. Run: node play/test-issues.mjs
import fs from 'node:fs';
import assert from 'node:assert';

const src = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');

// #6: the shop draws across the whole framebuffer, so it must use the battle (full-frame) layout.
const consts = src.match(/var EDIT_SCREEN = [^\n]*/)[0];
const isFullFrame = new Function(`${consts}
${src.match(/function isFullFrame\(screen\)\{[^\n]*\}/)[0]}
return isFullFrame;`)();
for (const s of [5, 19, 0, 11]) assert(isFullFrame(s), `screen ${s} is full-frame`);           // tactical, shop, editor, editor file dialog
for (const s of [9, 10, 15, 16, 17, 18, 21, -1]) assert(!isFullFrame(s), `screen ${s} is centered UI`); // map, laptop, menu, autoresolve, save/load, options, init-options, pre-boot

// #8 / hosted data: only the engine's own files live in the versioned e/<hash>/ dir.
const __ENGINE_DIR = 'e/abc/';
const locateFile = eval('(' + src.match(/locateFile: (function\(path\)\{[^\n]*\}),/)[1] + ')');
assert.equal(locateFile('ja2.wasm'), 'e/abc/ja2.wasm');
assert.equal(locateFile('ja2.data'), 'e/abc/ja2.data');
assert.equal(locateFile('ja2.js'), 'e/abc/ja2.js');
assert.equal(locateFile('ja2-gamedata.data'), 'ja2-gamedata.data');

// #8: server.py must not bounce /index.html back to the launcher.
const py = fs.readFileSync(new URL('./server.py', import.meta.url), 'utf8');
assert(!/'\/index\.html'\)/.test(py.match(/if LAUNCHER and[^\n]*/)[0]), 'server.py gates only /');

console.log('ok');
