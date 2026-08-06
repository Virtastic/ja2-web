// findDataDir: does it locate the JA2 Data folder for the layouts players actually pick, and does
// it REFUSE to sweep a folder that isn't a game install? Fake File System Access handles: entries()
// yields [name, {kind, entries}] like the real API, and counts how many directories get listed.
// Run: node play/test-finddata.mjs
import { readFileSync } from 'node:fs';

let listed = 0;
const dir = (name, kids) => [name, { kind:'directory', name,
  entries: async function*(){ listed++; for (const k of kids) yield k; } }];
const file = (name) => [name, { kind:'file', name }];
const DATA = () => [file('JAGGED ALLIANCE 2.SLF'), file('SPEECH.SLF'), file('ja2set.dat')];

const src = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const names = src.match(/var DATA_DIR_NAMES = [^\n]+/)[0];
const body  = src.match(/async function findDataDir\(dir, depth\)\{[\s\S]*?\n\}/)[0];
const findDataDir = new Function(`${names}\nreturn (${body.replace(/^async function/, 'async function')});`)();

const cases = [
  ['Data folder itself',            dir('Data', DATA()),                                            true],
  ['game folder',                   dir('Jagged Alliance 2', [file('ja2.exe'), dir('Data', DATA())]), true],
  ['wrapper (gamedata/data)',       dir('gamedata-src', [dir('gamedata', [dir('data', DATA())])]),   true],
  ['GOG linux game/Data',           dir('JA2 Gold', [dir('game', [dir('Data', DATA())])]),           true],
  ['no game data',                  dir('Documents', [dir('taxes', [file('x.pdf')])]),               false],
  ['nested past the bound',         dir('a', [dir('data',[dir('data',[dir('data',[dir('data', DATA())])])])]), false],
];

let fail = 0;
for (const [label, [, handle], expectHit] of cases){
  const got = await findDataDir(handle);
  const ok = expectHit ? !!got : got === null;
  if (!ok) fail++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label} -> ${got ? got.name : 'null'}`);
}

// The safety property: a personal folder full of unrelated subdirectories must cost ONE listing.
// If this regresses to walking everything, a granted handle would enumerate the user's whole tree.
listed = 0;
const home = dir('Home', Array.from({length:40}, (_,i) => dir('folder'+i, [dir('deep', [file('a.txt')])])));
const hit = await findDataDir(home[1]);
const swept = listed > 1 || hit !== null;
if (swept) fail++;
console.log(`  ${swept ? 'FAIL' : 'ok  '} personal folder is not swept (listed ${listed} dir, expected 1)`);

console.log(fail ? `\n${fail} FAILED` : '\nall checks passed');
process.exit(fail ? 1 : 0);
