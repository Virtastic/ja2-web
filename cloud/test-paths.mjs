// The path validator and the known-file list must agree: every path some edition ships has to
// survive safeRelPath, or the API rejects "bad path" for a file it simultaneously claims to know.
// That mismatch is exactly what rejected a real install's 109 .jsd TILECACHE files.
// Run: node cloud/test-paths.mjs
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('./server.js', import.meta.url), 'utf8');
const editions = JSON.parse(readFileSync(new URL('./ja2-editions.json', import.meta.url), 'utf8'));

// Rebuild the gate the same way the server does, then lift safeRelPath out verbatim.
const exts = new Set();
for (const p of Object.keys(editions.files)) { const m = /\.([a-z0-9]+)$/.exec(p); if (m) exts.add(m[1]); }
const DATA_EXT_OK = new RegExp('\\.(' + [...exts].join('|') + ')$', 'i');
const body = src.match(/function safeRelPath\(p, \{ requireDataExt = false \} = \{\}\) \{[\s\S]*?\n\}/)[0];
const safeRelPath = new Function('DATA_EXT_OK', 'path', `${body}; return safeRelPath;`)(DATA_EXT_OK, await import('node:path'));

let bad = [];
for (const p of Object.keys(editions.files)) if (!safeRelPath(p, { requireDataExt: true })) bad.push(p);
console.log(`${Object.keys(editions.files).length} known paths, ${bad.length} rejected by safeRelPath`);
if (bad.length) { bad.slice(0, 15).forEach((b) => console.log('  REJECTED ' + b)); }

// And the gate must still refuse things that are not game data.
const mustFail = ['payload.exe', 'notes.pdf', 'movie.mkv', '../../etc/passwd', 'a\\b.slf', '.hidden.slf'];
const leaks = mustFail.filter((p) => safeRelPath(p, { requireDataExt: true }));
leaks.forEach((l) => console.log('  ACCEPTED (should not be) ' + l));

const fail = bad.length + leaks.length;
console.log(fail ? `\n${fail} FAILED` : '\nthe validator accepts every shipped file and still refuses non-game paths');
process.exit(fail ? 1 : 0);
