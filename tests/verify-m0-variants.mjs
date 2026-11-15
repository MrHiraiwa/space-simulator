// Regression test (browser, CDP): M0 (prologue) per-variant impact safety & completion.
// For each variant (eco, std, fast):
//   fresh page -> career flow -> prologue plan panel -> select variant -> depart
//   -> test-side warp boost (30000 far, 300 in moon vicinity, 8 below dist 30000 to target)
//   -> track minDist to つむぎ and moon every poll
//   -> assert: mission completes (S.missionEnded && S.succeeded), no impact
//      (minDistつむぎ > 203000, minDist月 > 2600), and minDistつむぎ >= 203000 * 1.15.
// Run: node tests/verify-m0-variants.mjs [url]
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const URL = process.argv[2] || ('file://' + path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'game.html'));
const PORT = 9344;
const chrome = spawn('google-chrome', [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${PORT}`,
  '--user-data-dir=/tmp/chrome-verify-m0-variants',
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
  await waitFor(`!document.getElementById('btn-depart').disabled`, 20000, 'depart enabled for ' + variantId);
  await ev(`document.getElementById('btn-depart').click(); 'ok'`);
}

async function runVariant(variantId) {
  const tid = await newPage();
  try {
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

    await approveVariantInPanel(variantId);

    let minTsumugi = Infinity;
    let minMoon = Infinity;
    let finalState = null;
    const t0 = Date.now();

    while (Date.now() - t0 < 180000) {
      const st = await ev(`(() => {
        if (!S || !S.ship) return null;
        const tsumugi = S.planets && S.planets[1];
        const moon = S.planets && S.planets.find(p => p.isMoon);
        const dT = tsumugi ? Math.hypot(S.ship.x - tsumugi.x, S.ship.y - tsumugi.y, S.ship.z - tsumugi.z) : Infinity;
        const dM = moon ? Math.hypot(S.ship.x - moon.x, S.ship.y - moon.y, S.ship.z - moon.z) : Infinity;
        const dTarget = S.target ? Math.hypot(S.ship.x - S.target.x, S.ship.y - S.target.y, S.ship.z - S.target.z) : Infinity;
        const panelOpen = document.getElementById('plan-panel').classList.contains('open') && !!planPanelState && !planPanelState.tracking;
        if (!S.missionEnded && !S.failed && !panelOpen) {
          S.warp = dTarget < 30000 ? 8 : (dM < 30000 ? 300 : 30000);
        }
        return {
          dT, dM, dTarget, panelOpen,
          phase: S.planExec ? S.planExec.phase : 'none',
          ended: !!S.missionEnded,
          succeeded: !!S.succeeded,
          failed: !!S.failed,
          time: S.time || 0
        };
      })()`);

      if (st) {
        if (Number.isFinite(st.dT) && st.dT < minTsumugi) minTsumugi = st.dT;
        if (Number.isFinite(st.dM) && st.dM < minMoon) minMoon = st.dM;
        finalState = st;
        if (st.ended || st.failed) break;
        if (st.panelOpen) {
          await approveVariantInPanel(variantId);
        }
      }
      await sleep(120);
    }

    console.log(`Variant ${variantId}:`, {
      ended: finalState && finalState.ended,
      succeeded: finalState && finalState.succeeded,
      failed: finalState && finalState.failed,
      minTsumugi: Math.round(minTsumugi),
      minMoon: Math.round(minMoon),
      simTime: finalState ? Math.round(finalState.time) : 0
    });

    check(`M0 [${variantId}] mission completed (missionEnded && succeeded)`, !!(finalState && finalState.ended && finalState.succeeded));
    check(`M0 [${variantId}] no impact on つむぎ (> 203000)`, minTsumugi > 203000, `${Math.round(minTsumugi)}`);
    check(`M0 [${variantId}] no impact on こよみ (> 2600)`, minMoon > 2600, `${Math.round(minMoon)}`);
    check(`M0 [${variantId}] minDistつむぎ >= 203000 * 1.15 (${Math.round(203000 * 1.15)})`, minTsumugi >= 203000 * 1.15, `${Math.round(minTsumugi)}`);
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

  for (const vid of ['eco', 'std', 'fast']) {
    await runVariant(vid);
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
} finally {
  try { if (ws) ws.close(); } catch {}
  try { chrome.kill('SIGKILL'); } catch {}
}

process.exit(failures ? 1 : 0);
