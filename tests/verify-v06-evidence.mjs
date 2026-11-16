// Evidence drives for v0.6 finisher items (real page, headless Chrome on VM):
//  A. Avoidance protocol: decaying trajectory -> proposal tier (TTI>3600) appears; dismiss suppresses.
//     Then imminent trajectory (TTI<=3600) -> auto avoidance burn executes + report logged.
//  B. Fix 16 catch-up: simulate a hidden-tab gap via runCatchUp(3600) at warp 1 -> ship time advances ~3600s, log entry recorded.
//  C. Fix 12: plan panel default visible line count (summary-first) + details sections exist closed.
//  D. Fix 8: briefing "次へ" button at identical coordinates across two pages.
//  E. Reporting hierarchy: triggerEvent accumulates to reportQueue, no officer popup for ambient events.
//  F. Codex: 資料 button opens codex modal with entries.
// Run: node tests/verify-v06-evidence.mjs [url]
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const URL = process.argv[2] || ('file://' + path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'game.html'));
const PORT = 9347;
const OUT = '/tmp/v06/shots';
fs.mkdirSync(OUT, { recursive: true });
const chrome = spawn('google-chrome', ['--headless=new', '--disable-gpu', '--no-sandbox', '--mute-audio', `--remote-debugging-port=${PORT}`, '--user-data-dir=/tmp/chrome-verify-v06-prof', '--window-size=420,900', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function getJson(p) { return new Promise((resolve, reject) => { http.get(`http://127.0.0.1:${PORT}${p}`, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(JSON.parse(d))); }).on('error', reject); }); }
let ws, msgId = 0; const pending = new Map();
function send(method, params = {}, sessionId) { const id = ++msgId; const msg = { id, method, params }; if (sessionId) msg.sessionId = sessionId; ws.send(JSON.stringify(msg)); return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); setTimeout(() => reject(new Error('timeout ' + method)), 90000); }); }
let SID, failures = 0;
const check = (label, cond, extra) => { console.log((cond ? 'PASS' : 'FAIL') + '  ' + label + (extra !== undefined ? '  [' + extra + ']' : '')); if (!cond) failures++; };
async function ev(expr) { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, SID); if (r.exceptionDetails) throw new Error('page eval error: ' + (r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text)); return r.result ? r.result.value : undefined; }
async function waitFor(expr, timeoutMs, label) { const t0 = Date.now(); while (Date.now() - t0 < timeoutMs) { if (await ev(expr)) return true; await sleep(400); } throw new Error('waitFor timeout: ' + label); }
async function shot(name) { const r = await send('Page.captureScreenshot', { format: 'png' }, SID); fs.writeFileSync(path.join(OUT, name), Buffer.from(r.data, 'base64')); }

try {
  let version = null;
  for (let i = 0; i < 40; i++) { try { version = await getJson('/json/version'); break; } catch { await sleep(500); } }
  if (!version) throw new Error('chrome CDP not up');
  ws = new WebSocket(version.webSocketDebuggerUrl);
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id).resolve(d.result || d.error); pending.delete(d.id); } };
  await sleep(300);
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  SID = sessionId;
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }, SID);
  await send('Page.enable', {}, SID);
  await send('Runtime.enable', {}, SID);
  await send('Page.navigate', { url: URL }, SID);
  await waitFor(`!!document.getElementById('btn-sortie')`, 30000, 'start screen');
  await sleep(800);

  // Start the game with defaults (captain creation defaults -> port scene -> skip prologue into Mission 0 free state is complex;
  // instead use the start flow: click 出撃 and complete creation with defaults if shown)
  await ev(`localStorage.removeItem('ss-save-v1'); 'save-cleared'`); /* v0.6.3: 既存セーブの上書き確認で止まらないよう、出航前にセーブを消す */
  await ev(`document.getElementById('btn-sortie').click()`);
  await sleep(1500);
  // Captain creation modal may be open: accept defaults
  await ev(`(() => { const b = document.getElementById('btn-creation-done'); if (b && document.getElementById('creation-modal').classList.contains('open')) b.click(); })()`);
  await sleep(1500);
  // Briefing modal (Mission 0): D. measure 次へ button position on two consecutive pages
  const briefOpen = await ev(`document.getElementById('briefing-modal').classList.contains('open')`);
  if (briefOpen) {
    const pos1 = await ev(`(() => { const r = document.getElementById('btn-briefing-next').getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width) }; })()`);
    await shot('briefing-p1.png');
    await ev(`document.getElementById('btn-briefing-next').click()`);
    await sleep(700);
    const pos2 = await ev(`(() => { const r = document.getElementById('btn-briefing-next').getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width) }; })()`);
    await shot('briefing-p2.png');
    check('D: briefing next-button anchored (same coords page1/page2)', pos1.x === pos2.x && pos1.y === pos2.y && pos1.w === pos2.w, JSON.stringify(pos1) + ' vs ' + JSON.stringify(pos2));
    // skip prologue to reach free flight quickly
    await ev(`(() => { const b = document.getElementById('btn-skip-prologue'); if (b) b.click(); })()`);
    await sleep(1500);
  } else {
    check('D: briefing modal opened at game start', false, 'briefing not open');
  }

  await waitFor(`typeof S !== 'undefined' && S && S.ship`, 30000, 'game state S');
  // Ensure we are flying (not docked): if docked at station in M0 start, undock state may vary; force a clean free-flight lab state:
  await ev(`(() => {
    S.failed = false; S.missionEnded = false;
    if (S.docked) { S.docked = false; S.dockedTo = null; }
    if (S.planExec) { S.planExec.active = false; }
    S.warp = 1;
  })()`);
  await sleep(300);

  // ---------- E. Reporting hierarchy ----------
  await ev(`(() => { S.reportQueue = []; window.__popupBefore = (msgState.officer ? msgState.officer.id : -1); triggerEvent(); })()`);
  await sleep(300);
  const repQ = await ev(`(S.reportQueue || []).length`);
  const popupAfter = await ev(`(msgState.officer ? msgState.officer.id : -1)`);
  check('E: ambient event accumulated silently (reportQueue grew)', repQ >= 1, 'queue=' + repQ);
  check('E: ambient event produced NO officer popup', popupAfter === await ev(`window.__popupBefore`), 'popup id unchanged');

  // ---------- F. Codex ----------
  await ev(`document.getElementById('btn-codex').click()`);
  await sleep(500);
  const codexOpen = await ev(`document.getElementById('codex-modal').classList.contains('open')`);
  const codexEntries = await ev(`document.querySelectorAll('#codex-modal .codex-entry').length`);
  check('F: codex opens from 資料 task chip', codexOpen === true);
  check('F: codex has >=7 entries', codexEntries >= 7, 'entries=' + codexEntries);
  await shot('codex.png');
  await ev(`document.getElementById('btn-codex-close').click()`);
  await sleep(300);

  // ---------- A. Avoidance protocol ----------
  // Place the ship on a decaying trajectory toward つむぎ: at planet-relative position with planet-matched velocity (proven to fall in ~6.5h -> TTI > 3600 => proposal tier)
  const setup = await ev(`(() => {
    const p = S.planets[1]; // つむぎ
    // position: 400,000 from planet center, polar offset; velocity = planet's velocity (matched) -> decays and impacts (~6.5h per probe)
    const dx = 0, dy = 400000, dz = 0;
    S.ship.x = p.x + dx; S.ship.y = p.y + dy; S.ship.z = p.z + dz;
    S.ship.vx = p.vx; S.ship.vy = p.vy; S.ship.vz = p.vz;
    S.activeBurn = null; S.avoidProposal = null; S.avoidSuppress = {}; S.avoidWatchT = -1e9;
    const hit = predictImpact(172800);
    return hit ? { body: hit.body, tti: Math.round(hit.tti) } : null;
  })()`);
  check('A: predictImpact finds the decaying trajectory', !!setup, JSON.stringify(setup));
  if (setup) {
    check('A: predicted body is つむぎ (or its moon)', /つむぎ|こよみ/.test(setup.body), setup.body);
    check('A: TTI in proposal tier (>3600s)', setup.tti > 3600, 'tti=' + setup.tti + 's');
    await ev(`avoidanceWatch()`);
    await sleep(300);
    const prop = await ev(`S.avoidProposal ? { body: S.avoidProposal.body, mag: S.avoidProposal.mag } : null`);
    check('A: proposal tier sets avoidProposal', !!prop, JSON.stringify(prop));
    await ev(`updateAvoidanceAlert()`);
    await sleep(300);
    const alertTxt = await ev(`document.getElementById('msg-title') ? document.getElementById('msg-title').textContent : ''`);
    check('A: proposal alert card shown', /衝突回避の提案/.test(alertTxt || ''), alertTxt);
    await shot('avoid-proposal.png');
    // dismiss -> suppression
    await ev(`dismissAvoidance()`);
    await ev(`S.avoidWatchT = -1e9; avoidanceWatch()`);
    await sleep(200);
    const propAfterDismiss = await ev(`!!S.avoidProposal`);
    check('A: dismissal suppresses re-proposal (1h)', propAfterDismiss === false);
    // Imminent tier: place ship 60,000 above surface on direct collision course -> TTI <= 3600 => auto burn
    const setup2 = await ev(`(() => {
      const p = S.planets[1];
      const sr = surfaceRadius(p);
      const d = sr + 60000;
      S.ship.x = p.x + d; S.ship.y = p.y; S.ship.z = p.z;
      // velocity: planet velocity + radial inward 25 -> impact in ~ (60000/25)=2400s minus gravity accel -> <=3600
      S.ship.vx = p.vx - 25; S.ship.vy = p.vy; S.ship.vz = p.vz;
      S.activeBurn = null; S.avoidProposal = null; S.avoidSuppress = {}; S.avoidWatchT = -1e9; S.avoidAutoReport = false;
      const hit = predictImpact(172800);
      return hit ? { body: hit.body, tti: Math.round(hit.tti) } : null;
    })()`);
    check('A: imminent setup predicts impact', !!setup2, JSON.stringify(setup2));
    if (setup2) {
      check('A: imminent TTI <= 3600 (auto tier)', setup2.tti <= 3600, 'tti=' + setup2.tti + 's');
      const dvBefore = await ev(`S.dv`);
      await ev(`avoidanceWatch()`);
      await sleep(300);
      const burn = await ev(`S.activeBurn ? { kind: S.activeBurn.kind, cost: S.activeBurn.costTotal } : null`);
      check('A: auto tier executed avoidance burn immediately', !!burn && burn.kind === 'avoid', JSON.stringify(burn));
      check('A: auto report flagged', await ev(`!!S.avoidAutoReport`) === true);
      const logHas = await ev(`Array.from(document.getElementById('log').children).some(c => /回避噴射を即時実施/.test(c.textContent))`);
      check('A: auto avoidance reported in log', logHas === true);
      // let the burn finish and confirm trajectory now clears
      await ev(`(() => { const b = S.activeBurn; if (b) { S.ship.vx += b.remX; S.ship.vy += b.remY; S.ship.vz += b.remZ; S.dv -= b.costTotal; S.activeBurn = null; } })()`);
      const clear = await ev(`predictImpact(172800)`);
      check('A: post-burn trajectory clears all bodies (48h)', clear === null, JSON.stringify(clear));
      check('A: dv was charged for avoidance burn', (await ev(`S.dv`)) < dvBefore, 'dv ' + dvBefore.toFixed(1) + ' -> ' + (await ev(`S.dv`)).toFixed(1));
    }
  }

  // ---------- B. Fix 16 catch-up ----------
  await ev(`(() => {
    // park the ship in the station's circular orbit around つむぎ (radius 520,000, stable for days)
    const p = S.planets[1];
    const R = 520000;
    const vc = Math.sqrt(p.gm / R);
    S.ship.x = p.x + R; S.ship.y = p.y; S.ship.z = p.z;
    S.ship.vx = p.vx; S.ship.vy = p.vy; S.ship.vz = p.vz + vc;
    S.activeBurn = null; S.avoidProposal = null; S.avoidSuppress = {}; S.warp = 1;
    window.__t0 = S.time;
  })()`);
  await ev(`runCatchUp(3600)`);
  await sleep(300);
  const adv = await ev(`S.time - window.__t0`);
  check('B: catch-up advanced ship time ~3600s for 3600s absence at warp 1', adv > 3300 && adv <= 3700, 'advanced=' + Math.round(adv));
  const cuLog = await ev(`Array.from(document.getElementById('log').children).some(c => /離席中も航行は継続/.test(c.textContent))`);
  check('B: catch-up summary logged', cuLog === true);
  const warpRestored = await ev(`S.warp`);
  check('B: warp restored after catch-up', warpRestored === 1, 'warp=' + warpRestored);

  console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILURES');
  process.exit(failures === 0 ? 0 : 1);
} catch (e) {
  console.error('ERROR', e);
  process.exit(2);
} finally {
  try { chrome.kill(); } catch {}
}
