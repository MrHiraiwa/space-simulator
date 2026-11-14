// Regression: planet self-gravity NaN (v0.3 launch blocker, fixed 2026-11-15).
//
// Root cause: gravityAt()/fullAccFn() computed pa = gm/(d2*d) with d2 = 0 when
// a body is evaluated AT a planet's own position — and in the prologue the
// plan target IS a planet (S.target = S.planets[1]), stepped via stepBody.
// pa became Infinity, Infinity*0 = NaN, and one NaN planet then poisoned
// every other body's gravity, killing the whole world ~0.1 s before the
// first plan panel opened (all variants showed 「成立せず」, dv 0).
//
// This test extracts the REAL functions from game.html (no reimplementation),
// builds the TRUE prologue initial state (exact loadPrologueSystem values),
// steps it with the worst-case pattern (target planet ALSO stepped via
// stepBody), and asserts: no NaN anywhere, and the plan estimator succeeds
// from that true state. Run: node tests/regression-gravity.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const html = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'game.html'), 'utf8');
const blocks = []; const re = /<script>([\s\S]*?)<\/script>/g; let m;
while ((m = re.exec(html)) !== null) blocks.push(m[1]);
const main = blocks.sort((a, b) => b.length - a.length)[0];
function extractBalanced(src, s) { let d = 0, i = s, str = null, esc = false; for (; i < src.length; i++) { const c = src[i]; if (str) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === str) str = null; continue; } if (c === '"' || c === "'" || c === '`') { str = c; continue; } if (c === '{' || c === '[' || c === '(') d++; if (c === '}' || c === ']' || c === ')') { d--; if (d === 0) return src.slice(s, i + 1); } } return null; }
function extractFunc(src, name) { const idx = src.indexOf('function ' + name + '('); if (idx < 0) throw new Error('missing function ' + name); const brace = src.indexOf('{', idx); return src.slice(idx, brace) + extractBalanced(src, brace); }
function extractConst(src, name) { const idx = src.indexOf('const ' + name + ' ='); const start = src.indexOf('[', idx); return src.slice(idx, start) + extractBalanced(src, start) + ';'; }
const a = main.indexOf('/* ==== ORDER LOGIC (pure) ==== */'); const b = main.indexOf('/* ==== /ORDER LOGIC ==== */');
if (a < 0 || b < 0) { console.error('FAIL: ORDER LOGIC markers missing'); process.exit(1); }
const orderBlock = main.slice(a, b);
const fnNames = [...orderBlock.matchAll(/function (\w+)\(/g)].map(x => x[1]);
const parts = ['let S = null; const _g = {x:0,y:0,z:0};', extractConst(main, 'SYSTEMS')];
for (const fn of ['orbitState', 'makeBody', 'gravityAt', 'stepBody', 'stepPlanet']) parts.push(extractFunc(main, fn));
parts.push(orderBlock);
parts.push(';module.exports = { SYSTEMS, orbitState, makeBody, gravityAt, stepBody, stepPlanet, ' + fnNames.join(', ') + ', setS:(s)=>{S=s;} };');
const mod = { exports: {} };
new Function('module', 'exports', parts.join('\n'))(mod, mod.exports);
const H = mod.exports;
const clone = o => JSON.parse(JSON.stringify(o));
let failures = 0;
const check = (label, cond) => { console.log((cond ? 'PASS' : 'FAIL') + '  ' + label); if (!cond) failures++; };

// --- build the TRUE prologue state: exact copy of loadPrologueSystem() ---
const sys = H.SYSTEMS[0];
const S = { sys, planets: sys.planets.map((p, i) => H.makeBody(H.orbitState(sys.starGM, p.r, 0.7 + i * 1.35, p.inc, p.node), p.color, p.r > 250 ? 9 : 7, p.name, p.gm)) };
S.station = H.makeBody(H.orbitState(20000, 185, 0.55, 1, 0), 0x2dd4bf, 11, 'ステーション「あおば」', 0);
{ const st = H.orbitState(20000, 185, 0.42, 1, 0); st.vx *= 0.92; st.vy *= 0.92; st.vz *= 0.92; S.ship = H.makeBody(st, 0x6ea8ff, 5, 'ship', 0); }
S.target = S.planets[1]; // what startPrologueSteps() does at briefing end
H.setS(S);

// (1) gravityAt at a planet's own position must be finite (the original NaN source)
{ const out = { x: 0, y: 0, z: 0 }; H.gravityAt(S.planets[1].x, S.planets[1].y, S.planets[1].z, out);
  check('gravityAt at planet own position is finite', [out.x, out.y, out.z].every(Number.isFinite)); }

// (2) worst-case stepping for 120 s: planets via stepPlanet AND the target
//     planet ALSO via stepBody (pre-fix physics pattern) — nothing may NaN.
{ let finite = true;
  for (let t = 0; t < 120 && finite; t += 0.05) {
    for (const p of S.planets) H.stepPlanet(p, 0.05);
    H.stepBody(S.station, 0.05, null);
    H.stepBody(S.target, 0.05, null); // target IS planets[1]
    H.stepBody(S.ship, 0.05, null);
    for (const b of [S.ship, S.station, ...S.planets]) if (![b.x, b.y, b.z, b.vx, b.vy, b.vz].every(Number.isFinite)) finite = false;
  }
  check('120 s worst-case stepping: all bodies finite', finite); }

// (3) the estimator must succeed from the TRUE initial state (fresh build)
{ const S0 = { sys, planets: sys.planets.map((p, i) => H.makeBody(H.orbitState(sys.starGM, p.r, 0.7 + i * 1.35, p.inc, p.node), p.color, 7, p.name, p.gm)) };
  const st = H.orbitState(20000, 185, 0.42, 1, 0); st.vx *= 0.92; st.vy *= 0.92; st.vz *= 0.92;
  const ship0 = H.makeBody(st, 0, 5, 'ship', 0);
  const est = H.computePlanEstimate(clone(ship0), clone(S0.planets[1]), sys.starGM, 1.0, { arrivalDist: 70, needDock: false, planets: clone(S0.planets) });
  check('prologue estimate from true initial state: std ok', est.ok === true); }

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);
