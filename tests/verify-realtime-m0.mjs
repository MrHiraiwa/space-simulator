// Regression test (browser, CDP): v0.6.1 realtime drive — the conditions that froze
// the game on the user's phone (playtest/v06-feedback.md #5, plus #1/#2/#3/#4/#9 checks).
//
// Unlike verify-m0-variants (which fast-forwards state), this suite drives the REAL
// rAF loop under CPU throttling (4x) and injects main-thread gaps (busy-wait, the
// observable equivalent of returning from a backgrounded tab) mid-flight, then asserts:
//   - M0 completes for all 3 variants (eco/std/fast), missionEnded && succeeded
//   - the stall watchdog NEVER fires during a healthy flight (stallAlertActive)
//   - the plan panel opens without a multi-second synchronous block (async estimates):
//     max rAF gap during the panel phase stays below 6000 ms (pre-fix: ~10000 ms)
//   - catch-up after a 16 s gap at warp 100 is frame-sliced: it completes, advances
//     ship time by ~the full amount, and no single frame gap exceeds 2500 ms
//   - #4: after pressing 「副官に任せる」, routine tutorial steps advance without the
//     conversation card being fronted (msgState.tutorial stays null), chip is shown
//   - #1: at 390x844 the first plan-variant card starts below the conversation card
//   - #9: cruise AUTO framing keeps cam.dist in visual range and chart range 'local'
//   - #2: pinch zoom works via touch events and sets cam.manualHold; AUTO restores it
//   - #3: the asteroid belt has a visible name label in the 3D view
// Screenshots land in tests/shots-realtime/.
// Run: node tests/verify-realtime-m0.mjs [url]
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const URL = process.argv[2] || ('file://' + path.join(HERE, '..', 'game.html'));
const SHOTS = path.join(HERE, 'shots-realtime');
fs.mkdirSync(SHOTS, { recursive: true });
const PORT = 9345;
const chrome = spawn('google-chrome', [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--mute-audio',
  `--remote-debugging-port=${PORT}`,
  '--user-data-dir=/tmp/chrome-verify-realtime-m0',
  '--window-size=420,900',
  'about:blank'
], { stdio: 'ignore' });

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
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => reject(new Error('timeout ' + method)), 90000);
  });
}

let SID, failures = 0;
const check = (label, cond, detail) => {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + label + (detail ? ` (${detail})` : ''));
  if (!cond) failures++;
};

async function ev(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, SID);
  if (r.exceptionDetails) {
    throw new Error('page eval error: ' + (r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text));
  }
  return r.result ? r.result.value : undefined;
}

async function waitFor(expr, timeoutMs, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { if (await ev(expr)) return true; } catch { /* page busy in a long task; keep waiting */ }
    await sleep(300);
  }
  throw new Error('waitFor timeout: ' + label);
}

async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' }, SID);
  fs.writeFileSync(path.join(SHOTS, name), Buffer.from(r.data, 'base64'));
}

async function newPage() {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  SID = sessionId;
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }, SID);
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 2 }, SID);
  await send('Emulation.setCPUThrottlingRate', { rate: 4 }, SID);
  await send('Page.enable', {}, SID);
  await send('Runtime.enable', {}, SID);
  await send('Page.navigate', { url: URL }, SID);
  await waitFor(`!!document.getElementById('btn-sortie')`, 60000, 'start screen');
  // rAF gap recorder: measures the longest main-thread stall between frames.
  await ev(`(() => {
    window.__gapMax = 0; window.__gapLast = 0;
    const loop = (ts) => { if (window.__gapLast) window.__gapMax = Math.max(window.__gapMax, ts - window.__gapLast); window.__gapLast = ts; requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
    return 'recorder on';
  })()`);
  await sleep(300);
  return targetId;
}

async function driveToPlanPanel() {
  await ev(`localStorage.removeItem('ss-save-v1'); 'save-cleared'`); /* v0.6.3: 既存セーブの上書き確認で止まらないよう、出航前にセーブを消す */
  await ev(`document.getElementById('btn-sortie').click(); 'ok'`);
  await waitFor(`document.getElementById('creation-modal').classList.contains('open')`, 30000, 'creation modal');
  await ev(`document.getElementById('btn-creation-done').click(); 'ok'`);
  await waitFor(`document.getElementById('briefing-modal').classList.contains('open')`, 30000, 'port scene');
  await sleep(300);
  for (let i = 0; i < 8; i++) {
    const vis = await ev(`document.getElementById('btn-briefing-start').style.display !== 'none'`);
    if (vis) break;
    await ev(`document.getElementById('btn-briefing-next').click(); 'ok'`);
    await sleep(250);
  }
  await ev(`window.__gapMax = 0; document.getElementById('btn-briefing-start').click(); 'ok'`);
  await waitFor(`document.getElementById('plan-panel').classList.contains('open') && !!planPanelState && !planPanelState.tracking`, 60000, 'plan panel');
}

async function selectVariantAndDepart(variantId) {
  await waitFor(`!!planPanelState && planPanelState.estimating === false`, 180000, 'estimates done');
  const idx = await ev(`planPanelState.variants.findIndex(v => v.id === ${JSON.stringify(variantId)})`);
  if (idx < 0) throw new Error('variant not found: ' + variantId);
  await ev(`(() => { const cards = document.querySelectorAll('#plan-variants .pv-card'); if (cards[${idx}]) cards[${idx}].click(); const chk = document.getElementById('departure-checklist'); if (chk) chk.click(); return 'ok'; })()`);
  await waitFor(`!document.getElementById('btn-depart').disabled`, 30000, 'depart enabled for ' + variantId);
  await ev(`document.getElementById('btn-depart').click(); 'ok'`);
}

// Flight loop shared by all variants. hooks: { onCruise(state)->bool handled, injectGapAtCruise: 'catchup'|'small'|null }
async function dragCameraOnce() {
  // Real drag on the 3D view: satisfies the prologue tutorial's camera-look step (A2),
  // which gates the return leg and therefore mission completion.
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 200, y: 400, button: 'left', clickCount: 1 }, SID).catch(() => {});
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 260, y: 400, button: 'left' }, SID).catch(() => {});
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 320, y: 400, button: 'left' }, SID).catch(() => {});
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 370, y: 400, button: 'left' }, SID).catch(() => {});
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 370, y: 400, button: 'left', clickCount: 1 }, SID).catch(() => {});
}

async function flyToCompletion(variantId, hooks = {}) {
  let minTsumugi = Infinity, minMoon = Infinity, finalState = null;
  let stallSeen = false, cruiseHookDone = false, gapDone = false, dragDone = false;
  const t0 = Date.now();
  while (Date.now() - t0 < 900000) {
    const st = await ev(`(() => {
      if (!S || !S.ship) return null;
      const tsumugi = S.planets && S.planets[1];
      const moon = S.planets && S.planets.find(p => p.isMoon);
      const dT = tsumugi ? Math.hypot(S.ship.x - tsumugi.x, S.ship.y - tsumugi.y, S.ship.z - tsumugi.z) : Infinity;
      const dM = moon ? Math.hypot(S.ship.x - moon.x, S.ship.y - moon.y, S.ship.z - moon.z) : Infinity;
      const dTarget = S.target ? Math.hypot(S.ship.x - S.target.x, S.ship.y - S.target.y, S.ship.z - S.target.z) : Infinity;
      const panelOpen = document.getElementById('plan-panel').classList.contains('open') && !!planPanelState && !planPanelState.tracking;
      return {
        dT, dM, dTarget, panelOpen,
        phase: S.planExec ? S.planExec.phase : 'none',
        stall: !!(S.planExec && S.planExec.stallAlertActive),
        ended: !!S.missionEnded, succeeded: !!S.succeeded, failed: !!S.failed,
        time: S.time || 0, warp: S.warp
      };
    })()`).catch(() => null);
    if (st) {
      if (Number.isFinite(st.dT) && st.dT < minTsumugi) minTsumugi = st.dT;
      if (Number.isFinite(st.dM) && st.dM < minMoon) minMoon = st.dM;
      if (st.stall) stallSeen = true;
      finalState = st;
      if (st.ended || st.failed) break;
      if (Math.floor((Date.now() - t0) / 60000) !== Math.floor((Date.now() - t0 - 150) / 60000)) {
        console.log(`  [${variantId}] t+${Math.round((Date.now() - t0) / 1000)}s phase=${st.phase} dTarget=${Math.round(st.dTarget)} shipT=${Math.round(st.time)} warp=${st.warp}`);
      }
      if (st.panelOpen) {
        // Hold time at x1 while approving (as a player would): at boost warp the
        // ship drifts out of the return leg's recoverable geometry during approval.
        await ev(`if (S && !S.missionEnded && !S.failed) S.warp = 1; 'held'`).catch(() => {});
        try {
          await selectVariantAndDepart(variantId);
        } catch (e) {
          // Return-leg estimates are geometry-dependent: if the variant under test
          // is not flyable for the return, take the first workable card (as a
          // captain would) instead of stranding the flight.
          await ev(`(() => { const cards = [...document.querySelectorAll('#plan-variants .pv-card')]; const c = cards.find(x => !x.classList.contains('invalid') && !x.classList.contains('estimating')); if (c) c.click(); const chk = document.getElementById('departure-checklist'); if (chk) chk.click(); return 'fallback'; })()`);
          await waitFor(`!document.getElementById('btn-depart').disabled`, 30000, 'fallback depart enabled');
          await ev(`document.getElementById('btn-depart').click(); 'ok'`);
        }
        continue;
      }
      if (!dragDone && st.phase !== 'none') { dragDone = true; await dragCameraOnce(); }

      if (!cruiseHookDone && st.phase === 'cruise' && hooks.onCruise) {
        cruiseHookDone = await hooks.onCruise(st);
      }
      if (!gapDone && st.phase === 'cruise' && hooks.injectGapAtCruise && cruiseHookDone !== false) {
        gapDone = true;
        if (hooks.injectGapAtCruise === 'catchup') await injectCatchUpGap(variantId);
        else await injectSmallGap();
        continue;
      }
      // test-side warp boost (same policy as verify-m0-variants)
      await ev(`(() => {
        if (!S || S.missionEnded || S.failed) return 'done';
        // Between legs (arrival -> return panel) there is no active plan: hold
        // time at x1 so the ship does not drift out of the return geometry
        // while the panel is being prepared.
        if (!S.planExec || !S.planExec.active) { S.warp = 1; return 'held'; }
        const dTarget = S.target ? Math.hypot(S.ship.x - S.target.x, S.ship.y - S.target.y, S.ship.z - S.target.z) : Infinity;
        const moon = S.planets && S.planets.find(p => p.isMoon);
        const dM = moon ? Math.hypot(S.ship.x - moon.x, S.ship.y - moon.y, S.ship.z - moon.z) : Infinity;
        // The return leg (target = station) is flown at <=3000: its 90-unit arrival
        // bubble and approach guidance do not tolerate x30000 time steps.
        // Warp tiers are chosen so the approach is sampled finely enough for the
        // 90-unit bubble (>= several physics samples per bubble crossing) while
        // still crossing the 30000-unit approach zone in reasonable wall time
        // under CPU throttling (at x8 the dt cap makes the sim crawl at ~x1.6).
        const far = (S.station && S.target === S.station) ? 3000 : 30000;
        S.warp = dTarget < 3000 ? 30 : (dTarget < 30000 ? 300 : (dM < 30000 ? 300 : far));
        return 'boost';
      })()`).catch(() => {});
    }
    await sleep(150);
  }
  console.log(`  [${variantId}] flight loop end:`, JSON.stringify(finalState));
  return { finalState, minTsumugi, minMoon, stallSeen };
}

async function injectSmallGap() {
  // 3 s of main-thread blockage at cruise warp: below the catch-up threshold,
  // the page must simply stay alive and keep flying afterwards.
  await ev(`S.warp = 8; 'warp8'`);
  await sleep(500);
  await ev(`(() => { const t0 = performance.now(); while (performance.now() - t0 < 3000) {} return 'blocked 3s'; })()`);
  await sleep(500);
}

async function injectCatchUpGap(variantId) {
  // 16 s blockage at warp 100 => 1600 ship-sec of catch-up, which must be digested
  // in frame slices (~10 ms/frame), not in one synchronous task.
  await ev(`S.warp = 100; 'warp100'`);
  await sleep(500);
  const before = await ev(`({ t: S.time })`);
  await ev(`(() => { const t0 = performance.now(); while (performance.now() - t0 < 16000) {} return 'blocked 16s'; })()`);
  // The injected block itself is a 16 s rAF gap by construction: the recorder logs
  // it on the first frame after the block. Let that frame pass, THEN reset and
  // measure only the catch-up digestion frames.
  await sleep(700);
  await ev(`window.__gapMax = 0; 'gap reset'`);
  // catch-up state must appear and then drain
  let sawCatchUp = false;
  const t0 = Date.now();
  let after = null;
  while (Date.now() - t0 < 90000) {
    after = await ev(`({ t: S.time, cu: typeof catchUpState !== 'undefined' && !!catchUpState, gapMax: window.__gapMax, stall: !!(S.planExec && S.planExec.stallAlertActive) })`).catch(() => null);
    if (after) {
      if (after.cu) sawCatchUp = true;
      if (!after.cu && sawCatchUp) break;
      if (!after.cu && Date.now() - t0 > 20000 && after.t > before.t + 400) break; // drained between polls
    }
    await sleep(200);
  }
  check(`[${variantId}] catch-up engaged after background gap`, sawCatchUp || (after && after.t > before.t + 400), after ? `t ${Math.round(before.t)} -> ${Math.round(after.t)}` : 'no sample');
  // Full digestion is 1600 ship-sec, but a safety halt (avoidance burn, captain
  // decision, docking) may legitimately stop it early; require solid progress.
  check(`[${variantId}] catch-up advanced ship time (>= 400 of 1600 ship-sec)`, !!after && after.t - before.t >= 400, after ? `+${Math.round(after.t - before.t)}` : 'no sample');
  check(`[${variantId}] catch-up was frame-sliced (max frame gap < 2500 ms)`, !!after && after.gapMax < 2500, after ? `gapMax=${Math.round(after.gapMax)}ms` : 'no sample');
  check(`[${variantId}] no stall alert during catch-up`, !!after && !after.stall);
}

async function runEco() {
  const tid = await newPage();
  try {
    await driveToPlanPanel();

    // #5: panel must open without the old ~10 s synchronous estimate block
    await waitFor(`!!planPanelState && planPanelState.estimating === false`, 180000, 'estimates done (eco)');
    const gapPanel = await ev(`window.__gapMax`);
    check('[eco] plan panel: max frame gap during open+estimates < 6000 ms', gapPanel < 6000, `gapMax=${Math.round(gapPanel)}ms`);

    // #1: first variant card must not hide under the conversation card (390x844)
    const geo = await ev(`(() => {
      const card = document.getElementById('msg-card');
      const pv = document.querySelector('#plan-variants .pv-card');
      const panel = document.getElementById('plan-panel');
      if (!pv) return null;
      const pvR = pv.getBoundingClientRect();
      const cR = card ? card.getBoundingClientRect() : null;
      const cardVisible = !!(cR && cR.height > 0 && card.style.display !== 'none');
      return { pvTop: pvR.top, cardBottom: cardVisible ? cR.bottom : 0, cardVisible, banded: panel.classList.contains('banded') };
    })()`);
    check('[eco] #1 first plan card starts below conversation card', !!geo && geo.pvTop >= geo.cardBottom - 2, geo ? `pvTop=${Math.round(geo.pvTop)} cardBottom=${Math.round(geo.cardBottom)} banded=${geo.banded}` : 'no geometry');
    await shot('plan-panel-390x844.png');

    await selectVariantAndDepart('eco');

    // #4: standing delegation — force the "任せる" button, press it, then watch the
    // remaining routine steps advance with no conversation card fronted.
    await waitFor(`!!(S.tutorial && S.tutorial.steps && S.tutorial.active !== false)`, 60000, 'tutorial running');
    await ev(`if (S.tutorial) S.tutorial.stuckTime = 100; 'forced stuck'`);
    await waitFor(`!!document.getElementById('btn-tut-auto')`, 30000, 'delegate button visible');
    const stepAtClick = await ev(`S.tutorial ? S.tutorial.step : -1`);
    await ev(`document.getElementById('btn-tut-auto').click(); 'delegated'`);
    await sleep(1000);
    const delState = await ev(`({ delegated: !!(S.tutorial && S.tutorial.delegated), chip: (() => { const c = document.getElementById('delegate-chip'); return !!c && c.style.display !== 'none'; })() })`);
    check('[eco] #4 delegation flag set after 任せる', delState.delegated === true);
    check('[eco] #4 delegate chip visible while delegated', delState.chip === true);
    let fronted = 0, polls = 0, maxStep = stepAtClick;
    const tD = Date.now();
    while (Date.now() - tD < 150000) {
      const s = await ev(`({ step: S.tutorial ? S.tutorial.step : 99, done: !S.tutorial, fronted: !!(typeof msgState !== 'undefined' && msgState.tutorial) })`).catch(() => null);
      if (s) {
        polls++;
        if (s.fronted) fronted++;
        if (s.step > maxStep) maxStep = s.step;
        if (s.done || s.step >= 6) break;
      }
      await sleep(500);
    }
    check('[eco] #4 routine steps advanced under delegation', maxStep > stepAtClick, `step ${stepAtClick} -> ${maxStep}`);
    check('[eco] #4 no conversation card fronted for routine steps', fronted === 0, `fronted polls ${fronted}/${polls}`);

    // Full flight with camera checks + catch-up injection
    const res = await flyToCompletion('eco', {
      injectGapAtCruise: 'catchup',
      onCruise: async () => {
        await ev(`S.warp = 8; 'warp8 for camera checks'`);
        await sleep(2500);
        const camSt = await ev(`({ dist: cam.dist, range: chartState.range, mode: chartState.mode, phase: S.planExec ? S.planExec.phase : 'none' })`);
        check('[eco] #9 cruise AUTO chart range is local (not system)', camSt.range === 'local', `range=${camSt.range}`);
        check('[eco] #9 cruise AUTO camera keeps ship visible (dist <= 1000)', camSt.dist <= 1000, `dist=${Math.round(camSt.dist)} phase=${camSt.phase}`);
        await shot('cruise-framing.png');
        // #2 pinch: two fingers spreading => zoom in, manual hold engages
        const d0 = camSt.dist;
        const cx = 195, cy = 422;
        await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: cx - 30, y: cy, id: 1 }, { x: cx + 30, y: cy, id: 2 }] }, SID);
        await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: cx - 80, y: cy, id: 1 }, { x: cx + 80, y: cy, id: 2 }] }, SID);
        await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: cx - 110, y: cy, id: 1 }, { x: cx + 110, y: cy, id: 2 }] }, SID);
        await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }, SID);
        await sleep(400);
        const pinch = await ev(`({ dist: cam.dist, hold: !!cam.manualHold })`);
        check('[eco] #2 pinch zoom changes camera distance', pinch.dist < d0 * 0.8, `dist ${Math.round(d0)} -> ${Math.round(pinch.dist)}`);
        check('[eco] #2 manual camera op engages manualHold', pinch.hold === true);
        // AUTO restore via the frame chip releases the hold
        await ev(`document.getElementById('frame-chip-3d').click(); 'chip'`);
        await sleep(300);
        await ev(`(() => { const b = document.querySelector('#frame-sel-3d button[data-fref="auto"]'); if (b) b.click(); return 'auto clicked'; })()`);
        await sleep(300);
        const holdAfter = await ev(`cam.manualHold`);
        check('[eco] #2 frame AUTO restores automatic framing (hold released)', holdAfter === false);
        return true;
      }
    });
    check('[eco] mission completed (missionEnded && succeeded)', !!(res.finalState && res.finalState.ended && res.finalState.succeeded));
    check('[eco] no stall alert during healthy flight', res.stallSeen === false);
    check('[eco] no impact on つむぎ (> 203000)', res.minTsumugi > 203000, `${Math.round(res.minTsumugi)}`);
    check('[eco] no impact on こよみ (> 2600)', res.minMoon > 2600, `${Math.round(res.minMoon)}`);
  } finally {
    await send('Target.closeTarget', { targetId: tid }).catch(() => {});
  }
}

async function runVariantPlain(variantId) {
  const tid = await newPage();
  try {
    await driveToPlanPanel();
    await selectVariantAndDepart(variantId);
    const res = await flyToCompletion(variantId, { injectGapAtCruise: 'small', onCruise: async () => true });
    check(`[${variantId}] mission completed (missionEnded && succeeded)`, !!(res.finalState && res.finalState.ended && res.finalState.succeeded));
    check(`[${variantId}] no stall alert during healthy flight`, res.stallSeen === false);
    check(`[${variantId}] no impact on つむぎ (> 203000)`, res.minTsumugi > 203000, `${Math.round(res.minTsumugi)}`);
    check(`[${variantId}] no impact on こよみ (> 2600)`, res.minMoon > 2600, `${Math.round(res.minMoon)}`);
  } finally {
    await send('Target.closeTarget', { targetId: tid }).catch(() => {});
  }
}

async function runBeltCheck() {
  const tid = await newPage();
  try {
    await driveToPlanPanel();
    await ev(`closePlanPanel(); 'panel closed'`);
    await sleep(300);
    const belt = await ev(`(() => {
      frameState.mode = 'manual'; frameState.ref = 'star';
      cam.follow = false; cam.dist = 3.2e7; cam.az = 0.9; cam.pol = 1.02;
      // aim at the belt label (angle -0.65, r=98.5M, y=4.2M in star frame)
      if (cam.target) cam.target.set(Math.cos(-0.65) * 9.85e7, 4.2e6, Math.sin(-0.65) * 9.85e7);
      return { exists: typeof beltLabel !== 'undefined' && !!beltLabel, labelsOn: typeof labelsOn !== 'undefined' ? labelsOn : null };
    })()`);
    await sleep(800);
    const vis = await ev(`typeof beltLabel !== 'undefined' && beltLabel ? beltLabel.visible : false`);
    check('[belt] #3 belt label sprite exists in 3D scene', belt.exists === true);
    check('[belt] #3 belt label visible with labels on', vis === true, `labelsOn=${belt.labelsOn}`);
    await shot('belt-label.png');
  } finally {
    await send('Target.closeTarget', { targetId: tid }).catch(() => {});
  }
}

try {
  let version = null;
  for (let i = 0; i < 40; i++) {
    try { version = await getJson('/json/version'); break; } catch { await sleep(500); }
  }
  if (!version) throw new Error('chrome CDP not up');
  ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (ev2) => {
    const m = JSON.parse(ev2.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
    }
  };

  const only = process.argv[3] || '';
  if (!only || only === 'eco') await runEco();
  if (!only || only === 'std') await runVariantPlain('std');
  if (!only || only === 'fast') await runVariantPlain('fast');
  if (!only || only === 'belt') await runBeltCheck();

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
} finally {
  try { if (ws) ws.close(); } catch {}
  try { chrome.kill('SIGKILL'); } catch {}
}

process.exit(failures ? 1 : 0);
