// Verification test (browser, CDP): v0.6.3 mid-voyage save/load (台帳#26).
// Flow:
//   start -> creation -> briefing -> approve std -> depart -> camera drag (A2)
//   -> cruise partway -> record reference state -> force saveGame()
//   -> reload page -> start screen shows 「つづきから」
//   -> continue -> state restored within tolerance, catch-up advanced the clock,
//      plan still alive, tutorial past the A2 gate, log restored
//   -> keep flying via the panel-approval loop -> mission completes (berthing)
//   scenario B: with a save present, 「出航する」 asks for overwrite confirmation;
//      cancel keeps the start screen, confirm clears the save and starts new game.
// Run: node tests/verify-save-load.mjs [url]
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const URL = process.argv[2] || ('file://' + path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'game.html'));
const PORT = 9351;
const chrome = spawn('google-chrome', [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${PORT}`,
  '--user-data-dir=/tmp/chrome-verify-save-load-' + Date.now(),
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
    setTimeout(() => reject(new Error('timeout ' + method)), 60000);
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
    if (await ev(expr)) return true;
    await sleep(300);
  }
  throw new Error('waitFor timeout: ' + label);
}

async function newPage() {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  SID = sessionId;
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }, SID);
  await send('Page.enable', {}, SID);
  await send('Runtime.enable', {}, SID);
  await send('Page.navigate', { url: URL }, SID);
  await waitFor(`!!document.getElementById('btn-sortie')`, 30000, 'start screen');
  await sleep(400);
  return targetId;
}

async function approveVariantInPanel(variantId) {
  await waitFor(`document.getElementById('plan-panel').classList.contains('open') && !!planPanelState && !planPanelState.tracking`, 60000, 'plan panel');
  const idx = await ev(`planPanelState ? planPanelState.variants.findIndex(v => v.id === ${JSON.stringify(variantId)}) : -1`);
  if (idx < 0) throw new Error('variant not found: ' + variantId);
  await ev(`(() => { const cards = document.querySelectorAll('#plan-variants .pv-card'); if (cards[${idx}]) cards[${idx}].click(); const chk = document.getElementById('departure-checklist'); if (chk) chk.click(); return 'ok'; })()`);
  await waitFor(`!document.getElementById('btn-depart').disabled`, 90000, 'depart enabled for ' + variantId);
  await ev(`document.getElementById('btn-depart').click(); 'ok'`);
  await sleep(800);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 200, y: 400, button: 'left', clickCount: 1 }, SID).catch(() => {});
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 260, y: 400, button: 'left' }, SID).catch(() => {});
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 320, y: 400, button: 'left' }, SID).catch(() => {});
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 370, y: 400, button: 'left' }, SID).catch(() => {});
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 370, y: 400, button: 'left', clickCount: 1 }, SID).catch(() => {});
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

  const tid = await newPage();
  try {
    check('page title is v0.6.3', (await ev(`document.title`)).includes('v0.6.3'), await ev(`document.title`));
    check('no save initially: continue button hidden', await ev(`document.getElementById('btn-continue').style.display === 'none'`));

    /* ---- voyage start (player flow) ---- */
    await ev(`document.getElementById('btn-sortie').click(); 'ok'`);
    await waitFor(`document.getElementById('creation-modal').classList.contains('open')`, 20000, 'creation modal');
    await ev(`document.getElementById('btn-creation-done').click(); 'ok'`);
    await waitFor(`document.getElementById('briefing-modal').classList.contains('open')`, 20000, 'port scene');
    await sleep(400);
    for (let i = 0; i < 8; i++) {
      const vis = await ev(`document.getElementById('btn-briefing-start').style.display !== 'none'`);
      if (vis) break;
      await ev(`document.getElementById('btn-briefing-next').click(); 'ok'`);
      await sleep(250);
    }
    await ev(`document.getElementById('btn-briefing-start').click(); 'ok'`);
    await approveVariantInPanel('std');
    await waitFor(`!!S && !!S.planExec && S.planExec.active !== false && S.time > 5`, 30000, 'departed with live plan');

    /* ---- cruise partway (test-side warp boost), then settle to x1 ---- */
    await ev(`S.warp = 300; 'ok'`);
    await waitFor(`S.time > 1500`, 60000, 'cruise partway (S.time > 1500)');
    await ev(`S.warp = 1; 'ok'`);
    await sleep(400);

    const ref = await ev(`(() => ({
      time: S.time, x: S.ship.x, y: S.ship.y, z: S.ship.z,
      vx: S.ship.vx, vy: S.ship.vy, vz: S.ship.vz, dv: S.dv,
      phase: S.planExec ? S.planExec.phase : null,
      targetIsMoon: !!(S.target && S.target.isMoon),
      tutStep: S.tutorial ? S.tutorial.step : -1,
      npcs: S.npcs ? S.npcs.length : 0,
      logCount: document.getElementById('log').children.length
    }))()`);
    console.log('reference state:', JSON.stringify(ref));
    check('reference: plan alive mid-cruise', !!ref.phase && ref.phase !== 'done', 'phase=' + ref.phase);
    check('reference: tutorial past A2 gate (step >= 2)', ref.tutStep >= 2, 'step=' + ref.tutStep);
    check('reference: target is the moon', ref.targetIsMoon);

    /* ---- force save and inspect the stored payload ---- */
    check('saveGame() returns true', await ev(`saveGame('test')`) === true);
    const savedInfo = await ev(`(() => {
      const raw = localStorage.getItem('ss-save-v1');
      if (!raw) return null;
      const d = JSON.parse(raw);
      return { bytes: raw.length, format: d.format, shipTime: d.shipTime,
               shipX: d.bodies.ship.x, shipY: d.bodies.ship.y, shipZ: d.bodies.ship.z,
               label: d.label, tutStep: d.tutorial ? d.tutorial.step : null };
    })()`);
    console.log('saved payload:', JSON.stringify(savedInfo));
    check('save stored in localStorage', !!savedInfo && savedInfo.bytes > 1000, savedInfo ? savedInfo.bytes + ' bytes' : 'missing');
    check('save format = 1', !!savedInfo && savedInfo.format === 1);
    check('saved ship position matches reference', !!savedInfo && Math.hypot(savedInfo.shipX - ref.x, savedInfo.shipY - ref.y, savedInfo.shipZ - ref.z) < 5000,
      savedInfo ? 'dist=' + Math.round(Math.hypot(savedInfo.shipX - ref.x, savedInfo.shipY - ref.y, savedInfo.shipZ - ref.z)) : 'n/a');
    check('saved tutorial step matches reference', !!savedInfo && savedInfo.tutStep === ref.tutStep, 'saved=' + (savedInfo && savedInfo.tutStep));

    /* ---- reload and continue ---- */
    await send('Page.navigate', { url: URL }, SID);
    await waitFor(`!!document.getElementById('btn-sortie')`, 30000, 'start screen after reload');
    await waitFor(`document.getElementById('btn-continue').style.display !== 'none'`, 10000, 'continue button visible');
    check('continue info mentions the voyage', (await ev(`document.getElementById('continue-info').textContent`)).includes('処女航海'));
    await sleep(4000); /* let real time pass so the catch-up has something to chew */
    await ev(`document.getElementById('btn-continue').click(); 'ok'`);
    await waitFor(`!!S && gameStarted && !!S.ship`, 30000, 'state restored');
    await sleep(600);

    const got = await ev(`(() => ({
      time: S.time, x: S.ship.x, y: S.ship.y, z: S.ship.z,
      vx: S.ship.vx, vy: S.ship.vy, vz: S.ship.vz, dv: S.dv,
      phase: S.planExec ? S.planExec.phase : null,
      planTargetIsMoon: !!(S.planExec && S.planExec.targetBody && S.planExec.targetBody.isMoon),
      targetSameObject: !!(S.planExec && S.target && S.planExec.targetBody === S.target),
      tutStep: S.tutorial ? S.tutorial.step : -1,
      npcs: S.npcs ? S.npcs.length : 0,
      portCraft: S.portCraft ? S.portCraft.length : 0,
      logCount: document.getElementById('log').children.length,
      logHasResume: [...document.getElementById('log').children].some(d => d.textContent.includes('再開')),
      startHidden: document.getElementById('start-screen').classList.contains('hidden')
    }))()`);
    console.log('restored state:', JSON.stringify(got));
    const posErr = Math.hypot(got.x - ref.x, got.y - ref.y, got.z - ref.z);
    const velErr = Math.hypot(got.vx - ref.vx, got.vy - ref.vy, got.vz - ref.vz);
    check('restored: start screen hidden', got.startHidden);
    /* 小さいギャップ（<120 船内秒）は既存の runCatchUp の下限により追いつき
       対象外で、実時間のまま再開するのが正しい挙動（時計が飛ばないこと） */
    check('restored: small gap resumes in real time (no spurious jump)', got.time > ref.time && got.time < ref.time + 30, `ref=${ref.time.toFixed(1)} got=${got.time.toFixed(1)}`);
    check('restored: position within tolerance', posErr < 30000, 'err=' + Math.round(posErr));
    check('restored: velocity within tolerance', velErr < 20, 'err=' + velErr.toFixed(2));
    check('restored: dv not increased and close', got.dv <= ref.dv + 0.001 && got.dv >= ref.dv - 3, `ref=${ref.dv.toFixed(2)} got=${got.dv.toFixed(2)}`);
    check('restored: plan alive, same phase', got.phase === ref.phase, `phase=${got.phase}`);
    check('restored: plan target is the moon, same object as S.target', got.planTargetIsMoon && got.targetSameObject);
    check('restored: tutorial step preserved (A2 gate stays passed)', got.tutStep === ref.tutStep, `step=${got.tutStep}`);
    check('restored: traffic ships present', got.npcs === ref.npcs && got.npcs > 0, 'npcs=' + got.npcs);
    check('restored: port traffic rebuilt', got.portCraft > 0, 'portCraft=' + got.portCraft);
    check('restored: voyage log restored + resume line', got.logCount >= ref.logCount && got.logHasResume, 'log=' + got.logCount);

    /* ---- phase 2: a real catch-up through loadGame ----
       Save at warp 300, reload, wait a few real seconds: the elapsed gap
       (real seconds x saved warp) exceeds runCatchUp's 120 s threshold, so
       loadGame must engage the existing catch-up and consume the gap. */
    await ev(`S.warp = 300; saveGame('test2'); 'ok'`);
    await send('Page.navigate', { url: URL }, SID);
    await waitFor(`!!document.getElementById('btn-sortie')`, 30000, 'start screen (phase 2)');
    await waitFor(`document.getElementById('btn-continue').style.display !== 'none'`, 10000, 'continue visible (phase 2)');
    const savedTime2 = await ev(`JSON.parse(localStorage.getItem('ss-save-v1')).shipTime`);
    await sleep(4000);
    await ev(`document.getElementById('btn-continue').click(); 'ok'`);
    await waitFor(`!!S && gameStarted && !!S.ship`, 30000, 'state restored (phase 2)');
    await waitFor(`!catchUpState`, 90000, 'catch-up settled (phase 2)');
    await sleep(400);
    const got2 = await ev(`(() => ({
      time: S.time, failed: !!S.failed,
      planAlive: !!(S.planExec && S.planExec.active !== false),
      posFinite: [S.ship.x, S.ship.y, S.ship.z].every(Number.isFinite)
    }))()`);
    console.log('phase2 catch-up:', JSON.stringify({ savedTime2, ...got2 }));
    check('phase2: catch-up consumed the gap (>= +300 ship-sec)', got2.time >= savedTime2 + 300, `saved=${savedTime2.toFixed(1)} got=${got2.time.toFixed(1)}`);
    check('phase2: plan alive and ship intact after catch-up', got2.planAlive && got2.posFinite && !got2.failed);

    /* ---- fly on to completion through the approval loop ----
       駆動は verify-m0-variants と同一のワープ段（v0.6.2 最終検証で eco/std/
       fast 全完走した駆動）。なお完走は第1段の既知残件（捕捉軌道の長期安定性、
       帰還レグの Δv 余裕＝推定精度）の影響を受ける：同じ駆動でも v0.6.2 無改造
       で帰還接舷を取りこぼす場合があることを対照実験で確認済み（報告書参照）。
       ゲーム側の余裕そのものは第2段の担当で、ここでは変更しない。 */
    let minTsumugi = Infinity;
    let minMoon = Infinity;
    let finalState = null;
    const t0 = Date.now();
    while (Date.now() - t0 < 600000) {
      const st = await ev(`(() => {
        if (!S || !S.ship) return null;
        const tsumugi = S.planets && S.planets[1];
        const moon = S.planets && S.planets.find(p => p.isMoon);
        const dT = tsumugi ? Math.hypot(S.ship.x - tsumugi.x, S.ship.y - tsumugi.y, S.ship.z - tsumugi.z) : Infinity;
        const dM = moon ? Math.hypot(S.ship.x - moon.x, S.ship.y - moon.y, S.ship.z - moon.z) : Infinity;
        const dTarget = S.target ? Math.hypot(S.ship.x - S.target.x, S.ship.y - S.target.y, S.ship.z - S.target.z) : Infinity;
        const panelOpen = document.getElementById('plan-panel').classList.contains('open') && !!planPanelState && !planPanelState.tracking;
        if (!S.missionEnded && !S.failed && (!S.planExec || !S.planExec.active)) S.warp = 1;
        if (!S.missionEnded && !S.failed && !panelOpen) {
          const far = (S.station && S.target === S.station) ? 3000 : 30000;
          S.warp = dTarget < 3000 ? 30 : (dTarget < 30000 ? 300 : (dM < 30000 ? 300 : far));
        }
        if (panelOpen && !S.missionEnded && !S.failed) S.warp = 1;
        return { dT, dM, panelOpen, ended: !!S.missionEnded, succeeded: !!S.succeeded, failed: !!S.failed, time: S.time || 0 };
      })()`);
      if (st) {
        if (Number.isFinite(st.dT) && st.dT < minTsumugi) minTsumugi = st.dT;
        if (Number.isFinite(st.dM) && st.dM < minMoon) minMoon = st.dM;
        finalState = st;
        if (st.ended || st.failed) break;
        /* 帰還レグは eco で承認する（往路 std より噴射が穏やかで、推定誤差に
           対する余裕を取りやすい。艦長が帰りは安全側に倒す判断として自然） */
        if (st.panelOpen) await approveVariantInPanel('eco');
      }
      await sleep(120);
    }
    console.log('post-restore flight:', JSON.stringify({ ended: finalState && finalState.ended, succeeded: finalState && finalState.succeeded, failed: finalState && finalState.failed, minTsumugi: Math.round(minTsumugi), minMoon: Math.round(minMoon), simTime: finalState ? Math.round(finalState.time) : 0 }));
    check('post-restore: mission completed (missionEnded && succeeded)', !!(finalState && finalState.ended && finalState.succeeded));
    check('post-restore: no impact on つむぎ (> 203000)', minTsumugi > 203000, `${Math.round(minTsumugi)}`);
    check('post-restore: no impact on こよみ (> 2600)', minMoon > 2600, `${Math.round(minMoon)}`);

    /* ---- scenario B: overwrite confirmation on new game ---- */
    await send('Page.navigate', { url: URL }, SID);
    await waitFor(`!!document.getElementById('btn-sortie')`, 30000, 'start screen (scenario B)');
    await waitFor(`document.getElementById('btn-continue').style.display !== 'none'`, 10000, 'continue visible (scenario B)');
    await ev(`document.getElementById('btn-sortie').click(); 'ok'`);
    await sleep(500);
    check('overwrite confirm shown, creation not opened', await ev(`document.getElementById('save-overwrite-confirm').style.display !== 'none' && !document.getElementById('creation-modal').classList.contains('open')`));
    await ev(`document.getElementById('btn-overwrite-no').click(); 'ok'`);
    await sleep(300);
    check('cancel: confirm hidden, still on start screen', await ev(`document.getElementById('save-overwrite-confirm').style.display === 'none' && !document.getElementById('start-screen').classList.contains('hidden') && !!localStorage.getItem('ss-save-v1')`));
    await ev(`document.getElementById('btn-sortie').click(); 'ok'`);
    await sleep(500);
    await ev(`document.getElementById('btn-overwrite-yes').click(); 'ok'`);
    await waitFor(`document.getElementById('creation-modal').classList.contains('open')`, 20000, 'creation modal after overwrite confirm');
    check('overwrite confirm: save cleared, new game started', await ev(`localStorage.getItem('ss-save-v1') === null`));
  } finally {
    await send('Target.closeTarget', { targetId: tid }).catch(() => {});
  }

  console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURES`);
  process.exitCode = failures === 0 ? 0 : 1;
} catch (e) {
  console.error('ERROR', e);
  process.exitCode = 2;
} finally {
  try { chrome.kill(); } catch {}
}
