// Build cloud/ja2-editions.json - the SERVER's allowlist of genuine JA2 data files.
// Source of truth is the engine's own resource packs (fsroot/externalized/resource_packs/*.json),
// which list every file of every supported retail edition with its exact size and MD5. The Cloud
// Locker accepts an upload only if (path, size) matches an entry here, and then verifies the bytes
// against the recorded MD5 - so the locker can only ever hold real game data, never arbitrary bytes.
//
// Run after bumping the resource packs:  node cloud/build-editions.mjs
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.join(import.meta.dirname, '..', 'fsroot', 'externalized', 'resource_packs');
const OUT = path.join(import.meta.dirname, 'ja2-editions.json');

const files = {};   // pathLower -> [{ size, md5 }]  (a name can differ across editions)
let packs = 0, entries = 0;
for (const f of fs.readdirSync(SRC).filter((n) => n.endsWith('.json'))) {
  const pack = JSON.parse(fs.readFileSync(path.join(SRC, f), 'utf8'));
  packs++;
  for (const r of pack.resources || []) {
    const size = r.properties?.file_size, md5 = r.properties?.hash_md5;
    if (!r.path || typeof size !== 'number' || !md5) continue;
    const key = r.path.replace(/\\/g, '/').toLowerCase();
    const list = (files[key] ||= []);
    if (!list.some((e) => e.size === size && e.md5 === md5)) { list.push({ size, md5 }); entries++; }
  }
}
fs.writeFileSync(OUT, JSON.stringify({ generated: new Date().toISOString(), packs, files }));
console.log(`wrote ${OUT}: ${Object.keys(files).length} distinct paths, ${entries} variants, from ${packs} packs`);
