// Verification (real page / real flow) for the v0.4 cycle:
//   - time control (待機) measurably changes sim speed; state label updates
//   - departure operation phases run in order: undock -> harbor -> main leg
//   - port scene: あおば is established (control welcome, station type, berth)
//   - port traffic density: docked/holding/craft contacts + 3D name labels
//   - chart: AUTO follows the phase, manual override holds, AUTO resumes
//   - cruise ship-life: talk / rooms / small ops render while the sim runs
//   - mission 1: berthing operation phase precedes the docking completion
//   - layout at 390x844 and 844x390: no horizontal overflow, dock fits
// Run: node tests/verify-time-and-cruise.mjs [url]   (default: file:// game.html)
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const URL = process.argv[2] || ('file://' + path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'game.html'));
const PORT = 9342;
const chrome = spawn('google-chrome', ['--headless=new', '--disable-gpu', '--no-sandbox', `--remote-debugging-port=${PORT}`, '--user-data-dir=/tmp/chrome-verify-prof', '--window-size=420,900', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function getJson(p) { return new Promise((resolve, reject) => { http.get(`http://127.0.0.1:${PORT}${p}`, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(JSON.parse(d))); }).on('error', reject); }); }
let ws, msgId = 0; const pending = new Map();
function send(method, params = {}, sessionId) { const id = ++msgId; const msg = { id, method, params }; if (sessionId) msg.sessionId = sessionId; ws.send(JSON.stringify(msg)); return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); setTimeout(() => reject(new Error('timeout ' + method)), 60000); }); }
let SID, failures = 0;
const check = (label, cond) => { console.log((cond ? 'PASS' : 'FAIL') + '  ' + label); if (!cond) failures++; };
async function ev(expr) { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, SID); if (r.exceptionDetails) throw new Error('page eval error: ' + (r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text)); return r.result ? r.result.value : undefined; }
async function waitFor(expr, timeoutMs, label) { const t0 = Date.now(); while (Date.now() - t0 < timeoutMs) { if (await ev(expr)) return true; await sleep(400); } throw new Error('waitFor timeout: ' + label); }
async function newPage() {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  SID = sessionId;
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }, SID);
  await send('Page.enable', {}, SID);
  await send('Runtime.enable', {}, SID);
  await send('Page.navigate', { url: URL }, SID);
  await waitFor(`!!document.getElementById('btn-sortie')`, 30000, 'start screen');
  await sleep(600);
  return targetId;
}
try {
  let version = null;
  for (let i = 0; i < 40; i++) { try { version = await getJson('/json/version'); break; } catch { await sleep(500); } }
  if (!version) throw new Error('chrome CDP not up');
  ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (ev2) => { const m = JSON.parse(ev2.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } };

  // ---------- Part A: prologue (port start) ----------
  let tid = await newPage();
  // retry the sortie click: under headless load the listener may attach after the first click
  for (let i = 0; i < 5; i++) { await ev(`document.getElementById('btn-sortie').click(); 'ok'`); try { await waitFor(`document.getElementById('creation-modal').classList.contains('open')`, 5000, 'creation modal'); break; } catch { if (i === 4) throw new Error('waitFor timeout: creation modal'); } }
  await ev(`{ const a = document.getElementById('cr-ainame'); a.value = 'ミラ'; a.dispatchEvent(new Event('input', { bubbles: true })); 'ok' }`);
  await ev(`document.getElementById('btn-creation-done').click(); 'ok'`);
  await waitFor(`document.getElementById('briefing-modal').classList.contains('open')`, 20000, 'port scene');
  await sleep(600);

  const p1 = await ev(`document.getElementById('briefing-body').textContent`);
  check('grounding: first port-scene page is an inbound message from あおば管制', p1.includes('あおば管制'));
  check('grounding: the place is established (orbital station by the inhabited planet, berth stated)', p1.includes('軌道ステーション') && p1.includes('第6バース'));

  const contacts = await ev(`computeContacts().map(c => ({ name: c.name, cat: c.cat, gate: c.gate, dist: Math.round(c.dist) }))`);
  console.log('  contacts at dock:', JSON.stringify(contacts));
  check('traffic: port scene populated (>=10 contacts incl. station, route traffic, port craft)', contacts.length >= 10);
  check('traffic: docked ships at gates present', contacts.some(c => c.cat === 'docked' && c.gate));
  check('traffic: holding ships present', contacts.some(c => c.cat === 'holding'));
  check('traffic: small craft present', contacts.some(c => c.cat === 'craft'));
  check('traffic: route traffic present', contacts.some(c => c.cat === 'moving'));

  await sleep(1000);
  const labels = await ev(`[...document.querySelectorAll('.npc-label')].filter(e => e.style.display !== 'none' && e.textContent).map(e => e.textContent)`);
  console.log('  visible 3D labels:', JSON.stringify(labels));
  check('traffic: name labels visible in 3D view near the player (>=2)', labels.length >= 2);
  check('traffic: station itself is labeled', labels.some(t => t.includes('あおば')));

  // page through the port scene to the start button
  for (let i = 0; i < 6; i++) {
    const vis = await ev(`document.getElementById('btn-briefing-start').style.display !== 'none'`);
    if (vis) break;
    await ev(`document.getElementById('btn-briefing-next').click(); 'ok'`);
    await sleep(250);
  }
  await ev(`document.getElementById('btn-briefing-start').click(); 'ok'`);
  await waitFor(`document.getElementById('plan-panel').classList.contains('open')`, 60000, 'plan panel');
  check('ai naming: plan panel header uses the custom AI name', await ev(`document.getElementById('plan-ai-head').textContent.includes('ミラ')`));
  await waitFor(`!document.getElementById('btn-depart').disabled`, 20000, 'depart enabled');
  await ev(`document.getElementById('btn-depart').click(); 'ok'`);
  // 実スケールの港内航行は ×1 では約2.5分（離舷→出域1000）。フェーズ順序の検証が目的なので ×8 で観測する
  await ev(`document.querySelector('[data-warp="8"]').click(); 'ok'`);

  // departure phases + chart behavior during harbor
  const seen = [];
  let chartDone = false;
  const tPhase0 = Date.now();
  while (Date.now() - tPhase0 < 240000) {
    const ph = await ev(`S.planExec ? S.planExec.phase : 'none'`);
    if (ph && ph !== 'none' && seen[seen.length - 1] !== ph) seen.push(ph);
    if (ph === 'harbor' && !chartDone) {
      chartDone = true;
      await ev(`document.getElementById('btn-chart').click(); 'ok'`);
      await sleep(500);
      check('chart: panel opens', await ev(`document.getElementById('chart-panel').classList.contains('open')`));
      check('chart: AUTO selects port range during harbor ops', await ev(`chartState.mode === 'auto' && chartState.range === 'port'`));
      const shot = await send('Page.captureScreenshot', { format: 'png' }, SID);
      fs.writeFileSync('/tmp/verify-harbor.png', Buffer.from(shot.data, 'base64'));
      await ev(`document.querySelector('[data-range="system"]').click(); 'ok'`);
      await sleep(300);
      check('chart: manual override holds (system range, captain mode)', await ev(`chartState.mode === 'system' && chartState.range === 'system'`));
      await ev(`document.querySelector('[data-range="auto"]').click(); 'ok'`);
      await sleep(300);
      check('chart: returning to AUTO resumes AI management (port range in harbor)', await ev(`chartState.mode === 'auto' && chartState.range === 'port'`));
      await ev(`document.getElementById('btn-chart-close').click(); 'ok'`);
    }
    if (ph === 'cruise' || ph === 'brake') break;
    await sleep(300);
  }
  console.log('  departure phase sequence:', seen.join(' -> '));
  check('departure: undock phase ran', seen.includes('undock'));
  check('departure: harbor phase ran after undock', seen.indexOf('harbor') > seen.indexOf('undock'));
  check('departure: no main-leg phase appears before harbor', seen.indexOf('harbor') >= 0 && (seen.indexOf('depart') === -1 || seen.indexOf('depart') > seen.indexOf('harbor')) && (seen.indexOf('cruise') === -1 || seen.indexOf('cruise') > seen.indexOf('harbor')));
  check('chart: harbor chart checks executed', chartDone);

  // fast-forward measurement (real sim clock)
  await ev(`document.querySelector('[data-warp="1"]').click(); 'ok'`);
  await sleep(300);
  const m1a = await ev(`S.time`); await sleep(1200); const m1b = await ev(`S.time`);
  await ev(`document.querySelector('[data-warp="8"]').click(); 'ok'`);
  await sleep(300);
  check('ff: state label shows fast-forward', await ev(`document.getElementById('ff-now').textContent.includes('×8')`));
  const m8a = await ev(`S.time`); await sleep(1200); const m8b = await ev(`S.time`);
  const d1 = m1b - m1a, d8 = m8b - m8a;
  console.log('  sim advance in 1.2s real: x1=' + d1.toFixed(2) + 's, x8=' + d8.toFixed(2) + 's');
  check('ff: x8 advances the sim clock much faster than x1 (>3x)', d8 > d1 * 3 && d1 > 0.2);

  // cruise ship-life
  await waitFor(`S.planExec && S.planExec.phase === 'cruise'`, 300000, 'cruise phase');
  check('cruise: next-action line points at ship-life activities', await ev(`deriveNextAction().text.includes('艦内')`));
  const tBefore = await ev(`S.time`);
  await ev(`document.getElementById('btn-ship').click(); 'ok'`);
  await sleep(500);
  check('ship-life: drawer opens on the ship tab', await ev(`document.getElementById('tab-ship').classList.contains('active') || getComputedStyle(document.getElementById('tab-ship')).display !== 'none'`));
  check('ship-life: crew talk buttons render', await ev(`document.querySelectorAll('#ship-crew [data-crew]').length >= 5`));
  await ev(`document.querySelector('#ship-crew [data-crew="0"]').click(); 'ok'`);
  await sleep(600);
  const dlg1 = await ev(`document.getElementById('scene-line').textContent`);
  check('ship-life: talking opens a conversation scene with a dialogue line', dlg1.includes('「') && dlg1.length > 10 && await ev(`document.getElementById('scene-overlay').classList.contains('open')`));
  await waitFor(`crewRoster()[0].rel.trust > 0`, 120000, 'talk effect lands when the conversation time elapses');
  check('ship-life: relationship effect recorded (trust)', true);
  await ev(`document.querySelector('[data-backroom]').click(); 'ok'`);
  await sleep(300);
  await ev(`document.getElementById('scene-exit').click(); 'ok'`);
  await sleep(300);
  await ev(`document.querySelector('[data-room="engine"]').click(); 'ok'`);
  await sleep(400);
  check('ship-life: room visit describes the room and its occupants', await ev(`document.getElementById('ship-room-line').textContent.includes('機関室')`));
  await waitFor(`S.captainLoc && S.captainLoc.room === 'engine' && !S.captainLoc.transit`, 300000, 'walk to engine room');
  check('ship-life: the walk arrives as a room scene', await ev(`document.getElementById('scene-place').textContent.includes('機関室')`));
  await ev(`document.querySelector('[data-scene-op="engine"]').click(); 'ok'`);
  await sleep(300);
  await waitFor(`document.getElementById('log').textContent.includes('機関点検')`, 360000, 'engine op completes on the clock');
  check('ship-life: small op returns a report and a log entry', await ev(`document.getElementById('log').textContent.includes('機関点検')`));
  await ev(`document.getElementById('scene-exit').click(); 'ok'`);
  await sleep(300);
  const tAfter = await ev(`S.time`);
  check('ship-life: the flight keeps progressing during activities', tAfter > tBefore + 2);

  // layout at both orientations
  const lay1 = await ev(`({ sw: document.documentElement.scrollWidth, iw: window.innerWidth, ff: (() => { const r = document.querySelector('.ff-bar').getBoundingClientRect(); return { l: r.left, r: r.right, w: window.innerWidth }; })(), ship: (() => { const r = document.getElementById('btn-ship').getBoundingClientRect(); return r.right <= window.innerWidth && r.left >= 0; })(), chart: (() => { const r = document.getElementById('btn-chart').getBoundingClientRect(); return r.right <= window.innerWidth && r.left >= 0; })() })`);
  console.log('  layout 390x844:', JSON.stringify(lay1));
  check('layout 390x844: no horizontal overflow', lay1.sw <= lay1.iw);
  check('layout 390x844: ff-bar inside viewport', lay1.ff.l >= 0 && lay1.ff.r <= lay1.ff.w + 1);
  check('layout 390x844: ship/chart buttons inside viewport', lay1.ship && lay1.chart);
  await send('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 2, mobile: true }, SID);
  await sleep(700);
  const lay2 = await ev(`({ sw: document.documentElement.scrollWidth, iw: window.innerWidth, ffR: document.querySelector('.ff-bar').getBoundingClientRect().right })`);
  console.log('  layout 844x390:', JSON.stringify(lay2));
  check('layout 844x390: no horizontal overflow', lay2.sw <= lay2.iw);
  check('layout 844x390: ff-bar inside viewport', lay2.ffR <= lay2.iw + 1);
  await send('Target.closeTarget', { targetId: tid });

  // ---------- Part B: mission 1 berthing ----------
  tid = await newPage();
  for (let i = 0; i < 5; i++) { await ev(`document.getElementById('btn-sortie').click(); 'ok'`); try { await waitFor(`document.getElementById('creation-modal').classList.contains('open')`, 5000, 'creation modal (m1)'); break; } catch { if (i === 4) throw new Error('waitFor timeout: creation modal (m1)'); } }
  await ev(`document.getElementById('btn-creation-done').click(); 'ok'`);
  await waitFor(`document.getElementById('briefing-modal').classList.contains('open')`, 20000, 'port scene (m1)');
  await sleep(800);
  await ev(`document.getElementById('btn-skip-prologue').click(); 'ok'`);
  await sleep(1500);
  check('grounding: mission 1 opens with an inbound control message', await ev(`document.getElementById('log').textContent.includes('あおば管制') && document.getElementById('log').textContent.includes('訓練空域')`));
  await ev(`document.getElementById('btn-plan').click(); 'ok'`);
  await waitFor(`document.getElementById('plan-panel').classList.contains('open')`, 60000, 'm1 plan panel');
  await waitFor(`!document.getElementById('btn-depart').disabled`, 20000, 'm1 depart enabled');
  await ev(`document.getElementById('btn-depart').click(); 'ok'`);
  await sleep(500);
  await ev(`document.querySelector('[data-warp="8"]').click(); 'ok'`);
  // Mission 1's tutorial is part of the flow: step 3 asks for a camera drag,
  // and the 'captain' phase completes when the captain orders speed-matching
  // (the tutorial then releases the plan). Drive both with real input.
  async function dragCamera() {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 60, y: 400, button: 'left', buttons: 1 }, SID);
    for (let i = 1; i <= 10; i++) { await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 60 + i * 28, y: 400, button: 'left', buttons: 1 }, SID); await sleep(30); }
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 340, y: 400, button: 'left', buttons: 0 }, SID);
  }
  let berthingSeen = false, dragDone = false;
  const tB0 = Date.now();
  while (Date.now() - tB0 < 900000) {
    const st = await ev(`({ b: !!S.berthing, ph: S.planExec ? S.planExec.phase : null, docked: S.docked, ended: S.missionEnded, tut: S.tutorial ? S.tutorial.step : -1, dist: S.target && S.ship ? Math.hypot(S.target.x - S.ship.x, S.target.y - S.ship.y, S.target.z - S.ship.z) : 0, warp: S.warp })`);
    if (st.b) { berthingSeen = true; check('arrival: berthing is its own operation phase', st.ph === 'berthing'); break; }
    if (st.docked || st.ended) break;
    const wantWarp = st.dist > 2000000 ? 300000 : (st.dist > 300000 ? 300 : 8);
    if (st.warp !== wantWarp) await ev(`setWarp(${wantWarp}); 'ok'`);
    if (!dragDone && st.tut === 3) { await dragCamera(); dragDone = true; }
    // order speed-matching only at tutorial step 5 (the designed moment):
    // clicking after step 6 has released the plan would re-block the executor
    if (st.ph === 'captain' && st.tut === 5) await ev(`(() => { const b = document.getElementById('btn-order-match'); if (b && !b.disabled) b.click(); return 'ok'; })()`);
    await sleep(700);
  }
  // berthing lasts 5 sim-seconds (~0.6s real at x8), so polling can miss the live
  // window; the log lines and the residual plan phase are durable evidence.
  const bLog = await ev(`document.getElementById('log').textContent`);
  const bPhase = await ev(`S.planExec ? S.planExec.phase : null`);
  check('arrival: berthing phase occurs before docking completes', berthingSeen || (bLog.includes('接舷作業開始') && bLog.includes('係留完了') && bPhase === 'berthing'));
  await waitFor(`S.docked === true && S.missionEnded === true`, 60000, 'docking completion after berthing');
  check('arrival: docking completes after mooring + arrival procedures', true);
  check('arrival: result modal opens after completion', await ev(`document.getElementById('result-modal').classList.contains('open')`));
  await send('Target.closeTarget', { targetId: tid });
} catch (e) {
  console.log('FAIL  driver error: ' + e.message);
  failures++;
} finally { try { ws && ws.close(); } catch {} chrome.kill('SIGKILL'); }
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);
