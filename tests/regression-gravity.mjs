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
const parts = ['let S = null; const _g = {x:0,y:0,z:0};',
  'const SCALE_K = ' + main.match(/const SCALE_K = ([^;]+);/)[1] + ';',
  extractConst(main, 'SYSTEMS')];
for (const fn of ['orbitState', 'addOrbitState', 'makeBody', 'buildSystemPlanets', 'dynStep', 'gravityAt', 'stepBody', 'stepPlanet']) parts.push(extractFunc(main, fn));
parts.push(orderBlock);
parts.push(';module.exports = { SCALE_K, SYSTEMS, orbitState, addOrbitState, makeBody, buildSystemPlanets, dynStep, gravityAt, stepBody, stepPlanet, ' + fnNames.join(', ') + ', setS:(s)=>{S=s;} };');
const mod = { exports: {} };
new Function('module', 'exports', parts.join('\n'))(mod, mod.exports);
const H = mod.exports;
const clone = o => JSON.parse(JSON.stringify(o));
let failures = 0;
const check = (label, cond) => { console.log((cond ? 'PASS' : 'FAIL') + '  ' + label); if (!cond) failures++; };

// --- build the TRUE prologue state: exact copy of loadPrologueSystem() + startPrologue() ---
function buildPrologueState() {
  const sys = H.SYSTEMS[0];
  const planets = H.buildSystemPlanets(sys);
  const tsumugi = planets[1];
  const station = H.makeBody(H.addOrbitState(tsumugi, H.orbitState(tsumugi.gm, 520000, 0.9, 0, 0)), 0x2dd4bf, 11, 'ステーション「あおば」', 0);
  const ship = H.makeBody({ x: station.x, y: station.y, z: station.z, vx: station.vx, vy: station.vy, vz: station.vz }, 0x6ea8ff, 5, 'ship', 0);
  const moon = planets.find(p => p.isMoon) || planets[1];
  return { sys, planets, station, ship, target: moon };
}

const S = buildPrologueState();
H.setS(S);

// (1) gravityAt at a planet's own position must be finite (the original NaN source)
{ const out = { x: 0, y: 0, z: 0 }; H.gravityAt(S.planets[1].x, S.planets[1].y, S.planets[1].z, out);
  check('gravityAt at planet own position is finite', [out.x, out.y, out.z].every(Number.isFinite)); }

// (2) worst-case stepping for 2 ship-days (172800 s) using planet-aware dynStep:
//     planets via stepPlanet AND target (moon) ALSO via stepBody — nothing may NaN.
{ let finite = true;
  const twoDays = 2 * 86400;
  for (let t = 0; t < twoDays && finite; ) {
    const h = Math.min(H.dynStep(S.ship.x, S.ship.y, S.ship.z, S.sys.starGM, S.planets), twoDays - t);
    t += h;
    for (const p of S.planets) H.stepPlanet(p, h);
    H.stepBody(S.station, h, null);
    H.stepBody(S.target, h, null); // worst-case: target moon ALSO stepped via stepBody
    H.stepBody(S.ship, h, null);
    for (const b of [S.ship, S.station, ...S.planets]) if (![b.x, b.y, b.z, b.vx, b.vy, b.vz].every(Number.isFinite)) finite = false;
  }
  check('2 ship-days worst-case stepping (dynStep): all bodies finite', finite); }

// (3) the estimator must succeed from the TRUE docked initial state (fresh build)
{ const S0 = buildPrologueState();
  const est = H.computePlanEstimate(clone(S0.ship), clone(S0.target), S0.sys.starGM, 1.0, { arrivalDist: 12000, needDock: false, planets: clone(S0.planets) });
  check('prologue estimate from true docked state (moon, arrivalDist 12000): std ok', est.ok === true); }

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);
