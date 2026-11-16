// Visual/structural evidence for v0.6 finisher items (real M0 flow):
//  C. Fix 12: plan panel default visible line count (summary-first), details collapsed by default
//  Fix 13/B11: screenshots — berthed harbor (station scale), departure phases undock/harbor/depart/cruise
// Run: node tests/verify-v06-visual.mjs [url]
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const URL = process.argv[2] || ('file://' + path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'game.html'));
const PORT = 9351;
const OUT = '/tmp/v06/shots';
fs.mkdirSync(OUT, { recursive: true });
const chrome = spawn('google-chrome', ['--headless=new', '--disable-gpu', '--no-sandbox', '--mute-audio', `--remote-debugging-port=${PORT}`, '--user-data-dir=/tmp/chrome-verify-v06vis2-prof', '--window-size=420,900', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function getJson(p) { return new Promise((resolve, reject) => { http.get(`http://127.0.0.1:${PORT}${p}`, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(JSON.parse(d))); }).on('error', reject); }); }
let ws, msgId = 0; const pending = new Map();
function send(method, params = {}, sessionId) { const id = ++msgId; const msg = { id, method, params }; if (sessionId) msg.sessionId = sessionId; ws.send(JSON.stringify(msg)); return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); setTimeout(() => reject(new Error('timeout ' + method)), 90000); }); }
let SID, failures = 0;
const check = (label, cond, extra) => { console.log((cond ? 'PASS' : 'FAIL') + '  ' + label + (extra !== undefined ? '  [' + extra + ']' : '')); if (!cond) failures++; };
async function ev(expr) { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, SID); if (r.exceptionDetails) throw new Error('page eval error: ' + (r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text)); return r.result ? r.result.value : undefined; }
async function waitFor(expr, timeoutMs, label) { const t0 = Date.now(); while (Date.now() - t0 < timeoutMs) { if (await ev(expr)) return true; await sleep(400); } throw new Error('waitFor timeout: ' + label); }
async function shot(name) { const r = await send('Page.captureScreenshot', { format: 'png' }, SID); fs.writeFileSync(path.join(OUT, name), Buffer.from(r.data, 'base64')); console.log('shot:', name); }

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
  await ev(`localStorage.removeItem('ss-save-v1'); 'save-cleared'`); /* v0.6.3: 既存セーブの上書き確認で止まらないよう、出航前にセーブを消す */
  await ev(`document.getElementById('btn-sortie').click()`);
  await waitFor(`document.getElementById('creation-modal').classList.contains('open')`, 30000, 'creation modal');
  await ev(`document.getElementById('btn-creation-done').click()`);
  await waitFor(`document.getElementById('briefing-modal').classList.contains('open')`, 30000, 'briefing modal');
  await sleep(800);
  // page through the port scene to the start button (real flow)
  for (let i = 0; i < 8; i++) {
    const vis = await ev(`document.getElementById('btn-briefing-start').style.display !== 'none'`);
    if (vis) break;
    await ev(`document.getElementById('btn-briefing-next').click()`);
    await sleep(300);
  }
  await ev(`document.getElementById('btn-briefing-start').click()`);
  await waitFor(`document.getElementById('plan-panel').classList.contains('open')`, 60000, 'plan panel');
  await sleep(800);

  // Berthed harbor: close the plan panel to reveal the 3D berth view (station scale)
  await ev(`document.getElementById('btn-plan-close').click()`);
  await sleep(1200);
  await shot('harbor-berth.png');
  const docked = await ev(`!!S.docked`);
  check('harbor: ship starts docked at あおば', docked === true);

  // ---------- C. Plan panel line count ----------
  await ev(`document.getElementById('btn-plan').click()`);
  await waitFor(`document.getElementById('plan-panel').classList.contains('open')`, 30000, 'plan panel reopen');
  await sleep(1000);
  const lines = await ev(`(() => { const el = document.getElementById('plan-detail'); const txt = (el.innerText || '').split('\\n').map(s => s.trim()).filter(Boolean); return { visible: txt.length, details: el.querySelectorAll('details.pd-details').length, openDetails: el.querySelectorAll('details.pd-details[open]').length, hasSummary: !!el.querySelector('.pd-summary') }; })()`);
  console.log('plan-detail default:', JSON.stringify(lines));
  check('C: summary card present', lines.hasSummary === true);
  check('C: detail tables collapsed into >=3 closed <details>', lines.details >= 3 && lines.openDetails === 0, 'details=' + lines.details);
  check('C: default visible text lines <= 14 (v0.5 layout was ~30)', lines.visible <= 14, 'visible=' + lines.visible);
  await shot('plan-panel-summary.png');
  await ev(`(() => { const d = document.querySelector('#plan-detail details.pd-details'); if (d) d.open = true; })()`);
  await sleep(300);
  const expandedLines = await ev(`(() => { const el = document.getElementById('plan-detail'); return (el.innerText || '').split('\\n').map(s => s.trim()).filter(Boolean).length; })()`);
  check('C: expanding details reveals the full tables', expandedLines > lines.visible + 5, 'expanded=' + expandedLines);
  await shot('plan-panel-expanded.png');

  // ---------- Departure phases (real flow, x8) ----------
  await waitFor(`!document.getElementById('btn-depart').disabled`, 30000, 'depart enabled');
  await ev(`document.getElementById('btn-depart').click()`);
  await sleep(400);
  await ev(`document.querySelector('[data-warp="8"]').click()`);
  const seen = {};
  const t0 = Date.now();
  while (Date.now() - t0 < 300000) {
    const ph = await ev(`S.planExec ? S.planExec.phase : 'none'`);
    if (ph && ph !== 'none' && !seen[ph]) {
      seen[ph] = true;
      await sleep(900);
      await shot('depart-' + ph + '.png');
      console.log('captured phase', ph);
    }
    if (ph === 'cruise') break;
    await sleep(600);
  }
  const seq = Object.keys(seen);
  console.log('phase sequence:', seq.join(' -> '));
  check('departure: undock phase traversed', !!seen['undock'], seq.join(','));
  check('departure: harbor phase traversed (no teleport from berth to cruise)', !!seen['harbor'], seq.join(','));
  check('departure: reached cruise continuously', !!seen['cruise'], seq.join(','));
  check('departure: order undock < harbor < cruise', seq.indexOf('undock') < seq.indexOf('harbor') && seq.indexOf('harbor') < seq.indexOf('cruise'), seq.join(' -> '));

  console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILURES');
  process.exit(failures === 0 ? 0 : 1);
} catch (e) {
  console.error('ERROR', e);
  process.exit(2);
} finally {
  try { chrome.kill(); } catch {}
}
