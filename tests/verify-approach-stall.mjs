// Verification (real page / real flow) for Fix 11:
//   - approach oscillation does not spam playSfx('assist') or officer popups
//   - plan panel remains openable and operable throughout a 30s non-convergent approach
//   - stall watchdog / convergence tracker surfaces a recovery affordance
//   - game remains responsive after triggering the recovery action
// Run: node tests/verify-approach-stall.mjs [url]   (default: file:// game.html)
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const URL = process.argv[2] || ('file://' + path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'game.html'));
const PORT = 9343;
const chrome = spawn('google-chrome', ['--headless=new', '--disable-gpu', '--no-sandbox', `--remote-debugging-port=${PORT}`, '--user-data-dir=/tmp/chrome-verify-stall-prof', '--window-size=420,900', 'about:blank'], { stdio: 'ignore' });
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

  const tid = await newPage();
  await ev(`document.getElementById('btn-sortie').click(); 'ok'`);
  await waitFor(`document.getElementById('creation-modal').classList.contains('open')`, 20000, 'creation modal');
  await ev(`document.getElementById('btn-creation-done').click(); 'ok'`);
  await waitFor(`document.getElementById('briefing-modal').classList.contains('open')`, 20000, 'port scene');
  await sleep(800);
  await ev(`document.getElementById('btn-skip-prologue').click(); 'ok'`);
  await sleep(1500);

  await ev(`document.getElementById('btn-plan').click(); 'ok'`);
  await waitFor(`document.getElementById('plan-panel').classList.contains('open')`, 60000, 'm1 plan panel');
  await waitFor(`!document.getElementById('btn-depart').disabled`, 20000, 'm1 depart enabled');
  await ev(`document.getElementById('btn-depart').click(); 'ok'`);
  await sleep(500);
  await ev(`document.querySelector('[data-warp="8"]').click(); 'ok'`);

  async function dragCamera() {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 60, y: 400, button: 'left', buttons: 1 }, SID);
    for (let i = 1; i <= 10; i++) { await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 60 + i * 28, y: 400, button: 'left', buttons: 1 }, SID); await sleep(30); }
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 340, y: 400, button: 'left', buttons: 0 }, SID);
  }

  // Advance through cruise / tutorial until approach phase ('join' or 'final') with dist < 200,000.
  // The natural navigation gets 240 s; if the approach is not reached by then, the
  // bridge fallback below places the ship on its approach geometry (the M1 cruise
  // is ~5.7M ship-seconds and slow software-rendered environments cannot always
  // fly it in budget). What this suite asserts is the window behavior, not the cruise.
  let dragDone = false;
  let matchDone = false;
  const tNav0 = Date.now();
  while (Date.now() - tNav0 < 240000) {
    const st = await ev(`({
      ph: S.planExec ? S.planExec.phase : null,
      tut: S.tutorial ? S.tutorial.step : -1,
      dist: S.target && S.ship ? Math.hypot(S.target.x - S.ship.x, S.target.y - S.ship.y, S.target.z - S.ship.z) : Infinity,
      warp: S.warp
    })`);
    if ((st.ph === 'join' || st.ph === 'final') && st.dist < 200000) break;
    const wantWarp = st.dist > 2000000 ? 30000 : (st.dist > 300000 ? 300 : 8);
    if (st.warp !== wantWarp) await ev(`setWarp(${wantWarp}); 'ok'`);
    if (!dragDone && st.tut === 3) { await dragCamera(); dragDone = true; }
    if (!matchDone && st.ph === 'captain' && st.tut === 5) {
      await ev(`(() => { const b = document.getElementById('btn-order-match'); if (b && !b.disabled) b.click(); return 'ok'; })()`);
      matchDone = true;
    }
    await sleep(600);
  }
  // Scaffolding fallback (same bridge as verify-m1-arrival): the M1 cruise is
  // ~5.7M ship-seconds and in a slow software-rendered environment the boosted
  // navigation may not reach the approach within the budget. If we are still in
  // cruise, place the ship on its own approach geometry so the window below
  // exercises the real executor's join/final phases. Assertions are unchanged.
  {
    const st = await ev(`({ ph: S.planExec ? S.planExec.phase : null, dist: S.target && S.ship ? Math.hypot(S.target.x - S.ship.x, S.target.y - S.ship.y, S.target.z - S.ship.z) : Infinity })`);
    if (!((st.ph === 'join' || st.ph === 'final') && st.dist < 200000)) {
      await ev(`(() => {
        const t = S.planExec.targetBody;
        const fix = approachFix(t);
        let ax = fix.x - t.x, ay = fix.y - t.y, az = fix.z - t.z;
        const al = Math.hypot(ax, ay, az) || 1; ax /= al; ay /= al; az /= al;
        S.ship.x = fix.x + ax * 25; S.ship.y = fix.y + ay * 25; S.ship.z = fix.z + az * 25;
        S.ship.vx = t.vx - ax * 2.0; S.ship.vy = t.vy - ay * 2.0; S.ship.vz = t.vz - az * 2.0;
        S.activeBurn = null;
        if (S.planExec) { S.planExec.badEst = 0; S.planExec.paused = false; S.planExec.deviated = false; }
        if (S.tutorial && S.tutorial.step < 4) S.tutorial.step = 4;
        setWarp(8);
        return 'bridged';
      })()`);
      const tB = Date.now();
      while (Date.now() - tB < 120000) {
        const s2 = await ev(`({ ph: S.planExec ? S.planExec.phase : null, tut: S.tutorial ? S.tutorial.step : -1 })`);
        if (s2.ph === 'join' || s2.ph === 'final') break;
        if (s2.ph === 'captain') {
          await ev(`(() => { const b = document.getElementById('btn-order-match'); if (b && !b.disabled) b.click(); return 'ok'; })()`);
        }
        await sleep(600);
      }
    }
  }
  await ev(`setWarp(8); 'ok'`);

  // Instrument playSfx and record msgSeq start BEFORE perturbation window
  const msgSeqStart = await ev(`(() => {
    window.__sfxCount = {};
    const origPlaySfx = playSfx;
    playSfx = function(type) {
      window.__sfxCount[type] = (window.__sfxCount[type] || 0) + 1;
      return origPlaySfx.apply(this, arguments);
    };
    return msgSeq;
  })()`);

  // Force non-convergence for 30 real seconds
  let panelUsableAllChecks = true;
  let recoverySeen = false;
  let angle = 0;
  let nextPanelCheckMs = 5000;
  const winStart = Date.now();
  while (Date.now() - winStart < 30000) {
    const elapsed = Date.now() - winStart;
    angle += 0.9;
    const st = await ev(`(() => {
      const dist = S.target && S.ship ? Math.hypot(S.target.x - S.ship.x, S.target.y - S.ship.y, S.target.z - S.ship.z) : 0;
      if (dist > 15 && dist < 60000) {
        S.ship.vx += Math.cos(${angle}) * 1.2;
        S.ship.vy += Math.sin(${angle}) * 0.4;
        S.ship.vz += Math.sin(${angle}) * 1.2;
      }
      const pe = S.planExec;
      const logTxt = document.getElementById('log') ? document.getElementById('log').textContent : '';
      const hasAlert = !!(msgState.alert && msgState.alert.actions);
      const stalled = !!(pe && (pe.approachStalled || pe.manualModified));
      const logStall = logTxt.includes('自動接近が収束していません');
      return { dist, hasAlert, stalled, logStall };
    })()`);
    if (st.hasAlert || st.stalled || st.logStall) recoverySeen = true;

    if (elapsed >= nextPanelCheckMs) {
      nextPanelCheckMs += 5000;
      const panelOk = await ev(`(() => {
        const btn = document.getElementById('btn-plan');
        if (btn) btn.click();
        else openMissionPlanPanel();
        const pp = document.getElementById('plan-panel');
        const isOpen = !!(pp && pp.classList.contains('open'));
        const hasEnabled = !!(pp && [...pp.querySelectorAll('button')].some(b => !b.disabled));
        const closeBtn = document.getElementById('btn-plan-close');
        if (closeBtn) closeBtn.click();
        else if (pp) pp.classList.remove('open');
        return isOpen && hasEnabled;
      })()`);
      if (!panelOk) panelUsableAllChecks = false;
    }
    await sleep(500);
  }

  const endStats = await ev(`({
    assistCount: (window.__sfxCount && window.__sfxCount.assist) || 0,
    msgDelta: msgSeq - ${msgSeqStart},
    hasAlert: !!(msgState.alert && msgState.alert.actions),
    stalled: !!(S.planExec && (S.planExec.approachStalled || S.planExec.manualModified))
  })`);

  check('approach-stall: __sfxCount.assist <= 6 (got ' + endStats.assistCount + ')', endStats.assistCount <= 6);
  check('approach-stall: popup count (msgSeq delta) <= 6 (got ' + endStats.msgDelta + ')', endStats.msgDelta <= 6);
  check('approach-stall: plan panel openable and has enabled button every 5s', panelUsableAllChecks);
  check('approach-stall: recovery affordance surfaced during window', recoverySeen || endStats.hasAlert || endStats.stalled);

  // Click recovery action (alert button if present, else open plan panel) and verify responsiveness
  const tBeforeAction = await ev(`(() => {
    const alertBtn = document.querySelector('#msg-actions button');
    if (alertBtn) { alertBtn.click(); }
    else { openMissionPlanPanel(); }
    return S.time;
  })()`);
  await sleep(1000);
  const tAfterAction = await ev(`S.time`);
  check('approach-stall: game remains responsive and S.time advances after recovery action (' + tBeforeAction.toFixed(2) + ' -> ' + tAfterAction.toFixed(2) + ')', tAfterAction > tBeforeAction);

  await send('Target.closeTarget', { targetId: tid });
} catch (e) {
  console.log('FAIL  driver error: ' + e.message);
  failures++;
} finally { try { ws && ws.close(); } catch {} chrome.kill('SIGKILL'); }
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);
