// Scale verification suite (v0.6 real-scale Sol + planet-centric prologue).
// Extracts the REAL constants and physics/estimator functions from game.html.
// Run: node tests/verify-scale.mjs
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

const parts = [
  'let S = null;',
  'const SCALE_K = ' + main.match(/const SCALE_K = ([^;]+);/)[1] + ';',
  'const WARP_EDGE = ' + main.match(/const WARP_EDGE = ([^;]+);/)[1] + ';',
  extractConst(main, 'SYSTEMS')
];
for (const fn of ['orbitState', 'addOrbitState', 'makeBody', 'buildSystemPlanets']) parts.push(extractFunc(main, fn));
parts.push(orderBlock);
parts.push(';module.exports = { SCALE_K, WARP_EDGE, SYSTEMS, orbitState, addOrbitState, makeBody, buildSystemPlanets, ' + fnNames.join(', ') + ' };');

const mod = { exports: {} };
new Function('module', 'exports', parts.join('\n'))(mod, mod.exports);
const H = mod.exports;
const clone = o => JSON.parse(JSON.stringify(o));

let failures = 0;
const check = (label, cond, detail) => {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + label + (detail ? ` (${detail})` : ''));
  if (!cond) failures++;
};

const sol = H.SYSTEMS[0];
const DAY = 86400;
const YEAR = 365.25 * DAY;

// 1. Sol orbital periods: 2*pi*sqrt(r^3 / starGM)
const periodSec = r => 2 * Math.PI * Math.sqrt(Math.pow(r, 3) / sol.starGM);
const pSekiei = periodSec(sol.planets[0].r) / DAY;
const pTsumugi = periodSec(sol.planets[1].r) / DAY;
const pAkane = periodSec(sol.planets[2].r) / YEAR;
const pUzushio = periodSec(sol.planets[3].r) / YEAR;

check('Sol period: せきえい 183–186 d', pSekiei >= 183 && pSekiei <= 186, `${pSekiei.toFixed(2)} d`);
check('Sol period: つむぎ 364–368 d', pTsumugi >= 364 && pTsumugi <= 368, `${pTsumugi.toFixed(2)} d`);
check('Sol period: あかね 1.68–1.76 y', pAkane >= 1.68 && pAkane <= 1.76, `${pAkane.toFixed(3)} y`);
check('Sol period: うずしお 2.78–2.88 y', pUzushio >= 2.78 && pUzushio <= 2.88, `${pUzushio.toFixed(3)} y`);

// 2. Prologue geometry: station-つむぎ & station-moon distances
const pPlanets = H.buildSystemPlanets(sol);
const tsumugi = pPlanets[1];
const moon = pPlanets.find(p => p.isMoon);
const station = H.makeBody(H.addOrbitState(tsumugi, H.orbitState(tsumugi.gm, 520000, 0.9, 0, 0)), 0x2dd4bf, 11, 'ステーション「あおば」', 0);
const dStationTsumugi = Math.hypot(station.x - tsumugi.x, station.y - tsumugi.y, station.z - tsumugi.z);
const dStationMoon = Math.hypot(station.x - moon.x, station.y - moon.y, station.z - moon.z);

check('Prologue station–つむぎ distance in [4.7e5, 5.7e5]', dStationTsumugi >= 4.7e5 && dStationTsumugi <= 5.7e5, `${Math.round(dStationTsumugi)}`);
check('Prologue initial station–moon distance in [1.2e5, 2.0e5]', dStationMoon >= 1.2e5 && dStationMoon <= 2.0e5, `${Math.round(dStationMoon)}`);

// 3. M0 estimates (true prologue docked state, moon target, arrivalDist 12000)
const m0Ship = H.makeBody({ x: station.x, y: station.y, z: station.z, vx: station.vx, vy: station.vy, vz: station.vz }, 0x6ea8ff, 5, 'ship', 0);
const m0Est = {
  std:  H.computePlanEstimate(clone(m0Ship), clone(moon), sol.starGM, 1.0, { arrivalDist: 12000, needDock: false, planets: clone(pPlanets) }),
  eco:  H.computePlanEstimate(clone(m0Ship), clone(moon), sol.starGM, 0.8, { arrivalDist: 12000, needDock: false, planets: clone(pPlanets) }),
  fast: H.computePlanEstimate(clone(m0Ship), clone(moon), sol.starGM, 1.3, { arrivalDist: 12000, needDock: false, planets: clone(pPlanets) }),
};
check('M0 estimates: all variants ok', m0Est.std.ok && m0Est.eco.ok && m0Est.fast.ok,
  `std=${m0Est.std.ok} eco=${m0Est.eco.ok} fast=${m0Est.fast.ok}`);
check('M0 std time in [1800, 43200] s', m0Est.std.timeTotal >= 1800 && m0Est.std.timeTotal <= 43200, `${Math.round(m0Est.std.timeTotal)} s`);
check('M0 std dv <= 20', m0Est.std.dvTotal <= 20, `${m0Est.std.dvTotal.toFixed(2)}`);
check('M0 eco.dv <= std.dv', m0Est.eco.dvTotal <= m0Est.std.dvTotal, `${m0Est.eco.dvTotal.toFixed(2)} <= ${m0Est.std.dvTotal.toFixed(2)}`);
check('M0 fast.time <= 0.90 * std.time', m0Est.fast.timeTotal <= 0.90 * m0Est.std.timeTotal, `${Math.round(m0Est.fast.timeTotal)} <= ${Math.round(0.90 * m0Est.std.timeTotal)}`);

// 4. M1 estimates (true loadSystem state)
const m1Planets = H.buildSystemPlanets(sol);
const m1Target = H.makeBody(H.orbitState(sol.starGM, 255 * H.SCALE_K, 2.4, 18, 40), 0x52e6a8, 8, '補給艦「あけぼの」', 0);
const m1St = H.orbitState(sol.starGM, 170 * H.SCALE_K, 0.2, 1, 0);
m1St.vx *= 0.92; m1St.vy *= 0.92; m1St.vz *= 0.92;
const m1Ship = H.makeBody(m1St, 0x6ea8ff, 5, 'ship', 0);
const m1Est = {
  std:  H.computePlanEstimate(clone(m1Ship), clone(m1Target), sol.starGM, 1.0, { arrivalDist: 12, needDock: true, planets: clone(m1Planets) }),
  eco:  H.computePlanEstimate(clone(m1Ship), clone(m1Target), sol.starGM, 0.8, { arrivalDist: 12, needDock: true, planets: clone(m1Planets) }),
  fast: H.computePlanEstimate(clone(m1Ship), clone(m1Target), sol.starGM, 1.3, { arrivalDist: 12, needDock: true, planets: clone(m1Planets) }),
};
check('M1 estimates: all variants ok', m1Est.std.ok && m1Est.eco.ok && m1Est.fast.ok,
  `std=${m1Est.std.ok} eco=${m1Est.eco.ok} fast=${m1Est.fast.ok}`);
check('M1 std time in [172800, 7776000] s', m1Est.std.timeTotal >= 172800 && m1Est.std.timeTotal <= 7776000, `${Math.round(m1Est.std.timeTotal)} s`);
check('M1 std dv <= 45', m1Est.std.dvTotal <= 45, `${m1Est.std.dvTotal.toFixed(2)}`);
check('M1 eco.dv <= std.dv', m1Est.eco.dvTotal <= m1Est.std.dvTotal, `${m1Est.eco.dvTotal.toFixed(2)} <= ${m1Est.std.dvTotal.toFixed(2)}`);
check('M1 fast.time <= 0.85 * std.time', m1Est.fast.timeTotal <= 0.85 * m1Est.std.timeTotal, `${Math.round(m1Est.fast.timeTotal)} <= ${Math.round(0.85 * m1Est.std.timeTotal)}`);

// 5. WARP_EDGE > うずしお orbit radius
check('WARP_EDGE > うずしお orbit radius', H.WARP_EDGE > sol.planets[3].r, `${H.WARP_EDGE} > ${sol.planets[3].r}`);

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);
