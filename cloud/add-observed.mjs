// Record variants seen in a REAL install that the engine's resource packs don't list.
//
// The packs cover five editions; the game shipped in more. When a folder is overwhelmingly a match
// for a known edition, the handful of files that differ are almost certainly a legitimate patched or
// re-released build - not tampering - and recording them lets those installs verify exactly instead
// of falling back to the size-tolerance path. Entries are marked `observed` so it stays obvious
// which hashes came from upstream and which we learned locally.
//
// Usage: node cloud/add-observed.mjs <path-to-Data-folder> [--min-match 0.9] [--write]
// Without --write it only reports.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const dirArg = process.argv[2];
if (!dirArg) { console.error('usage: node cloud/add-observed.mjs <Data folder> [--write]'); process.exit(1); }
const WRITE = process.argv.includes('--write');
const MIN_MATCH = Number((process.argv.find((a) => a.startsWith('--min-match=')) || '').split('=')[1] || 0.9);

const OUT = new URL('./ja2-editions.json', import.meta.url);
const manifest = JSON.parse(fs.readFileSync(OUT, 'utf8'));

const md5 = (p) => new Promise((res, rej) => {
  const h = crypto.createHash('md5');
  fs.createReadStream(p).on('data', (d) => h.update(d)).on('end', () => res(h.digest('hex'))).on('error', rej);
});

// Walk the folder, keyed the same way the manifest is (relative path, lowercased).
const found = [];
(function walk(d, pre) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name), rel = (pre ? pre + '/' : '') + e.name;
    if (e.isDirectory()) walk(p, rel);
    else found.push({ rel, key: rel.toLowerCase(), size: fs.statSync(p).size, path: p });
  }
})(dirArg, '');

// Only trust a folder that is already overwhelmingly a known edition: that is what makes the odd
// file out "a different build of this game" rather than "an unknown file someone handed us".
let exact = 0, known = 0;
const news = [];
for (const f of found) {
  const variants = manifest.files[f.key];
  if (!variants) continue;
  known++;
  const hash = await md5(f.path);
  if (variants.some((v) => v.size === f.size && v.md5 === hash)) { exact++; continue; }
  news.push({ ...f, md5: hash });
}
const ratio = known ? exact / known : 0;
console.log(`${found.length} files, ${known} known names, ${exact} hash-exact (${(ratio * 100).toFixed(1)}%)`);

if (ratio < MIN_MATCH) {
  console.error(`refusing: only ${(ratio * 100).toFixed(1)}% of known files hash-match, below ${(MIN_MATCH * 100)}%.`);
  console.error('That is not confidently a genuine install, so its variants are not worth recording.');
  process.exit(1);
}
if (!news.length) { console.log('nothing new: every known file already matches a recorded hash.'); process.exit(0); }

console.log('\nvariants not in any recorded edition:');
for (const n of news) console.log(`  ${n.rel}  ${n.size} bytes  md5 ${n.md5}`);
if (!WRITE) { console.log('\n(dry run - pass --write to record these)'); process.exit(0); }

for (const n of news) manifest.files[n.key].push({ size: n.size, md5: n.md5, observed: true });
manifest.observedAdded = (manifest.observedAdded || 0) + news.length;
fs.writeFileSync(OUT, JSON.stringify(manifest));
console.log(`\nrecorded ${news.length} variant(s) into ja2-editions.json`);
