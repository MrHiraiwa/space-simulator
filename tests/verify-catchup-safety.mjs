// Catch-up safety (ledger #44/#47/#48): the catch-up path (background resume and
// debug skip share it) must never fly the ship into a body.
//  (i)   eco outbound + debug skip -> arrival (capture) or a decision point, never a crash.
//  (iv)  end-state stability: after capture arrival, 24 h of unpowered propagation
//        stays bounded near the moon (no fall-in, no divergence) — the approval
//        wait is a safe berth (#47).
//  (iii) background catch-up with the plan removed mid-flight -> halts as a
//        captain-required event instead of sailing on planless.
//  (ii)  planless collision course -> catch-up halts on the free-flight guard
//        before impact.
// Also saves the departure-framing screenshot (station + planet backdrop) for #7.
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';

const URL = 'file://' + path.join(process.env.HOME, 'workspace/space-simulator/game.html');
const PORT = 9365;
const SHOTS = path.join(process.env.HOME, 'workspace/space-simulator/playtest/shots-v062');
fs.mkdirSync(SHOTS, { recursive: true });
const chrome = spawn('/home/hatch/bin/google-chrome', [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${PORT}`,
  '--user-data-dir=/tmp/chrome-cusafe-' + Date.now(),
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
  return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); setTimeout(() => reject(new Error('timeout ' + method)), 120000); });
}
let SID;
async function ev(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, SID);
  if (r.exceptionDetails) throw new Error('eval: ' + (r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text));
  return r.result ? r.result.value : undefined;
}
async function waitFor(expr, timeoutMs, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) { if (await ev(expr)) return true; await sleep(300); }
  throw new Error('waitFor timeout: ' + label);
}
async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' }, SID);
  fs.writeFileSync(path.join(SHOTS, name), Buffer.from(r.data, 'base64'));
  console.log('shot:', name);
}
let failures = 0;
const check = (label, cond, detail) => { console.log((cond ? 'PASS' : 'FAIL') + '  ' + label + (detail ? ` (${detail})` : '')); if (!cond) failures++; };

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
// depart with ECO (the #44 accident was on eco)
await ev(`(() => { const idx = planPanelState.variants.findIndex(v => v.id === 'eco'); const cards = document.querySelectorAll('#plan-variants .pv-card'); if (cards[idx]) cards[idx].click(); return idx; })()`);
await sleep(300);
await ev(`(() => { const chk = document.getElementById('departure-checklist'); if (chk) chk.click(); return 'ok'; })()`);
await waitFor(`!document.getElementById('btn-depart').disabled`, 60000, 'depart enabled (eco feasible)');
await ev(`document.getElementById('btn-depart').click(); 'ok'`);
await sleep(800);
// A2 drag + A3 warp
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 200, y: 400, button: 'left', clickCount: 1 }, SID).catch(() => {});
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 260, y: 400, button: 'left' }, SID).catch(() => {});
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 320, y: 400, button: 'left' }, SID).catch(() => {});
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 370, y: 400, button: 'left' }, SID).catch(() => {});
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 370, y: 400, button: 'left', clickCount: 1 }, SID).catch(() => {});
await sleep(600);
await ev(`document.querySelector('[data-warp="8"]').click(); 'ok'`);
await waitFor(`!!(S.planExec && S.planExec.phase === 'harbor')`, 60000, 'harbor phase');
await sleep(1500);
await shot('departure-harbor.png');
await waitFor(`!!(S.planExec && S.planExec.phase === 'cruise')`, 120000, 'cruise phase');

// (i) debug skip from cruise -> arrival / decision point, never a crash
await ev(`startDebugSkip(); 'ok'`);
await waitFor(`catchUpState === null`, 300000, 'skip halted');
await sleep(500);
const afterSkip = await ev(`(() => { const moon = S.planets.find(p => p.isMoon); return {
  failed: !!S.failed, step: S.tutorial ? S.tutorial.step : -1,
  pePhase: S.planExec ? S.planExec.phase : null, captureDone: !!(S.planExec && S.planExec.captureDone),
  dMoon: moon ? Math.round(Math.hypot(S.ship.x - moon.x, S.ship.y - moon.y, S.ship.z - moon.z)) : -1,
  dv: +S.dv.toFixed(1) }; })()`);
console.log('after skip:', JSON.stringify(afterSkip));
check('(i) skip did not crash the ship', afterSkip.failed === false);
check('(i) skip reached arrival (tutorial step >= 4)', afterSkip.step >= 4, 'step=' + afterSkip.step);
check('(i) ship is in the moon vicinity (captured)', afterSkip.dMoon > 2600 && afterSkip.dMoon < 45000, 'dMoon=' + afterSkip.dMoon);

// (iii) return leg: approve, reach cruise, then remove the plan mid-catch-up
await waitFor(`document.getElementById('plan-panel').classList.contains('open') && !!planPanelState`, 90000, 'return panel');
await ev(`(() => { const idx = planPanelState.variants.findIndex(v => v.id === 'std'); const cards = document.querySelectorAll('#plan-variants .pv-card'); if (cards[idx]) cards[idx].click(); const chk = document.getElementById('departure-checklist'); if (chk) chk.click(); return 'ok'; })()`);
await waitFor(`!document.getElementById('btn-depart').disabled`, 60000, 'return depart enabled');
await ev(`document.getElementById('btn-depart').click(); 'ok'`);
await ev(`document.querySelector('[data-warp="8"]').click(); 'ok'`);
await waitFor(`!!(S.planExec && S.planExec.phase === 'cruise')`, 180000, 'return cruise');
await ev(`runCatchUp(10800); 'ok'`);
await sleep(1500);
await ev(`S.planExec = null; 'plan removed'`);
await waitFor(`catchUpState === null`, 120000, 'catch-up halted after plan removal');
await sleep(300);
const logAfterRemoval = await ev(`[...document.getElementById('log').children].map(d => d.textContent).join('\\n')`);
check('(iii) halted as captain-required event (plan ended / collision course)', /計画の終了|衝突コース検出/.test(logAfterRemoval));
check('(iii) ship not failed', await ev(`!!S.failed`) === false);

// (ii) planless collision course: teleport onto a moon-impact trajectory.
// Close the plan panel first: an open panel is itself a catch-up halt reason
// (captain decision pending) and would pre-empt the guard this case tests.
await ev(`(() => { const b = document.getElementById('btn-plan-close'); if (b) b.click(); return 'closed'; })()`);
await sleep(400);
await ev(`(() => {
  const moon = S.planets.find(p => p.isMoon);
  const tsu = S.planets[1];
  let rx = moon.x - tsu.x, ry = moon.y - tsu.y, rz = moon.z - tsu.z;
  const rl = Math.hypot(rx, ry, rz); rx /= rl; ry /= rl; rz /= rl;
  S.ship.x = moon.x + rx * 25000; S.ship.y = moon.y + ry * 25000; S.ship.z = moon.z + rz * 25000;
  S.ship.vx = moon.vx - rx * 6.0; S.ship.vy = moon.vy - ry * 6.0; S.ship.vz = moon.vz - rz * 6.0;
  S.target = moon; S.planExec = null; S.docked = false; S.activeBurn = null;
  return 'placed';
})()`);
await ev(`setWarp(8); runCatchUp(10800); 'ok'`);
await waitFor(`catchUpState === null`, 180000, 'guard halted catch-up');
await sleep(300);
const guardState = await ev(`(() => { const moon = S.planets.find(p => p.isMoon); return {
  failed: !!S.failed,
  dMoon: moon ? Math.round(Math.hypot(S.ship.x - moon.x, S.ship.y - moon.y, S.ship.z - moon.z)) : -1,
  log: [...document.getElementById('log').children].map(d => d.textContent).join('\\n') }; })()`);
console.log('guard state: dMoon=' + guardState.dMoon + ' failed=' + guardState.failed);
/* #44 の合格条件は「自動安全化（回避噴射）か、衝突前に停止して艦長を呼ぶ」の
   どちらか。配置直後のサンプルで回避監視が先に発火した場合は回避側で止まる
   （実測: 約1チャンクで停止）。自由航行ガードは回避が見逃すコースへの備えとして
   毎チャンク判定する側で、どちらで止まっても「自由航行のまま衝突させない」は
   成立する。停止が配置直後でもよい（危険を即検出した結果であり、進行してから
   止まること自体は要件ではない）。 */
check('(ii) free-flight collision course halted before impact (guard or avoidance)', /衝突コース検出（計画なし）|衝突回避の自動実施/.test(guardState.log));
check('(ii) ship did not impact', guardState.failed === false && guardState.dMoon > 2600, 'dMoon=' + guardState.dMoon);


// (iv) end-state stability in a fresh session: fly eco outbound with the skip,
// then propagate the captured arrival state unpowered for 24 h of ship time.
await send('Page.navigate', { url: URL }, SID);
await waitFor(`!!document.getElementById('btn-sortie')`, 30000, 'start (session 2)');
await sleep(2500);
await ev(`localStorage.removeItem('ss-save-v1'); 'save-cleared'`); /* v0.6.3: 既存セーブの上書き確認で止まらないよう、出航前にセーブを消す */
await ev(`document.getElementById('btn-sortie').click(); 'ok'`);
await waitFor(`document.getElementById('creation-modal').classList.contains('open')`, 20000, 'creation 2');
await ev(`document.getElementById('btn-creation-done').click(); 'ok'`);
await waitFor(`document.getElementById('briefing-modal').classList.contains('open')`, 20000, 'briefing 2');
await sleep(300);
for (let i = 0; i < 8; i++) {
  const vis = await ev(`document.getElementById('btn-briefing-start').style.display !== 'none'`);
  if (vis) break;
  await ev(`document.getElementById('btn-briefing-next').click(); 'ok'`);
  await sleep(200);
}
await ev(`document.getElementById('btn-briefing-start').click(); 'ok'`);
await waitFor(`document.getElementById('plan-panel').classList.contains('open') && !!planPanelState`, 60000, 'panel 2');
await ev(`(() => { const idx = planPanelState.variants.findIndex(v => v.id === 'eco'); const cards = document.querySelectorAll('#plan-variants .pv-card'); if (cards[idx]) cards[idx].click(); return idx; })()`);
await sleep(300);
await ev(`(() => { const chk = document.getElementById('departure-checklist'); if (chk) chk.click(); return 'ok'; })()`);
await waitFor(`!document.getElementById('btn-depart').disabled`, 60000, 'depart enabled 2');
await ev(`document.getElementById('btn-depart').click(); 'ok'`);
await sleep(800);
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 200, y: 400, button: 'left', clickCount: 1 }, SID).catch(() => {});
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 320, y: 400, button: 'left' }, SID).catch(() => {});
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 320, y: 400, button: 'left', clickCount: 1 }, SID).catch(() => {});
await sleep(600);
await ev(`document.querySelector('[data-warp="8"]').click(); 'ok'`);
await waitFor(`!!(S.planExec && S.planExec.phase === 'cruise')`, 120000, 'cruise 2');
await ev(`startDebugSkip(); 'ok'`);
await waitFor(`catchUpState === null`, 300000, 'skip halted 2');
await sleep(500);
check('(iv) session-2 arrival reached', await ev(`!!(S.tutorial && S.tutorial.step >= 4) && !S.failed`));
const stab = await ev(`(() => {
  const moon = S.planets.find(p => p.isMoon);
  let mn = Infinity, mx = 0;
  for (let i = 0; i < 1440; i++) {
    physics(60);
    if (i % 20 === 0) { const d = Math.hypot(S.ship.x - moon.x, S.ship.y - moon.y, S.ship.z - moon.z); if (d < mn) mn = d; if (d > mx) mx = d; }
  }
  return { mn: Math.round(mn), mx: Math.round(mx), failed: !!S.failed };
})()`);
console.log('stability 24h:', JSON.stringify(stab));
check('(iv) end state stable: no fall-in over 24 h', stab.mn > 3400, 'min=' + stab.mn);
check('(iv) end state bounded: no divergence over 24 h', stab.mx < 45000, 'max=' + stab.mx);
check('(iv) not failed after 24 h wait', stab.failed === false);

console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)');
try { ws.close(); } catch {}
chrome.kill();
process.exit(failures === 0 ? 0 : 1);
