// Regression (end-to-end, real page / real flow): the v0.3 launch blocker was
// invisible to function-level probes because it lived in the real physics
// loop. This script drives the ACTUAL game.html in headless Chrome through
// the ACTUAL click flow and asserts on the DOM and game state at each stage:
//   career: start -> captain creation -> port scene -> plan panel -> depart
//   mission1: (skip prologue) -> plan button -> plan panel
// No synthetic state is injected.
//
// Run on a machine with Chrome + Node >= 22 (e.g. TowerPC):
//   node tests/regression-drive.mjs [url]
// Default URL is the repo's game.html via file://. For the live site pass
// https://mrhiraiwa.github.io/space-simulator/game.html
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const URL = process.argv[2] || ('file://' + path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'game.html'));
const PORT = 9341;
const chrome = spawn('google-chrome', ['--headless=new', '--disable-gpu', '--no-sandbox', `--remote-debugging-port=${PORT}`, '--user-data-dir=/tmp/chrome-regression-prof', '--window-size=420,900', 'about:blank'], { stdio: 'ignore' });
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
  if (!version) throw new Error('chrome CDP not up (google-chrome required in PATH)');
  ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (ev2) => { const m = JSON.parse(ev2.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } };

  // ---- career opening: sortie -> creation -> port scene -> plan -> depart
  let tid = await newPage();
  await ev(`localStorage.removeItem('ss-save-v1'); 'save-cleared'`); /* v0.6.3: 既存セーブの上書き確認で止まらないよう、出航前にセーブを消す */
  await ev(`document.getElementById('btn-sortie').click(); 'ok'`);
  await waitFor(`document.getElementById('creation-modal').classList.contains('open')`, 20000, 'creation modal');
  check('career: creation screen opens after scenario select', true);
  check('career: creation lists are data-driven and populated', await ev(`document.querySelectorAll('#cr-tracks .cr-opt').length === 3 && document.querySelectorAll('#cr-origins .cr-opt').length === 6 && document.querySelectorAll('#cr-homes .cr-opt').length === 4 && document.querySelectorAll('#cr-traits .cr-opt').length === 8 && document.querySelectorAll('#cr-portraits .cr-face').length >= 3`));
  // give the captain a custom name, a custom AI name, and pick the patrol track, then confirm
  await ev(`{ const i = document.getElementById('cr-name'); i.value = '星野 テスト'; i.dispatchEvent(new Event('input', { bubbles: true })); const a = document.getElementById('cr-ainame'); a.value = 'ミラ'; a.dispatchEvent(new Event('input', { bubbles: true })); document.querySelectorAll('#cr-tracks .cr-opt')[2].click(); 'ok' }`);
  await ev(`document.getElementById('btn-creation-done').click(); 'ok'`);
  await waitFor(`document.getElementById('briefing-modal').classList.contains('open')`, 20000, 'port scene');
  check('port scene: captain record stored in game state', await ev(`!!(S.captain && S.captain.id === 'captain' && S.captain.abilities && S.captain.flags)`));
  check('port scene: chosen name is used in the opening dialogue', await ev(`document.getElementById('briefing-body').textContent.includes('星野')`));
  check('port scene: ship starts DOCKED at the station', await ev(`S.docked === true && S.dockedTo === S.station`));
  // page through the port scene to the officers page (control welcome = p1, guide = p2, officers = p3)
  for (let i = 0; i < 4; i++) {
    const has = await ev(`document.getElementById('briefing-officers').textContent.includes('配置')`);
    if (has) break;
    await ev(`document.getElementById('btn-briefing-next').click(); 'ok'`);
    await sleep(250);
  }
  check('port scene: officers introduced with posts', await ev(`document.getElementById('briefing-officers').textContent.includes('配置')`));
  check('creation: custom AI name reaches the plan panel header', await ev(`document.getElementById('plan-ai-head').textContent.includes('ミラ')`));
  for (let i = 0; i < 5; i++) {
    const vis = await ev(`document.getElementById('btn-briefing-start').style.display !== 'none'`);
    if (vis) break;
    await ev(`document.getElementById('btn-briefing-next').click(); 'ok'`);
    await sleep(250);
  }
  await ev(`document.getElementById('btn-briefing-start').click(); 'ok'`);
  await waitFor(`document.getElementById('plan-panel').classList.contains('open') && planPanelState && planPanelState.variants && planPanelState.variants.length >= 3 && planPanelState.variants.every(x => x.est)`, 60000, 'prologue plan panel');
  await sleep(300);
  const pv = await ev(`({ v: planPanelState.variants.map(x => ({ id: x.id, ok: x.est.ok, dv: x.est.dvTotal })), finite: [S.ship.x, S.ship.y, S.ship.z, S.ship.vx, S.ship.vy, S.ship.vz].every(Number.isFinite), docked: S.docked, shipLine: document.getElementById('plan-ship').textContent })`);
  check('prologue: ship state finite at plan panel', pv.finite);
  check('prologue: still docked while the plan is confirmed', pv.docked === true);
  check('prologue: standard variant ok with numeric dv', pv.v.find(x => x.id === 'std').ok === true && pv.v.find(x => x.id === 'std').dv > 0);
  check('prologue: at least 2 of 3 variants ok', pv.v.filter(x => x.ok).length >= 2);
  check('prologue: plan panel ship line reflects chosen track (patrol)', pv.shipLine.includes('哨戒艇'));
  await waitFor(`!document.getElementById('btn-depart').disabled`, 20000, 'depart button enabled');
  check('prologue: depart button enabled after checklist', true);
  await ev(`document.getElementById('btn-depart').click(); 'ok'`);
  await sleep(800);
  check('prologue: departure undocks the ship (departure is an event)', await ev(`S.docked === false`));
  check('prologue: plan execution active after depart', await ev(`!!(S.planExec && S.planExec.active)`));
  check('prologue: departure begins with the undock operation phase', await ev(`['undock', 'harbor'].includes(S.planExec.phase)`));
  check('time control: ff-bar present with plain-language label and 4 rates', await ev(`!!document.querySelector('.ff-bar .ff-label') && document.querySelectorAll('[data-warp]').length === 4`));
  await send('Target.closeTarget', { targetId: tid });

  // ---- mission 1 flow: creation (saved profile) -> port scene skip -> plan
  tid = await newPage();
  await ev(`localStorage.removeItem('ss-save-v1'); 'save-cleared'`); /* v0.6.3: 既存セーブの上書き確認で止まらないよう、出航前にセーブを消す */
  await ev(`document.getElementById('btn-sortie').click(); 'ok'`);
  await waitFor(`document.getElementById('creation-modal').classList.contains('open')`, 20000, 'creation modal (m1)');
  await ev(`document.getElementById('btn-creation-done').click(); 'ok'`);
  await waitFor(`document.getElementById('briefing-modal').classList.contains('open')`, 20000, 'port scene (m1)');
  await sleep(800);
  await ev(`document.getElementById('btn-skip-prologue').click(); 'ok'`);
  await sleep(1200);
  await ev(`document.getElementById('btn-plan').click(); 'ok'`);
  await waitFor(`document.getElementById('plan-panel').classList.contains('open') && planPanelState && planPanelState.variants && planPanelState.variants.length >= 3 && planPanelState.variants.every(x => x.est)`, 60000, 'mission 1 plan panel');
  await sleep(300);
  const mv = await ev(`({ v: planPanelState.variants.map(x => ({ id: x.id, ok: x.est.ok })), finite: [S.ship.x, S.ship.y, S.ship.z].every(Number.isFinite) })`);
  check('mission1: ship state finite at plan panel', mv.finite);
  check('mission1: standard variant ok', mv.v.find(x => x.id === 'std').ok === true);
  await send('Target.closeTarget', { targetId: tid });
} catch (e) {
  console.log('FAIL  driver error: ' + e.message);
  failures++;
} finally { try { ws && ws.close(); } catch {} chrome.kill('SIGKILL'); }
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);
