// Every row the upload wizard draws must be able to reach "done": rows are ticked when all THEIR
// files have uploaded, so a row covering files this copy does not have would sit pending forever and
// a finished upload would look unfinished. Run: node play/test-checklist.mjs [data-folder]
import fs from 'node:fs';
import path from 'node:path';

const src = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const body = src.match(/function cloudNeededRows\(ed, have\)\{[\s\S]*?\n\}/)[0];
const cloudNeededRows = new Function(`${body}; return cloudNeededRows;`)();
const rowKeyFor = (p) => { const i = p.indexOf('/'); return i < 0 ? p : p.slice(0, i) + '/'; };

const eds = JSON.parse(fs.readFileSync(new URL('./data-manifests.json', import.meta.url), 'utf8')).editions;
const root = process.argv[2] || 'gamedata-src/gamedata/data';
if (!fs.existsSync(root)) { console.log(`no data folder at ${root} - skipping`); process.exit(0); }

const have = {};
(function walk(d, pre) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name), rel = (pre ? pre + '/' : '') + e.name;
    if (e.isDirectory()) walk(p, rel);
    else have[rel.toLowerCase()] = { size: fs.statSync(p).size, rel };
  }
})(root, '');

let best = null;
for (const ed of eds) { let m = 0; for (const p of Object.keys(ed.files)) if (have[p]) m++;
  if (!best || m > best.m) best = { ed, m }; }

// What the wizard will draw, and what it will actually upload.
const rows = cloudNeededRows(best.ed, have);
const uploading = Object.keys(best.ed.files).filter((p) => have[p]);
const willTick = new Set(uploading.map(rowKeyFor));

const orphans = rows.filter((r) => !willTick.has(r.name.toLowerCase()));
console.log(`${best.ed.name}`);
console.log(`  files present: ${uploading.length} of ${Object.keys(best.ed.files).length}`);
console.log(`  rows drawn:    ${rows.length}`);
console.log(`  rows that can never tick: ${orphans.length}`);
orphans.forEach((o) => console.log(`     ${o.name}`));

// And the old behaviour must still be reproducible, so the regression is actually pinned.
const oldRows = cloudNeededRows(best.ed);
const oldOrphans = oldRows.filter((r) => !willTick.has(r.name.toLowerCase())).length;
console.log(`  (drawing from the full edition list instead would strand ${oldOrphans} rows)`);

if (orphans.length) { console.log('\nFAILED'); process.exit(1); }
if (!oldOrphans) console.log('  note: this copy is complete, so the bug would not show with it');
console.log('\nevery drawn row is completable');
