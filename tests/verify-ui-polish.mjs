// Verification (real page / real flow) for the v0.5 cycle:
//   - calm UI: single message surface, contextual order bar / metric chips,
//     measured unobstructed 3D band at 390x844 in the M0 cruise state
//   - NPC orientation: hull forward vs velocity (route NPCs, port craft)
//   - traffic course lines: chart (relative-velocity vectors) + 3D near lines
//   - speaker silhouettes + location backdrops (port scene, ship rooms, talk)
//   - real transfers: estimator dv split + arrival relative velocity,
//     berthing approach rel velocity, collision-course warning / collision
//   - time continuity at x8: clock samples advance in small steps,
//     log timestamps use ship time (day + hh:mm:ss)
// Run: node tests/verify-ui-polish.mjs [url]   (default: file:// game.html)
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const URL = process.argv[2] || ('file://' + path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'game.html'));
const PORT = 9343;
const chrome = spawn('google-chrome', ['--headless=new', '--disable-gpu', '--no-sandbox', `--remote-debugging-port=${PORT}`, '--user-data-dir=/tmp/chrome-uipolish-prof', '--window-size=420,900', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function getJson(p) { return new Promise((resolve, reject) => { http.get(`http://127.0.0.1:${PORT}${p}`, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(JSON.parse(d))); }).on('error', reject); }); }
let ws, msgId = 0; const pending = new Map();
function send(method, params = {}, sessionId) { const id = ++msgId; const msg = { id, method, params }; if (sessionId) msg.sessionId = sessionId; ws.send(JSON.stringify(msg)); return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); setTimeout(() => reject(new Error('timeout ' + method)), 60000); }); }
let SID, failures = 0;
const check = (label, cond) => { console.log((cond ? 'PASS' : 'FAIL') + '  ' + label); if (!cond) failures++; };
async function ev(expr) { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, SID); if (r.exceptionDetails) throw new Error('page eval error: ' + (r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text)); return r.result ? r.result.value : undefined; }
async function waitFor(expr, timeoutMs, label) { const t0 = Date.now(); while (Date.now() - t0 < timeoutMs) { if (await ev(expr)) return true; await sleep(400); } throw new Error('waitFor timeout: ' + label); }
async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' }, SID);
  fs.writeFileSync('/tmp/' + name, Buffer.from(r.data, 'base64'));
  console.log('  screenshot: /tmp/' + name);
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
  await sleep(600);
  return targetId;
}
const ANGLE_FN = `window.__angleAudit = () => {
  const fwd = (mesh) => { const v = new THREE.Vector3(0, 0, 1); v.applyQuaternion(mesh.quaternion); return v; };
  const ang = (a, b) => { const d = Math.max(-1, Math.min(1, a.x * b.x + a.y * b.y + a.z * b.z)); return Math.acos(d) * 180 / Math.PI; };
  const out = { npcs: [], craft: [] };
  (S.npcs || []).forEach((n, i) => { const m = npcMeshes[i]; if (!m) return; const sp = Math.hypot(n.vx, n.vy, n.vz) || 1; out.npcs.push({ name: n.name, ang: ang(fwd(m), { x: n.vx / sp, y: n.vy / sp, z: n.vz / sp }) }); });
  (S.portCraft || []).forEach((c, i) => { const m = portCraftMeshes[i]; if (!m || c.hx == null) return; out.craft.push({ name: c.name, cat: c.cat, ang: ang(fwd(m), { x: c.hx, y: c.hy, z: c.hz }) }); });
  return out;
}; 'ok'`;

try {
  let version = null;
  for (let i = 0; i < 40; i++) { try { version = await getJson('/json/version'); break; } catch { await sleep(500); } }
  if (!version) throw new Error('chrome CDP not up');
  ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (ev2) => { const m = JSON.parse(ev2.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } };

  // ---------- Part A: port scene -> plan -> cruise (Mission 0) ----------
  let tid = await newPage();
  await ev(`localStorage.removeItem('ss-save-v1'); 'save-cleared'`); /* v0.6.3: 既存セーブの上書き確認で止まらないよう、出航前にセーブを消す */
  await ev(`document.getElementById('btn-sortie').click(); 'ok'`);
  await waitFor(`document.getElementById('creation-modal').classList.contains('open')`, 20000, 'creation modal');
  await ev(`{ const a = document.getElementById('cr-ainame'); a.value = 'ミラ'; a.dispatchEvent(new Event('input', { bubbles: true })); 'ok' }`);
  await ev(`document.getElementById('btn-creation-done').click(); 'ok'`);
  await waitFor(`document.getElementById('briefing-modal').classList.contains('open')`, 20000, 'port scene');
  await sleep(700);
  check('silhouette: port-scene speaker has an avatar (SVG or portrait)', await ev(`!!document.querySelector('#briefing-avatar svg, #briefing-avatar img')`));
  check('place: port scene has a location backdrop (station interior)', await ev(`!!document.querySelector('#briefing-bg svg, #briefing-bg img')`));
  await shot('uip-port-scene.png');
  // advance the port scene to the end, then start
  for (let i = 0; i < 8; i++) {
    const last = await ev(`document.getElementById('btn-briefing-start').style.display !== 'none'`);
    if (last) break;
    await ev(`document.getElementById('btn-briefing-next').click(); 'ok'`);
    await sleep(350);
  }
  await ev(`document.getElementById('btn-briefing-start').click(); 'ok'`);
  await waitFor(`document.getElementById('plan-panel').classList.contains('open')`, 60000, 'plan panel');
  // v0.6.1: estimates fill asynchronously; wait until the first card carries real numbers
  await waitFor(`(() => { const m = document.querySelector('.pv-meta'); return !!m && m.textContent.includes('出発噴射'); })()`, 60000, 'first variant estimate rendered');
  const pv = await ev(`document.querySelector('.pv-meta') ? document.querySelector('.pv-meta').textContent : ''`);
  check('transfer: plan panel shows dv split （出発噴射/到着噴射）', pv.includes('出発噴射') && pv.includes('到着噴射'));
  check('transfer: plan panel shows arrival relative velocity', pv.includes('相対速度'));
  check('time: plan panel duration uses natural units (no raw seconds count)', !/推定時間: 約\d+秒/.test(pv) || pv.includes('分') || pv.includes('時間'));
  // plan as an operations document (the real estimator check runs on the actual M1 plan in Part B)
  const pd = await ev(`(() => { const el = document.getElementById('plan-detail'); return { rows: el.querySelectorAll('.pd-row').length, txt: el.textContent }; })()`);
  check('plan doc: leg-by-leg burn plan present （噴射計画）', pd.txt.includes('噴射計画') && pd.txt.includes('出発噴射'));
  check('plan doc: route with waypoint ETAs present （航路）', pd.txt.includes('航路') && pd.txt.includes('ETA'));
  check('plan doc: propellant budget with reserve line', pd.txt.includes('推進剤予算') && pd.txt.includes('予備'));
  check('plan doc: arrival condition stated', pd.txt.includes('到着条件'));
  await ev(`document.querySelector('[data-prio="fuel"]').click(); 'ok'`);
  await sleep(300);
  check('plan lever: priority re-derives the recommendation', await ev(`planPanelState.priority === 'fuel' && document.getElementById('plan-detail').querySelectorAll('.pd-row').length >= 4`));
  await ev(`document.querySelector('[data-res="20"]').click(); 'ok'`);
  await sleep(200);
  check('plan lever: reserve margin is adjustable', await ev(`planPanelState.reserve === 20`));
  await shot('uip-plan-doc.png');
  await ev(ANGLE_FN);
  const auditA = await ev(`window.__angleAudit()`);
  console.log('  orientation at port:', JSON.stringify(auditA));
  check('orientation: route NPCs fly nose-first (<5 deg)', auditA.npcs.length >= 2 && auditA.npcs.every(n => n.ang < 5));
  const docked = auditA.craft.filter(c => c.cat === 'docked');
  check('orientation: berthed ships aligned (<10 deg)', docked.length >= 3 && docked.every(c => c.ang < 10));
  const movers = auditA.craft.filter(c => c.cat !== 'docked');
  check('orientation: holding/craft/lane aligned to their motion (<25 deg)', movers.length >= 3 && movers.every(c => c.ang < 25));
  check('single surface: no officer-popup element', await ev(`!document.getElementById('officer-popup')`));
  check('single surface: no tutorial-steps element', await ev(`!document.getElementById('tutorial-steps')`));
  check('traffic: 3D course lines visible near port (>=2)', await ev(`(window.__trafficLinesVisible || 0) >= 2`));
  await waitFor(`!document.getElementById('btn-depart').disabled`, 20000, 'depart enabled');
  await ev(`document.getElementById('btn-depart').click(); 'ok'`);
  await sleep(600);
  check('course 3D: after plan approval, 3D course line and waypoint markers are active', await ev(`!!(S.planSamples && S.planSamples.length > 0 && planLine && planLine.visible && planWpGroup && planWpGroup.visible && planWpGroup.children.length > 0)`));
  await ev(`document.querySelector('[data-warp="8"]').click(); 'ok'`);
  // prologue tutorial step A2 asks for a camera drag; without it the tutorial
  // never advances and the M0 return leg never starts (same drive as Part B).
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 200, y: 300, button: 'left', clickCount: 1 }, SID);
  for (let i = 1; i <= 8; i++) { await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 200 + i * 18, y: 300, button: 'left' }, SID); await sleep(30); }
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 344, y: 300, button: 'left', clickCount: 1 }, SID);
  // harbor: chart course lines at port range
  await ev(`document.getElementById('btn-chart').click(); 'ok'`);
  await sleep(900);
  check('chart: course lines drawn for contacts at port range (>=3)', await ev(`(window.__chartCourseLines || 0) >= 3`));
  await shot('uip-chart-port.png');
  await ev(`document.getElementById('btn-chart-close').click(); 'ok'`);
  await waitFor(`S.planExec && S.planExec.phase === 'cruise'`, 120000, 'cruise phase');
  await sleep(800);
  const lay = await ev(`(() => { const th = document.getElementById('top-hud').getBoundingClientRect(); const bs = document.getElementById('bottom-stack').getBoundingClientRect(); return { band: bs.top - th.bottom, ih: window.innerHeight }; })()`);
  console.log('  unobstructed band:', JSON.stringify(lay), 'share:', (lay.band / lay.ih * 100).toFixed(1) + '%');
  check('calm UI: unobstructed 3D band >= 50% of viewport height in cruise', lay.band / lay.ih >= 0.5);
  const hudNoOverlap = await ev(`(() => { const a = document.getElementById('mb-sys').getBoundingClientRect(); const b = document.getElementById('btn-mute').getBoundingClientRect(); return a.width > 0 && b.width > 0 && (a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top); })()`);
  check('HUD 390x844: #mb-sys and #btn-mute do not overlap', hudNoOverlap);
  check('calm UI: order bar hidden during AI cruise', await ev(`!document.getElementById('order-bar').classList.contains('visible')`));
  check('calm UI: conditional metric chips hidden during cruise', await ev(`[...document.querySelectorAll('.metric-chip.cond')].every(e => !e.classList.contains('visible'))`));
  check('calm UI: camera/status overlay is outside the control dock', await ev(`!document.getElementById('control-dock').contains(document.getElementById('view-overlay'))`));
  const dup = await ev(`(() => { const b = document.getElementById('msg-body').textContent || ''; const n = document.getElementById('next-action'); const nv = n && n.style.display !== 'none' ? (n.textContent || '') : ''; return { body: b.slice(0, 40), nextVisible: nv.length > 0, overlap: b.length > 10 && nv.includes(b.slice(0, 20)) }; })()`);
  check('single surface: guide text is not duplicated in the next-action line', !dup.overlap);
  check('silhouette: message card speaker has an avatar (SVG or portrait)', await ev(`!!document.querySelector('#msg-avatar svg, #msg-avatar img')`));
  await shot('uip-cruise-portrait.png');
  // time continuity at x8: sample the sim clock
  const samples = [];
  for (let i = 0; i < 10; i++) { samples.push(await ev(`S.time`)); await sleep(120); }
  const steps = samples.slice(1).map((t, i) => t - samples[i]);
  console.log('  clock steps at x8:', steps.map(s => s.toFixed(2)).join(','));
  check('time: clock advances continuously at x8 (every step < 1.6 sim-s, all positive)', steps.every(s => s > 0 && s < 1.6));
  const logTxt = await ev(`document.getElementById('log').textContent`);
  check('time: log timestamps are ship time (day + hh:mm:ss)', /\[船内時 1日目 \d{2}:\d{2}:\d{2}\]/.test(logTxt));
  const noDupApproachBurn = await ev(`(() => { const lines = (document.getElementById('log').innerText || document.getElementById('log').textContent || '').split('\\n').filter(l => l.includes('計画噴射：接近噴射')); const stamps = lines.map(l => (l.match(/\\[船内時 [^\\]]+\\]/) || [''])[0]).filter(Boolean); return stamps.length === new Set(stamps).size; })()`);
  check('log: no duplicate 計画噴射：接近噴射 lines at the same ship-time second', noDupApproachBurn);
  // chart + plan coexistence while en route (must run before the long scene section:
  // by then the M0 flight may already have completed)
  await ev(`document.getElementById('btn-chart').click(); 'ok'`);
  await sleep(400);
  await ev(`document.getElementById('btn-plan').click(); 'ok'`);
  await sleep(600);
  check('task: chart + plan coexist (both stay open; the second is a compact sheet)', await ev(`document.getElementById('plan-panel').classList.contains('open') && document.getElementById('chart-panel').classList.contains('open') && document.getElementById('plan-panel').classList.contains('compact')`));
  check('plan tracking: en route the plan task opens as a live tracking document', await ev(`!!(planPanelState && planPanelState.tracking) && document.getElementById('plan-detail').textContent.includes('噴射計画と実績')`));
  await sleep(700);
  check('chart: the plan route + waypoints are drawn with the plan', await ev(`(() => { renderChart(); const r = window.__chartRoute || {}; return r.pts > 5 && r.wps >= 2; })()`));
  await shot('uip-chart-plan.png');
  await ev(`showOfficerPopup(HELM, 'カットイン確認'); 'ok'`);
  await sleep(400);
  check('cut-in: dialogue overlays open tasks without closing them', await ev(`document.getElementById('msg-card').classList.contains('visible') && document.getElementById('plan-panel').classList.contains('open') && document.getElementById('chart-panel').classList.contains('open')`));
  await ev(`document.getElementById('msg-close').click(); 'ok'`);
  await sleep(300);
  await ev(`document.getElementById('btn-plan-close').click(); 'ok'`);
  await sleep(300);
  check('task: closing the plan restores the chart to full form', await ev(`document.getElementById('chart-panel').classList.contains('open') && !document.getElementById('chart-panel').classList.contains('compact')`));
  await ev(`document.getElementById('btn-chart-close').click(); 'ok'`);
  await sleep(200);
  // interior as scenes: directory -> corridor transit (ship time) -> room scene -> talk scene
  await ev(`document.getElementById('btn-ship').click(); 'ok'`);
  await sleep(600);
  const bgBridge = await ev(`document.getElementById('ship-scene-bg').innerHTML`);
  const tWalk0 = await ev(`S.time`);
  await ev(`document.querySelector('[data-room="engine"]').click(); 'ok'`);
  await sleep(600);
  check('scene: moving rooms passes through the corridor (transit state)', await ev(`document.getElementById('scene-overlay').classList.contains('open') && document.getElementById('scene-place').textContent.includes('通路') && document.getElementById('scene-line').textContent.includes('移動中')`));
  await shot('uip-scene-corridor.png');
  await waitFor(`S.captainLoc && S.captainLoc.room === 'engine' && !S.captainLoc.transit`, 60000, 'arrival in engine room');
  console.log('  bridge->engine walk ship-time cost:', (await ev(`S.time`)) - tWalk0);
  check('scene: arrival in the engine room after ship-time transit', await ev(`document.getElementById('scene-place').textContent.includes('機関室')`));
  check('scene: a person stands in the room scene', await ev(`document.getElementById('scene-people').textContent.includes('陳') && !!document.querySelector('#scene-people svg, #scene-people img')`));
  await shot('uip-scene-engine.png');
  check('place: walk-around changes the backdrop （機関室）', await ev(`document.getElementById('ship-scene-name').textContent.includes('機関室') && document.getElementById('ship-scene-bg').innerHTML !== ${JSON.stringify(bgBridge)}`));
  const tOp0 = await ev(`S.time`);
  await ev(`document.querySelector('[data-scene-op="engine"]').click(); 'ok'`);
  await sleep(400);
  check('scene: room action runs on the clock (not instant)', await ev(`!!(S.captainLoc && S.captainLoc.activity && S.captainLoc.activity.kind === 'op')`));
  await waitFor(`document.getElementById('log').textContent.includes('機関点検')`, 120000, 'engine inspection completes on the clock');
  console.log('  engine inspection ship-time cost:', (await ev(`S.time`)) - tOp0);
  check('scene: room action completes and reports', await ev(`document.getElementById('log').textContent.includes('機関点検')`));
  await ev(`document.querySelector('#scene-people [data-talk]').click(); 'ok'`);
  await sleep(500);
  check('scene: conversation is a full-stage scene (large avatar + line)', await ev(`document.querySelector('.scene-person.talk-focus .sp-sil svg, .scene-person.talk-focus .sp-sil img') !== null && document.getElementById('scene-line').textContent.includes('「')`));
  await shot('uip-talk-scene.png');
  await ev(`document.querySelector('[data-endtalk="1"]').click(); 'ok'`);
  await sleep(300);
  await ev(`document.getElementById('scene-exit').click(); 'ok'`);
  await sleep(300);
  check('scene: exit returns to the prior task state (drawer still open)', await ev(`!document.getElementById('scene-overlay').classList.contains('open') && document.getElementById('drawer').classList.contains('open')`));
  // mode toggle: chart/camera state must survive 航行->艦内->航行, flight uninterrupted
  await ev(`document.getElementById('btn-chart').click(); 'ok'`);
  await sleep(500);
  const fcInit = await ev(`document.querySelector('#frame-chip-chart .frame-chip-label')?.textContent || ''`);
  check('frame: frame indicator chip exists and shows a 基準 label', fcInit.includes('基準'));
  await ev(`document.querySelector('[data-range="system"]').click(); 'ok'`);
  // v0.6.1: cruise AUTO no longer parks the camera at system range, so after the
  // manual switch the ease toward the wide distance needs time to settle before
  // the snapshot (the assertion itself is unchanged).
  await waitFor(`camDistTarget === null`, 120000, 'camera ease settled at system range');
  const fcSys = await ev(`document.querySelector('#frame-chip-chart .frame-chip-label')?.textContent || ''`);
  check('frame: switching chart to wide range sets frame indicator to ソル基準', fcSys.includes('ソル基準'));
  const before = await ev(`({ mode: chartState.mode, range: chartState.range, camd: cam.dist, t: S.time })`);
  await ev(`document.getElementById('btn-chart-close').click(); 'ok'`);
  await ev(`document.getElementById('btn-mode-nav').click(); 'ok'`);
  await sleep(300);
  check('mode: nav toggle closes the drawer', await ev(`!document.getElementById('drawer').classList.contains('open')`));
  const dsTxt = await ev(`document.getElementById('drawer-status').textContent`);
  console.log('  drawer-status:', JSON.stringify(dsTxt));
  check('mode: slim voyage status line exists for interior mode', dsTxt.length > 4 && (dsTxt.includes('計画') || dsTxt.includes('航行') || dsTxt.includes('Δv')));
  await ev(`showOfficerPopup(HELM, '当直報告テスト'); 'ok'`);
  await ev(`document.getElementById('btn-ship').click(); 'ok'`);
  await sleep(700);
  check('mode: report notice appears inside interior mode', await ev(`document.getElementById('drawer-notice').style.display !== 'none'`));
  await ev(`document.getElementById('drawer-notice').click(); 'ok'`);
  await sleep(300);
  check('mode: notice tap returns to navigation in one tap', await ev(`!document.getElementById('drawer').classList.contains('open')`));
  const after = await ev(`({ mode: chartState.mode, range: chartState.range, camd: cam.dist, t: S.time })`);
  check('mode: chart manual override preserved across toggles', before.mode === after.mode && before.range === after.range);
  check('mode: camera distance preserved across toggles', Math.abs(before.camd - after.camd) < 0.5);
  check('mode: flight kept running across toggles', after.t > before.t);
  // task system: every surface closable, one-up, chips carry pending, events reopen
  await ev(`document.getElementById('btn-top-toggle').click(); 'ok'`);
  await sleep(300);
  check('task: top stack collapses (banner+card away, slim line stays)', await ev(`document.getElementById('top-hud').classList.contains('collapsed') && getComputedStyle(document.getElementById('mission-banner')).display === 'none' && !!document.getElementById('next-action')`));
  await ev(`showOfficerPopup(HELM, 'イベント駆動テスト'); 'ok'`);
  await sleep(400);
  check('task: an incoming report reopens the message surface by itself', await ev(`!document.getElementById('top-hud').classList.contains('collapsed') && document.getElementById('msg-card').classList.contains('visible')`));
  await ev(`document.getElementById('btn-dock-toggle').click(); 'ok'`);
  await sleep(300);
  check('task: dock collapses to its essentials (orders/metrics away)', await ev(`document.getElementById('control-dock').classList.contains('collapsed') && getComputedStyle(document.querySelector('.hud-metrics')).display === 'none'`));
  await ev(`document.getElementById('btn-dock-toggle').click(); 'ok'`);
  await sleep(200);
  const logChip = await ev(`({ pending: document.getElementById('btn-task-log').classList.contains('pending'), n: document.getElementById('btn-task-log').dataset.n })`);
  console.log('  log chip:', JSON.stringify(logChip));
  await ev(`document.getElementById('btn-task-log').click(); 'ok'`);
  // poll for the cleared mark instead of a fixed 400 ms assert (raced the render loop)
  try { await waitFor(`!document.getElementById('btn-task-log').classList.contains('pending')`, 6000, 'log chip mark clears'); } catch (e) { /* the check below reports the state */ }
  check('task: log chip opens the drawer on the log tab and clears its mark', await ev(`document.getElementById('drawer').classList.contains('open') && document.getElementById('tab-log').classList.contains('active') && !document.getElementById('btn-task-log').classList.contains('pending')`));
  await ev(`document.getElementById('btn-mode-nav').click(); 'ok'`);
  await sleep(200);
  await send('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 2, mobile: true }, SID);
  await sleep(500);
  await ev(`document.querySelector('[data-tab="galaxy"]') && 'ok'`);
  await shot('uip-cruise-landscape.png');
  // Complete Mission 0 while the interior view is open and verify #result-modal opens
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }, SID);
  await sleep(300);
  await ev(`setWarp(1000); 'ok'`);
  await waitFor(`document.getElementById('plan-panel').classList.contains('open') || S.missionEnded`, 180000, 'M0 return plan panel');
  if (!await ev(`S.missionEnded`)) {
    await ev(`(() => { const c = document.getElementById('departure-checklist'); if (c && !c.checked) c.click(); })()`);
    /* 待ち延長（ドライバ都合、v0.6.2）: 帰投推定（終端フェーズ込み）が重くなり
     20 秒では推定が揃わないため 120 秒に延長（アサーションは不変）。 */
  await waitFor(`!document.getElementById('btn-depart').disabled`, 120000, 'M0 return depart enabled');
    await ev(`document.getElementById('btn-depart').click(); 'ok'`);
    await sleep(400);
    await ev(`document.getElementById('btn-ship').click(); 'ok'`);
    await sleep(300);
    const tM0End = Date.now();
    while (Date.now() - tM0End < 300000) {
      const m0st = await ev(`({ ended: S.missionEnded, dist: S.target && S.ship ? Math.hypot(S.target.x - S.ship.x, S.target.y - S.ship.y, S.target.z - S.ship.z) : 0, warp: S.warp })`);
      if (m0st.ended) break;
      const want = m0st.dist > 50000 ? 1000 : (m0st.dist > 5000 ? 300 : 8);
      if (m0st.warp !== want) await ev(`setWarp(${want}); 'ok'`);
      await sleep(350);
    }
  }
  await waitFor(`S.missionEnded === true`, 60000, 'M0 completion');
  check('M0 completion: completing Mission 0 while interior view is open makes #result-modal visible', await ev(`document.getElementById('result-modal').classList.contains('open')`));
  await send('Target.closeTarget', { targetId: tid });

  // ---------- Part B: mission 1 — measured arrival relative velocity ----------
  tid = await newPage();
  await ev(`localStorage.removeItem('ss-save-v1'); 'save-cleared'`); /* v0.6.3: 既存セーブの上書き確認で止まらないよう、出航前にセーブを消す */
  await ev(`document.getElementById('btn-sortie').click(); 'ok'`);
  await waitFor(`document.getElementById('creation-modal').classList.contains('open')`, 20000, 'creation modal (m1)');
  await ev(`document.getElementById('btn-creation-done').click(); 'ok'`);
  await waitFor(`document.getElementById('briefing-modal').classList.contains('open')`, 20000, 'port scene (m1)');
  await sleep(800);
  await ev(`document.getElementById('btn-skip-prologue').click(); 'ok'`);
  await sleep(1500);
  // skip-prologue starts the rendezvous training mission (MISSIONS index 0).
  // Part B measures that mission's arrival. (An earlier draft also called
  // startMission(1) here, which silently switched to the warp mission.)
  await ev(`document.getElementById('btn-plan').click(); 'ok'`);
  await waitFor(`document.getElementById('plan-panel').classList.contains('open')`, 60000, 'm1 plan panel');
  const est1 = await ev(`(() => { const e = computePlanEstimate(S.ship, S.target, S.sys.starGM, 1, { needDock: true, planets: S.planets }); return { ok: e.ok, cross: !!e.planetCross, dv: e.dvTotal, dep: e.dvDepart, arr: e.dvArrival, rel: e.finalRel, legs: (e.legs || []).length }; })()`);
  console.log('  estimate for the actual M1 plan (station -> supply ship):', JSON.stringify(est1));
  check('transfer: the actual M1 plan is feasible', est1.ok === true);
  check('transfer: the planned course does not cross a planet', est1.cross === false);
  check('transfer: dv split sums to total', Math.abs((est1.dep + est1.arr) - est1.dv) < 0.11);
  check('transfer: planned arrival relative velocity ~0 (<=1.5)', est1.rel <= 1.5);
  check('plan doc: estimator returns leg segments', est1.legs >= 3);
  await waitFor(`!document.getElementById('btn-depart').disabled`, 120000, 'm1 depart enabled');
  await ev(`document.getElementById('btn-depart').click(); 'ok'`);
  await sleep(500);
  await ev(`document.querySelector('[data-warp="8"]').click(); 'ok'`);
  let lastApproachRel = null;
  const tB0 = Date.now();
  while (Date.now() - tB0 < 420000) {
    const st = await ev(`({ b: !!S.berthing, ph: S.planExec ? S.planExec.phase : null, docked: S.docked, ended: S.missionEnded, tut: S.tutorial ? S.tutorial.step : -1, dist: relState().dist, rel: relState().rel, warp: S.warp })`);
    if (st.b) break;
    if (st.docked || st.ended) break;
    const wantWarp = st.dist > 2000000 ? 30000 : (st.dist > 300000 ? 300 : 8);
    if (st.warp !== wantWarp) await ev(`setWarp(${wantWarp}); 'ok'`);
    if (st.dist < 16) lastApproachRel = st.rel;
    // tutorial step 3 asks for a camera drag; without it the tutorial never
    // reaches step 5 and the captain phase waits forever (same drive as
    // verify-time-and-cruise Part B).
    if (st.tut === 3) {
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 200, y: 300, button: 'left', clickCount: 1 }, SID);
      for (let i = 1; i <= 8; i++) { await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 200 + i * 18, y: 300, button: 'left' }, SID); await sleep(30); }
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 344, y: 300, button: 'left', clickCount: 1 }, SID);
    }
    // the match order belongs to tutorial step 5 in the captain phase; retry
    // while in that state (a click before the button enables is a no-op)
    if (st.ph === 'captain' && st.tut === 5) await ev(`(() => { const b = document.getElementById('btn-order-match'); if (b && !b.disabled) b.click(); return 'ok'; })()`);
    await sleep(300);
  }
  console.log('  approach relative velocity just before berthing:', lastApproachRel);
  check('transfer: berthing approach arrives velocity-matched (rel <= 1.6)', lastApproachRel !== null && lastApproachRel <= 1.6);
  await waitFor(`S.docked === true && S.missionEnded === true`, 90000, 'm1 docking completion');
  check('transfer: mission 1 docks after velocity-matched approach', true);
  await send('Target.closeTarget', { targetId: tid });

  // ---------- Part C: deliberately unmatched approach -> warning / collision ----------
  tid = await newPage();
  await ev(`localStorage.removeItem('ss-save-v1'); 'save-cleared'`); /* v0.6.3: 既存セーブの上書き確認で止まらないよう、出航前にセーブを消す */
  await ev(`document.getElementById('btn-sortie').click(); 'ok'`);
  await waitFor(`document.getElementById('creation-modal').classList.contains('open')`, 20000, 'creation modal (mc)');
  await ev(`document.getElementById('btn-creation-done').click(); 'ok'`);
  await waitFor(`document.getElementById('briefing-modal').classList.contains('open')`, 20000, 'port scene (mc)');
  await sleep(800);
  await ev(`document.getElementById('btn-skip-prologue').click(); 'ok'`);
  await sleep(1500);
  await ev(`(() => {
    const p = S.planets[0];
    S.planExec = null; S.tutorial = null; S.docked = false; S.berthing = null;
    S.ship.x = p.x + 42; S.ship.y = p.y; S.ship.z = p.z;
    S.ship.vx = p.vx - 10; S.ship.vy = p.vy; S.ship.vz = p.vz;
    setWarp(8);
    return 'ok';
  })()`);
  let warned = false, collided = false;
  const tC0 = Date.now();
  while (Date.now() - tC0 < 30000) {
    const st = await ev(`({ failed: S.failed, log: document.getElementById('log').textContent })`);
    if (st.log.includes('衝突コース')) warned = true;
    if (st.failed) { collided = true; break; }
    if (warned) break;
    await sleep(500);
  }
  console.log('  unmatched approach outcome: warned =', warned, ', collided =', collided);
  check('transfer: unmatched collision course produces a control warning or a collision', warned || collided);
  await send('Target.closeTarget', { targetId: tid });
} catch (e) {
  console.log('FAIL  driver error: ' + e.message);
  failures++;
} finally { try { ws && ws.close(); } catch {} chrome.kill('SIGKILL'); }
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);
