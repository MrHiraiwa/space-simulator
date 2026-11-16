// Regression test (browser, CDP): 台帳#32 — デバッグ用時間スキップ（v0.6.2）。
// 待機バーの「⏩ スキップ」は離席キャッチアップのチャンク処理を再利用し、
// 次の判断イベント／到着まで一気に進める。検証:
//   1. M0 往路の巡航中に押すと、到着（レグ完了）まで一気に進んで止まる。
//   2. 到着後に開く帰投計画パネル（＝次の判断イベント）の前で止まっている
//      （キャッチアップ状態が残っていない）。
//   3. 帰投レグでも押せて、作戦終了（帰投完了）で止まる。
// Run: node tests/verify-debug-skip.mjs [url]
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const URL = process.argv[2] || ('file://' + path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'game.html'));
const PORT = 9349;
const chrome = spawn('google-chrome', [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${PORT}`,
  '--user-data-dir=/tmp/chrome-verify-debug-skip',
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

async function approveStdInPanel() {
  await waitFor(`document.getElementById('plan-panel').classList.contains('open') && !!planPanelState && !planPanelState.tracking`, 60000, 'plan panel');
  const idx = await ev(`planPanelState ? planPanelState.variants.findIndex(v => v.id === 'std') : -1`);
  if (idx < 0) throw new Error('std variant not found');
  await ev(`(() => { const cards = document.querySelectorAll('#plan-variants .pv-card'); if (cards[${idx}]) cards[${idx}].click(); const chk = document.getElementById('departure-checklist'); if (chk) chk.click(); return 'ok'; })()`);
  await waitFor(`!document.getElementById('btn-depart').disabled`, 30000, 'depart enabled');
  await ev(`document.getElementById('btn-depart').click(); 'ok'`);
}

async function main() {
  for (let i = 0; i < 50; i++) {
    try { await getJson('/json/version'); break; } catch { await sleep(200); }
  }
  const ver = await getJson('/json/version');
  ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    }
  };

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  SID = sessionId;
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }, SID);
  await send('Page.enable', {}, SID);
  await send('Runtime.enable', {}, SID);
  await send('Page.navigate', { url: URL }, SID);
  await waitFor(`!!document.getElementById('btn-sortie')`, 30000, 'start screen');
  await sleep(400);

  check('skip button exists in standby bar', await ev(`!!document.getElementById('btn-debug-skip')`));

  await ev(`document.getElementById('btn-sortie').click(); 'ok'`);
  await waitFor(`document.getElementById('creation-modal').classList.contains('open')`, 20000, 'creation modal');
  await ev(`document.getElementById('btn-creation-done').click(); 'ok'`);
  await waitFor(`document.getElementById('briefing-modal').classList.contains('open')`, 20000, 'briefing modal');
  await sleep(400);
  for (let i = 0; i < 8; i++) {
    const vis = await ev(`document.getElementById('btn-briefing-start').style.display !== 'none'`);
    if (vis) break;
    await ev(`document.getElementById('btn-briefing-next').click(); 'ok'`);
    await sleep(250);
  }
  await ev(`document.getElementById('btn-briefing-start').click(); 'ok'`);

  // 往路の承認・出発（艦長操作）
  await approveStdInPanel();
  // A2 カメラ確認ステップを通す（実ドラッグ）
  await sleep(800);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 200, y: 400, button: 'left', clickCount: 1 }, SID).catch(() => {});
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 260, y: 400, button: 'left' }, SID).catch(() => {});
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 320, y: 400, button: 'left' }, SID).catch(() => {});
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 370, y: 400, button: 'left' }, SID).catch(() => {});
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 370, y: 400, button: 'left', clickCount: 1 }, SID).catch(() => {});
  // A3 の艦長操作としてワープを上げる（ドライバ都合の追加操作。アサーションは不変）
  await sleep(600);
  await ev(`document.querySelector('[data-warp="8"]').click(); 'ok'`);

  await waitFor(`!!(S.planExec && S.planExec.phase === 'cruise')`, 120000, 'outbound cruise');
  const tBefore = await ev(`S.time`);
  const wallBefore = Date.now();

  // --- スキップ 1: 往路 → 到着まで一気に進む ---
  await ev(`document.getElementById('btn-debug-skip').click(); 'ok'`);
  await waitFor(`catchUpState === null && !!(S.tutorial && S.tutorial.step >= 4)`, 180000, 'skip halts at arrival');
  const tAfter = await ev(`S.time`);
  const advanced = tAfter - tBefore;
  const wallSec = (Date.now() - wallBefore) / 1000;
  console.log(`  outbound skip: advanced ${Math.round(advanced)} ship-s in ${wallSec.toFixed(1)}s wall`);
  check('skip advanced to arrival in one go', advanced > 3600, `advanced=${Math.round(advanced)}`);
  check('skip was fast (not real-time warp)', wallSec < 120, `wall=${wallSec.toFixed(1)}s`);
  const skipLog = await ev(`[...document.getElementById('log').children].some(d => d.textContent.includes('デバッグスキップ') && d.textContent.includes('到着'))`);
  check('skip halt logged with arrival reason', skipLog === true);

  // --- 判断イベント（帰投計画パネル）の前で止まっている ---
  await waitFor(`document.getElementById('plan-panel').classList.contains('open')`, 30000, 'return plan panel opens');
  check('stopped before decision (panel open, no catch-up running)', await ev(`catchUpState === null`));

  // 帰投を承認・出発 → 巡航で再びスキップ → 作戦終了で止まる
  await approveStdInPanel();
  await waitFor(`!!(S.planExec && (S.planExec.phase === 'cruise' || S.planExec.phase === 'harbor')) && S.tutorial && S.tutorial.step === 5`, 120000, 'return leg underway');
  await ev(`document.getElementById('btn-debug-skip').click(); 'ok'`);
  await waitFor(`catchUpState === null && !!S.missionEnded`, 180000, 'skip halts at mission end');
  check('return skip completed the prologue', await ev(`!!(S.missionEnded && S.succeeded)`));

  await send('Target.closeTarget', { targetId }).catch(() => {});
}

try {
  await main();
} catch (e) {
  console.log('ERROR: ' + e.message);
  failures++;
} finally {
  try { ws && ws.close(); } catch {}
  chrome.kill();
}
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
