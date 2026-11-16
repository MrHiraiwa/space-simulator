// Plan-line transform consistency (v0.6.2, ledger #41/#43 acceptance):
// the DRAWN plan line must equal the estimator's predicted trajectory (inertial
// samples) transformed into the CURRENT display frame — in every frame, at any
// time, including right after a catch-up/skip. The predicted trajectory itself
// is collision-checked by the estimator (impactRisk), so a drawn line crossing
// a body surface is by definition a rendering bug.
// Method: reconstruct inertial points from the line geometry + object offset +
// current frame ref, and compare against getActiveCourseData().samples.
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';

const URL = 'file://' + path.join(process.env.HOME, 'workspace/space-simulator/game.html');
const PORT = 9362;
const chrome = spawn('/home/hatch/bin/google-chrome', [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${PORT}`,
  '--user-data-dir=/tmp/chrome-pline-' + Date.now(),
  '--window-size=420,900',
  'about:blank'
], { stdio: 'ignore' });
process.on('exit', () => { try { chrome.kill(); } catch {} });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function getJson(p) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${PORT}${p}`, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(JSON.parse(d)));
    }).on('error', reject);
  });
}
let ws, msgId = 0;
const pending = new Map();
function send(method, params = {}, sessionId) {
  const id = ++msgId;
  const msg = { id, method, params };
  if (sessionId) msg.sessionId = sessionId;
  ws.send(JSON.stringify(msg));
  return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); setTimeout(() => reject(new Error('timeout ' + method)), 60000); });
}
let SID;
async function ev(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, SID);
  if (r.exceptionDetails) throw new Error('eval: ' + (r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text));
  return r.result ? r.result.value : undefined;
}
async function waitFor(expr, timeoutMs, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) { if (await ev(expr)) return true; await sleep(250); }
  throw new Error('waitFor timeout: ' + label);
}
let failures = 0;
const check = (label, cond, detail) => { console.log((cond ? 'PASS' : 'FAIL') + '  ' + label + (detail ? ` (${detail})` : '')); if (!cond) failures++; };
const MEASURE = `(() => {
  const cd = getActiveCourseData(); if(!cd || !cd.samples || cd.samples.length < 2) return { err: 'no course' };
  if(!planLine || !planLine.visible) return { err: 'line not visible' };
  const attr = planLine.geometry.getAttribute('position');
  const ref = getFrameRefPos();
  let maxDev = 0;
  const n = Math.min(attr.count, cd.samples.length);
  for(let i = 0; i < n; i++){
    const ix = attr.getX(i) + planLine.position.x + ref.x;
    const iy = attr.getY(i) + planLine.position.y + ref.y;
    const iz = attr.getZ(i) + planLine.position.z + ref.z;
    const d = Math.hypot(ix - cd.samples[i][0], iy - cd.samples[i][1], iz - cd.samples[i][2]);
    if(d > maxDev) maxDev = d;
  }
  return { maxDev: +maxDev.toFixed(3), n, samples: cd.samples.length, attrCount: attr.count };
})()`;

for (let i = 0; i < 50; i++) { try { await getJson('/json/version'); break; } catch { await sleep(200); } }
const ver = await getJson('/json/version');
ws = new WebSocket(ver.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
ws.onmessage = (m) => { const msg = JSON.parse(m.data); if (msg.id && pending.has(msg.id)) { const p = pending.get(msg.id); pending.delete(msg.id); msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result); } };
const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
SID = sessionId;
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }, SID);
await send('Page.enable', {}, SID);
await send('Runtime.enable', {}, SID);
await send('Page.navigate', { url: URL }, SID);
await waitFor(`!!document.getElementById('btn-sortie')`, 30000, 'start');
await sleep(2500);
await ev(`localStorage.removeItem('ss-save-v1'); 'save-cleared'`); /* v0.6.3: 既存セーブの上書き確認で止まらないよう、出航前にセーブを消す */
await ev(`document.getElementById('btn-sortie').click(); 'ok'`);
await waitFor(`document.getElementById('creation-modal').classList.contains('open')`, 20000, 'creation');
await ev(`document.getElementById('btn-creation-done').click(); 'ok'`);
await waitFor(`document.getElementById('briefing-modal').classList.contains('open')`, 20000, 'briefing');
await sleep(300);
for (let i = 0; i < 8; i++) {
  const vis = await ev(`document.getElementById('btn-briefing-start').style.display !== 'none'`);
  if (vis) break;
  await ev(`document.getElementById('btn-briefing-next').click(); 'ok'`);
  await sleep(200);
}
await ev(`document.getElementById('btn-briefing-start').click(); 'ok'`);
await waitFor(`document.getElementById('plan-panel').classList.contains('open') && !!planPanelState`, 60000, 'panel');
await waitFor(`planPanelState.variants.every(v => v.est)`, 90000, 'estimates');
// The estimator's trajectory is collision-checked: closest approach must clear the surface.
const risk = await ev(`(() => { const v = planPanelState.variants[planPanelState.selIdx]; const ir = v.est && v.est.impactRisk; return ir ? { minDist: Math.round(ir.minDist), surfaceR: Math.round(ir.surfaceR), margin: Math.round(ir.margin) } : null; })()`);
console.log('selected estimate impactRisk:', JSON.stringify(risk));
check('predicted trajectory clears the target surface', !!risk && risk.minDist >= risk.surfaceR, JSON.stringify(risk));
// Depart on the selected (std) plan.
await ev(`(() => { const cards = document.querySelectorAll('#plan-variants .pv-card'); if (cards[planPanelState.selIdx]) cards[planPanelState.selIdx].click(); const chk = document.getElementById('departure-checklist'); if (chk) chk.click(); return 'ok'; })()`);
await waitFor(`!document.getElementById('btn-depart').disabled`, 30000, 'depart enabled');
await ev(`document.getElementById('btn-depart').click(); 'ok'`);
await waitFor(`!!(S.planExec && S.planExec.active)`, 30000, 'plan active');
await sleep(2500);
let m = await ev(MEASURE);
console.log('measure @departure:', JSON.stringify(m));
check('line == trajectory at departure (AUTO/station frame)', !m.err && m.maxDev < 1.0, JSON.stringify(m));
// Let ship time flow (bodies move) at warp 8.
await ev(`setWarp(8); 'ok'`);
await sleep(15000);
m = await ev(MEASURE);
console.log('measure @cruise+15s real:', JSON.stringify(m));
check('line == trajectory after bodies moved', !m.err && m.maxDev < 1.0, JSON.stringify(m));
// Switch frame to planet (manual): ref jumps ~520,000 without any re-bake trigger of its own.
await ev(`document.getElementById('frame-chip-3d').click(); 'ok'`);
await sleep(400);
await ev(`document.querySelector('#frame-sel-3d button[data-fref="planet"]').click(); 'ok'`);
await sleep(1200);
m = await ev(MEASURE);
console.log('measure @planet frame:', JSON.stringify(m));
check('line == trajectory in planet frame', !m.err && m.maxDev < 1.0, JSON.stringify(m));
// Switch frame to star.
await ev(`document.getElementById('frame-chip-3d').click(); 'ok'`);
await sleep(400);
await ev(`document.querySelector('#frame-sel-3d button[data-fref="star"]').click(); 'ok'`);
await sleep(1200);
m = await ev(MEASURE);
console.log('measure @star frame:', JSON.stringify(m));
check('line == trajectory in star frame', !m.err && m.maxDev < 1.0, JSON.stringify(m));
// Back to AUTO, then run the debug skip (catch-up path) and measure on the first frames after it ends.
await ev(`document.getElementById('frame-chip-3d').click(); 'ok'`);
await sleep(400);
await ev(`document.querySelector('#frame-sel-3d button[data-fref="auto"]').click(); 'ok'`);
await sleep(500);
await ev(`startDebugSkip(); 'ok'`);
const t0 = Date.now();
let skipState = null;
while (Date.now() - t0 < 150000) {
  skipState = await ev(`({ running: !!catchUpState, failed: !!S.failed, t: Math.round(S.time), phase: S.planExec ? S.planExec.phase : null, panel: document.getElementById('plan-panel').classList.contains('open') })`);
  if (!skipState.running) break;
  await sleep(1000);
}
console.log('after skip:', JSON.stringify(skipState));
check('skip ended without a crash', skipState && !skipState.failed);
await sleep(300);
m = await ev(MEASURE);
console.log('measure @right after skip:', JSON.stringify(m));
// After an arrival the course may legitimately be gone (return panel preview instead);
// if a course exists, the transform must still be exact.
if (!m.err) check('line == trajectory right after catch-up/skip', m.maxDev < 1.0, JSON.stringify(m));
else console.log('note: no active course right after skip (' + m.err + ') — arrival state, transform check n/a');

console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)');
try { ws.close(); } catch {}
chrome.kill();
process.exit(failures === 0 ? 0 : 1);
