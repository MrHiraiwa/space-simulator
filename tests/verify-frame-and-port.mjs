// Frame switching at docked state + port visibility evidence (v0.6.2, ledger steer 1 / #7).
// Flow: start prologue -> close the A1 plan panel -> at the DOCKED view, switch the
// frame via the real chip UI (planet / star / back to AUTO) and assert the effective
// ref + manual mode persist and the camera target anchors to the ref body (origin).
// Screenshots are saved under playtest/shots-v062/ for the visibility judgement.
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';

const URL = 'file://' + path.join(process.env.HOME, 'workspace/space-simulator/game.html');
const PORT = 9360;
const SHOTS = path.join(process.env.HOME, 'workspace/space-simulator/playtest/shots-v062');
fs.mkdirSync(SHOTS, { recursive: true });
const chrome = spawn('/home/hatch/bin/google-chrome', [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${PORT}`,
  '--user-data-dir=/tmp/chrome-frame-' + Date.now(),
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
  return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); setTimeout(() => reject(new Error('timeout ' + method)), 60000); });
}
let SID;
async function ev(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, SID);
  if (r.exceptionDetails) throw new Error('eval: ' + (r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text));
  return r.result ? r.result.value : undefined;
}
async function waitFor(expr, timeoutMs, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) { if (await ev(expr)) return true; await sleep(250); }
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
// Close the plan panel -> docked 3D view (still berthed at Aoba).
await ev(`document.getElementById('btn-plan-close').click(); 'ok'`);
await sleep(1200);
const docked = await ev(`({ docked: !!S.docked, ref: getEffectiveFrameRef(), mode: frameState.mode, camFollow: cam.follow, chipVisible: !!document.getElementById('frame-chip-3d') })`);
console.log('docked state:', JSON.stringify(docked));
check('docked at Aoba before frame test', docked.docked === true);
check('AUTO ref is station while docked', docked.ref === 'station', docked.ref);
await shot('port-docked-auto.png');

// --- #7: the station structure itself must be IN the docked view ---
// Regression: targetMesh once aliased stationMesh, and the target-placement
// block overwrote the station mesh position with the moon's relative position
// every frame — the port structure vanished from the docked view (only the
// label and the player ship remained). Assert the mesh sits at the frame
// origin (the station IS the ref) and projects to a large on-screen area,
// and that port traffic near the berths is in frame in a raised view.
const port = await ev(`(() => {
  const wp = new THREE.Vector3(); stationMesh.getWorldPosition(wp);
  const bb = new THREE.Box3().setFromObject(stationMesh);
  const corners = [];
  for (const x of [bb.min.x, bb.max.x]) for (const y of [bb.min.y, bb.max.y]) for (const z of [bb.min.z, bb.max.z]) corners.push(new THREE.Vector3(x, y, z));
  const scr = corners.map(c => { const v = c.clone().project(camera); return { x: (v.x * 0.5 + 0.5) * 390, y: (-v.y * 0.5 + 0.5) * 844, behind: v.z > 1 }; });
  const xs = scr.map(s => s.x), ys = scr.map(s => s.y);
  return {
    meshOff: Math.round(Math.hypot(wp.x, wp.y, wp.z)),
    spanX: Math.round(Math.max(...xs) - Math.min(...xs)),
    spanY: Math.round(Math.max(...ys) - Math.min(...ys))
  };
})()`);
console.log('station projection:', JSON.stringify(port));
check('#7 station mesh at frame origin (no alias displacement)', port.meshOff < 5, 'off=' + port.meshOff);
check('#7 station structure spans the view', port.spanX > 150 && port.spanY > 100, `span=${port.spanX}x${port.spanY}`);
await ev(`cam.pol = 0.6; cam.manualHold = true; 'ok'`);
await sleep(1500);
const craft = await ev(`(() => (S.portCraft || []).map((c, i) => {
  const v = new THREE.Vector3(); portCraftMeshes[i].getWorldPosition(v); const p = v.project(camera);
  return { name: c.name, d: Math.round(Math.hypot(c.x - S.station.x, c.y - S.station.y, c.z - S.station.z)),
    x: Math.round((p.x * 0.5 + 0.5) * 390), y: Math.round((-p.y * 0.5 + 0.5) * 844), behind: p.z > 1 };
}).filter(c => c.d < 200))()`);
console.log('near port craft:', JSON.stringify(craft));
const inFrame = craft.filter(c => !c.behind && c.x > 0 && c.x < 390 && c.y > 0 && c.y < 844);
check('#7 port traffic near berths in frame (raised view)', inFrame.length >= 1, inFrame.map(c => c.name).join(',') || 'none');
await shot('port-station-pol06.png');
await ev(`cam.manualHold = false; 'ok'`);
await sleep(800);

// --- switch to planet (tsumugi) via the real chip UI ---
await ev(`document.getElementById('frame-chip-3d').click(); 'ok'`);
await sleep(400);
await ev(`document.querySelector('#frame-sel-3d button[data-fref="planet"]').click(); 'ok'`);
await sleep(600);
let st = await ev(`({ ref: getEffectiveFrameRef(), mode: frameState.mode, tgt: [Math.round(cam.target.x), Math.round(cam.target.y), Math.round(cam.target.z)], dist: Math.round(cam.dist) })`);
console.log('after planet select:', JSON.stringify(st));
check('manual planet ref effective', st.ref === 'planet' && st.mode === 'manual', JSON.stringify(st));
// hold ~5 s of frames: mode must persist, target must converge to the origin (planet at frame origin)
await sleep(5000);
st = await ev(`({ ref: getEffectiveFrameRef(), mode: frameState.mode, tgtLen: Math.round(Math.hypot(cam.target.x, cam.target.y, cam.target.z)), dist: Math.round(cam.dist) })`);
console.log('planet hold 5s:', JSON.stringify(st));
check('manual mode persists (no AUTO override)', st.mode === 'manual' && st.ref === 'planet');
check('camera anchored to ref body (target ~ origin)', st.tgtLen < 2000, 'tgtLen=' + st.tgtLen);
await shot('port-frame-planet.png');

// --- switch to star (Sol) ---
await ev(`document.getElementById('frame-chip-3d').click(); 'ok'`);
await sleep(400);
await ev(`document.querySelector('#frame-sel-3d button[data-fref="star"]').click(); 'ok'`);
await sleep(5000);
st = await ev(`({ ref: getEffectiveFrameRef(), mode: frameState.mode, tgtLen: Math.round(Math.hypot(cam.target.x, cam.target.y, cam.target.z)), dist: Math.round(cam.dist) })`);
console.log('star hold 5s:', JSON.stringify(st));
check('manual star ref effective and persists', st.mode === 'manual' && st.ref === 'star');
check('camera anchored to star (target ~ origin)', st.tgtLen < 2000, 'tgtLen=' + st.tgtLen);
await shot('port-frame-star.png');

// --- back to AUTO ---
await ev(`document.getElementById('frame-chip-3d').click(); 'ok'`);
await sleep(400);
await ev(`document.querySelector('#frame-sel-3d button[data-fref="auto"]').click(); 'ok'`);
await sleep(3000);
st = await ev(`({ ref: getEffectiveFrameRef(), mode: frameState.mode, shipRel: Math.round(Math.hypot(cam.target.x - (S.ship.x - getFrameRefPos().x), cam.target.y - (S.ship.y - getFrameRefPos().y), cam.target.z - (S.ship.z - getFrameRefPos().z))) })`);
console.log('back to AUTO:', JSON.stringify(st));
check('AUTO restores station ref while docked', st.mode === 'auto' && st.ref === 'station');
check('AUTO restores ship-follow anchor', st.shipRel < 50, 'shipRel=' + st.shipRel);
await shot('port-docked-auto2.png');

console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)');
try { ws.close(); } catch {}
chrome.kill();
process.exit(failures === 0 ? 0 : 1);
