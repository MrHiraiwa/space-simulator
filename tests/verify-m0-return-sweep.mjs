// Regression test (browser, CDP): (B) 帰投航法の位相スイープ受け入れ + 台帳#34。
// M0（プロローグ）を 月位相 12位相 × 3バリアント で通しで飛ばし、次を検証する:
//   - 全ラン完走（S.missionEnded && S.succeeded）、衝突ゼロ（failed なし、
//     月 > 表面 2600、つむぎ > 表面 203017 を常時維持）
//   - 停滞・逸脱ポーズなし（planExec.paused を一度も立てない）
//   - #34: 接舷（帰投完了）時点の実残量 Δv が、帰投計画の提示時に確保すると
//     した予備（帰投パネル時点の残量 × 予備設定%）を下回らない
// 駆動ワープは目標近傍で過大にしない（到着判定のトンネリング回避、
// playtest/v062-report.md の所見参照）: 100,000 以内は ≤300、港内は 30。
// 位相注入: 月の相対状態（対つむぎ）を軌道角運動量軸まわりに Δ 回転させる
// （円軌道の位相進みと等価）。相対位相（月−ステーション）が Δ だけ変わる。
// Run: node tests/verify-m0-return-sweep.mjs [url] [degCsv] [variantCsv]
//   例: node tests/verify-m0-return-sweep.mjs "" "0,90,180,270" "std"
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const URL = process.argv[2] || ('file://' + path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'game.html'));
const DEGS = (process.argv[3] || '0,30,60,90,120,150,180,210,240,270,300,330').split(',').map(Number);
const VARIANTS = (process.argv[4] || 'eco,std,fast').split(',');
const PORT = 9353;
const chrome = spawn('google-chrome', [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${PORT}`,
  '--user-data-dir=/tmp/chrome-verify-m0-return-sweep',
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
    await sleep(250);
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
  await sleep(300);
  return targetId;
}

function injectPhaseExpr(deg) {
  const th = (deg * Math.PI / 180).toFixed(6);
  return `(() => {
    const moon = S.planets.find(p => p.isMoon);
    const host = S.planets.find(p => p.name === moon.moonOf) || S.planets[1];
    const rx = moon.x - host.x, ry = moon.y - host.y, rz = moon.z - host.z;
    const vx = moon.vx - host.vx, vy = moon.vy - host.vy, vz = moon.vz - host.vz;
    let hx = ry * vz - rz * vy, hy = rz * vx - rx * vz, hz = rx * vy - ry * vx;
    const hm = Math.hypot(hx, hy, hz); hx /= hm; hy /= hm; hz /= hm;
    const th = ${th}, c = Math.cos(th), s = Math.sin(th);
    const rot = (x, y, z) => {
      const dot = hx * x + hy * y + hz * z;
      return [x * c + (hy * z - hz * y) * s + hx * dot * (1 - c),
              y * c + (hz * x - hx * z) * s + hy * dot * (1 - c),
              z * c + (hx * y - hy * x) * s + hz * dot * (1 - c)];
    };
    const nr = rot(rx, ry, rz), nv = rot(vx, vy, vz);
    moon.x = host.x + nr[0]; moon.y = host.y + nr[1]; moon.z = host.z + nr[2];
    moon.vx = host.vx + nv[0]; moon.vy = host.vy + nv[1]; moon.vz = host.vz + nv[2];
    return 'ok';
  })()`;
}

async function selectVariantAndDepart(variantId, tag) {
  await waitFor(`document.getElementById('plan-panel').classList.contains('open') && !!planPanelState && !planPanelState.tracking`, 60000, tag + ' panel');
  // 推定が揃うまで待つ
  await waitFor(`planPanelState.variants.every(v => v.est)`, 90000, tag + ' estimates');
  const info = await ev(`(() => {
    const i = planPanelState.variants.findIndex(v => v.id === ${JSON.stringify(variantId)});
    const v = planPanelState.variants[i];
    const cards = document.querySelectorAll('#plan-variants .pv-card');
    const card = cards[i];
    return { idx: i, ok: !!(v && v.est && v.est.ok), dvEst: v && v.est ? +v.est.dvTotal.toFixed(1) : null, finalRel: v && v.est && v.est.finalRel != null ? +v.est.finalRel.toFixed(2) : null,
             cls: card ? card.className : '', dvNow: +S.dv.toFixed(1), reserve: planPanelState.reserve || 10 };
  })()`);
  if (info.idx < 0) throw new Error(tag + ': variant not found ' + variantId);
  if (!info.ok) return { departed: false, reason: 'est-not-ok', ...info };
  if (info.cls.includes('invalid')) return { departed: false, reason: 'card-invalid', ...info };
  await ev(`(() => { const cards = document.querySelectorAll('#plan-variants .pv-card'); if (cards[${info.idx}]) cards[${info.idx}].click(); const chk = document.getElementById('departure-checklist'); if (chk) chk.click(); return 'ok'; })()`);
  const enabled = await waitFor(`!document.getElementById('btn-depart').disabled`, 30000, tag + ' depart enabled').catch(() => false);
  if (!enabled) return { departed: false, reason: 'depart-disabled', ...info };
  await ev(`document.getElementById('btn-depart').click(); 'ok'`);
  return { departed: true, ...info };
}

async function runCase(deg, variantId) {
  const tid = await newPage();
  const tag = `Δ=${deg} ${variantId}`;
  try {
    await ev(`document.getElementById('btn-sortie').click(); 'ok'`);
    await waitFor(`document.getElementById('creation-modal').classList.contains('open')`, 20000, 'creation modal');
    await ev(`document.getElementById('btn-creation-done').click(); 'ok'`);
    await waitFor(`document.getElementById('briefing-modal').classList.contains('open')`, 20000, 'briefing modal');
    await sleep(300);
    for (let i = 0; i < 8; i++) {
      const vis = await ev(`document.getElementById('btn-briefing-start').style.display !== 'none'`);
      if (vis) break;
      await ev(`document.getElementById('btn-briefing-next').click(); 'ok'`);
      await sleep(200);
    }
    await ev(`document.getElementById('btn-briefing-start').click(); 'ok'`);
    // S が生えた瞬間に位相注入（A1 パネルの推定開始前に入れる）
    await waitFor(`!!(S && S.planets && S.planets.some(p => p.isMoon))`, 20000, 'world ready');
    if (deg !== 0) await ev(injectPhaseExpr(deg));

    const out = await selectVariantAndDepart(variantId, tag + ' outbound');
    if (!out.departed) {
      console.log(`CASE ${tag}: OUTBOUND NOT DEPARTED (${out.reason}) est=${JSON.stringify(out)}`);
      return { deg, variantId, cls: 'outbound-not-departed', out };
    }
    // A2 カメラ確認（実ドラッグ）
    await sleep(700);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 200, y: 400, button: 'left', clickCount: 1 }, SID).catch(() => {});
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 280, y: 400, button: 'left' }, SID).catch(() => {});
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 370, y: 400, button: 'left' }, SID).catch(() => {});
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 370, y: 400, button: 'left', clickCount: 1 }, SID).catch(() => {});

    let minMoon = Infinity, minTsu = Infinity, pausedEver = false;
    let arrivalRec = null, skipUsedOut = false, skipUsedReturn = false;
    let retInfo = null, dvAtReturnPanel = null, reservePct = 10;
    let arrivedMoon = false;
    const t0 = Date.now();
    let finalState = null;
    while (Date.now() - t0 < 600000) {
      const st = await ev(`(() => {
        if (!S || !S.ship) return null;
        const moon = S.planets.find(p => p.isMoon);
        const tsu = S.planets[1];
        const pe = S.planExec;
        let dist = null;
        if (pe && pe.targetBody) dist = Math.hypot(S.ship.x - pe.targetBody.x, S.ship.y - pe.targetBody.y, S.ship.z - pe.targetBody.z);
        return {
          step: S.tutorial ? S.tutorial.step : -1,
          phase: pe ? pe.phase : null,
          paused: pe ? !!pe.paused : false,
          dist,
          dMoon: Math.hypot(S.ship.x - moon.x, S.ship.y - moon.y, S.ship.z - moon.z),
          dTsu: Math.hypot(S.ship.x - tsu.x, S.ship.y - tsu.y, S.ship.z - tsu.z),
          dv: +S.dv.toFixed(2), maxDv: S.maxDv,
          failed: !!S.failed, ended: !!S.missionEnded, succeeded: !!S.succeeded,
          panelOpen: document.getElementById('plan-panel').classList.contains('open')
        };
      })()`);
      if (!st) { await sleep(400); continue; }
      if (st.dMoon < minMoon) minMoon = st.dMoon;
      if (st.dTsu < minTsu) minTsu = st.dTsu;
      if (st.paused) pausedEver = true;
      if (st.ended) { finalState = st; break; }
      if (st.failed) { finalState = st; break; }
      // 到着状態の記録（計画対実績 #34追記）＋終了状態の安定性（#44/#47）:
      // 到着した瞬間の相対速度・距離・実績消費を取り、状態を保存して 24 時間
      // 無動力伝播（安定性）を見てから復元する。
      if (!arrivedMoon && st.step >= 4) {
        arrivedMoon = true;
        arrivalRec = await ev(`(() => {
          const moon = S.planets.find(p => p.isMoon);
          const rel = Math.hypot(S.ship.vx - moon.vx, S.ship.vy - moon.vy, S.ship.vz - moon.vz);
          const snap = JSON.stringify({ ship: S.ship, planets: S.planets, station: S.station, time: S.time, dv: S.dv });
          let mn = Infinity, mx = 0;
          for (let i = 0; i < 1440; i++) { physics(60); if (i % 20 === 0) { const d = Math.hypot(S.ship.x - moon.x, S.ship.y - moon.y, S.ship.z - moon.z); if (d < mn) mn = d; if (d > mx) mx = d; } }
          const stab = { mn: Math.round(mn), mx: Math.round(mx) };
          const s2 = JSON.parse(snap);
          const oldTarget = S.target;
          S.ship = s2.ship; S.planets = s2.planets; S.station = s2.station; S.time = s2.time; S.dv = s2.dv;
          const newMoon = S.planets.find(p => p.isMoon);
          if (oldTarget && oldTarget.isMoon) S.target = newMoon;
          else if (oldTarget && S.station && oldTarget.name === S.station.name) S.target = S.station;
          if (S.planExec && S.planExec.targetBody && S.planExec.targetBody.isMoon) S.planExec.targetBody = newMoon;
          return { dMoon: Math.round(Math.hypot(S.ship.x - newMoon.x, S.ship.y - newMoon.y, S.ship.z - newMoon.z)), relMoon: +rel.toFixed(2), dvNow: +S.dv.toFixed(2), stab };
        })()`);
        console.log(`CASE ${tag}: ARRIVAL dMoon=${arrivalRec.dMoon} relMoon=${arrivalRec.relMoon} (est finalRel=${out.finalRel}) dvSpent=${(out.dvNow - arrivalRec.dvNow).toFixed(1)} (est ${out.dvEst}+harbor) stab24h=[${arrivalRec.stab.mn}..${arrivalRec.stab.mx}]`);
      }
      // 帰投パネルが開いたら記録して出発（同バリアント優先、不成立なら成立する最安へ）
      if (arrivedMoon && !retInfo && st.panelOpen) {
        dvAtReturnPanel = st.dv;
        retInfo = await selectVariantAndDepart(variantId, tag + ' return');
        if (!retInfo.departed) {
          for (const alt of ['eco', 'std', 'fast']) {
            if (alt === variantId) continue;
            const altInfo = await selectVariantAndDepart(alt, tag + ' return-' + alt).catch(() => null);
            if (altInfo && altInfo.departed) { retInfo = { ...altInfo, fallbackFrom: variantId }; break; }
          }
        }
        reservePct = retInfo.reserve || 10;
        if (!retInfo.departed) {
          console.log(`CASE ${tag}: RETURN NOT DEPARTED (${retInfo.reason}) dvAtPanel=${dvAtReturnPanel} est=${JSON.stringify(retInfo)}`);
          return { deg, variantId, cls: 'return-not-departed', out, retInfo, dvAtReturnPanel, minMoon, minTsu, pausedEver, arrivalRec };
        }
        skipUsedReturn = false;
        continue;
      }
      // 巡航は追いつき（デバッグスキップ）で駆動する（#44: スイープに追いつき経路を含める）
      if (st.phase === 'cruise' && !st.panelOpen) {
        /* 駆動はゲームの設計包絡内（実時間ワープ＋追いつき）に限定する
           （ドライバ都合の明記、v0.6.2）: 巡航は追いつき（デバッグスキップ、
           適応チャンク）が正規の早送りであり、warp 10000 の生駆動は誘導の
           前提（ケイデンス＋RK4 精度）を超えて実飛行だけを発散させていた。
           スキップは停止のたびに再投入する。 */
        await ev(`if (!catchUpState) startDebugSkip(); 'ok'`).catch(() => {});
      }
      // ワープラダー（目標近傍で過大にしない）
      let w = null;
      const ph = st.phase;
      if (ph === 'undock' || ph === 'harbor') w = 30;
      else if (ph === 'approach' || ph === 'join' || ph === 'captain' || ph === 'berthing' || ph === 'final' || ph === 'brake') w = 8;
      else if (st.dist != null) w = st.dist > 3000 ? 300 : st.dist > 400 ? 30 : 8;
      if (w != null) await ev(`S.warp = ${w}; 'ok'`).catch(() => {});
      await sleep(400);
    }
    if (!finalState) {
      console.log(`CASE ${tag}: TIMEOUT minMoon=${Math.round(minMoon)} minTsu=${Math.round(minTsu)} paused=${pausedEver}`);
      return { deg, variantId, cls: 'timeout', out, retInfo, dvAtReturnPanel, minMoon, minTsu, pausedEver, arrivalRec };
    }
    const dvFinal = finalState.dv;
    const resNeed = dvAtReturnPanel != null ? dvAtReturnPanel * reservePct / 100 : null;
    const resOk = resNeed == null ? null : dvFinal >= resNeed - 1e-9;
    console.log(`CASE ${tag}: ${finalState.succeeded ? 'COMPLETE' : 'ENDED-NOT-SUCCEEDED'} dvFinal=${dvFinal} dvAtReturnPanel=${dvAtReturnPanel} resNeed=${resNeed != null ? resNeed.toFixed(1) : '-'} resOk=${resOk} minMoon=${Math.round(minMoon)} minTsu=${Math.round(minTsu)} paused=${pausedEver} failed=${finalState.failed}`);
    return { deg, variantId, cls: finalState.succeeded ? 'complete' : 'not-succeeded', out, retInfo, dvAtReturnPanel, dvFinal, resNeed, resOk, minMoon, minTsu, pausedEver, failed: finalState.failed, arrivalRec };
  } finally {
    await send('Target.closeTarget', { targetId: tid }).catch(() => {});
  }
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

  const results = [];
  for (const deg of DEGS) {
    for (const v of VARIANTS) {
      try {
        results.push(await runCase(deg, v));
      } catch (e) {
        console.log(`CASE Δ=${deg} ${v}: ERROR ${e.message}`);
        results.push({ deg, variantId: v, cls: 'error', error: e.message });
      }
    }
  }

  console.log('\n==== SWEEP SUMMARY ====');
  for (const r of results) {
    console.log(`Δ=${r.deg} ${r.variantId}: ${r.cls}` +
      (r.dvFinal != null ? ` dvFinal=${r.dvFinal}` : '') +
      (r.resNeed != null ? ` resNeed=${r.resNeed.toFixed(1)} resOk=${r.resOk}` : '') +
      (r.minMoon != null ? ` minMoon=${Math.round(r.minMoon)} minTsu=${Math.round(r.minTsu)}` : '') +
      (r.pausedEver ? ' PAUSED' : '') + (r.failed ? ' FAILED' : ''));
  }
  const completes = results.filter(r => r.cls === 'complete');
  check(`sweep: all ${results.length} cases complete`, completes.length === results.length, `${completes.length}/${results.length}`);
  check('sweep: no impacts (minMoon > 2600, minTsu > 203017)', results.every(r => r.minMoon == null || (r.minMoon > 2600 && r.minTsu > 203017)));
  check('sweep: no deviation pauses', results.every(r => !r.pausedEver));
  check('sweep: no failures', results.every(r => !r.failed));
  check('#34: arrival Δv >= reserve (all cases)', results.every(r => r.resOk !== false), results.filter(r => r.resOk === false).map(r => `Δ=${r.deg}/${r.variantId}`).join(',') || 'all ok');
  check('#44/#47: end-state stability (24 h propagation bounded, no fall-in)', results.every(r => !r.arrivalRec || (r.arrivalRec.stab.mn > 3400 && r.arrivalRec.stab.mx < 45000)), results.filter(r => r.arrivalRec && !(r.arrivalRec.stab.mn > 3400 && r.arrivalRec.stab.mx < 45000)).map(r => `Δ=${r.deg}/${r.variantId} [${r.arrivalRec.stab.mn}..${r.arrivalRec.stab.mx}]`).join(',') || 'all ok');
  for (const r of results) if (r.arrivalRec) console.log(`  arrival Δ=${r.deg} ${r.variantId}: relMoon=${r.arrivalRec.relMoon} estFinalRel=${r.out.finalRel} dvSpent=${(r.out.dvNow - r.arrivalRec.dvNow).toFixed(1)} estDv=${r.out.dvEst}`);
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
