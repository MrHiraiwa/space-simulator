// Regression test (browser, CDP): 台帳 #33 — 委任ステップの再実行・再記録。
// v0.6.1 では委任中の「見守り」ステップ（A4: setWarp のみ）が40船内秒ごとの
// 再試行ラッチ解除で再実行され、「🤝 副官代行：A4…」が約47船内秒間隔で
// 日誌に繰り返し記録された。v0.6.2 では:
//   (1) 代行は一度きりでラッチ（再評価サイクルで再実行・再記録しない）
//   (2) logEvent は同一内容の連続エントリを重ねない（保険）
// 本テスト: 委任ONでプロローグを通し（巡航→接近→帰投→完了）、各ステップの
// 代行ログが最大1回だけであること、および (2) の単体挙動を検証する。
// Run: node tests/verify-delegate-latch.mjs [url]
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const URL = process.argv[2] || ('file://' + path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'game.html'));
const PORT = 9348;
const chrome = spawn('google-chrome', [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${PORT}`,
  '--user-data-dir=/tmp/chrome-verify-delegate-latch',
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

const STEP_TITLES = [
  'A1: 観光航海計画の承認',
  'A2: 艦橋からの視界確認（カメラ回転）',
  'A3: 待機（時間を進める）',
  'A4: 衛星「こよみ」へ到着',
  'B1: 帰還計画の承認',
  'B2: ステーション「あおば」へ帰投'
];

async function main() {
  for (let i = 0; i < 50; i++) {
    try { await getJson('/json/version'); break; } catch { await sleep(200); }
  }
  const targets = await getJson('/json/list');
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

  // キャリア開始 → プロローグ
  await ev(`localStorage.removeItem('ss-save-v1'); 'save-cleared'`); /* v0.6.3: 既存セーブの上書き確認で止まらないよう、出航前にセーブを消す */
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
  await waitFor(`!!(S && S.tutorial && S.tutorial.mode === 'prologue')`, 20000, 'prologue tutorial');

  // (2) の単体チェック: 連続同一エントリは1回だけ、間に別エントリを挟めば再記録可
  await ev(`logEvent('TESTDUP-33'); logEvent('TESTDUP-33'); logEvent('TESTDUP-33'); 'ok'`);
  await sleep(200);
  const dup1 = await ev(`[...document.getElementById('log').children].filter(d => d.textContent.includes('TESTDUP-33')).length`);
  check('logEvent: consecutive duplicates suppressed', dup1 === 1, `count=${dup1}`);
  await ev(`logEvent('TESTDUP-33-B'); logEvent('TESTDUP-33'); 'ok'`);
  await sleep(200);
  const dup2 = await ev(`[...document.getElementById('log').children].filter(d => d.textContent.includes('TESTDUP-33') && !d.textContent.includes('TESTDUP-33-B')).length`);
  check('logEvent: non-consecutive repeat is logged', dup2 === 2, `count=${dup2}`);

  // 委任ON: 「副官に任せる」は stuckTime>=40 で現れる（ドライバ都合で進める）
  await ev(`S.tutorial.stuckTime = 41; 'ok'`);
  await waitFor(`!!document.getElementById('btn-tut-auto')`, 15000, 'delegate button');
  await ev(`document.getElementById('btn-tut-auto').click(); 'ok'`);
  await sleep(300);
  check('delegation enabled', await ev(`!!(S.tutorial && S.tutorial.delegated)`));

  // 通し駆動: 階層ワープで巡航を進め、プロローグ完了まで見守る
  const t0 = Date.now();
  let completed = false;
  let lastStep = -1;
  let panelStuckSince = 0;
  let minMoon = Infinity, minTsu = Infinity;
  while (Date.now() - t0 < 720000) {
    const st = await ev(`(() => {
      if (!S || !S.ship) return null;
      const pe = S.planExec;
      let dist = null;
      if (pe && pe.targetBody) dist = Math.hypot(S.ship.x - pe.targetBody.x, S.ship.y - pe.targetBody.y, S.ship.z - pe.targetBody.z);
      else if (S.tutorial && S.tutorial.step === 3) { const hab = S.planets.find(p => p.isMoon); dist = Math.hypot(S.ship.x - hab.x, S.ship.y - hab.y, S.ship.z - hab.z); }
      const moon = S.planets.find(p => p.isMoon);
      const tsu = S.planets[1];
      return {
        step: S.tutorial ? S.tutorial.step : -1,
        phase: pe ? pe.phase : null,
        paused: pe ? !!pe.paused : false,
        dist,
        dMoon: Math.hypot(S.ship.x - moon.x, S.ship.y - moon.y, S.ship.z - moon.z),
        dTsu: Math.hypot(S.ship.x - tsu.x, S.ship.y - tsu.y, S.ship.z - tsu.z),
        failed: !!S.failed,
        selVariant: (typeof planPanelState !== 'undefined' && planPanelState) ? planPanelState.selected : null,
        panelOpen: document.getElementById('plan-panel').classList.contains('open'),
        ended: !!S.missionEnded, succeeded: !!S.succeeded
      };
    })()`);
    if (!st) { await sleep(400); continue; }
    if (st.dMoon < minMoon) minMoon = st.dMoon;
    if (st.dTsu < minTsu) minTsu = st.dTsu;
    if (st.step !== lastStep) { console.log(`  step -> ${st.step} phase=${st.phase} dist=${st.dist ? Math.round(st.dist) : '-'} sel=${st.selVariant}`); lastStep = st.step; }
    if (st.ended) {
      completed = st.succeeded;
      if (!completed) {
        const tail = await ev(`[...document.getElementById('log').children].slice(-6).map(d => d.textContent)`);
        console.log(`  MISSION ENDED WITHOUT SUCCESS failed=${st.failed} minMoon=${Math.round(minMoon)} minTsu=${Math.round(minTsu)}`);
        console.log('  log tail:', JSON.stringify(tail, null, 1));
      }
      break;
    }
    // 階層ワープ（移動系フェーズは距離ラダー。接近・接舷系は控えめ）
    // A3（step 2）は委任の setWarp(3) で進むステップなので、ドライバは warp を触らない
    let w = null;
    if (st.step === 2) w = null;
    else if (st.dist != null && ['cruise', 'depart', 'undock'].includes(st.phase)) {
      w = st.dist > 60000 ? 30000 : st.dist > 30000 ? 3000 : st.dist > 3000 ? 300 : st.dist > 400 ? 30 : 8;
      if (st.phase !== 'cruise') w = Math.min(w, 3000);
    } else if (['harbor', 'approach', 'join', 'captain', 'berthing'].includes(st.phase)) {
      w = 8;
    }
    if (w != null) await ev(`S.warp = ${w}; 'ok'`).catch(() => {});
    // 保険: パネルが開いたまま35秒を超えたら（代行の出航待ちが尽きた場合）艦長席から出航
    if (st.panelOpen) {
      if (!panelStuckSince) panelStuckSince = Date.now();
      else if (Date.now() - panelStuckSince > 35000) {
        const en = await ev(`!document.getElementById('btn-depart').disabled`);
        if (en) { console.log('  note: driver fallback depart click'); await ev(`document.getElementById('btn-depart').click(); 'ok'`); panelStuckSince = 0; }
      }
    } else panelStuckSince = 0;
    await sleep(400);
  }
  check('prologue completed under delegation', completed === true, `ended check`);

  // (1) の検証: 各ステップの代行ログは最大1回。A4 は本バグの現場なので1回ちょうどを要求
  const counts = await ev(`(() => {
    const texts = [...document.getElementById('log').children].map(d => d.textContent);
    const out = {};
    for (const t of ${JSON.stringify(STEP_TITLES)}) out[t] = texts.filter(x => x.includes('副官代行') && x.includes(t)).length;
    out.__total = texts.filter(x => x.includes('副官代行')).length;
    return out;
  })()`);
  console.log('  delegate log counts:', JSON.stringify(counts));
  for (const t of STEP_TITLES) {
    check(`delegate log at most once: ${t}`, counts[t] <= 1, `count=${counts[t]}`);
  }
  check('delegate log exactly once: A4 (bug step)', counts['A4: 衛星「こよみ」へ到着'] === 1, `count=${counts['A4: 衛星「こよみ」へ到着']}`);
  check('delegation actually ran (total >= 4)', counts.__total >= 4, `total=${counts.__total}`);

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
