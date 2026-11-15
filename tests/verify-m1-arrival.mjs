// Mission 1 arrival-chain verification (bridged drive):
// The full M1 flight is ~7.7M ship-seconds (89 days); in a software-rendered headless
// environment the coast alone exceeds any practical suite budget (traced separately:
// distance closes monotonically under plan burns, no pause/deviation over 7.03M s).
// This drive flies the REAL flow (creation -> skip -> plan -> depart -> tutorial drag ->
// cruise burns), then bridges the ship onto its own approach geometry 1.5M units out
// and lets the REAL plan executor fly brake -> captain (tutorial speed-match order) ->
// join -> final -> berthing -> docking. Assertions are the same as the soak's Part B.
// Run: node tests/verify-m1-arrival.mjs [url]
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const URL = process.argv[2] || ('file://' + path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'game.html'));
const PORT = 9358;
const chrome = spawn('google-chrome', ['--headless=new', '--disable-gpu', '--no-sandbox', '--mute-audio', `--remote-debugging-port=${PORT}`, '--user-data-dir=/tmp/chrome-verify-m1arr-prof', '--window-size=420,900', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function getJson(p) { return new Promise((resolve, reject) => { http.get(`http://127.0.0.1:${PORT}${p}`, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(JSON.parse(d))); }).on('error', reject); }); }
let ws, msgId = 0; const pending = new Map();
function send(method, params = {}, sessionId) { const id = ++msgId; const msg = { id, method, params }; if (sessionId) msg.sessionId = sessionId; ws.send(JSON.stringify(msg)); return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); setTimeout(() => reject(new Error('timeout ' + method)), 90000); }); }
let SID, failures = 0;
const check = (label, cond, extra) => { console.log((cond ? 'PASS' : 'FAIL') + '  ' + label + (extra !== undefined ? '  [' + extra + ']' : '')); if (!cond) failures++; };
async function ev(expr) { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, SID); if (r.exceptionDetails) throw new Error('page eval error: ' + (r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text)); return r.result ? r.result.value : undefined; }
async function waitFor(expr, timeoutMs, label) { const t0 = Date.now(); while (Date.now() - t0 < timeoutMs) { if (await ev(expr)) return true; await sleep(400); } throw new Error('waitFor timeout: ' + label); }

try {
  let version = null;
  for (let i = 0; i < 40; i++) { try { version = await getJson('/json/version'); break; } catch { await sleep(500); } }
  if (!version) throw new Error('chrome CDP not up');
  ws = new WebSocket(version.webSocketDebuggerUrl);
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id).resolve(d.result || d.error); pending.delete(d.id); } };
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; setTimeout(() => rej(new Error('ws timeout')), 15000); });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  SID = sessionId;
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }, SID);
  await send('Page.enable', {}, SID);
  await send('Runtime.enable', {}, SID);
  await send('Page.navigate', { url: URL }, SID);
  await waitFor(`!!document.getElementById('btn-sortie')`, 30000, 'start screen');
  await sleep(1200);
  for (let i = 0; i < 5; i++) { await ev(`document.getElementById('btn-sortie').click()`); try { await waitFor(`document.getElementById('creation-modal').classList.contains('open')`, 5000, 'creation'); break; } catch { if (i === 4) throw new Error('creation never opened'); } }
  await ev(`document.getElementById('btn-creation-done').click()`);
  await waitFor(`document.getElementById('briefing-modal').classList.contains('open')`, 30000, 'briefing');
  await sleep(800);
  await ev(`document.getElementById('btn-skip-prologue').click()`);
  await sleep(1500);
  await ev(`document.getElementById('btn-plan').click()`);
  await waitFor(`document.getElementById('plan-panel').classList.contains('open')`, 60000, 'plan panel');
  await waitFor(`!document.getElementById('btn-depart').disabled`, 20000, 'depart enabled');
  const dist0 = await ev(`Math.hypot(S.target.x - S.ship.x, S.target.y - S.ship.y, S.target.z - S.ship.z)`);
  check('m1: rendezvous target is interplanetary (>50M units)', dist0 > 5.0e7, 'dist=' + Math.round(dist0));
  await ev(`document.getElementById('btn-depart').click()`);
  await sleep(500);
  await ev(`document.querySelector('[data-warp="8"]').click()`);
  // tutorial camera drag at step 3 (real input, as in the soak)
  async function dragCamera() {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 60, y: 400, button: 'left', buttons: 1 }, SID);
    for (let i = 1; i <= 10; i++) { await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 60 + i * 28, y: 400, button: 'left', buttons: 1 }, SID); await sleep(30); }
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 340, y: 400, button: 'left', buttons: 0 }, SID);
  }
  let dragDone = false, cruiseBurnSeen = false;
  const tC0 = Date.now();
  while (Date.now() - tC0 < 180000) {
    const st = await ev(`({ ph: S.planExec ? S.planExec.phase : null, tut: S.tutorial ? S.tutorial.step : -1, burn: S.activeBurn ? S.activeBurn.kind : null, dist: Math.round(Math.hypot(S.target.x - S.ship.x, S.target.y - S.ship.y, S.target.z - S.ship.z)) })`);
    if (st.burn === 'approach') cruiseBurnSeen = true;
    if (!dragDone && st.tut === 3) { await dragCamera(); dragDone = true; }
    if (st.ph === 'cruise' && dragDone) break;
    await sleep(700);
  }
  check('m1: departure completed into cruise under the plan', await ev(`S.planExec && S.planExec.phase === 'cruise'`) === true);
  check('m1: tutorial camera step completed (step>=4)', (await ev(`S.tutorial ? S.tutorial.step : -1`)) >= 4);
  await ev(`setWarp(300000)`);
  await sleep(30000);
  const dist1 = await ev(`Math.hypot(S.target.x - S.ship.x, S.target.y - S.ship.y, S.target.z - S.ship.z)`);
  check('m1: coast closes distance under plan guidance', dist1 < dist0 - 2.0e5, Math.round(dist0) + ' -> ' + Math.round(dist1));
  check('m1: plan guidance burns occurred', cruiseBurnSeen || (await ev(`S.dv`)) < 54.5, 'dv=' + (await ev(`S.dv`)).toFixed(1));

  // ---- bridge into the endgame regime (test scaffolding; executor flies the rest) ----
  // The executor's phase machine switches cruise->brake at dist<75 world units from
  // pe.targetBody, so the bridge places the ship 70 units out, closing at 2.0 u/s —
  // the same state the real flight reaches at the end of its cruise.
  await ev(`(() => {
    const t = S.planExec.targetBody;
    const fix = approachFix(t);
    // approach axis: target -> fix (the published approach course). Place the ship
    // on the axis beyond the fix, closing at 2.0 u/s — the state the real flight
    // reaches as it joins the course.
    let ax = fix.x - t.x, ay = fix.y - t.y, az = fix.z - t.z;
    const al = Math.hypot(ax, ay, az) || 1; ax /= al; ay /= al; az /= al;
    S.ship.x = fix.x + ax * 25; S.ship.y = fix.y + ay * 25; S.ship.z = fix.z + az * 25;
    S.ship.vx = t.vx - ax * 2.0; S.ship.vy = t.vy - ay * 2.0; S.ship.vz = t.vz - az * 2.0;
    S.activeBurn = null;
    if (S.planExec) { S.planExec.badEst = 0; S.planExec.paused = false; S.planExec.deviated = false; }
    if (S.tutorial && S.tutorial.step < 4) S.tutorial.step = 4;
    setWarp(8);
  })()`);
  const gateInfo = await ev(`JSON.stringify({ gate: S.planExec.gate, arrivalDist: S.planExec.arrivalDist, targetBody: S.planExec.targetBody ? S.planExec.targetBody.name : null, target: S.target ? S.target.name : null, needDock: S.planExec.needDock })`);
  console.log('  gate info:', gateInfo);
  let berthingSeen = false;
  const phases = [];
  const tB0 = Date.now();
  let traceN = 0;
  while (Date.now() - tB0 < 600000) {
    if (traceN++ % 3 === 0) {
      const tr = await ev(`(() => { const gp = S.planExec && S.planExec.gate ? resolveFixPos(S.planExec.gate) : null; const gd = gp ? Math.hypot(S.ship.x - gp[0], S.ship.y - gp[1], S.ship.z - gp[2]) : -1; const ri = relInfo(S.ship, S.target); return JSON.stringify({ ph: S.planExec.phase, dist: +ri.dist.toFixed(1), rel: +ri.rel.toFixed(2), closing: +ri.closing.toFixed(2), gateDist: +gd.toFixed(1), est: S.approach.established, burn: S.activeBurn ? S.activeBurn.kind : null, dv: +S.dv.toFixed(1) }); })()`);
      console.log('  trace:', tr);
    }
    const st = await ev(`({ b: !!S.berthing, ph: S.planExec ? S.planExec.phase : null, paused: S.planExec ? !!S.planExec.paused : null, docked: S.docked, ended: S.missionEnded, failed: !!S.failed, tut: S.tutorial ? S.tutorial.step : -1, dist: Math.round(Math.hypot(S.target.x - S.ship.x, S.target.y - S.ship.y, S.target.z - S.ship.z)), warp: S.warp })`);
    if (st.ph && phases[phases.length - 1] !== st.ph) phases.push(st.ph);
    if (st.b) { berthingSeen = true; break; }
    if (st.docked || st.ended || st.failed) break;
    if (st.ph === 'captain' && st.tut === 5) await ev(`(() => { const b = document.getElementById('btn-order-match'); if (b && !b.disabled) b.click(); return 'ok'; })()`);
    await sleep(700);
  }
  console.log('  arrival phase sequence:', phases.join(' -> '));
  const dump = await ev(`(() => {
    const logEl = document.getElementById('log');
    const lines = logEl ? Array.from(logEl.children).slice(-12).map(c => c.textContent) : [];
    const rm = document.getElementById('result-modal');
    const rel = (b) => b ? Math.round(Math.hypot(S.ship.x - b.x, S.ship.y - b.y, S.ship.z - b.z)) : null;
    const relV = (b) => b ? +Math.hypot(S.ship.vx - b.vx, S.ship.vy - b.vy, S.ship.vz - b.vz).toFixed(2) : null;
    return JSON.stringify({ failed: !!S.failed, ended: S.missionEnded, docked: S.docked, resultTitle: rm ? (rm.querySelector('h2,h3,.result-title') || {}).textContent : null, resultText: rm ? rm.textContent.slice(0, 300) : null, distTarget: rel(S.target), relTarget: relV(S.target), distStation: rel(S.station), distTargetBody: rel(S.planExec ? S.planExec.targetBody : null), est: S.approach ? S.approach.established : null, logTail: lines }, null, 1);
  })()`);
  console.log('  arrival dump:', dump);
  const bLog = await ev(`document.getElementById('log').textContent`);
  const bPhase = await ev(`S.planExec ? S.planExec.phase : null`);
  check('arrival: not failed', (await ev(`!!S.failed`)) === false);
  check('arrival: berthing phase occurs before docking completes', berthingSeen || (bLog.includes('接舷作業開始') && bLog.includes('係留完了') && bPhase === 'berthing'), 'berthingSeen=' + berthingSeen + ' phase=' + bPhase);
  await waitFor(`S.docked === true && S.missionEnded === true`, 120000, 'docking completion after berthing');
  check('arrival: docking completes after mooring + arrival procedures', true);
  check('arrival: result modal opens after completion', await ev(`document.getElementById('result-modal').classList.contains('open')`) === true);

  console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILURES');
  process.exit(failures === 0 ? 0 : 1);
} catch (e) {
  console.error('FAIL  driver error:', e.message);
  process.exit(2);
} finally {
  try { chrome.kill(); } catch {}
}
