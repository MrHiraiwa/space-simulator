/* flight-core.js — 宇宙シミュレーター飛行コア（台帳 #56、v0.6.4）
   物理積分・天体伝播・航海計画の推定・誘導・到着／捕捉判定・港内退出
   シミュレーションを game.html から verbatim に切り出した単一モジュール。
   ブラウザでは window.FlightCore、node では module.exports として読み込む。
   計算内容は切り出し前と同一（等価性はパラメータグリッドで機械検証済み）。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.FlightCore = factory(); }
}(typeof self !== 'undefined' ? self : this, function () {

const SCALE_K = 386700;
const WARP_EDGE = 340 * SCALE_K;

function orbitState(gm, r, phase, incDeg, nodeDeg){
  const v = Math.sqrt(gm / r);
  let px = Math.cos(phase)*r, py = 0, pz = Math.sin(phase)*r;
  let vx = -Math.sin(phase)*v, vy = 0, vz = Math.cos(phase)*v;
  const inc = incDeg*Math.PI/180, node = nodeDeg*Math.PI/180;
  function rot(x,y,z){
    let y1 = y*Math.cos(inc) - z*Math.sin(inc);
    let z1 = y*Math.sin(inc) + z*Math.cos(inc);
    let x2 = x*Math.cos(node) + z1*Math.sin(node);
    let z2 = -x*Math.sin(node) + z1*Math.cos(node);
    return [x2, y1, z2];
  }
  const P = rot(px,py,pz), V = rot(vx,vy,vz);
  return { x:P[0], y:P[1], z:P[2], vx:V[0], vy:V[1], vz:V[2] };
}

function makeBody(state, color, radius, name, gm){
  return Object.assign({}, state, { color, radius, name, gm:gm||0, trail:[] });
}

/* ==== ORDER LOGIC (pure) ==== */
const STAR_SURFACE_R = 900000;
const V_IAF = 12;
const V_FINAL = 4;
const V_CONTACT = 1.5;
/* マスドライバーの公表出口速度（台帳#113）: 装備港からの接舷出発は、射出
   レーンを進んで出域点（錨中心＋depSep×80）で「錨の速度＋depSep×MD_EXIT_V」
   という港の公表値どおりの状態に固定される。推定と実飛行が同じ出口状態を
   共有するため、出発状態のばらつき（推定と実績の最大の発散源）が消える。
   射出は港の設備なので船の推進剤は使わない（港内操船 Δv は 0）。 */
const MD_EXIT_V = 2.5;
function surfaceRadius(body){
  if(!body) return 0;
  if(body.isStar || body === 'star') return STAR_SURFACE_R;
  if(body.dispR != null && body.dispR > 0) return body.dispR;
  return body.radius || 7;
}
function impactMargin(sr){
  return Math.max(2000, sr * 0.1);
}
function vicinityRadius(body){
  if(!body) return 0;
  if(body.isMoon) return 30000;
  return Math.max(3 * surfaceRadius(body), 600000);
}
function inVicinityOf(ship, planets){
  if(!ship || !planets) return null;
  let best = null;
  for(const p of planets){
    if(!p.gm || p.gm <= 0) continue;
    const d = Math.hypot(ship.x - p.x, ship.y - p.y, ship.z - p.z);
    if(d < vicinityRadius(p)){
      if(!best || d < best.dist) best = { body: p, dist: d };
    }
  }
  return best;
}
function planCadenceFor(ship, dist, planets){
  let cad = planCadence(dist);
  const vic = inVicinityOf(ship, planets);
  if(vic && vic.body.gm > 0){
    const d = Math.max(vic.dist, surfaceRadius(vic.body) || 100);
    const period = 2 * Math.PI * Math.sqrt(Math.pow(d, 3) / vic.body.gm);
    cad = Math.min(cad, Math.max(5, 0.02 * period));
  }
  return cad;
}
function relInfo(a, b){
  const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
  const dist = Math.hypot(dx, dy, dz);
  const rvx = a.vx - b.vx, rvy = a.vy - b.vy, rvz = a.vz - b.vz;
  const rel = Math.hypot(rvx, rvy, rvz);
  const closing = dist > 1e-9 ? (rvx * dx + rvy * dy + rvz * dz) / dist : 0;
  return { dx, dy, dz, dist, rvx, rvy, rvz, rel, closing };
}
function safeClosing(dist){
  return Math.max(0.7, Math.min(1.4, dist * 0.07));
}
function approachClosing(dist){
  return Math.max(1.2, Math.min(3.2, dist * 0.055));
}
function rk4StepState(st, h, accFn){
  const a1 = accFn(st.x, st.y, st.z);
  const a2 = accFn(st.x + st.vx*h/2, st.y + st.vy*h/2, st.z + st.vz*h/2);
  const a3 = accFn(st.x + (st.vx + a1[0]*h/2)*h/2, st.y + (st.vy + a1[1]*h/2)*h/2, st.z + (st.vz + a1[2]*h/2)*h/2);
  const a4 = accFn(st.x + (st.vx + a2[0]*h/2)*h, st.y + (st.vy + a2[1]*h/2)*h, st.z + (st.vz + a2[2]*h/2)*h);
  st.x  += (st.vx + 2*(st.vx + a1[0]*h/2) + 2*(st.vx + a2[0]*h/2) + (st.vx + a3[0]*h)) / 6 * h;
  st.y  += (st.vy + 2*(st.vy + a1[1]*h/2) + 2*(st.vy + a2[1]*h/2) + (st.vy + a3[1]*h)) / 6 * h;
  st.z  += (st.vz + 2*(st.vz + a1[2]*h/2) + 2*(st.vz + a2[2]*h/2) + (st.vz + a3[2]*h)) / 6 * h;
  st.vx += (a1[0] + 2*a2[0] + 2*a3[0] + a4[0]) / 6 * h;
  st.vy += (a1[1] + 2*a2[1] + 2*a3[1] + a4[1]) / 6 * h;
  st.vz += (a1[2] + 2*a2[2] + 2*a3[2] + a4[2]) / 6 * h;
}
function starAccFn(starGM){
  return (px, py, pz) => { const r2 = px*px + py*py + pz*pz, r = Math.sqrt(r2) || 0.001, a = -starGM / (r2 * r); return [a*px, a*py, a*pz]; };
}
function fullAccFn(starGM, pls){
  const sAcc = starAccFn(starGM);
  return (px, py, pz) => {
    const a = sAcc(px, py, pz);
    if(pls) for(const p of pls){
      const dx = p.x - px, dy = p.y - py, dz = p.z - pz;
      const d2 = dx*dx + dy*dy + dz*dz, d = Math.max(Math.sqrt(d2), 3), pa = p.gm / (d * d * d);
      a[0] += pa * dx; a[1] += pa * dy; a[2] += pa * dz;
    }
    return a;
  };
}
/* pls[i] 自身を除いた全重力（v0.6.2）: RK4 は中間点（現在位置からずれた点）で
   加速度を評価するため、自分の項が残ると「過去の自分の位置へ引かれる」偽の力が
   gm/d² で発生し、衛星の積分が1ステップで爆発する（実測: 月の速度が 116 秒で
   Δv≈85 壊れた）。天体リスト内の天体を全重力で進める場合は必ずこちらを使う。
   実シムの stepBody はオイラー法で現在位置でのみ評価し自己項が 0 になるため無事。 */
function accExcluding(starGM, pls, idx){
  return fullAccFn(starGM, pls ? pls.filter((_, j) => j !== idx) : pls);
}
function dynStep(px, py, pz, starGM, pls, cap){
  let ts = Math.sqrt(Math.pow(Math.hypot(px, py, pz) || 1, 3) / starGM);
  if(pls) for(const p of pls){
    if(!p.gm || p.gm <= 0) continue;
    const d = Math.max(Math.hypot(px - p.x, py - p.y, pz - p.z), 50);
    const t2 = Math.sqrt(Math.pow(d, 3) / p.gm);
    if(t2 < ts) ts = t2;
  }
  return Math.min(cap || 0.75, Math.max(0.06, ts * 0.1));
}
function encounterCap(a, b){
  const info = relInfo(a, b);
  let cap = Math.max(0.05, 0.3 * info.dist / Math.max(info.closing, 0.1));
  if(info.dist < 2000) cap = Math.min(cap, 2);
  return cap;
}
function planCadence(dist){
  return Math.min(21483, Math.max(30, dist / 400));
}
function propRK4(b, starGM, t, pl, target){
  const st = { x: b.x, y: b.y, z: b.z, vx: b.vx, vy: b.vy, vz: b.vz };
  if(t <= 0) return st;
  const pls = pl ? pl.map(p => ({ x: p.x, y: p.y, z: p.z, vx: p.vx, vy: p.vy, vz: p.vz, gm: p.gm, isMoon: !!p.isMoon })).filter(p => Math.hypot(p.x - b.x, p.y - b.y, p.z - b.z) > 1) : null;
  const sAcc = starAccFn(starGM);
  const acc = fullAccFn(starGM, pls);
  const accs = pls ? pls.map((_, i) => accExcluding(starGM, pls, i)) : null;
  const cap = Math.max(0.75, t / 200);
  let done = 0, guard = 0;
  while(done < t && guard++ < 8000){
    let h = Math.min(dynStep(st.x, st.y, st.z, starGM, pls, cap), t - done);
    if(target) h = Math.min(h, encounterCap(st, target));
    rk4StepState(st, h, acc);
    if(pls){
      const capP = fastestOrbitCap(pls, starGM, h, st.x, st.y, st.z);
      const nSubP = Math.min(200, Math.max(1, Math.ceil(h / Math.max(1, capP))));
      const hs = h / nSubP;
      for(let k = 0; k < nSubP; k++) for(let ii = 0; ii < pls.length; ii++) rk4StepState(pls[ii], hs, pls[ii].isMoon ? accs[ii] : sAcc);
    }
    done += h;
  }
  return st;
}
function predictTargetPos(b, starGM, t, pl){
  return propRK4(b, starGM, t, pl);
}
function computeApproach(ship, target, starGM, closingScale = 1, pl, horizon, ctx){
  // Guidance in three tiers (v0.6.2):
  //   Tier 0 (safety): if the coast path itself crosses a body, take the
  //     best-clearing burn — collision clearance is a hard filter, never a
  //     soft score term that a "faster" candidate can outbid.
  //   Tier 1 (phasing nudges): the original small-nudge hill climb
  //     (along-track / radial / normal + capped intercept-lite). This is the
  //     fuel-efficient path and stays the default whenever it is working.
  //   Tier 2 (committed intercept): only when no nudge passes the gate and
  //     the coast path does not arrive — full intercept burns toward the
  //     target's predicted position at several lead times. Phasing nudges
  //     alone cannot close a relative-phase gap (the ship settles into a
  //     drift orbit and every small nudge fails the improvement gate); the
  //     intercept is judged by the same honest prediction, so only burns
  //     that actually rendezvous are taken.
  const kScale = typeof SCALE_K !== 'undefined' ? SCALE_K : 386700;
  let HZ = horizon;
  if(!HZ){
    const info = relInfo(ship, target);
    HZ = Math.max(240, Math.min(240 * kScale, info.dist / Math.max(info.closing, 0.5)));
  }
  const scale = closingScale || 1;
  const pc0 = predictClosest(ship, target, starGM, HZ, pl);
  /* 通過判定（v0.6.2、台帳#34）: スコア用の HZ は従来どおり中心到達時刻までに保ち、
     衝突判定だけを「通過（最接近）まで見渡す」別予測で補う。HZ 自体を延ばすと
     スコアの物差し（minDist）が「最接近を詰める」意味に変わり、誘導が通過を
     削る方向に暴れる（実測で終端接近が破綻した）。判定と物差しは分ける。 */
  const infoP = relInfo(ship, target);
  const passHz = (!horizon && infoP.dist < 100000 && infoP.closing > 0) ? Math.min(240 * kScale, 2.2 * infoP.dist / Math.max(infoP.closing, 0.5)) : 0;
  const pcPass0 = passHz ? predictClosest(ship, target, starGM, passHz, pl) : null;
  const clr0 = Math.min(pc0.minClearance, pcPass0 ? pcPass0.minClearance : Infinity);
  if(pc0.minDist <= 30 && !(clr0 < 0)) return { dvx: 0, dvy: 0, dvz: 0, cost: 0 };
  const info0 = relInfo(ship, target);
  const wantClose = Math.max(2, (3.45 * Math.log10(Math.max(10, info0.dist)) - 12.15) * Math.pow(scale, 1.3));
  const coastTol = Math.max(30, info0.dist * 0.006);
  if(pc0.minDist <= coastTol && info0.closing >= wantClose * 0.85 && !(clr0 < 0)){
    return { dvx: 0, dvy: 0, dvz: 0, cost: 0 };
  }
  const needSpeed = info0.closing < wantClose * 0.85;
  const fineCorr = !needSpeed && pc0.minDist <= info0.dist * 0.5;
  const magScale = fineCorr
    ? Math.min(0.25, Math.max(0.05, pc0.minDist / Math.max(1, pc0.tMin))) * scale
    : (pc0.minDist > 150 ? 2 : 1) * scale;
  const magT = 0.8 * magScale, magR = 0.5 * magScale;
  const vmag = Math.hypot(ship.vx, ship.vy, ship.vz) || 1;
  const vh = [ship.vx / vmag, ship.vy / vmag, ship.vz / vmag];
  const rmag = Math.hypot(ship.x, ship.y, ship.z) || 1;
  const rh = [ship.x / rmag, ship.y / rmag, ship.z / rmag];
  const nh = [rh[1] * vh[2] - rh[2] * vh[1], rh[2] * vh[0] - rh[0] * vh[2], rh[0] * vh[1] - rh[1] * vh[0]];
  const tgtSr = surfaceRadius(target);
  /* 狙点オフセット: 表面＋マージン＋4,500。重力で軌道が内側へ垂れる（サグ）ため、
     狙点どおりの通過でも実際の最接近は狙点より ~2,900 内側になる（実測:
     狙点 7,600 で予測最接近 4,631〜4,947）。旧値 +3,000 では予測最接近が
     安全閾値（表面＋マージン = 4,600）の際どい上に乗り、飛行中の分散で
     割り込んで逸脱判定→計画停止→到着処理まで止まる事故になった（v0.6.2 実測）。
     +4,500 で予測最接近は ~6,200 になり、閾値へ 1,600 の余裕ができる。 */
  const aimOff = tgtSr > 50 ? (tgtSr + impactMargin(tgtSr) + 4500) : 0;
  const aimAt = (tp) => [tp.x + rh[0] * aimOff, tp.y + rh[1] * aimOff, tp.z + rh[2] * aimOff];
  const tLead = Math.min(HZ, info0.dist / wantClose);
  const tPred = predictTargetPos(target, starGM, tLead, pl);
  const iap = aimAt(tPred);
  const ix = (iap[0] - ship.x) / Math.max(1, tLead) - ship.vx;
  const iy = (iap[1] - ship.y) / Math.max(1, tLead) - ship.vy;
  const iz = (iap[2] - ship.z) / Math.max(1, tLead) - ship.vz;
  const im = Math.hypot(ix, iy, iz) || 1;
  const ih = [ix / im, iy / im, iz / im];
  const timeW = (needSpeed && info0.dist > 60000) ? wantClose * (scale < 0.95 ? 0.15 : (scale > 1.1 ? 0.25 : 0.35)) : 0;
  const relW = 2 + info0.dist * 0.001;
  const improveFrac = info0.dist > 50000 ? (fineCorr ? 0.10 : (scale < 0.95 ? 0.05 : (scale > 1.1 ? 0.01 : 0.03))) : 0.025;
  /* 目標天体への通過マージン（v0.6.2）: 表面＋衝突マージンの内側を掠める通過は、
     実飛行で到着ガード／回避が立て直す対象であり、計画として提示すべきでない。
     通過予測（passHz 窓）への食い込みペナルティと、会合が見える範囲での
     最接近評価の飽和で、誘導の段階からマージンを保つ通過を選ばせる。
     接舷対象（駅など小天体）は接近そのものが目的なので対象外（aimOff と同じ境界）。 */
  const passFloor = tgtSr > 50 ? tgtSr + impactMargin(tgtSr) + 800 : 0;
  const passPen = (pc) => (passFloor && pc.minDist < passFloor) ? (passFloor - pc.minDist) * 4 : 0;
  /* 飽和は std/fast のみに適用する（v0.6.2 実測）: eco の弱い shaping 噴射は、
     飽和で平らになったスコア地形では勾配を見失い微修正を繰り返して Δv が
     2倍化した（24.71）。eco は素の最接近勾配で寄せるのが最も安い（11.07）。 */
  const scoreFn = pc => (passFloor && scale >= 0.95 && pc.minDist < passFloor * 4 ? Math.min(pc.minDist, passFloor) : pc.minDist) + pc.relAtMin * relW + timeW * pc.tMin + (pc.minClearance < 0 ? 1e6 + Math.abs(pc.minClearance) * 100 : 0);
  const score0 = scoreFn(pc0) + passPen(pcPass0 || pc0);
  /* フライバイ会合の成立滑空（v0.6.2）: 予測通過が「マージンを保ち、狙点の帯の中」
     に入り、通過窓でも安全な場合、それ以上の shaping 噴射は通過を良くせず
     推進剤だけを食う（実測: eco は飽和したスコア地形で微修正を繰り返し Δv が
     2倍化した）。会合が成立したら滑空し、予測が帯から外れたら通常段が再開する。
     到着の最終判定は到着ガード／滑空検証が別途担う。 */
  /* 帯の下限は硬い安全線（表面＋衝突マージン）まで広げる（v0.6.2）: passFloor
     （+800 の慎重分）より少し内側の通過は到着ガードが許容する安全な通過で、
     それを「直そう」とすると修正が両側に振れてリミットサイクルになる
     （実測: dist 31,000 で 2.08 の噴射を延々反復）。 */
  const hardFloor = tgtSr > 50 ? tgtSr + impactMargin(tgtSr) : 0;
  if(passFloor && info0.dist < 100000 && info0.closing > 0 && !(clr0 < 0)
     && pc0.minDist >= hardFloor && pc0.minDist <= aimOff * 1.6
     && (pcPass0 ? pcPass0.minDist : pc0.minDist) >= hardFloor){
    return { dvx: 0, dvy: 0, dvz: 0, cost: 0 };
  }
  const zero = { dvx: 0, dvy: 0, dvz: 0, cost: 0 };
  const evalCands = (cands) => cands.map(c => {
    const s2 = { x: ship.x, y: ship.y, z: ship.z, vx: ship.vx + c[0], vy: ship.vy + c[1], vz: ship.vz + c[2] };
    const pc = predictClosest(s2, target, starGM, HZ, pl);
    let clr = pc.minClearance, pp = null;
    if(passHz){ pp = predictClosest(s2, target, starGM, passHz, pl); if(pp.minClearance < clr) clr = pp.minClearance; }
    return { dv: c, pc, clr, score: scoreFn(pc) + passPen(pp || pc) };
  });
  const mk = (e) => ({ dvx: e.dv[0], dvy: e.dv[1], dvz: e.dv[2], cost: Math.hypot(e.dv[0], e.dv[1], e.dv[2]) });

  /* ---- Tier 1: phasing nudges (original policy) ---- */
  const cands = [];
  if(info0.closing < wantClose * 0.5 && pc0.minDist > 1000){
    for(const f of [0.6, 1.0]){
      const d = Math.min(im * f, wantClose);
      cands.push([ih[0] * d, ih[1] * d, ih[2] * d]);
    }
  }
  if(fineCorr && pc0.miss && pc0.tMin > 1){
    let mx = pc0.miss[0]/pc0.tMin, my = pc0.miss[1]/pc0.tMin, mz = pc0.miss[2]/pc0.tMin;
    const dot = mx*vh[0]+my*vh[1]+mz*vh[2]; mx -= dot*vh[0]; my -= dot*vh[1]; mz -= dot*vh[2];
    const mm = Math.hypot(mx,my,mz)||1, k = Math.min(1, (0.6*scale)/mm);
    cands.push([mx*k, my*k, mz*k]);
  }
  for(const sgn of [1, -1]){
    cands.push([rh[0] * magR * sgn, rh[1] * magR * sgn, rh[2] * magR * sgn]);
    cands.push([nh[0] * magR * sgn, nh[1] * magR * sgn, nh[2] * magR * sgn]);
    if(!fineCorr) cands.push([vh[0] * magT * sgn, vh[1] * magT * sgn, vh[2] * magT * sgn]);
    if(needSpeed) cands.push([ih[0] * magT * sgn, ih[1] * magT * sgn, ih[2] * magT * sgn]);
  }
  const ev1 = evalCands(cands);
  const safe1 = ev1.filter(e => !(e.clr < 0));
  safe1.sort((a, b) => a.score - b.score);
  let pick1 = null;
  if(safe1.length){
    const best = safe1[0];
    if(best.score < score0 - 6 && best.score < score0 * (1 - improveFrac)) pick1 = { e: best, tier: 'tier1' };
    /* 滑空では到達できない局面では％ゲートを外す（安全な候補に限る） */
    else if(pc0.minDist > coastTol && pc0.minDist > info0.dist * 0.55 && best.pc.minDist < pc0.minDist * 0.8 && best.score < score0 - 6) pick1 = { e: best, tier: 'tier1-relaxed' };
  }

  /* ---- Tier 2: committed intercept ---- */
  /* 発動条件は「滑空予測が現在の距離の半分にも近づかない」こと。近づいている
     軌道は位相ナッジが仕上げられるので、収束途中の軌道を横取りしない。
     Tier1 が採れた場合でも、インターセプトのスコアが明確に良ければそちらを採る
     （出発直後など、ナッジの積み重ねより直接遷移が本質的に良い局面がある。
     バリアント間の速さの差はリードタイム＝wantClose の差としてここに現れる）
     フライバイ目標×eco（scale<0.95）では使わない（v0.6.2 実測）: eco の
     インターセプトは上限（wantClose×2）に切り詰められて狙点へ届かず、
     会合未成立のまま再インターセプトを繰り返した（10.0→30,000で再び10.0）。
     eco は位相ナッジの漸進遷移が設計どおり最も安い。会合目標（駅・艦船）は
     全バリアントで使う（帰投の実証済み経路を変えない）。 */
  let pick2 = null;
  /* eco 除外は「終端のフライバイ局面」（dist <= 60000）に限る（v0.6.2 追加実測）:
     港内出発の終了状態は目標から離反していることがあり（dist 162,341・
     closing -6.62）、長距離では位相ナッジも Tier 2 も届かず誘導が噴射ゼロに
     陥る盲点があった。推定器は接舷状態から始めるため、この状態を踏まない。
     長距離の離反局面では eco でもインターセプトが必要。 */
  if(pc0.minDist > coastTol && pc0.minDist > info0.dist * 0.55 && (info0.dist > 30000 || !passFloor) && !(passFloor && scale < 0.95 && info0.dist <= 60000)){
    const icands = [];
    /* 上限は「相対運動を殺して再捕捉する」量まで認める（v0.6.2 追加実測）:
       離反局面の正直なインターセプトは wantClose×2 を超える（実測 17〜19 に
       対し旧上限 11.65）。切り詰めた候補は会合を証明できず、誘導がゼロに
       陥っていた。採否は従来どおり「予測で会合が成立すること」が担う。 */
    const cap = Math.max(10, wantClose * 2.0, (info0.rel || 0) * 2 + wantClose);
    for(const f of [0.55, 1.0, 1.7]){
      const tL = Math.max(120, tLead * f);
      if(tL > HZ * 1.05) continue;
      const tp = predictTargetPos(target, starGM, tL, pl);
      const ap = aimAt(tp);
      let dx = (ap[0] - ship.x) / tL - ship.vx;
      let dy = (ap[1] - ship.y) / tL - ship.vy;
      let dz = (ap[2] - ship.z) / tL - ship.vz;
      const dm = Math.hypot(dx, dy, dz);
      if(dm > cap){ const k = cap / dm; dx *= k; dy *= k; dz *= k; }
      if(dm > 0.05) icands.push([dx, dy, dz]);
    }
    /* 重力井戸からの脱出候補（v0.6.2）: 目標でない天体の近傍（捕捉軌道など）
       から遠方の目標へ向かう場合、直接インターセプトは井戸の中で相対速度を
       殺すため法外になる（実測: 捕捉軌道からの帰投で単発 36.77）。まず井戸を
       脱出する噴射（接線方向へ脱出速度少し超）を候補に足し、予測評価に委ねる。
       脱出後の幾何は通常の巡航と同じで、後続のケイデンスが仕上げる。 */
    {
      let well = null;
      for(const p of (pl || [])){
        if(!p || p === target || !(p.gm > 0)) continue;
        const d = Math.hypot(ship.x - p.x, ship.y - p.y, ship.z - p.z);
        if(d < 60000){ well = { body: p, d }; break; }
      }
      if(well){
        const B = well.body, d = Math.max(well.d, 50);
        const rvx = ship.vx - (B.vx || 0), rvy = ship.vy - (B.vy || 0), rvz = ship.vz - (B.vz || 0);
        const rm = Math.hypot(rvx, rvy, rvz);
        const ux = (ship.x - B.x) / d, uy = (ship.y - B.y) / d, uz = (ship.z - B.z) / d;
        let tx = rvx - (rvx * ux + rvy * uy + rvz * uz) * ux, ty = rvy - (rvx * ux + rvy * uy + rvz * uz) * uy, tz = rvz - (rvx * ux + rvy * uy + rvz * uz) * uz;
        let tm = Math.hypot(tx, ty, tz);
        if(tm < 0.3){ tx = uy * 0 - uz * 1; ty = uz * 0 - ux * 0; tz = ux * 1 - uy * 0; tm = Math.hypot(tx, ty, tz) || 1; }
        tx /= tm; ty /= tm; tz /= tm;
        const vEscDes = Math.sqrt(2 * B.gm / d) * 1.03;
        const tdx = target.x - ship.x, tdy = target.y - ship.y, tdz = target.z - ship.z;
        const tdm = Math.hypot(tdx, tdy, tdz) || 1;
        const gx = tdx / tdm, gy = tdy / tdm, gz = tdz / tdm;
        for(const rot of [0, 0.5, -0.5]){
          const cs = Math.cos(rot), sn = Math.sin(rot);
          const dxu = tx * cs + gx * sn, dyu = ty * cs + gy * sn, dzu = tz * cs + gz * sn;
          const dm2 = Math.hypot(dxu, dyu, dzu) || 1;
          const dvx = (B.vx || 0) + (dxu / dm2) * vEscDes - ship.vx;
          const dvy = (B.vy || 0) + (dyu / dm2) * vEscDes - ship.vy;
          const dvz = (B.vz || 0) + (dzu / dm2) * vEscDes - ship.vz;
          if(Math.hypot(dvx, dvy, dvz) > 0.05) icands.push([dvx, dvy, dvz]);
        }
      }
    }
    /* 狙点の反復補正: 直線インターセプトは重力の曲がりを無視するため、予測の
       最接近ミス（miss = 目標−自艦 @tMin）を tMin で割って噴射に足し戻す。
       補正は2段まで繰り返す（1段では速い遷移の曲がりを取り切れず、会合が
       30,000 級に外れて次の大噴射を呼んだ実測がある。各段で再クリップ）。 */
    const refined = [];
    for(const c of icands){
      let cur = c;
      for(let it = 0; it < 2; it++){
        const s2 = { x: ship.x, y: ship.y, z: ship.z, vx: ship.vx + cur[0], vy: ship.vy + cur[1], vz: ship.vz + cur[2] };
        const pc = predictClosest(s2, target, starGM, HZ, pl);
        if(!(pc.miss && pc.tMin > 60 && pc.minDist > 1500)) break;
        /* 補正の目標は中心ではなく狙点（aimOff のオフセット点）: miss は中心
           基準なので、オフセット分を差し引いてから割る。中心へ補正すると
           補正候補がすべて表面へ突っ込み、クリアランスで全滅した実測がある。 */
        let nx = cur[0] + (pc.miss[0] - rh[0] * aimOff) / pc.tMin, ny = cur[1] + (pc.miss[1] - rh[1] * aimOff) / pc.tMin, nz = cur[2] + (pc.miss[2] - rh[2] * aimOff) / pc.tMin;
        const nm = Math.hypot(nx, ny, nz);
        if(nm > cap){ const k = cap / nm; nx *= k; ny *= k; nz *= k; }
        if(nm <= 0.05) break;
        cur = [nx, ny, nz];
        refined.push(cur);
      }
    }
    const ev2 = evalCands(icands.concat(refined));
    const safe2 = ev2.filter(e => !(e.clr < 0));
    safe2.sort((a, b) => a.score - b.score);
    if(safe2.length){
      const best = safe2[0];
      /* インターセプトは「実際に会合できる」場合だけ採る。スコアの timeW 項は
         長い遷移そのものを罰するため、Tier 2 の採否には使わない（順序付けのみ）。
         採否の物差しは会合の成立そのもの。 */
      if(best.pc.minDist < Math.max(1500, pc0.minDist * 0.25)) pick2 = { e: best, tier: 'tier2' };
    }
  }
  /* ---- Tier 0 (fallback): coast is on a collision course ---- */
  /* 通常段（Tier 1/2）が噴射を選んだ場合はそちらを優先する。通常段の候補は
     通過窓までクリアランスでフィルタ済みなので、「滑空が衝突コース」という
     判定だけで先回りして大噴射を撃つ必要はない（出発直後など、どうせ最初の
     接近噴射で軌道が書き換わる局面で Tier 0 が暴れるのを防ぐ）。
     通常段が何も選ばない場合でも、発動には「マージンを 600 超えて食い込む」
     深さを求める（ヒステリシス）。クリアランス ≈ 0 の境界では、惑星が
     1フレーム進んだだけで判定が反転し、16 超の大噴射と通常のインターセプトが
     入れ替わる実測があったため。食い込みが浅いうちは回避監視と到着ガードが
     受け持ち、深くなれば（月面落下中など）ここが即応する。 */
  if(pc0.minClearance < -600 && (pc0.tClear == null || pc0.tClear <= 10800)){
    const cands0 = [];
    if(pc0.hazardDir){
      for(const m of [magR, magT * 2, 3 * scale, 6 * scale]){
        cands0.push([pc0.hazardDir[0] * m, pc0.hazardDir[1] * m, pc0.hazardDir[2] * m]);
        cands0.push([(pc0.hazardDir[0] * 0.7 + vh[0] * 0.7) * m, (pc0.hazardDir[1] * 0.7 + vh[1] * 0.7) * m, (pc0.hazardDir[2] * 0.7 + vh[2] * 0.7) * m]);
      }
    }
    for(const f of [0.55, 1.0, 1.7]){
      const tL = Math.max(120, tLead * f);
      if(tL > HZ * 1.05) continue;
      const tp = predictTargetPos(target, starGM, tL, pl);
      const ap = aimAt(tp);
      let dx = (ap[0] - ship.x) / tL - ship.vx;
      let dy = (ap[1] - ship.y) / tL - ship.vy;
      let dz = (ap[2] - ship.z) / tL - ship.vz;
      const dm = Math.hypot(dx, dy, dz), cap = Math.max(10, wantClose * 2.0);
      if(dm > cap){ const k = cap / dm; dx *= k; dy *= k; dz *= k; }
      if(dm > 0.05) cands0.push([dx, dy, dz]);
    }
    for(const sgn of [1, -1]){
      cands0.push([rh[0] * magR * sgn, rh[1] * magR * sgn, rh[2] * magR * sgn]);
      cands0.push([nh[0] * magR * sgn, nh[1] * magR * sgn, nh[2] * magR * sgn]);
      cands0.push([vh[0] * magT * sgn, vh[1] * magT * sgn, vh[2] * magT * sgn]);
    }
    /* 天体中心の脱出候補（v0.6.2）: 天体の重力井戸の中で衝突コースにある場合、
       恒星中心のナッジや hazardDir では脱出できない（落下中の艦に必要なのは
       その天体に対する接線速度＝周回速度級の噴射）。最も脅威な天体を特定し、
       その天体まわりの接線／動径方向へ円軌道速度のオーダーで噴射する候補を足す */
    {
      let hb = null, hbD = Infinity, hbClr = Infinity;
      for(const p of (pl || [])){
        if(!p || !(p.gm > 0)) continue;
        const sr = surfaceRadius(p);
        const dP = Math.hypot(ship.x - p.x, ship.y - p.y, ship.z - p.z);
        const c = dP - (sr + impactMargin(sr));
        if(c < hbClr){ hbClr = c; hb = p; hbD = dP; }
      }
      if(hb && hbD < 300000){
        const rx = (ship.x - hb.x) / hbD, ry = (ship.y - hb.y) / hbD, rz = (ship.z - hb.z) / hbD;
        const rvx = ship.vx - (hb.vx || 0), rvy = ship.vy - (hb.vy || 0), rvz = ship.vz - (hb.vz || 0);
        const vr = rvx * rx + rvy * ry + rvz * rz;
        let tx = rvx - vr * rx, ty = rvy - vr * ry, tz = rvz - vr * rz;
        let tm = Math.hypot(tx, ty, tz);
        if(tm < 0.3){
          tx = ry * vh[2] - rz * vh[1]; ty = rz * vh[0] - rx * vh[2]; tz = rx * vh[1] - ry * vh[0];
          tm = Math.hypot(tx, ty, tz) || 1;
        }
        tx /= tm; ty /= tm; tz /= tm;
        const vc = Math.sqrt(hb.gm / Math.max(50, hbD));
        for(const f of [0.8, 1.15, 1.5]) for(const sgn of [1, -1]) cands0.push([tx * f * vc * sgn, ty * f * vc * sgn, tz * f * vc * sgn]);
        for(const f of [0.6, 1.1]) cands0.push([rx * f * vc, ry * f * vc, rz * f * vc]);
        for(const sgn of [1, -1]) cands0.push([(tx * 0.8 + rx * 0.6) * vc * sgn, (ty * 0.8 + ry * 0.6) * vc * sgn, (tz * 0.8 + rz * 0.6) * vc * sgn]);
      }
    }
    const ev0 = evalCands(cands0);
    const safe0 = ev0.filter(e => !(e.pc.minClearance < 0));
    if(safe0.length){
      safe0.sort((a, b) => a.score - b.score);
      return mk(safe0[0]);
    }
    ev0.sort((a, b) => (b.pc.minClearance - a.pc.minClearance) || (a.score - b.score));
    if(ev0.length && ev0[0].pc.minClearance > pc0.minClearance + 50){ return mk(ev0[0]); }
    return zero;
  }
  /* 井戸内の忍耐（v0.6.2）: 目標でない天体の重力井戸の中（捕捉軌道など）で
     高額なインターセプトしか無い場合、即座に撃たず滑空して位相を待つ。
     井戸内の軌道運動が相対幾何を回し、半周もすれば安い遷移窓が来る
     （実測: 捕捉軌道からの帰投で単発 36.77 を即撃ちしていた）。滑空自体が
     危険な場合（clr0 < 0）は Tier 0 が先に処理済み。呼び出し側が ctx で
     残り回数を管理し、尽きたら通常どおり撃つ（無限に待たない）。 */
  const inWell = (() => {
    for(const p of (pl || [])){
      if(!p || p === target || !(p.gm > 0)) continue;
      if(Math.hypot(ship.x - p.x, ship.y - p.y, ship.z - p.z) < 60000) return true;
    }
    return false;
  })();
  const holdIfPricey = (e) => {
    /* 閾値はバリアントの規模に合わせる（eco の 13 は std の 13 より重い） */
    if(ctx && ctx.patienceLeft > 0 && inWell && clr0 >= 0 && Math.hypot(e.dv[0], e.dv[1], e.dv[2]) > 14 * Math.pow(scale, 1.3)){
      ctx.patienceLeft--;
      return zero;
    }
    return mk(e);
  };
  /* Tier 2 の発動境界での忍耐（v0.6.4 切り分け）: 滑空最接近が現在距離の
     55% 付近にある局面では、ゲート（minDist > dist×0.55）が予測の微差で
     反転し、「滑空継続（0）」と「全面インターセプト（実測 29.2）」が
     120 秒違いの評価で入れ替わる。推定側と実飛行側で評価位相がずれると
     別の枝に入り、推定 22.6 の航程が実績 46.7 に化けた（Δ=120 eco）。
     滑空が実質的に接近している（最接近 < 距離×0.75）局面で高額な Tier 2
     候補が立つ間は、井戸内と同じ忍耐で滑空を続け、位相の回転で局面が
     解けるのを待つ。滑空がほぼ接近しない局面（出域直後の離反など）では
     従来どおり即時発動する。尽きたら通常どおり撃つ。 */
  const holdTier2IfAmbiguous = (e) => {
    if(ctx && ctx.patienceLeft > 0 && clr0 >= 0 && pc0.minDist < info0.dist * 0.75
       && Math.hypot(e.dv[0], e.dv[1], e.dv[2]) > 14 * Math.pow(scale, 1.3)){
      ctx.patienceLeft--;
      return zero;
    }
    return mk(e);
  };
  /* Tier 2 の確定経路: 井戸内の忍耐→境界の忍耐の順に適用する */
  const settlePick2 = (e) => {
    const held = holdIfPricey(e);
    if(!held.cost) return held;
    return holdTier2IfAmbiguous(e);
  };
  if(pick2 && pick1){
    /* Tier 間の比較には噴射コストも換算して入れる（v0.6.2）: スコアには
       Δv の項がなく、大噴射の Tier 2 が小噴射の Tier 1 を「到達性」だけで
       outbid してしまう（eco が std より高くつく逆転の原因）。コスト差を
       relW（速度→スコアの換算）で差し引いてから比べる。 */
    const c1 = Math.hypot(pick1.e.dv[0], pick1.e.dv[1], pick1.e.dv[2]);
    const c2 = Math.hypot(pick2.e.dv[0], pick2.e.dv[1], pick2.e.dv[2]);
    if(pick2.e.score + Math.max(0, c2 - c1) * relW < pick1.e.score) return settlePick2(pick2.e);
    return mk(pick1.e);
  }
  if(pick2){ return settlePick2(pick2.e); }
  if(pick1){ return mk(pick1.e); }
  return zero;
}
/* 捕捉バーン（v0.6.2、設計規則 台帳#44/#47）: 質量のある天体の近傍で、現在の
   相対位置における円軌道速度（順行・現在の角運動量方向）へ速度を合わせ、
   フライバイ状態から安定な捕捉軌道へ移す Δv を返す。計画の終了状態は安定で
   なければならない（相対速度一致／軌道捕捉／予算明示の定常保持のいずれか）。
   判断待ちの間に船が遠ざかり続ける状態で計画を手放さないための機構。 */
function orbitPeriapsis(ship, target){
  /* 目標に対する相対軌道のエネルギーと近点を返す（捕捉の成否判定用）。 */
  if(!target || !(target.gm > 0)) return null;
  const rx = ship.x - target.x, ry = ship.y - target.y, rz = ship.z - target.z;
  const d = Math.hypot(rx, ry, rz);
  if(d < 1) return null;
  const rvx = ship.vx - (target.vx || 0), rvy = ship.vy - (target.vy || 0), rvz = ship.vz - (target.vz || 0);
  const energy = (rvx * rvx + rvy * rvy + rvz * rvz) / 2 - target.gm / d;
  if(energy >= 0) return { energy, periapsis: Infinity, apoapsis: Infinity };
  const a = -target.gm / (2 * energy);
  const hx = ry * rvz - rz * rvy, hy = rz * rvx - rx * rvz, hz = rx * rvy - ry * rvx;
  const p = (hx * hx + hy * hy + hz * hz) / target.gm;
  const e = Math.sqrt(Math.max(0, 1 - p / a));
  return { energy, periapsis: a * (1 - e), apoapsis: a * (1 + e) };
}
/* 捕捉軌道の遠点上限（v0.6.4、課題3）: 衛星については、母天体に対する
   ヒル半径の 30% を上限とする。旧上限（脱出速度×0.85）は捕捉半径 18,000 で
   遠点 ≈46,800＝ヒル圏の 94% に達し、母惑星の潮汐で数日以内に月から脱出→
   母惑星へ落下する軌道を量産した（実測: 判断待ち中に「約36時間後に
   つむぎへ衝突」の提案）。45% でも不十分なことを実測で確認した: 遠点 22,500
   （ヒル 45%）の捕捉軌道は潮汐で離心率が汲み上げられ、近点が 11,874 →
   9,491 と 24 時間で沈降し、衝突予測が繰り返し発火した。遠点 30% では
   遠点での潮汐／月重力比が約 2% まで下がる。惑星（ヒル圏が巨大で拘束に
   ならない）には適用しない。 */
function captureApoCap(target, planetsRaw){
  if(!target || !(target.gm > 0) || !target.isMoon) return Infinity;
  /* 母天体の探索は「評価対象の世界の惑星」で行う（v0.6.4 修正）: 推定器や
     スナップショット評価で実世界の S.planets を読むと、時刻のずれた幾何で
     上限を計算してしまい推定が壊れる（回帰テストで検出）。惑星が渡されない
     実飛行の手動命令などでのみ S へフォールバックする。 */
  const src = (planetsRaw && planetsRaw.length) ? planetsRaw : ((typeof S === 'undefined' || !S || !S.planets) ? null : S.planets);
  if(!src) return Infinity;
  let best = null;
  for(const p of src){
    if(!p || !(p.gm > 0) || p.name === target.name) continue;
    const d = Math.hypot(target.x - p.x, target.y - p.y, target.z - p.z);
    if(d < 1) continue;
    const pull = p.gm / (d * d);
    if(!best || pull > best.pull) best = { gm: p.gm, d, pull };
  }
  if(!best) return Infinity;
  const rHill = best.d * Math.cbrt(target.gm / (3 * best.gm));
  const sr = surfaceRadius(target);
  return Math.max(sr + impactMargin(sr) + 4200, 0.30 * rHill);
}
/* 軌道そのものが捕捉の安全帯に収まっているか（v0.6.4）: 束縛・近点フロア・
   遠点のヒル上限をすべて満たす場合のみ true。 */
function captureOrbitInBand(ship, target, planetsRaw){
  const orb = orbitPeriapsis(ship, target);
  if(!orb || !(orb.energy < 0)) return false;
  const sr = surfaceRadius(target);
  if(orb.periapsis < sr + impactMargin(sr) + 800) return false;
  const apoCap = captureApoCap(target, planetsRaw);
  if(isFinite(apoCap) && orb.apoapsis > apoCap) return false;
  return true;
}
/* 捕捉噴射後の軌道が「安全な港」か（v0.6.4）: 束縛・近点フロア・遠点のヒル
   上限をすべて満たす場合のみ true。捕捉の発火判定（実飛行・推定器で共用）と
   到着後の解析確認に使う。 */
function captureSettlesOk(ship, target, planetsRaw){
  const cap = computeCapture(ship, target, planetsRaw);
  if(!cap) return false;
  const post = { x: ship.x, y: ship.y, z: ship.z, vx: ship.vx + cap.dvx, vy: ship.vy + cap.dvy, vz: ship.vz + cap.dvz };
  return captureOrbitInBand(post, target, planetsRaw);
}
/* 捕捉軌道の長期安定性を数値伝播で確認する（v0.6.4 課題3）: 解析的な
   遠点上限（ヒル 30%）を満たしても、母惑星の潮汐で離心率が汲み上げられ
   近点が沈む軌道がある（実測: 遠点 14,970 以内で捕捉 → 72 時間内に遠点
   23,882 まで成長し、約25時間先の月面衝突が予測された）。捕捉の発火前に
   捕捉後の状態を無動力で伝播し、月・母惑星・恒星への衝突と月からの脱出
   （距離 90,000 超）がないこと、さらに捕捉帯（近点フロア〜遠点上限）に
   留まり続けることを確認する。伝播長は「判断待ち 72 時間＋
   衝突提案の予測ホライズン 48 時間」の 120 時間（実測: 72 時間ちょうどで
   切り上げると、待ちの後半で衝突提案が立つ軌道を通してしまった）。
   伝播は実飛行と同一の積分規律（下記）で行う。衛星以外は解析帯で十分とし、
   常に true を返す。 */
function captureOrbitStable72h(ship, target, starGM, planetsRaw){
  if(!target || !target.isMoon || !(target.gm > 0)) return true;
  const pls = (planetsRaw || []).map(p => ({ x: p.x, y: p.y, z: p.z, vx: p.vx, vy: p.vy, vz: p.vz, gm: p.gm, radius: p.radius || 7, dispR: p.dispR || 0, name: p.name || '', isMoon: !!p.isMoon, moonOf: p.moonOf || null }));
  const tIdx = pls.findIndex(p => p.name === target.name);
  if(tIdx < 0) return true;
  const t = pls[tIdx];
  const s = { x: ship.x, y: ship.y, z: ship.z, vx: ship.vx, vy: ship.vy, vz: ship.vz };
  const sAcc = starAccFn(starGM);
  const accs = pls.map((_, i) => accExcluding(starGM, pls, i));
  const accFull = fullAccFn(starGM, pls);
  const segMin = (ax0, ay0, az0, bx0, by0, bz0) => {
    const dx = bx0 - ax0, dy = by0 - ay0, dz = bz0 - az0;
    const len2 = dx * dx + dy * dy + dz * dz;
    const u = len2 > 1e-12 ? Math.max(0, Math.min(1, -(ax0 * dx + ay0 * dy + az0 * dz) / len2)) : 0;
    return Math.hypot(ax0 + dx * u, ay0 + dy * u, az0 + dz * u);
  };
  /* 伝播は実飛行と同一の積分規律で行う（v0.6.4 修正）: 当初この確認は RK4
     （天体を刻み始めに凍結する演算子分割）で伝播していたが、月近傍では
     1 刻みで月が約 2,300 単位移動するため分割誤差が軌道を歪め、実世界では
     120 時間安定な捕捉軌道 [11,434, 14,954] を「27 時間で月面衝突」と
     誤判定した（推定器が捕捉を撃てず計画が成立しない回帰の原因）。
     判定系は守る対象の世界と同じモデルで測る: 衛星・自船は半陰的オイラー
     （stepBody と同じ v→x の順）、惑星は恒星のみ RK4、刻みは実飛行の
     計画有効中の上限（遠 120 秒／目標 300,000 以内 20 秒）にそろえる。 */
  const eulerStep = (b, h, accFn) => {
    const a = accFn(b.x, b.y, b.z);
    b.vx += a[0] * h; b.vy += a[1] * h; b.vz += a[2] * h;
    b.x += b.vx * h; b.y += b.vy * h; b.z += b.vz * h;
  };
  /* 帯の維持（v0.6.4 切り分けで追加）: 衝突・脱出がないだけでは「安全な港」
     にならない。潮汐で離心率が汲み上がる軌道は、近点が捕捉フロア
     （表面＋マージン＋800）を割り込んで回避系の発火域（表面＋マージン）に
     接近し、判断待ちの間に回避提案と自動噴射を繰り返す（ハーネス実測:
     Δ=0 の捕捉軌道は 120 時間で衝突も脱出もしないが、72 時間の保持で
     提案 12 回・自動噴射 3 回・Δv 4.5 を浪費した）。捕捉後の軌道が
     120 時間を通して捕捉帯（近点フロア〜遠点上限×1.15）に留まることを
     発火条件に含める。1.15 は三体効果で瞬時遠点が振動する分の許容で、
     汲み上がりで 1.6 倍超まで成長した実測軌道とは分離できる。 */
  const srT = surfaceRadius(t);
  const bandFloor = srT + impactMargin(srT) + 800;
  const apoCapT = captureApoCap(target, planetsRaw);
  const bandCap = isFinite(apoCapT) ? apoCapT * 1.15 : 90000;
  let tt = 0;
  const H = 120 * 3600;
  let guard = 0;
  while(tt < H){
    if(++guard > 400000) return false;
    const dMoon0 = Math.hypot(s.x - t.x, s.y - t.y, s.z - t.z);
    /* 刻みの下限 2 秒: dynStep の既定上限（0.75 秒）のままでは 120 時間で
       57 万刻みを超え、暴走ガードが「不安定」と誤判定した（実測）。2 秒でも
       月周回（周期約 10,650 秒）に対して 5,000 刻み以上あり判定には十分で、
       実飛行の近傍刻み 20 秒より細かい。 */
    const h = Math.max(2, Math.min(dynStep(s.x, s.y, s.z, starGM, pls), dMoon0 < 300000 ? 20 : 120, H - tt));
    if(!(h > 0)) return false;
    const prevRel = pls.map(p => [s.x - p.x, s.y - p.y, s.z - p.z]);
    const prevStar = [s.x, s.y, s.z];
    for(let i = 0; i < pls.length; i++){
      if(pls[i].isMoon) eulerStep(pls[i], h, accs[i]);
      else rk4StepState(pls[i], h, sAcc);
    }
    eulerStep(s, h, accFull);
    tt += h;
    for(let i = 0; i < pls.length; i++){
      const b = pls[i];
      const sr = surfaceRadius(b);
      const d = Math.min(Math.hypot(s.x - b.x, s.y - b.y, s.z - b.z), segMin(prevRel[i][0], prevRel[i][1], prevRel[i][2], s.x - b.x, s.y - b.y, s.z - b.z));
      if(d < sr) return false;
      if(i === tIdx && d < bandFloor) return false;
    }
    if(Math.min(Math.hypot(s.x, s.y, s.z), segMin(prevStar[0], prevStar[1], prevStar[2], s.x, s.y, s.z)) < STAR_SURFACE_R) return false;
    const dMoon = Math.hypot(s.x - t.x, s.y - t.y, s.z - t.z);
    if(dMoon > 90000) return false;
    if(dMoon > bandCap) return false;
  }
  return true;
}
/* 捕捉の発火幾何（#76 で単一化）: 推定器と実飛行が共用する「今ここで捕捉噴射を
   撃ってよいか」の唯一の判定。到着の定義が推定と判定で食い違う事故（v0.7 実測）
   を断つため、両者はこの関数を通してだけ捕捉を許可する。3 つの枝:
     1) 捕捉半径フロア（capR）以遠で、動径速度がほぼゼロ（近点／遠点の通過時）。
        旧規則は closing <= 0.05（接近が止んだ）だけで通したため、近点を高速で
        通過した後の離行脚でも発火し、非束縛のフライバイを力任せの噴射で捕捉に
        化けさせた（実測: 近点 5,075・相対速度 20.3 の通過の離行側、距離 9,122・
        離行 11.6 で捕捉が発火し、約束の会合より 11.5 時間早い「到着」になった）。
        動径速度は絶対値で見る（離行は捕捉の幾何ではない）。
     2) 束縛軌道で遠点が capR 未満（軌道全体が捕捉帯の内側）なら随時。
     3) 近点がフロア未満でも、捕捉後の軌道が安全帯に収まる束縛軌道なら可。
   2) 3) は束縛（eOrb < 0）が前提なので、離行中でも「去り行く」ことにはならない。 */
function captureGateAt(ship, target, planetsRaw, arrivalDist){
  if(!target || !(target.gm > 0)) return false;
  const info = relInfo(ship, target);
  const capSr = surfaceRadius(target);
  const capR = Math.min(capSr + impactMargin(capSr) + 4200, arrivalDist * 0.9);
  if(info.dist >= capR && Math.abs(info.closing) <= 0.05) return true;
  if(info.closing <= 0.05){
    const eOrb = info.rel * info.rel / 2 - target.gm / Math.max(info.dist, 1);
    if(eOrb < 0 && 2 * (-target.gm / (2 * eOrb)) - info.dist < capR) return true;
    if(eOrb < 0 && info.dist >= capSr + impactMargin(capSr) + 800 && captureSettlesOk(ship, target, planetsRaw)) return true;
  }
  return false;
}
/* 捕捉の機会（2026-11-20、台帳#130）: captureGateAt は「既に束縛された幾何」
   でしか開かないため、近接パスで有効な捕捉解があっても試みすらされず、
   熱いフライバイ（実測: 相対速度 17〜19、脱出速度超過）のまま通り過ぎて
   推進剤を食い潰した。ゲートが閉じていても、捕捉半径（capR）内に入って
   いて、捕捉噴射後の軌道が安全帯に収まり 72 時間安定し、残量で払える
   解があるなら、それは捕捉の機会である。v0.7 の失敗（離行脚での力任せ
   捕捉→到着の偽装）への歯止めは、発火条件の厳しさではなく「帯内＋
   72 時間安定＋捕捉後 1800 秒の滑空確認（captureOrbitConfirmOk）」が
   担う——ここではその全てを通る解だけを返す。推定器と実飛行が共用し、
   見積もる捕捉と実際に撃つ捕捉の規則を一致させる（#76 の単一化を維持）。
   高コスト（安定伝播を含む）なので、呼び出し側は試行間隔で絞ること。 */
function captureOpportunity(ship, target, planetsRaw, arrivalDist, starGM, dvAvail){
  if(!target || !(target.gm > 0)) return null;
  if(captureGateAt(ship, target, planetsRaw, arrivalDist)) return null; /* ゲートが開く幾何は従来経路に任せる */
  const info = relInfo(ship, target);
  const capSr = surfaceRadius(target);
  const capR = Math.min(capSr + impactMargin(capSr) + 4200, (arrivalDist || 0) * 0.9);
  if(!(info.dist <= capR)) return null;
  const cap = computeCapture(ship, target, planetsRaw);
  if(!cap) return null;
  if(dvAvail != null && cap.cost > dvAvail) return null;
  const post = { x: ship.x, y: ship.y, z: ship.z, vx: ship.vx + cap.dvx, vy: ship.vy + cap.dvy, vz: ship.vz + cap.dvz };
  if(!captureOrbitInBand(post, target, planetsRaw)) return null;
  if(starGM && !captureOrbitStable72h(post, target, starGM, planetsRaw)) return null;
  return cap;
}
/* 到着の確定条件（#76 で単一化）: 捕捉後の状態が「安定な終了状態」か。
   束縛軌道であり、近点が安全フロア（表面＋マージン＋800）を割らないこと。
   推定器の捕捉後確認と実飛行の到着確定が共用する。捕捉噴射の完了をもって
   到着とせず、この条件を滑空確認の末に満たした時だけ到着が成立する。 */
function captureOrbitConfirmOk(ship, target){
  const orb = orbitPeriapsis(ship, target);
  if(!orb || !(orb.energy < 0)) return false;
  const sr = surfaceRadius(target);
  return orb.periapsis >= sr + impactMargin(sr) + 800;
}
function computeCapture(ship, target, planetsRaw){
  if(!target || !(target.gm > 0)) return null;
  const rx = ship.x - target.x, ry = ship.y - target.y, rz = ship.z - target.z;
  const d = Math.hypot(rx, ry, rz);
  if(d < 1) return null;
  const rvx = ship.vx - (target.vx || 0), rvy = ship.vy - (target.vy || 0), rvz = ship.vz - (target.vz || 0);
  let hx = ry * rvz - rz * rvy, hy = rz * rvx - rx * rvz, hz = rx * rvy - ry * rvx;
  const hm = Math.hypot(hx, hy, hz);
  if(hm < 1e-9) return null;
  hx /= hm; hy /= hm; hz /= hm;
  const ux = rx / d, uy = ry / d, uz = rz / d;
  const tx = hy * uz - hz * uy, ty = hz * ux - hx * uz, tz = hx * uy - hy * ux;
  const vc = Math.sqrt(target.gm / d);           /* 円軌道速度 */
  const vEsc = vc * Math.SQRT2;                  /* 脱出速度 */
  const sr = surfaceRadius(target);
  /* 近点の下限: 表面＋マージン＋4,200（月では 8,800）。捕捉軌道は「次の出発状態」
     でもある。下限が浅い（旧 +800 = 5,400）と捕捉軌道の近点が ~4,800 まで落ち、
     そこからの帰投推定が std 33.9／eco 47.1 と爆発して往復が閉じなかった
     （v0.6.2 実測）。近点を 8,800 以上に保つと帰投は ~11〜15 に収まる。 */
  const rSafe = sr + impactMargin(sr) + 4200;     /* 近点の下限 */
  /* 接線速度の帯: 下限は「現在半径が遠点になっても近点が rSafe を割らない」速さ、
     上限は脱出速度の 0.85 倍（v0.6.4 で衛星については遠点のヒル上限も併用する:
     0.85 倍だけでは遠点がヒル圏の 94% に達し長期安定しなかった）。円軌道化まで
     行うと高速到着で捕捉だけで 14.7 食ったため、束縛＋近点安全を満たす最小の
     補正（動径成分の除去＋帯へのクランプ）に留める。 */
  const qMin = Math.sqrt(2 * rSafe / Math.max(d + rSafe, 1));
  const vtLo = vc * Math.min(0.99, qMin);
  let vtHi = vEsc * 0.85;
  /* 遠点のヒル上限（v0.6.4、課題3）: 現在半径が近点になる軌道で遠点が
     apoCap に収まる接線速度まで上限を締める（vtLo の近点フロアと対の式）。
     apoCap ≤ d の場所では接線クランプだけでは遠点を下げられないため締めない
     （その捕捉の可否は captureSettlesOk 側の解析確認が判断する）。 */
  const apoCap = captureApoCap(target, planetsRaw);
  if(isFinite(apoCap) && apoCap > d){
    /* 狙いは上限の内側（0.97 倍）に置く: 二体式で上限ちょうどに合わせると、
       三体効果で振動する瞬時遠点が上限を跨いで帯判定・到着確認が硬直する
       （実測: 遠点 14,954 対上限 14,954 で捕捉が何度も門前払いになった）。 */
    const apoAim = apoCap * 0.97;
    vtHi = Math.min(vtHi, vc * Math.sqrt(2 * apoAim / (d + apoAim)));
  }
  const vt = rvx * tx + rvy * ty + rvz * tz;
  const vtGoal = Math.max(vtLo, Math.min(Math.max(vtHi, vtLo), vt));
  const dvx = (target.vx || 0) + tx * vtGoal - ship.vx;
  const dvy = (target.vy || 0) + ty * vtGoal - ship.vy;
  const dvz = (target.vz || 0) + tz * vtGoal - ship.vz;
  return { dvx, dvy, dvz, cost: Math.hypot(dvx, dvy, dvz) };
}
function computeBrake(ship, target){
  const info = relInfo(ship, target);
  const limit = Math.max(0.6, Math.min(1.3, info.dist * 0.07));
  if(info.rel <= limit) return { dvx: 0, dvy: 0, dvz: 0, cost: 0 };
  const scale = (info.rel - limit) / info.rel;
  const dvx = -info.rvx * scale, dvy = -info.rvy * scale, dvz = -info.rvz * scale;
  return { dvx, dvy, dvz, cost: info.rel - limit };
}
function computeMatch(ship, target){
  const info = relInfo(ship, target);
  return { dvx: -info.rvx, dvy: -info.rvy, dvz: -info.rvz, cost: info.rel };
}
function computeHold(ship, target){
  const info = relInfo(ship, target);
  if(info.rel <= 0.2) return null;
  const scale = (info.rel - 0.2) / info.rel;
  const dvx = -info.rvx * scale, dvy = -info.rvy * scale, dvz = -info.rvz * scale;
  return { dvx, dvy, dvz, cost: info.rel - 0.2 };
}
function approachFix(target){
  const v = Math.hypot(target.vx, target.vy, target.vz);
  let ux, uy, uz;
  if(v > 1e-4){
    ux = -target.vx / v; uy = -target.vy / v; uz = -target.vz / v;
  } else {
    const r = Math.hypot(target.x, target.y, target.z) || 1;
    ux = target.x / r; uy = target.y / r; uz = target.z / r;
  }
  return { x: target.x + ux * 48, y: target.y + uy * 48, z: target.z + uz * 48 };
}
function computeJoinApproach(ship, target, starGM, pl){
  // Local maneuver (tens of units): direct velocity guidance toward the
  // approach fix, which moves rigidly with the target. Short-range pursuit
  // is accurate here; long-horizon prediction is not (the fix is glued to
  // the target, not a ballistic body).
  const fix = approachFix(target);
  // The fix is glued behind the target, so it has its own velocity: the
  // target's velocity plus the rotation of the behind-axis. Feed that
  // forward, otherwise the ship settles into a standoff limit cycle.
  const vm = Math.hypot(target.vx, target.vy, target.vz) || 1;
  const ux = target.vx / vm, uy = target.vy / vm, uz = target.vz / vm;
  const rm = Math.hypot(target.x, target.y, target.z) || 1;
  const ga = -starGM / (rm * rm);
  const ax = ga * (target.x / rm), ay = ga * (target.y / rm), az = ga * (target.z / rm);
  const aDotU = ax * ux + ay * uy + az * uz;
  const fvx = target.vx - 48 * (ax - aDotU * ux) / vm;
  const fvy = target.vy - 48 * (ay - aDotU * uy) / vm;
  const fvz = target.vz - 48 * (az - aDotU * uz) / vm;
  const dx = fix.x - ship.x, dy = fix.y - ship.y, dz = fix.z - ship.z;
  const d = Math.hypot(dx, dy, dz) || 1;
  const spd = Math.max(0.8, Math.min(2.2, d * 0.06));
  let dvx = (fvx + (dx / d) * spd - ship.vx) * 0.7;
  let dvy = (fvy + (dy / d) * spd - ship.vy) * 0.7;
  let dvz = (fvz + (dz / d) * spd - ship.vz) * 0.7;
  let cost = Math.hypot(dvx, dvy, dvz);
  if(cost > 2.5){ const k = 2.5 / cost; dvx *= k; dvy *= k; dvz *= k; cost = 2.5; }
  return { dvx, dvy, dvz, cost };
}
function fastestOrbitCap(pls, starGM, hMax, nearX, nearY, nearZ){
  /* pls 中の最速の軌道周期の 1/100 を返す（刻みの上限）。惑星・衛星の伝播刻みは
     これ以下に保たないと、周期の短い衛星の位相が予測内で無相関になる。
     ただし高速天体が評価点の近傍（3,000,000 以内）に無い場合はその精度は
     クリアランスにも最接近にも効かないため、対象から外してコストを抑える
     （長距離巡航の予測で全天体をサブステップすると評価が約150倍に膨らむ）。 */
  let cap = hMax;
  for(const p of pls){
    if(nearX !== undefined && Math.hypot(p.x - nearX, p.y - nearY, p.z - nearZ) > 3000000) continue;
    let bGm = starGM, bD = Math.hypot(p.x, p.y, p.z);
    for(const q of pls){ if(q !== p && q.gm > 0){ const d = Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z); if(d > 1 && q.gm / (d * d) > bGm / Math.max(1, bD * bD)){ bGm = q.gm; bD = d; } } }
    if(bGm > 0 && bD > 0) cap = Math.min(cap, Math.max(20, 2 * Math.PI * Math.sqrt(Math.pow(bD, 3) / bGm) * 0.01));
  }
  return cap;
}
function predictClosest(ship, target, starGM, tMax, pl, hMax){
  const lim = tMax || 240;
  /* 局所レジーム（短い予測ホライズン）でのみ、誘導側の余裕と曲率キャップを使う。
     長距離巡航の予測は v0.6.1 で調整済みの刻み（lim/2400）が前提で、ここを変えると
     数十日の巡航の候補選択が連鎖的に変わってしまう。局所ではホライズンが短く
     刻みを細かくしてもステップ数が爆発せず、マージンと予測誤差が同程度の大きさに
     なるため、余裕と解像度の両方が要る */
  const localRegime = lim < 3000000;
  const cap = lim / 320;
  let s = { x: ship.x, y: ship.y, z: ship.z, vx: ship.vx, vy: ship.vy, vz: ship.vz };
  let t = { x: target.x, y: target.y, z: target.z, vx: target.vx, vy: target.vy, vz: target.vz };
  const pls = pl ? pl.map(p => ({ x: p.x, y: p.y, z: p.z, vx: p.vx, vy: p.vy, vz: p.vz, gm: p.gm, dispR: p.dispR || 0, radius: p.radius || 7, isMoon: !!p.isMoon })) : null;
  const plsT = pls ? pls.filter(p => Math.hypot(p.x - target.x, p.y - target.y, p.z - target.z) > 1) : null;
  const targetPlIdx = pls ? pls.findIndex(p => Math.hypot(p.x - target.x, p.y - target.y, p.z - target.z) <= 1) : -1;
  const sAcc = starAccFn(starGM);
  const acc = fullAccFn(starGM, pls);
  const accT = plsT === pls ? acc : fullAccFn(starGM, plsT);
  const accs = pls ? pls.map((_, i) => accExcluding(starGM, pls, i)) : null;
  let minDist = Math.hypot(t.x - s.x, t.y - s.y, t.z - s.z), tMin = 0, relAtMin = Math.hypot(s.vx - t.vx, s.vy - t.vy, s.vz - t.vz);
  let missAtMin = [t.x - s.x, t.y - s.y, t.z - s.z];
  let minClearance = Infinity, hazardDir = null, tClear = 0, curT = 0;
  const checkClr = (bx, by, bz, sr) => {
    const mg = impactMargin(sr) + 600;
    const dB = Math.hypot(s.x - bx, s.y - by, s.z - bz);
    const clr = dB - (sr + mg);
    if(clr < minClearance){
      minClearance = clr;
      tClear = curT;
      if(dB > 1e-6) hazardDir = [(s.x - bx) / dB, (s.y - by) / dB, (s.z - bz) / dB];
    }
  };
  /* 線分クリアランス（v0.6.2）: 端点サンプリングでは高速な月がステップ間を
     すり抜け（トンネリング）、誘導が「クリア」と誤認した経路を実飛行の弦判定が
     衝突と裁定する食い違いがあった。相対運動の線分で最接近を測って両者を一致させる */
  const segClrPts = (ps, pb, es, eb, sr, buf) => {
    const ax = ps.x - pb.x, ay = ps.y - pb.y, az = ps.z - pb.z;
    const dx = (es.x - eb.x) - ax, dy = (es.y - eb.y) - ay, dz = (es.z - eb.z) - az;
    const dd = dx * dx + dy * dy + dz * dz;
    let u = 0;
    if(dd > 1e-12) u = Math.max(0, Math.min(1, -(ax * dx + ay * dy + az * dz) / dd));
    const cx = ax + dx * u, cy = ay + dy * u, cz = az + dz * u;
    const d = Math.hypot(cx, cy, cz);
    /* 誘導側の余裕（buf）: 非目標天体については推定器の判定マージンより広く取って
       誘導する。予測と実飛行の数百単位の食い違いで「計画は安全・実飛行はマージン内
       侵入」にならないための堅牢化（判定側の impactMargin は不変）。
       目標天体そのものには付けない（接近末端の幾何は aimOff 側で担保する） */
    const clr = d - (sr + impactMargin(sr) + (buf || 0));
    if(clr < minClearance){
      minClearance = clr;
      tClear = curT;
      if(d > 1e-6) hazardDir = [cx / d, cy / d, cz / d];
    }
  };
  const segClr = (ps, pb, b, sr, buf) => segClrPts(ps, pb, s, b, sr, buf);
  let prevS = null, prevP = null;
  for(let tt = 0; tt <= lim;){
    /* ステップ下限（v0.6.1 #5）: 接近しない軌道では dynStep が極小になりステップ数が
       爆発するため、ステップ数に上限（約2400）を持たせる。下限は通常の接近局面の
       dynStep を下回る値に抑え、最接近の精度は落とさない（接近局面は encounterCap も担保）。
       2400 は精度（eco≤std の順序）と速度（命令評価のコスト）の実測バランス点。 */
    prevS = { x: s.x, y: s.y, z: s.z };
    if(pls) prevP = pls.map(p => ({ x: p.x, y: p.y, z: p.z }));
    let hh = Math.min(Math.max(dynStep(s.x, s.y, s.z, starGM, pls, cap), lim / 2400), encounterCap(s, t));
    if(pls) for(const p of pls){
      /* 天体近傍ではステップを絞り、線分判定の取りこぼし自体を減らす。
         相対速度ベースの上限に加え、重力の曲率ベースの上限（弦と弧の乖離が
         マージンの1割未満に収まる刻み）を課す。出発直後のように相対速度が
         ほぼ0でも、天体の重力で曲がる区間を正しく解像するため */
      const dP = Math.hypot(s.x - p.x, s.y - p.y, s.z - p.z);
      const relP = Math.hypot(s.vx - (p.vx || 0), s.vy - (p.vy || 0), s.vz - (p.vz || 0));
      if(relP > 0.05) hh = Math.min(hh, Math.max(2, 0.35 * dP / relP));
      const aP = (p.gm || 0) / Math.max(1, dP * dP);
      if(localRegime && aP > 1e-7) hh = Math.min(hh, Math.sqrt(300 / aP));
    }
    tt += hh; curT = tt;
    rk4StepState(s, hh, acc);
    if(pls){
      /* 惑星系はサブステップで進める（v0.6.2）: hh は自船の力学で決まり深宇宙では
         約2.5日に達するが、周期1.6日の衛星はその刻みでは位相が無相関になり、
         予測内の衛星位置がノイズ化して幽霊衝突（安全な候補の誤排除）を起こす
         （M1 std の推定が 36.7 → 71.8 に膨らんだ一因）。最速軌道の 1/100 以下に
         刻み、クリアランスもサブステップ単位で測る（自船位置は線形補間）。 */
      const capP = fastestOrbitCap(pls, starGM, hh, s.x, s.y, s.z);
      const nSubP = Math.min(200, Math.max(1, Math.ceil(hh / Math.max(1, capP))));
      const hs = hh / nSubP;
      let prevPk = prevP;
      for(let k = 0; k < nSubP; k++){
        rk4StepState(t, hs, accT);
        for(let i = 0; i < pls.length; i++){
          if(i === targetPlIdx){ pls[i].x = t.x; pls[i].y = t.y; pls[i].z = t.z; pls[i].vx = t.vx; pls[i].vy = t.vy; pls[i].vz = t.vz; }
          else rk4StepState(pls[i], hs, pls[i].isMoon ? accs[i] : sAcc);
        }
        if(prevPk){
          const f0 = k / nSubP, f1 = (k + 1) / nSubP;
          const ss0 = { x: prevS.x + (s.x - prevS.x) * f0, y: prevS.y + (s.y - prevS.y) * f0, z: prevS.z + (s.z - prevS.z) * f0 };
          const ss1 = { x: prevS.x + (s.x - prevS.x) * f1, y: prevS.y + (s.y - prevS.y) * f1, z: prevS.z + (s.z - prevS.z) * f1 };
          for(let i = 0; i < pls.length; i++) segClrPts(ss0, prevPk[i], ss1, pls[i], surfaceRadius(pls[i]), (i === targetPlIdx || !localRegime) ? 0 : 600);
        }
        prevPk = pls.map(p => ({ x: p.x, y: p.y, z: p.z }));
      }
      if(!prevP) for(const p of pls) checkClr(p.x, p.y, p.z, surfaceRadius(p));
    } else {
      rk4StepState(t, hh, accT);
    }
    if(prevS) segClr(prevS, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, STAR_SURFACE_R, localRegime ? 600 : 0);
    else checkClr(0, 0, 0, STAR_SURFACE_R);
    const d = Math.hypot(t.x - s.x, t.y - s.y, t.z - s.z);
    if(d < minDist){ minDist = d; tMin = tt; relAtMin = Math.hypot(s.vx - t.vx, s.vy - t.vy, s.vz - t.vz); missAtMin = [t.x - s.x, t.y - s.y, t.z - s.z]; }
    else if(d > minDist + Math.max(80, minDist * 0.2) && tt > tMin + 10) break;
  }
  return { minDist, tMin, relAtMin, miss: missAtMin, minClearance, hazardDir, tClear };
}
/* 港内出発のシミュレーション（v0.6.4、課題2）: 実飛行の港内航行
   （updateDepartureOps）は「錨の速度＋depSep×プロファイル速度」への速度追従
   操船で、錨中心から 80（バースの構造を離れる最小の分離）への到達で
   出域する。したがって本航行の
   実開始状態（出域時の位置・速度）は錨と目標の幾何で決まる湧出状態であり、
   単純なモデル状態（depSep×900・+3.2）で代用すると位相によって誘導の解の
   族が変わり、実消費が推定を大きく上回る（実測 Δ=240: 推定の初回噴射 23.4・
   巡航噴射ほぼ0 に対し、実勢は初回 11.2 の後に巡航の再噴射が累計 47）。
   そこで接舷出発の推定では、港内航行そのものを実飛行と同じ操船則で回し、
   出域状態・操船Δv・所要時間を実測と同じ規則で求めてから本航行の推定に
   入る。錨（＝接舷中の自艦と同状態）・天体は階層モデル（惑星＝恒星重力のみ、
   衛星・錨・自艦＝全重力）で進める。 */
function simulateHarborExit(ship, depSep, starGM, planetsRaw, md){
  const pls = (planetsRaw || []).map(p => ({ x: p.x, y: p.y, z: p.z, vx: p.vx, vy: p.vy, vz: p.vz, gm: p.gm, radius: p.radius || 7, dispR: p.dispR || 0, name: p.name || '', isMoon: !!p.isMoon }));
  const sAcc = starAccFn(starGM);
  const accs = pls.map((_, i) => accExcluding(starGM, pls, i));
  const accFull = fullAccFn(starGM, pls);
  /* マスドライバー出発（md 指定時）では、基準 a を錨中心の状態に置く
     （呼び出し側が md.anchor0 に中心スナップショットを渡す）。出口状態は
     a から公表式で決まるため、開始状態がバースでも中心でも推定は同じ
     出域点・出口速度に着地する */
  const a = (md && md.anchor0) ? { x: md.anchor0.x, y: md.anchor0.y, z: md.anchor0.z, vx: md.anchor0.vx, vy: md.anchor0.vy, vz: md.anchor0.vz }
    : { x: ship.x, y: ship.y, z: ship.z, vx: ship.vx, vy: ship.vy, vz: ship.vz };
  /* 錨が pls 内の天体そのものの場合（月の地表射出）、錨の伝播に全天体の
     加速度を使うと自分自身の重力（距離 0）で発散する。錨自身を除いた
     加速度で進める（ステーション錨は pls に無いため従来どおり） */
  const aIdx = (md && md.anchor0 && md.anchor0.name) ? pls.findIndex(p => p.name === md.anchor0.name) : -1;
  const aAcc = aIdx >= 0 ? accs[aIdx] : accFull;
  const s = { x: ship.x, y: ship.y, z: ship.z, vx: ship.vx, vy: ship.vy, vz: ship.vz };
  const h = 2;
  let t = 0, dvHarbor = 0;
  const steer = (tvx, tvy, tvz) => {
    const cx = tvx - s.vx, cy = tvy - s.vy, cz = tvz - s.vz;
    const mag = Math.hypot(cx, cy, cz);
    if(mag < 1e-6) return;
    const applied = Math.min(mag, 3.0 * h);
    const f = applied / mag;
    s.vx += cx * f; s.vy += cy * f; s.vz += cz * f;
    dvHarbor += applied;
  };
  /* 港内プロファイル（2026-11-19 組み直し、実飛行 updateDepartureOps と同一則）:
     バースは錨中心から depSep 方向に約60の位置にあり（ステーションの縁）、
     分離はそのまま同じ方向への直線移動になる。錨中心から 80（バースの構造を
     離れる最小の分離）まで、速度は「残距離で決まる上限（近くで緩む）」と
     「離舷直後の緩やかな立ち上がり」の小さい方。80 に達したら分離は完了で、
     本航行の噴射がそのまま始まる（「出域点まで移動してから出発」という
     二段構えは、2026-11-19 夜の本人指摘「最初の位置からそのまま行けるのに
     出域フィックスまで移動する謎の動きはいらない」で廃止。210→130→80）。
     出域時の相対速度は約0.5と小さく、本航行の計画はこの状態をそのまま
     引き継ぐ（横向きの速度をため込まない）。 */
  while(t < 600){
    for(let i = 0; i < pls.length; i++) rk4StepState(pls[i], h, pls[i].isMoon ? accs[i] : sAcc);
    rk4StepState(a, h, aAcc);
    rk4StepState(s, h, accFull);
    t += h;
    const distA = Math.hypot(s.x - a.x, s.y - a.y, s.z - a.z);
    const remain = Math.max(0, 80 - distA);
    const spd = Math.min(0.4 + t * 0.25, Math.max(0.5, Math.min(2.2, 0.5 + remain / 90)));
    steer(a.vx + depSep.x * spd, a.vy + depSep.y * spd, a.vz + depSep.z * spd);
    if(distA >= 80){
      if(md){
        /* 出口状態は港の公表値で固定（台帳#113）: 位置＝錨＋depSep×80、
           速度＝錨の速度＋depSep×公表出口速度。射出は港の設備のため
           港内 Δv は 0（従来の自力出発は dvHarbor を数え、両航路を残す）。
           地表射出（台帳#114/#116）では出口点が錨中心から depSep×80 では
           なく基地点＋射出方向×トラック長になるため、md.exitOffset が
           渡された場合はそのオフセット（錨中心相対）を出口点に使う */
        const off = md.exitOffset || { x: depSep.x * 80, y: depSep.y * 80, z: depSep.z * 80 };
        s.x = a.x + off.x; s.y = a.y + off.y; s.z = a.z + off.z;
        s.vx = a.vx + depSep.x * md.exitV; s.vy = a.vy + depSep.y * md.exitV; s.vz = a.vz + depSep.z * md.exitV;
        dvHarbor = 0;
      }
      break;
    }
  }
  return { state: s, dvHarbor, time: t };
}
/* 月地表の基地点（台帳#114）: 月の公転フレームで主星と反対側の地表点。
   位置は主星方向の単位ベクトル×表面半径、速度は剛体回転（ω×オフセット）。
   planets は状態スナップショット（伝播中の複製でもよい） */
function moonBasePointIn(moon, planets){
  const host = (planets || []).find(q => q.name === moon.moonOf) || null;
  const cx = host ? moon.x - host.x : moon.x, cy = host ? moon.y - host.y : moon.y, cz = host ? moon.z - host.z : moon.z;
  const rp = Math.hypot(cx, cy, cz) || 1;
  const R = { x: cx / rp, y: cy / rp, z: cz / rp };
  const sr = surfaceRadius(moon);
  const ox = R.x * sr, oy = R.y * sr, oz = R.z * sr;
  const rvx = host ? moon.vx - host.vx : moon.vx, rvy = host ? moon.vy - host.vy : moon.vy, rvz = host ? moon.vz - host.vz : moon.vz;
  const wx = (cy * rvz - cz * rvy) / (rp * rp), wy = (cz * rvx - cx * rvz) / (rp * rp), wz = (cx * rvy - cy * rvx) / (rp * rp);
  return {
    x: moon.x + ox, y: moon.y + oy, z: moon.z + oz,
    vx: moon.vx + (wy * oz - wz * oy), vy: moon.vy + (wz * ox - wx * oz), vz: moon.vz + (wx * oy - wy * ox)
  };
}
/* 降下の終端制動則（台帳#114）: 降下楕円の近点付近から基地点へ。
   希望速度＝基地の速度＋基地方向×許容速度で、許容速度は等減速プロファイル
   v(d) = √(2·a·d + v_end²)（a = 0.05、v_end = 0.8、上限 24）。地表 200 未満で
   中心へ向かう速度成分が過大な時は外向きへ逃がす（地形の安全帯）。
   返すのは希望速度との差分×0.85（上限 2.5）で、実噴射は呼び出し側が
   vector 命令として出す */
function computeDescent(ship, base, moon){
  const dx = base.x - ship.x, dy = base.y - ship.y, dz = base.z - ship.z;
  const dist = Math.hypot(dx, dy, dz);
  if(dist < 1e-6) return null;
  /* 終端のグライド: 基地そのものではなく、距離に応じて上空の点を狙う。
     球面の弦の沈み込み（半径 2,600 の球で 3,000 先の点への直行は中間で
     約 470 地表下へ切る）が主因で、上げ幅は弦の沈み＋60 を距離 800 まで
     満額、そこから線形に消す。40 以内では上げ幅 0＝基地へ直接 */
  const upx = base.x - moon.x, upy = base.y - moon.y, upz = base.z - moon.z;
  const ul = Math.hypot(upx, upy, upz) || 1;
  const surfR2 = surfaceRadius(moon);
  const half = Math.min(dist, 2 * surfR2) / 2;
  const dip = surfR2 - Math.sqrt(Math.max(0, surfR2 * surfR2 - half * half));
  const glide = dist > 40 ? Math.min(80, (dist - 40) * 0.18) : 0;
  const raise = Math.max(glide, (dip + 200) * Math.min(1, dist / 800)) * (dist > 40 ? 1 : 0);
  const ax = base.x + (upx / ul) * raise - ship.x, ay = base.y + (upy / ul) * raise - ship.y, az = base.z + (upz / ul) * raise - ship.z;
  const ad = Math.hypot(ax, ay, az) || 1;
  /* 許容速度は残り距離のプロファイルと高度クランプの小さい方（2026-11-20）:
     低高度では横方向の距離を根拠に速い接近を許すと、粗いサンプリングの
     間に沈み込みが間に合わず地表を割る（実測）。高度 100 で約 4.5、
     高度 20 で約 2.5 に制限される */
  const altV = Math.hypot(ship.x - moon.x, ship.y - moon.y, ship.z - moon.z) - surfR2;
  const vAllow = Math.min(24, Math.sqrt(2 * 0.05 * dist + 0.64), Math.sqrt(2 * 0.07 * Math.max(0, altV)) + 0.8);
  let dvx0 = base.vx + (ax / ad) * vAllow - ship.vx;
  let dvy0 = base.vy + (ay / ad) * vAllow - ship.vy;
  let dvz0 = base.vz + (az / ad) * vAllow - ship.vz;
  const dcx = ship.x - moon.x, dcy = ship.y - moon.y, dcz = ship.z - moon.z;
  const dc = Math.hypot(dcx, dcy, dcz) || 1;
  const alt = dc - surfaceRadius(moon);
  if(alt < 200){
    const ux = dcx / dc, uy = dcy / dc, uz = dcz / dc;
    const vRad = (ship.vx - moon.vx) * ux + (ship.vy - moon.vy) * uy + (ship.vz - moon.vz) * uz;
    if(vRad < -1.5){ const push = (-vRad - 1.5) * 0.9; dvx0 += ux * push; dvy0 += uy * push; dvz0 += uz * push; }
  }
  const mag = Math.hypot(dvx0, dvy0, dvz0);
  if(mag < 0.05) return null;
  /* 上限 3.5・係数 0.9: 2.5/0.85 では速度制御に噴射枠を使い切り、重力サグ
     分の経路補正が残らず地表へ沈んだ（独立 sim 実測） */
  const f = Math.min(1, 3.5 / mag) * 0.9;
  return { dvx: dvx0 * f, dvy: dvy0 * f, dvz: dvz0 * f, cost: mag * f, dist };
}
/* 降下目標照準（台帳#114）: 捕捉軌道から地表基地への降下楕円を 1 回の
   逆行噴射で作る探索。変数は「今からの待ち時間 τ」と「噴射の大きさ m」。
   候補ごとに実飛行と同じ積分規律で伝播し、到着時刻の基地点への最接近
   （線分最小距離）とその時の相対速度で採点する。最良候補のまわりで
   1 段だけ細かく再探索する。戻り値の totalEst（m＋到着相対速度）が
   そのまま降下レグの Δv 見積もりになる */
function findDescentBurn(ship, moon, planetsRaw, starGM, tNow){
  if(!moon || !(moon.gm > 0)) return null;
  const pls0 = (planetsRaw || []).map(p => ({ x: p.x, y: p.y, z: p.z, vx: p.vx, vy: p.vy, vz: p.vz, gm: p.gm, radius: p.radius || 7, dispR: p.dispR || 0, name: p.name || '', isMoon: !!p.isMoon, moonOf: p.moonOf || null }));
  const mIdx = pls0.findIndex(p => p.name === moon.name);
  if(mIdx < 0) return null;
  const srT = surfaceRadius(pls0[mIdx]);
  const eulerStep = (b, h, accFn) => { const a = accFn(b.x, b.y, b.z); b.vx += a[0] * h; b.vy += a[1] * h; b.vz += a[2] * h; b.x += b.vx * h; b.y += b.vy * h; b.z += b.vz * h; };
  function propagate(s, pls, seconds, track, tOff0){
    const sAcc = starAccFn(starGM);
    const accs = pls.map((_, i) => accExcluding(starGM, pls, i));
    const accFull = fullAccFn(starGM, pls);
    let tt = 0, guard = 0, best = null, lastBaseDist = Infinity, minDc = Infinity;
    let prevS = { x: s.x, y: s.y, z: s.z }, prevB = track ? moonBasePointIn(pls[mIdx], pls) : null;
    /* 照準点は基地の真上 600（2026-11-20 改定）: 弾道楕円は地表の点でなく
       上空の点に接し、最後の 600 は終端制動が受け持つ。地表すれすれの
       楕円は積分刻みの差で地表を割る（実ページ・粗刻み sim で実測） */
    const aimOf = (bp, mc) => { const ux = bp.x - mc.x, uy = bp.y - mc.y, uz = bp.z - mc.z; const ul = Math.hypot(ux, uy, uz) || 1; return { x: bp.x + ux / ul * 600, y: bp.y + uy / ul * 600, z: bp.z + uz / ul * 600 }; };
    let prevA = track ? aimOf(prevB, pls[mIdx]) : null;
    while(tt < seconds){
      if(++guard > 200000) break;
      const dNear = Math.hypot(s.x - pls[mIdx].x, s.y - pls[mIdx].y, s.z - pls[mIdx].z);
      /* 刻みは実飛行の physics() と同じ規律に揃える（目標近傍 20 秒／遠方
         120 秒、dynStep の上限は physics と同じ 0.75×SCALE_K）。細かい刻み
         （2 秒）で照準すると、実飛行の粗い積分では楕円が別物になり、
         実ページで地表衝突した（2026-11-20 実測）。判定・照準は守る対象の
         世界と同じモデルで測る——捕捉安定確認と同じ原則 */
      const h = Math.max(2, Math.min(dynStep(s.x, s.y, s.z, starGM, pls, 0.75 * SCALE_K), dNear < 300000 ? 20 : 120, seconds - tt));
      if(!(h > 0)) break;
      for(let i = 0; i < pls.length; i++){ if(pls[i].isMoon) eulerStep(pls[i], h, accs[i]); else rk4StepState(pls[i], h, sAcc); }
      eulerStep(s, h, accFull);
      tt += h;
      if(track){
        const bp = moonBasePointIn(pls[mIdx], pls);
        const aim = aimOf(bp, pls[mIdx]);
        const mx = (prevA.x + aim.x) / 2, my = (prevA.y + aim.y) / 2, mz = (prevA.z + aim.z) / 2;
        const sx = s.x - prevS.x, sy = s.y - prevS.y, sz = s.z - prevS.z;
        const len2 = sx * sx + sy * sy + sz * sz;
        const u = len2 > 1e-12 ? Math.max(0, Math.min(1, -((prevS.x - mx) * sx + (prevS.y - my) * sy + (prevS.z - mz) * sz) / len2)) : 0;
        const d = Math.hypot(prevS.x + sx * u - mx, prevS.y + sy * u - my, prevS.z + sz * u - mz);
        if(!best || d < best.miss){
          const rel = Math.hypot(s.vx - bp.vx, s.vy - bp.vy, s.vz - bp.vz);
          best = { miss: d, arrRel: rel, arrT: tNow + tOff0 + tt - h + h * u };
        }
        lastBaseDist = Math.hypot(s.x - aim.x, s.y - aim.y, s.z - aim.z);
        const dc = Math.hypot(s.x - pls[mIdx].x, s.y - pls[mIdx].y, s.z - pls[mIdx].z);
        /* 最低高度はステップ端点でなく区間の弦の最接近で測る: 粗い刻みの
           端点だけ見ると、ステップ間の一番深い沈みを取りこぼす（実測で
           ゲート 2,900 に対し実飛行 2,531 まで沈んだ）。また照準点まで
           3,000 以内は終端制動の担当域としてゲートから外す（低い軌道から
           の降下では、制動圏の手前で 300 の余裕を保てない候補しかない） */
        if(lastBaseDist > 3000){
          const cx = pls[mIdx].x, cy = pls[mIdx].y, cz = pls[mIdx].z;
          const mx2 = (prevS.x + s.x) / 2 - cx, my2 = (prevS.y + s.y) / 2 - cy, mz2 = (prevS.z + s.z) / 2 - cz;
          const segDc = Math.hypot(mx2, my2, mz2) - Math.hypot(s.x - prevS.x, s.y - prevS.y, s.z - prevS.z) / 2;
          if(segDc < minDc) minDc = segDc;
          if(dc < minDc) minDc = dc;
        }
        prevS = { x: s.x, y: s.y, z: s.z }; prevB = bp; prevA = aim;
        if(dc < srT + 1) break;
        if(best && tt > 1200 && lastBaseDist > best.miss + 800) break;
      }
    }
    return track ? { best, minDc } : best;
  }
  function evaluate(waitS, m){
    const pls = pls0.map(p => ({ ...p }));
    const s = { x: ship.x, y: ship.y, z: ship.z, vx: ship.vx, vy: ship.vy, vz: ship.vz };
    if(waitS > 0) propagate(s, pls, waitS, false, 0);
    /* 逆行は月相対の運動に対する逆行（慣性系の速度で引くと主星まわりの
       公転成分を消してしまい、月の周回軌道から外れる） */
    const mv = pls[mIdx];
    const rvx = s.vx - mv.vx, rvy = s.vy - mv.vy, rvz = s.vz - mv.vz;
    const sp = Math.hypot(rvx, rvy, rvz) || 1;
    const burn = { x: -rvx / sp * m, y: -rvy / sp * m, z: -rvz / sp * m };
    s.vx += burn.x; s.vy += burn.y; s.vz += burn.z;
    const res = propagate(s, pls, 9000, true, waitS);
    const best = res && res.best;
    if(!best) return null;
    /* 弾道区間の最低高度はハードゲート（地表＋300 未満は採用しない）:
       ソフトな罰点では「小さな miss と引き換えのすれすれ楕円」が勝ち、
       実飛行の積分差で地表を割った（2026-11-20 実測）。全滅の場合は
       null を返して軌道待機に留まるのが正直な振る舞い */
    const minDc = isFinite(res.minDc) ? res.minDc : srT + 300;
    if(minDc < srT + 300) return { waitS, m, burn, miss: best.miss, arrRel: best.arrRel, arrT: best.arrT, score: 1e7 + (srT + 300 - minDc) * 100, gated: true };
    const score = best.miss + Math.max(0, best.arrRel - 18) * 25;
    return { waitS, m, burn, miss: best.miss, arrRel: best.arrRel, arrT: best.arrT, score };
  }
  const r0 = Math.hypot(ship.x - moon.x, ship.y - moon.y, ship.z - moon.z);
  const period = 2 * Math.PI * Math.sqrt(Math.pow(Math.max(r0, srT + 100), 3) / moon.gm);
  let best = null;
  const mags = [0.5, 1.25, 2.0, 2.75, 3.5];
  for(let k = 0; k < 16; k++){
    const w = period * k / 16;
    for(const m of mags){ const r = evaluate(w, m); if(r && (!best || r.score < best.score)) best = r; }
  }
  if(!best || best.gated) return null;
  const wStep = period / 16, mStep = 0.75;
  for(const dw of [-wStep / 2, wStep / 2]){
    for(const dm of [-mStep / 2, mStep / 2]){
      const w = best.waitS + dw, m = best.m + dm;
      if(w < 0 || m < 0.2) continue;
      const r = evaluate(w, m); if(r && r.score < best.score) best = r;
    }
  }
  if(best.miss > 1500) return null; /* 実行側の却下基準と同値（照準が遠い案は案でない） */
  /* totalEst は見積もり用: 終端制動の実績は（照準噴射＋到着相対速度）の
     約 2.6 倍（高度クランプ導入後の実測: 係数 1.8〜2.9、形状でばらつく。
     独立 sim・実系・通常フレーム刻みで全形状着陸時の合計 43〜57） */
  return { waitS: best.waitS, dvx: best.burn.x, dvy: best.burn.y, dvz: best.burn.z, cost: best.m, miss: best.miss, arrRel: best.arrRel, arrT: best.arrT, totalEst: (best.m + best.arrRel) * 2.6 };
}
function createPlanEstimateJob(ship, target, starGM, closingScale, opts){
  // The estimate flies the SAME phase policy as the real plan execution
  // (depart/cruise -> brake -> captain match -> join -> final), with
  // instantaneous burns, so the numbers it quotes are the numbers the
  // flown plan will actually spend (approximately, honestly derived).
  const o = opts || {};
  const arrivalDist = o.arrivalDist != null ? o.arrivalDist : 12;
  /* 出発母港のスナップショット（2026-11-19）: 初回噴射のクリアランス判定に使う */
  const depAnchor = o.depAnchor ? { x: o.depAnchor.x, y: o.depAnchor.y, z: o.depAnchor.z, vx: o.depAnchor.vx, vy: o.depAnchor.vy, vz: o.depAnchor.vz } : null;
  const depAnchorName = o.depAnchor ? (o.depAnchor.name || null) : null;
  const needDock = o.needDock !== false;
  const scale = closingScale || 1.0;
  const kScale = typeof SCALE_K !== 'undefined' ? SCALE_K : 386700;
  const BIG = 0.75 * kScale;
  const s = { x: ship.x, y: ship.y, z: ship.z, vx: ship.vx, vy: ship.vy, vz: ship.vz };
  let dvHarbor = 0, harborTime = 0;
  if(o.depSep){ /* v0.6.4: 接舷出発は港内航行を実操船則で回し、出域状態から始める（下記注記） */
    const har = simulateHarborExit(ship, o.depSep, starGM, o.planets, o.mdExitV != null ? { exitV: o.mdExitV, anchor0: o.depAnchor || null, exitOffset: o.mdExitOffset || null } : null);
    s.x = har.state.x; s.y = har.state.y; s.z = har.state.z;
    s.vx = har.state.vx; s.vy = har.state.vy; s.vz = har.state.vz;
    dvHarbor = har.dvHarbor; harborTime = har.time;
  }
  /* 接舷状態からの推定は接舷状態のまま始める（v0.6.2 で方針変更）: 以前は
     港内出発の終了状態（depSep×850 先・+3 の速度）を開始状態にしていたが、
     港内出発の幾何そのものが直った（目標ブレンドのレーン＋速度プロファイルで
     出域時は約+3・目標側）結果、その開始状態モデルが推定器内部の誘導を
     実飛行と違う振る舞いにし、eco の推定が 16.9 → 44.5 に膨らんだ（Tier 1
     微修正のリミットサイクル＋遅い大修正）。実測では実飛行 std の消費
     （約27.6、港内込み）が接舷開始モデル＋港内見込み（16.5＋11）と一致する。
     港内操船の消費はパネル側で HARBOR_STEER_DV として別途見込む。

     【v0.6.4 で開始状態モデルを出域状態へ戻す】上記の一致は位相 Δ=0 の話で、
     位相が悪いと接舷開始モデルは「実在しない安い航路」を見つけてしまう。
     実測（v0.6.3・出域開始で推定器を回した対照実験）:
       Δ=180: 接舷開始の推定は初回噴射 1.0＋微修正で計 20.0（成立扱い）だが、
              実飛行は初回 28.87→枯渇・未到着。出域開始では初回 29.07・
              修正 0.6／0.6 と実績に一致し、推定自体も不成立（ok:false）に倒れる。
       Δ=270: 接舷開始 計 16.7（成立扱い）／実績は初回 25.86＋捕捉 25.0。
              出域開始は初回 25.90・捕捉 26.9 で実績に一致。
     実飛行の誘導は港内出発の終了状態から計算される以上、推定も同じ状態から
     始めないと「承認した計画が実は枯渇する」事故（#48 の同型）を防げない。
     o.depSep が無い呼び出し（飛行中の再推定・非接舷の出発）は現在状態から
     始める（従来どおり）。
     【同日追補】出域状態の近似（depSep×900・+3.2）でも Δ=240 で実勢と解の
     族が食い違った（推定 初回 23.4＋捕捉 25.7＝49.1 に対し実勢は初回 11.2 の
     後に巡航再噴射 累計47、到着時残量 0.3）。出域状態は港内操船の湧出状態で
     近似では族が変わるため、開始状態は simulateHarborExit（実操船則の
     シミュレーション）で求める。操船Δv は dvHarbor として別建てで返し、
     パネル側の見込み（従来の固定 HARBOR_STEER_DV）もこの実測値で置き換える。 */
  /* 目標のクローンには本体属性（dispR＝表面半径・名前）も持たせる（v0.6.2）。
     状態だけのクローンだと computeApproach 側の surfaceRadius が既定値 7 に
     落ち、狙点オフセット（aimOff）が 0 ＝中心狙いになり、推定シムと実飛行で
     誘導の狙いが食い違っていた（精密インターセプトが中心を狙う推定側だけ
     際どい通過を量産した）。実飛行と同じ狙いで推定する。 */
  const t = { x: target.x, y: target.y, z: target.z, vx: target.vx, vy: target.vy, vz: target.vz, dispR: target.dispR, radius: target.radius, name: target.name, isMoon: !!target.isMoon, gm: target.gm || 0 };
  let h = 0.25; const maxT = 1500 * kScale;
  const initialDist = Math.hypot(t.x - s.x, t.y - s.y, t.z - s.z);
  let sampleStride = Math.max(2, initialDist / 2000);
  let dvTotal = 0, dvCruise = 0, dvGravityComp = 0, timeTotal = 0, nextSampleT = sampleStride;
  timeTotal += harborTime; /* 港内航行の所要時間も計画の所要時間に含める（v0.6.4） */
  const samples = [[s.x, s.y, s.z]];
  /* サンプルの実時刻（2026-11-19）: サンプルはシミュレーションの刻み境界で
     採取され、刻み幅は巡航で最大約6時間まで粗くなるため、採取時刻は等間隔に
     ならない。従来は採取時刻を保持せず、利用側（航路表示・計画追従）が等間隔
     前提で再構成していたため、基準軌道の位相が実軌道と系統的にずれていた。
     採取した timeTotal をそのまま対で保持する（間引きも対で同じ規則）。 */
  const sampleTimes = [timeTotal];
  let established = false;
  let phase = 'cruise', checkTimer = 0, actCd = 0;
  let capDone = false, capT = 0; /* 到着時の捕捉（安定な終了状態）の実施と確認 */
  let lastCapTryT = -1e9; /* 捕捉の安定確認（120時間伝播）の試行ケイデンス（v0.6.4 課題3） */
  let lastZoneFixT = -1e9; /* 到着圏の立て直し噴射のケイデンス（v0.6.4: 実飛行の終端誘導は
     15〜20秒間隔で判断するため、推定側も毎ステップ噴射しない。毎ステップ直すと
     圏内でのみ存在する噴射カスケードが推定を膨らませる） */
  /* 推定の ok の意味（v0.6.2 で統一）: 「表面に当たらず完走するか」。
     擦過（表面＋マージンの内側への接近）は impactRisk として報告し、承認可否は
     パネル側の安全判定（isVarSafe）が担う。旧基準は擦過でも ok:false になり、
     捕捉軌道からの出発（自軌道の近点が擦過域にある）だけで帰投推定が
     全滅した（実測: 完走するのに ok:false、dv 42.8）。 */
  const approachCtx = { patienceLeft: 30 }; /* 井戸内の忍耐（computeApproach の ctx） */
  const pls = (o.planets || []).map(p => ({ x: p.x, y: p.y, z: p.z, vx: p.vx, vy: p.vy, vz: p.vz, gm: p.gm, radius: p.radius || 7, dispR: p.dispR || 0, name: p.name || '', isMoon: !!p.isMoon }));
  const plsT = pls.filter(p => Math.hypot(p.x - t.x, p.y - t.y, p.z - t.z) > 1);
  const targetPlIdx = pls.findIndex(p => Math.hypot(p.x - t.x, p.y - t.y, p.z - t.z) <= 1);
  const starBody = { x: 0, y: 0, z: 0, isStar: true, name: '恒星' };
  const segMinDist = (ax0, ay0, az0, bx0, by0, bz0) => {
    const dx = bx0 - ax0, dy = by0 - ay0, dz = bz0 - az0;
    const len2 = dx * dx + dy * dy + dz * dz;
    const u = len2 > 1e-12 ? Math.max(0, Math.min(1, -(ax0 * dx + ay0 * dy + az0 * dz) / len2)) : 0;
    return Math.hypot(ax0 + dx * u, ay0 + dy * u, az0 + dz * u);
  };
  /* 実飛行積分器の双子モード（v0.6.4 課題2）: opts.integrator === 'euler' の時、
     自船・目標・衛星の伝播を実飛行の stepBody と同じ半陰的オイラー＋同じ刻み上限
     （目標まで 300,000 以内は 20 秒、それ以外は 120 秒）に切り替える。誘導判断
     （computeApproach 内の RK4 予測）は実飛行でも RK4 なので、そのまま使う。
     迎撃が「際どい通過」の位相では、積分器の刻み列の違いだけで捕捉できる分岐と
     高くつく再接近分岐が入れ替わる（実測: 同一軌道で推定 26〜75 のばらつき）。
     RK4 のみの推定は安い分岐だけを見て承認し、実飛行が枯渇する事故になるため、
     パネルの成立判定は両分岐のアンサンブル（悪い方）で見る。 */
  const eulerTwin = o.integrator === 'euler';
  const eulerStepTwin = (b, hh, accFn) => {
    const dT = Math.hypot(s.x - t.x, s.y - t.y, s.z - t.z);
    const capE = dT < 300000 ? 20 : 120;
    const nE = Math.min(2000, Math.max(1, Math.ceil(hh / capE)));
    const he = hh / nE;
    for(let k = 0; k < nE; k++){
      const a = accFn(b.x, b.y, b.z);
      b.vx += a[0] * he; b.vy += a[1] * he; b.vz += a[2] * he;
      b.x += b.vx * he; b.y += b.vy * he; b.z += b.vz * he;
    }
  };
  const propStar = () => {
    /* 天体の伝播は階層モデル（v0.6.2 で全経路に統一）: 惑星は恒星重力のみ
       （ケプラー軌道＝刻みに依らず全ての予測器が一致する）、衛星は全重力
       （母惑星の重力が働かないと脱出する＝#50 の真因）、自船・目標は全重力。
       旧推定器は目標以外の天体を恒星重力だけで進めていたため衛星の予測位置が
       数時間でずれ帰投推定が爆発した。逆に惑星まで全重力にすると、惑星同士の
       摂動で積分器ごとに惑星位置が発散し、迎撃精度が壊れて長距離推定が
       膨らむ（M1 std 36.7 → 71.8 の実測）。惑星をレールに固定するのが両立点。
       さらに惑星系は自船より細かく刻む: 自船の刻み h は巡航ケイデンス
       （最大 約6時間）まで粗くなるが、それでは周期1.6日の衛星の位相が
       数日で無相関になる。最速の軌道周期の 1/100 以下に刻みを制限する。 */
    const acc = fullAccFn(starGM, pls);
    const accT = fullAccFn(starGM, plsT);
    const sAccEst = starAccFn(starGM);
    const accs = pls.map((_, i) => accExcluding(starGM, pls, i));
    let capP = h;
    for(const p of pls){
      let bGm = starGM, bD = Math.hypot(p.x, p.y, p.z);
      for(const q of pls){ if(q !== p && q.gm > 0){ const d = Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z); if(d > 1 && q.gm / (d * d) > bGm / Math.max(1, bD * bD)){ bGm = q.gm; bD = d; } } }
      if(bGm > 0 && bD > 0) capP = Math.min(capP, Math.max(20, 2 * Math.PI * Math.sqrt(Math.pow(bD, 3) / bGm) * 0.01));
    }
    const nSub = Math.min(400, Math.max(1, Math.ceil(h / Math.max(1, capP))));
    const hs = h / nSub;
    for(let k = 0; k < nSub; k++){
      if(eulerTwin){
        eulerStepTwin(s, hs, acc);
        eulerStepTwin(t, hs, accT);
      } else {
        rk4StepState(s, hs, acc);
        rk4StepState(t, hs, accT);
      }
      for(let i = 0; i < pls.length; i++){
        if(i === targetPlIdx){ pls[i].x = t.x; pls[i].y = t.y; pls[i].z = t.z; pls[i].vx = t.vx; pls[i].vy = t.vy; pls[i].vz = t.vz; }
        else if(eulerTwin && pls[i].isMoon) eulerStepTwin(pls[i], hs, accs[i]);
        else rk4StepState(pls[i], hs, pls[i].isMoon ? accs[i] : sAccEst);
      }
    }
  };
  /* 初回噴射の母港クリアランス（2026-11-19）: 推定器の誘導は出発母港
     （ステーション）を障害物として知らないため、目標が母港の背後に回る位相
     では初回噴射が母港を貫く航路を選びうる（実飛行では衝突として裁定され、
     出発直後に計画ごと失われる事故を実測: 最接近 28.5 < 衝突半径 40）。
     初回噴射の適用前に、噴射後の滑空が母港から安全距離（KEEP）を保つか
     予測で確認し、割り込む場合は噴射後の速度ベクトルを母港から離す向きへ
     最小限だけ回して回避する。大きさ（Δv コスト）は変えないため、推定の
     収支はそのまま実飛行に一致する。 */
  /* 出発噴射の対錨最接近（最終的に選ばれた噴射について）。fin() で impactRisk
     へ統合され、KEEP 未満なら案そのものが不成立になる（2026-11-20 #122:
     従来は回転フォールバックが「一番マシな危険案」を黙って返し、最接近
     約 10 の計画が承認・実行されてステーションに衝突した。錨は pls に
     含まれず recordBody の対象外だったため、impactRisk にも載らなかった） */
  let departClearMin = null;
  const departClearBurn = (d) => {
    const aBody = depAnchorName ? pls.find(p => p.name === depAnchorName) : null;
    const KEEP = (aBody && surfaceRadius(aBody) > 100) ? surfaceRadius(aBody) + 15 : 200, HORIZON = 900; /* 小錨（ステーション等）の KEEP は 55→200（2026-11-21 #137: 実飛行は出発噴射の幾何ずれで推定軌道から最大 ~460 逸れるため、衝突半径 40＋初期ずれ許容 ~160 を見込む。届かなければ遅延・回転でも届かず、案は窓待ちへ倒れる＝#90/#122 の設計どおり） */
    if(Math.hypot(depAnchor.x - s.x, depAnchor.y - s.y, depAnchor.z - s.z) > 3000) return d;
    /* 錨が pls 内の天体なら、錨の伝播は自身の重力を除く（地表射出の錨＝月） */
    const aIdx2 = depAnchorName ? pls.findIndex(p => p.name === depAnchorName) : -1;
    const acc = aIdx2 >= 0 ? accExcluding(starGM, pls, aIdx2) : fullAccFn(starGM, pls);
    /* 錨を指定時刻まで進めた状態 */
    const anchorAt = (epochT) => {
      const pa = { x: depAnchor.x, y: depAnchor.y, z: depAnchor.z, vx: depAnchor.vx, vy: depAnchor.vy, vz: depAnchor.vz };
      let tA = 0; while(tA < epochT){ const hh = Math.min(20, epochT - tA); rk4StepState(pa, hh, acc); tA += hh; }
      return pa;
    };
    /* 与えた船状態・時刻から噴射した場合の、錨への最接近（900秒地平）。
       刻みは錨に近いほど細かくする: 相対速度 10 級の横断を 15 秒刻みで測ると
       最接近を最大で数十ほど過大評価し、危険な案が KEEP を通ってしまう */
    const probeAt = (shipSt, epochT, dvx, dvy, dvz) => {
      const ps = { x: shipSt.x, y: shipSt.y, z: shipSt.z, vx: shipSt.vx + dvx, vy: shipSt.vy + dvy, vz: shipSt.vz + dvz };
      const pa = anchorAt(epochT);
      let minD = Math.hypot(ps.x - pa.x, ps.y - pa.y, ps.z - pa.z);
      let tE = 0;
      while(tE < HORIZON){
        const hh = minD < 300 ? 3 : 15;
        rk4StepState(ps, hh, acc); rk4StepState(pa, hh, acc); tE += hh;
        const dd = Math.hypot(ps.x - pa.x, ps.y - pa.y, ps.z - pa.z);
        if(dd < minD) minD = dd;
      }
      return minD;
    };
    const probe = (dvx, dvy, dvz) => probeAt(s, timeTotal, dvx, dvy, dvz);
    const md0 = probe(d.dvx, d.dvy, d.dvz);
    if(md0 >= KEEP){ departClearMin = md0; return d; }
    /* 遅延を回転に優先する（2026-11-19）: 噴射ベクトルを回転させると迎撃の
       前提そのものが壊れ、推定が「目標を素通り→周回して戻る」劣化計画に化ける
       （実測: 回転 0.28 rad の案が会議で選ばれ、実飛行は到着圏を素通りするか
       推進剤を使い切った）。同じベクトルのまま、分離ドリフトで滑空して航路が
       錨を自然に避ける時刻まで噴射を遅らせる方が、迎撃を保ったまま安全になる。
       滑空の確定はこのジョブの世界（自船・目標・惑星）を propStar でそのまま
       進めて行うため、サンプル列・時刻列は一貫したままになる。遅延区間の
       recordBody（擦過台帳）だけは付かないが、分離直後の開けた宙域であり、
       対象の錨は pls に含まれないため実害はない。 */
    for(const tau of [60, 120, 240, 480, 900, 1500]){
      if(timeTotal + tau > 1750) break; /* 実飛行のコミット噴射ゲート（atT ≤ 1800）に収める */
      const cs = { x: s.x, y: s.y, z: s.z, vx: s.vx, vy: s.vy, vz: s.vz };
      let tc = 0; while(tc < tau){ const hh = Math.min(20, tau - tc); rk4StepState(cs, hh, acc); tc += hh; }
      const mdTau = probeAt(cs, timeTotal + tau, d.dvx, d.dvy, d.dvz);
      if(mdTau >= KEEP){
        departClearMin = mdTau;
        const savedH = h; let doneTau = 0;
        while(doneTau < tau){ const chunk = Math.min(120, tau - doneTau); h = chunk; propStar(); timeTotal += chunk; doneTau += chunk; }
        h = savedH;
        return d;
      }
    }
    const pa0 = anchorAt(timeTotal);
    /* 回転軸: （錨方向）×（噴射後速度）。この軸回りの回転が最接近を最も素直に広げる */
    const rx = pa0.x - s.x, ry = pa0.y - s.y, rz = pa0.z - s.z;
    const wx = s.vx + d.dvx, wy = s.vy + d.dvy, wz = s.vz + d.dvz;
    let nx = ry * wz - rz * wy, ny = rz * wx - rx * wz, nz = rx * wy - ry * wx;
    let nm = Math.hypot(nx, ny, nz);
    if(nm < 1e-9){
      const axv = Math.abs(wx) < 0.9 ? [1, 0, 0] : [0, 1, 0];
      nx = axv[1] * wz - axv[2] * wy; ny = axv[2] * wx - axv[0] * wz; nz = axv[0] * wy - axv[1] * wx;
      nm = Math.hypot(nx, ny, nz) || 1;
    }
    nx /= nm; ny /= nm; nz /= nm;
    const rot = (vx, vy, vz, th) => {
      const c = Math.cos(th), sn = Math.sin(th), ic = 1 - c;
      const dot = nx * vx + ny * vy + nz * vz;
      return [
        vx * c + (ny * vz - nz * vy) * sn + nx * dot * ic,
        vy * c + (nz * vx - nx * vz) * sn + ny * dot * ic,
        vz * c + (nx * vy - ny * vx) * sn + nz * dot * ic
      ];
    };
    let best = null, bestMin = -Infinity;
    for(const th of [0.03, 0.06, 0.10, 0.15, 0.21, 0.28, 0.36]){
      for(const sg of [1, -1]){
        const rv = rot(wx, wy, wz, sg * th);
        let cvx = rv[0] - s.vx, cvy = rv[1] - s.vy, cvz = rv[2] - s.vz;
        const cm = Math.hypot(cvx, cvy, cvz);
        if(cm < 1e-9) continue;
        const f = d.cost / cm;
        cvx *= f; cvy *= f; cvz *= f;
        const md = probe(cvx, cvy, cvz);
        if(md > bestMin){ bestMin = md; best = { dvx: cvx, dvy: cvy, dvz: cvz, cost: d.cost }; }
        if(md >= KEEP){ departClearMin = md; return best; }
      }
    }
    /* ここに来るのは「どの手でも KEEP に届かなかった」場合。選ばれた噴射の
       最接近を記録し、fin() 経由で案を不成立にする（黙って飛ばさない） */
    departClearMin = best ? bestMin : md0;
    return best || d;
  };
  const applyDv = d => {
    if(!d) return;
    if(firstBurn === null && depAnchor && d.cost > 0.001) d = departClearBurn(d);
    s.vx += d.dvx; s.vy += d.dvy; s.vz += d.dvz;
    dvTotal += d.cost;
    /* 計画の噴射は予定表として記録する（2026-11-19）: 実飛行はサンプルの弦を
       追うのではなく、この噴射列を時刻どおりに実行して計画そのものを飛ぶ */
    if(d.cost > 0.01) burns.push({ t: timeTotal, dvx: d.dvx, dvy: d.dvy, dvz: d.dvz, cost: d.cost });
    if(phase === 'cruise') dvCruise += d.cost;
    if(d.cost > 0 && inVicinityOf(s, pls)) dvGravityComp += d.cost;
    if(firstBurn === null && d.cost > 0.001){ firstBurn = d.cost; firstBurnVec = { dvx: d.dvx, dvy: d.dvy, dvz: d.dvz, cost: d.cost }; firstBurnT = timeTotal; }
    phaseDv[phase] = (phaseDv[phase] || 0) + d.cost;
  };
  const split = rel => ({ dvDepart: dvCruise, dvArrival: dvTotal - dvCruise, dvGravityComp, finalRel: rel });
  let firstBurn = null, firstBurnVec = null, firstBurnT = null;
  const burns = [];
  const phaseDv = {}, phaseT0 = {};
  const mkLegs = () => {
    const order = ['cruise', 'brake', 'captain', 'join', 'final'];
    const seen = order.filter(p => phaseT0[p] !== undefined);
    return seen.map((p, i) => ({ phase: p, t0: phaseT0[p], t1: (i + 1 < seen.length ? phaseT0[seen[i + 1]] : timeTotal), dv: phaseDv[p] || 0 }));
  };
  const fin = rel => {
    /* 出発噴射の対錨最接近を impactRisk へ統合する（#122）。錨（ステーション等、
       衝突半径 40）への最接近が安全側 55 未満なら、案の安全判定が落ちて
       会議・窓の仕組みが次の窓や他案へ倒れる。bestRisk は最小高度の記録なので
       錨の高度（最接近 − 40）がそれより小さい時だけ差し替える */
    if(departClearMin != null){
      const aSurf = anchorBody ? surfaceRadius(anchorBody) : 40;
      const altA = departClearMin - aSurf;
      if(!bestRisk || altA < bestRisk.minDist - bestRisk.surfaceR){
        bestRisk = { body: depAnchorName || '出発地', minDist: departClearMin, surfaceR: aSurf, margin: aSurf > 100 ? 15 : 160 }; /* 小錨は departClearBurn の KEEP 200 と一致させる（margin = KEEP − 表面半径）。これで承認可否（minDist < surfaceR + margin で不成立）が KEEP 判定と揃う */
        bestAlt = altA;
      }
    }
    return Object.assign(split(rel), { legs: mkLegs(), firstBurn: firstBurn || 0, firstBurnVec, firstBurnT, impactRisk: bestRisk, dvHarbor, harborTime, mdUse: (o.mdExitV != null && !!o.depSep), sampleTimes, burns });
  };
  let planetCross = false, surfaceHit = false, bestRisk = null, bestAlt = Infinity;
  let hitCount = 0, crossCount = 0, capHitBase = 0, capCrossBase = 0;
  /* 推定の暴走ガード（v0.6.1 #5）: シミュレーション上の艦が天体に捕捉される軌道に入ると、
     ステップが極小のまま maxT（5.8億秒）まで回り続け、実測で135秒の同期ブロックになった。
     反復回数と実時間に上限を設け、超過したら「情報なし（timeout）」として打ち切る。
     通常の推定（桁違いに少ない反復で完走する）は影響を受けない。 */
  /* 暴走ガードは反復回数のみに依存させる（第2段b、検証高速化5）: 旧実装は壁時計
     （60秒／5秒+3万回）でも打ち切ったため、同じ入力でも実行環境の負荷で成立判定が
     反転する境界があった（v0.6.5 残件4）。反復上限 400,000 が歯止めであることは
     旧コメントの整理どおり。刻み実行（job.step）は壁時計を結果に使わない。 */
  let iterCount = 0, lastRel = 0;
  /* 公表出口での出発（マスドライバー）では、出発母港の安全は出口状態の
     構成と初回噴射のクリアランス判定が担う。地表射出のように母港天体の
     擦過マージン圏内から始まる計画では、上昇中の最接近が計画全体の
     impactRisk を毒するため、圏外へ抜けるまでは母港を擦過台帳から外す
     （地表そのものへの衝突は引き続き検出する）。台帳#114/#116 */
  const anchorBody = depAnchorName ? (pls.find(p => p.name === depAnchorName) || null) : null;
  let anchorCleared = !(anchorBody && o.mdExitV != null);
  const recordBody = (b, ax0, ay0, az0) => {
    const sr = surfaceRadius(b), mg = impactMargin(sr);
    const bx0 = s.x - b.x, by0 = s.y - b.y, bz0 = s.z - b.z;
    const dEnd = Math.hypot(bx0, by0, bz0);
    const dSeg = segMinDist(ax0, ay0, az0, bx0, by0, bz0);
    const d = Math.min(dEnd, dSeg);
    const alt = d - sr;
    if(alt < bestAlt){
      bestAlt = alt;
      bestRisk = { body: b.name || '天体', minDist: d, surfaceR: sr, margin: mg };
    }
    if(d < sr){ surfaceHit = true; hitCount++; }
    if(d < sr + mg){ planetCross = true; crossCount++; }
  };
  /* 到着後の滑空検証（v0.6.2、台帳#34）: simple レグの到着は「圏内に入った瞬間」では
     なく「そのまま滑空しても天体に衝突しない通過であること」まで含めて判定する。
     クローンを最大7,200秒（または目標から十分離れるまで）伝播し、衝突があれば true。
     通過の最接近は bestRisk に反映する（計画表示の最接近を到着後の通過まで正直にする）。
     実飛行側 updatePlanExecution の到着安全確認と同じ規則。 */
  const verifyPassCoast = () => {
    const cs = { x: s.x, y: s.y, z: s.z, vx: s.vx, vy: s.vy, vz: s.vz };
    const ct = { x: t.x, y: t.y, z: t.z, vx: t.vx, vy: t.vy, vz: t.vz };
    const cpls = pls.map(p => ({ x: p.x, y: p.y, z: p.z, vx: p.vx, vy: p.vy, vz: p.vy, vz: p.vz, gm: p.gm, radius: p.radius, dispR: p.dispR, name: p.name, isMoon: p.isMoon }));
    const cplsT = cpls.filter(p => Math.hypot(p.x - ct.x, p.y - ct.y, p.z - ct.z) > 1);
    const sAccV = starAccFn(starGM);
    const exitR = Math.max(3 * arrivalDist, arrivalDist + 20000);
    let ctt = 0, hit = false;
    /* リスクはローカルで測り、滑空が「到着として受理された」場合だけ bestRisk に
       反映する。衝突コースで立て直した滑空は実際に飛ばない軌道なので、その
       最接近で計画全体を危険判定しない（v0.6.2 実測：A1 の std/eco が到着直前の
       旧滑空の擦過で選択不能になっていた）。 */
    let lAlt = Infinity, lRisk = null;
    while(ctt < 7200){
      const hh = Math.min(dynStep(cs.x, cs.y, cs.z, starGM, cpls, BIG), encounterCap(cs, ct), 7200 - ctt);
      if(hh <= 0) break;
      const prevRelC = cpls.map(p => [cs.x - p.x, cs.y - p.y, cs.z - p.z]);
      const acc = fullAccFn(starGM, cpls);
      const caccs = cpls.map((_, i) => accExcluding(starGM, cpls, i));
      const accT = fullAccFn(starGM, cplsT);
      rk4StepState(cs, hh, acc);
      rk4StepState(ct, hh, accT);
      for(let i = 0; i < cpls.length; i++){
        if(i === targetPlIdx){ cpls[i].x = ct.x; cpls[i].y = ct.y; cpls[i].z = ct.z; cpls[i].vx = ct.vx; cpls[i].vy = ct.vy; cpls[i].vz = ct.vz; }
        else rk4StepState(cpls[i], hh, cpls[i].isMoon ? caccs[i] : sAccV);
      }
      ctt += hh;
      for(let i = 0; i < cpls.length; i++){
        const b = cpls[i];
        const sr = surfaceRadius(b), mg = impactMargin(sr);
        const bx0 = cs.x - b.x, by0 = cs.y - b.y, bz0 = cs.z - b.z;
        const d = Math.min(Math.hypot(bx0, by0, bz0), segMinDist(prevRelC[i][0], prevRelC[i][1], prevRelC[i][2], bx0, by0, bz0));
        const alt = d - sr;
        if(alt < lAlt){ lAlt = alt; lRisk = { body: b.name || '天体', minDist: d, surfaceR: sr, margin: mg }; }
        if(d < sr) hit = true;
      }
      if(hit) break;
      if(Math.hypot(cs.x - ct.x, cs.y - ct.y, cs.z - ct.z) > exitR) break;
    }
    if(!hit && lRisk && lAlt < bestAlt){ bestAlt = lAlt; bestRisk = lRisk; }
    return hit;
  };
  /* 軌道出発フェーズ（2026-11-20）: 目標でない天体に束縛された軌道から
     出発する推定では、巡航ホーミングが軌道位相を無視して即噴射し、配置次第で
     速度の打消し＋再加速になる（実測: 帰投推定 80〜98、初回噴射 45.3 を即発射）。
     物理的な正道は、軌道を滑空して位相を選び、接線方向に脱出すること
     （同条件の実測で総計 28 前後）。1 軌道周期にわたり弾道スコア
     （脱出Δv＋最接近時の相対速度＋ミス距離の罰）で最良の脱出スナップショットを
     保持し、周期の終わりにその状態へ戻して脱出噴射→通常巡航へ移る。
     候補ごとに本推定を回さないため、計算量はほぼ 1 ジョブ分＋周期的な弾道評価。 */
  let depBody = null, depPeriod = 0, depStartT = 0, depTimer = 0, depBest = null;
  if(!o.depSep){
    /* 対象は「衛星の捕捉軌道」に限る: 惑星の周りの遷移軌道や惑星間巡航も
       エネルギー的には束縛だが、それは通常巡航の領分で、軌道出発を被せると
       巡航中の再推定まで壊れる（実測: 月脱出後の状態から作った推定が
       つむぎ周りで二重に発火し 28.5 の帰投が 91.6 に化けた）。捕捉軌道の
       緊さ（a が衛星の近傍半径未満）も併せて要求する。 */
    for(const p of pls){
      if(!p.gm || !p.isMoon || p === pls[targetPlIdx]) continue;
      const r = Math.hypot(s.x - p.x, s.y - p.y, s.z - p.z);
      if(r < 1) continue;
      const rvx = s.vx - p.vx, rvy = s.vy - p.vy, rvz = s.vz - p.vz;
      const E = (rvx * rvx + rvy * rvy + rvz * rvz) / 2 - p.gm / r;
      if(E >= 0) continue;
      const aO = -p.gm / (2 * E);
      if(aO >= vicinityRadius(p)) continue;
      const P = 2 * Math.PI * Math.sqrt(aO * aO * aO / p.gm);
      if(P < 600 || P > 400000) continue;
      if(!depBody || r < depBody.r){ depBody = { p, r }; depPeriod = P; }
    }
    if(depBody){ phase = 'orbitdep'; depStartT = timeTotal; depTimer = 0; }
  }
  const snapState = () => ({
    s: { x: s.x, y: s.y, z: s.z, vx: s.vx, vy: s.vy, vz: s.vz },
    t: { x: t.x, y: t.y, z: t.z, vx: t.vx, vy: t.vy, vz: t.vz },
    pls: pls.map(p => ({ x: p.x, y: p.y, z: p.z, vx: p.vx, vy: p.vy, vz: p.vz })),
    timeTotal, dvTotal, dvCruise, dvGravityComp,
    samples: samples.map(a => a.slice()), sampleTimes: sampleTimes.slice(), sampleStride, nextSampleT,
    bestAlt, bestRisk, planetCross, surfaceHit, hitCount, crossCount, lastRel,
    patience: approachCtx.patienceLeft
  });
  const restoreState = (sn) => {
    Object.assign(s, sn.s); Object.assign(t, sn.t);
    pls.forEach((p, i) => Object.assign(p, sn.pls[i]));
    timeTotal = sn.timeTotal; dvTotal = sn.dvTotal; dvCruise = sn.dvCruise; dvGravityComp = sn.dvGravityComp;
    samples.length = 0; sn.samples.forEach(a => samples.push(a));
    sampleTimes.length = 0; sn.sampleTimes.forEach(v => sampleTimes.push(v));
    sampleStride = sn.sampleStride; nextSampleT = sn.nextSampleT;
    bestAlt = sn.bestAlt; bestRisk = sn.bestRisk; planetCross = sn.planetCross; surfaceHit = sn.surfaceHit;
    hitCount = sn.hitCount; crossCount = sn.crossCount; lastRel = sn.lastRel;
    approachCtx.patienceLeft = sn.patience;
  };
  /* 軌道出発の弾道スコア（2026-11-20）: 脱出後の状態を無噴射で 75,000 秒
     伝播し、最接近距離とその時の相対速度で候補を採点する。伝播は推定双子と
     同じ積分器・同じ刻み上限で行う——RK4 の予測（predictClosest）だけでは、
     オイラー双子が発散する位相（実測 τ1520: RK4 では 35.7、オイラーでは 92）
     を見抜けない。 */
  const ballisticScore = (es, dv) => {
    const cs = { x: es.x, y: es.y, z: es.z, vx: es.vx, vy: es.vy, vz: es.vz };
    const ct = { x: t.x, y: t.y, z: t.z, vx: t.vx, vy: t.vy, vz: t.vz };
    const cpls = pls.map(p => ({ x: p.x, y: p.y, z: p.z, vx: p.vx, vy: p.vy, vz: p.vz, gm: p.gm, isMoon: !!p.isMoon }));
    const cplsT = cpls.filter(p => Math.hypot(p.x - ct.x, p.y - ct.y, p.z - ct.z) > 1);
    const acc = fullAccFn(starGM, cpls);
    const accT = fullAccFn(starGM, cplsT);
    const accs = cpls.map((_, i) => accExcluding(starGM, cpls, i));
    const sAcc = starAccFn(starGM);
    const stepB = (b, hh, accFn) => {
      if(eulerTwin){ const a = accFn(b.x, b.y, b.z); b.vx += a[0] * hh; b.vy += a[1] * hh; b.vz += a[2] * hh; b.x += b.vx * hh; b.y += b.vy * hh; b.z += b.vz * hh; }
      else rk4StepState(b, hh, accFn);
    };
    let minDist = Math.hypot(ct.x - cs.x, ct.y - cs.y, ct.z - cs.z), relAtMin = Math.hypot(cs.vx - ct.vx, cs.vy - ct.vy, cs.vz - ct.vz), tt = 0, tAtMin = 0;
    while(tt < 75000){
      let hh = 120;
      const dT = Math.hypot(cs.x - ct.x, cs.y - ct.y, cs.z - ct.z);
      if(dT < 300000) hh = 20;
      else for(const p of cpls){ if(p.gm && Math.hypot(cs.x - p.x, cs.y - p.y, cs.z - p.z) < 300000){ hh = 20; break; } }
      hh = Math.min(hh, 75000 - tt);
      stepB(cs, hh, acc); stepB(ct, hh, accT);
      for(let i = 0; i < cpls.length; i++){
        if(i === targetPlIdx){ cpls[i].x = ct.x; cpls[i].y = ct.y; cpls[i].z = ct.z; cpls[i].vx = ct.vx; cpls[i].vy = ct.vy; cpls[i].vz = ct.vz; }
        else stepB(cpls[i], hh, cpls[i].isMoon ? accs[i] : sAcc);
      }
      tt += hh;
      const d = Math.hypot(ct.x - cs.x, ct.y - cs.y, ct.z - cs.z);
      if(d < minDist){ minDist = d; relAtMin = Math.hypot(cs.vx - ct.vx, cs.vy - ct.vy, cs.vz - ct.vz); tAtMin = tt; }
    }
    return dv + relAtMin + Math.max(0, minDist - 20000) / 2000 + tAtMin / 25000;
  };
  const job = { done: false, result: null, iterCount: 0, timeTotal: 0, maxT };
  job.step = function(maxIter, maxMs){
    if(job.done) return true;
    const sliceStart = performance.now();
    let n = 0;
    while(timeTotal < maxT){
    /* ガードは反復上限（400,000）のみ（第2段bで壁時計条件を撤去し決定論化）。
       刻み予算（maxIter／maxMs）は「どこで中断するか」だけを決め、結果には影響しない。 */
    iterCount++;
    if(iterCount > 400000){
      job.result = Object.assign({ ok: false, timeout: true, planetCross, dvTotal, timeTotal, samples }, fin(lastRel));
      job.done = true;
      break;
    }
    if(n++ >= maxIter || ((n & 15) === 0 && maxMs != null && performance.now() - sliceStart > maxMs)) break;
    const infoDistApprox = Math.hypot(t.x - s.x, t.y - s.y, t.z - s.z);
    const phaseCap = phase === 'cruise' ? (needDock && infoDistApprox < 300 ? Math.min(1.5, Math.max(0.25, checkTimer)) : Math.max(1, checkTimer)) : ((phase === 'final' || phase === 'join') ? 8 : BIG);
    h = Math.min(dynStep(s.x, s.y, s.z, starGM, pls, BIG), encounterCap(s, t), phaseCap, maxT - timeTotal);
    /* 実飛行との刻み一致（2026-11-19）: 実飛行は天体 300,000 以内で刻みを
       20 秒に cap する（game.html stepWorld）。推定側が井戸の中で ~52 秒
       刻みだと、双子の軌道が通過の数分で数千ずれる（実測: 最接近通過で
       位置誤差 673→3,064・速度誤差 6.79 まで発散し、追従が推進剤を
       食い切った）。計画は世界を予測する側なので、世界の刻みに合わせる */
    { let dMinP = Infinity; for(const p of pls){ if(!p.gm) continue; const dd = Math.hypot(s.x - p.x, s.y - p.y, s.z - p.z); if(dd < dMinP) dMinP = dd; } if(dMinP < 300000) h = Math.min(h, 20); }
    if(h <= 0){ job.result = Object.assign({ ok: false, planetCross, dvTotal, timeTotal, samples }, fin(0)); job.done = true; break; }
    const prevRel = pls.map(p => [s.x - p.x, s.y - p.y, s.z - p.z]);
    const prevStar = [s.x, s.y, s.z];
    propStar();
    timeTotal += h;
    for(let i = 0; i < pls.length; i++){
      if(!anchorCleared && pls[i] === anchorBody){
        const srA = surfaceRadius(pls[i]);
        const ddA = Math.hypot(s.x - pls[i].x, s.y - pls[i].y, s.z - pls[i].z);
        if(ddA < srA){ surfaceHit = true; hitCount++; }
        if(ddA > srA + impactMargin(srA)) anchorCleared = true;
        else continue;
      }
      recordBody(pls[i], prevRel[i][0], prevRel[i][1], prevRel[i][2]);
    }
    recordBody(starBody, prevStar[0], prevStar[1], prevStar[2]);
    const info = relInfo(s, t);
    lastRel = info.rel;
    if(capDone){
      /* 捕捉後の確認滑空（設計規則 台帳#44/#47）: 捕捉が済んだら誘導はもう触らない
         （捕捉軌道の圏出入りに通常段が反応して噴射を打ち合った実測がある）。
         30分滑空して束縛軌道の範囲（到着圏×3）に留まれば、安定な終了状態として
         到着が成立する。 */
      if(timeTotal - capT >= 1800){
        /* 捕捉後の滑空で「新たに」衝突・擦過が増えていないことだけを見る:
           捕捉前の接近擦過は到着系が処理済みの幾何で、捕捉軌道の安定性とは別。
           あわせて捕捉軌道そのものの近点・束縛も解析的に確認する（実飛行側と
           同じ規則: 近点が安全フロア未満・非束縛の軌道は安定な終了状態ではない）。 */
        /* 到着確認で遠点の上限は見ない（v0.6.4 修正）: 三体場の瞬時遠点は
           滑空の間にも上限の数 % を跨いで振動する（実測: 二体遠点 14,954 の
           軌道で瞬時距離が 15,528 まで伸びた）。遠点の統制は発火時の帯判定＋
           120 時間の数値確認が担っており、ここでは束縛・近点フロア・新たな
           衝突/擦過がないことだけを確認する（上限つきで確認すると、安定な
           到着を「不成立」と誤判定し、位相によって計画が点滅した）。
           判定は実飛行と共用の captureOrbitConfirmOk（#76 で単一化）。 */
        const orbitOk = captureOrbitConfirmOk(s, t);
        const okCap = info.dist <= arrivalDist * 3 && hitCount === capHitBase && crossCount === capCrossBase && orbitOk;
        job.result = Object.assign({ ok: okCap, planetCross, dvTotal, timeTotal, samples }, fin(info.rel)); job.done = true;
      }
    } else if(!needDock && (info.dist <= arrivalDist || (info.dist <= Math.max(arrivalDist * 3, 300) && info.rel <= 4))){
      /* 終端の捕捉エンベロープ（v0.6.2）: 到着半径が小さい目標（ステーション 90 等）では、
         巡航ケイデンスの刻みと誘導だけでは球を突く振動になり、推定が実飛行より
         大幅に高くなる（実測: 帰投終端で 1.6 の噴射を反復＋7.92）。実飛行の終端は
         接近スーパーフェーズ（15秒ケイデンスの速度一致誘導）が担うため、推定側も
         「近接＋低相対速度＋滑空安全」で到着受理する。 */
      if(t.gm > 0 && arrivalDist > 1000){
        /* 安定な終了状態: フライバイのまま計画を終えると、判断待ちの間に船は
           遠ざかり続け、帰還計画の前提が崩れる。到着は「圏内＋滑空安全」だけで
           なく「捕捉軌道に入ったこと」まで含める。捕捉バーンも推定消費に含む
           （帰還側の前提＝捕捉状態で揃える）。 */
        if(verifyPassCoast()){
          if(timeTotal - lastZoneFixT >= 20){ lastZoneFixT = timeTotal; applyDv(computeApproach(s, t, starGM, scale, pls)); }
        } else if(captureGateAt(s, t, pls, arrivalDist) || (timeTotal - lastCapTryT >= 3600 && captureOpportunity(s, t, pls, arrivalDist, starGM, null))){
          /* 捕捉の発火条件は実飛行と共用の captureGateAt（#76 で単一化）。
             旧インライン判定は branch 1 が離行脚でも発火する欠陥を含んでいた。
             近接パスで有効解がある場合は captureOpportunity（#130）も発火
             条件に含める——実飛行と同じ規則で見積もり、熱い到着の捕捉
             コストを見積に含める。機会判定は高コストなので試行間隔で絞る */
          /* 捕捉は近点通過の瞬間に撃つ: 動径成分がほぼ消え、接線速度の帯調整
             だけで済むため最も安い（圏突入直後の捕捉は動径落下の殺しが高くつく）。 */
          const cap = computeCapture(s, t, pls);
          if(!cap){ job.result = Object.assign({ ok: false, planetCross, dvTotal, timeTotal, samples }, fin(info.rel)); job.done = true; }
          /* 実飛行と同じ規則（v0.6.4 課題3）: 捕捉後の軌道が安全帯に収まり
             120 時間伝播でも安定な幾何でだけ撃ち、収まらない幾何（近点通過
             など）を待つ。安定確認は高コストなので試行（成功・失敗を問わず）
             ごとに間隔を空ける: 失敗のたびに再評価すると推定が終わらない。 */
          const postCapE = { x: s.x, y: s.y, z: s.z, vx: s.vx + cap.dvx, vy: s.vy + cap.dvy, vz: s.vz + cap.dvz };
          if(timeTotal - lastCapTryT >= 3600){
            lastCapTryT = timeTotal;
            if(captureOrbitInBand(postCapE, t, pls) && captureOrbitStable72h(postCapE, t, starGM, pls)){
              applyDv(cap);
              capDone = true; capT = timeTotal;
              capHitBase = hitCount; capCrossBase = crossCount;
            }
          }
        }
      } else if(verifyPassCoast()){
        /* 到着圏内だが滑空すると衝突する。通過を安全にする噴射で立て直してから
           到着する（実飛行側の到着安全確認と同じ規則）。この噴射も推定消費に含む。 */
        if(timeTotal - lastZoneFixT >= 20){ lastZoneFixT = timeTotal; applyDv(computeApproach(s, t, starGM, scale, pls)); }
      } else {
        job.result = Object.assign({ ok: !surfaceHit, planetCross, dvTotal, timeTotal, samples }, fin(info.rel)); job.done = true;
      }
    }
    if(job.done) break;
    if(dvTotal > 120){ job.result = Object.assign({ ok: false, planetCross, dvTotal, timeTotal, samples }, fin(info.rel)); job.done = true; }
    const fix = approachFix(t);
    const dFix = Math.hypot(s.x - fix.x, s.y - fix.y, s.z - fix.z);
    if(needDock){
      if(!established && dFix <= 10 && info.rel <= 2.5) established = true;
      if(established){
        const abx = t.x - fix.x, aby = t.y - fix.y, abz = t.z - fix.z;
        const den = abx * abx + aby * aby + abz * abz || 1;
        const tt = Math.max(0, Math.min(1, ((s.x - fix.x) * abx + (s.y - fix.y) * aby + (s.z - fix.z) * abz) / den));
        const px = fix.x + abx * tt, py = fix.y + aby * tt, pz = fix.z + abz * tt;
        if(Math.hypot(s.x - px, s.y - py, s.z - pz) > 16) established = false;
      }
      if(established && info.dist < arrivalDist && info.rel <= V_CONTACT){ job.result = Object.assign({ ok: !surfaceHit, planetCross, dvTotal, timeTotal, samples }, fin(info.rel)); job.done = true; }
    }
    if(job.done) break;
    if(phaseT0[phase] === undefined) phaseT0[phase] = timeTotal;
    if(actCd > 0) actCd -= h;
    if(phase === 'orbitdep'){
      depTimer -= h;
      if(depTimer <= 0){
        depTimer = Math.max(300, Math.min(1200, depPeriod / 16));
        const B = depBody.p;
        const r = Math.hypot(s.x - B.x, s.y - B.y, s.z - B.z) || 1;
        const rvx = s.vx - B.vx, rvy = s.vy - B.vy, rvz = s.vz - B.vz;
        const rsp = Math.hypot(rvx, rvy, rvz) || 1e-9;
        for(const vInf of [0.3, 1.0, 2.0]){
          const dv = Math.sqrt(vInf * vInf + 2 * B.gm / r) - rsp;
          if(dv < -0.01) continue;
          const d = Math.max(0, dv);
          const es = { x: s.x, y: s.y, z: s.z, vx: s.vx + rvx / rsp * d, vy: s.vy + rvy / rsp * d, vz: s.vz + rvz / rsp * d };
          const score = ballisticScore(es, d);
          if(!depBest || score < depBest.score) depBest = { score, snap: snapState(), dvx: rvx / rsp * d, dvy: rvy / rsp * d, dvz: rvz / rsp * d, cost: d };
        }
      }
      if(timeTotal - depStartT >= depPeriod){
        if(depBest){
          const b = depBest;
          restoreState(b.snap);
          phase = 'cruise'; checkTimer = 0;
          applyDv({ dvx: b.dvx, dvy: b.dvy, dvz: b.dvz, cost: b.cost });
        } else { phase = 'cruise'; checkTimer = 0; }
      }
    } else if(phase === 'cruise'){
      checkTimer -= h;
      if(checkTimer <= 0){
        checkTimer = planCadenceFor(s, info.dist, pls);
        if(!capDone && (needDock || info.dist >= arrivalDist)) applyDv(computeApproach(s, t, starGM, scale, pls, undefined, approachCtx));
      }
      if(needDock && (info.dist < 75 || (info.dist < 150 && info.rel > V_IAF))) phase = 'brake';
      else if(!needDock && !(t.gm > 0) && info.dist < 25000) phase = 'final';
      /* gm を持たない目標（ステーション）への単純レグの終端（v0.6.2）: 実飛行の
         終端は接近スーパーフェーズの速度一致誘導が担う。推定側が巡航誘導の
         まま到着球（90）を突くと振動して消費が膨らむため、終端フェーズ
         （刻み 2 秒以下）で実飛行と同じ閉速度プロファイルに寄せる。 */
    } else if(phase === 'brake'){
      applyDv(computeBrake(s, t));
      phase = 'captain';
    } else if(phase === 'captain'){
      applyDv(computeMatch(s, t));
      phase = 'join';
    } else if(phase === 'join'){
      if(established) phase = 'final';
      else if(actCd <= 0){
        if(dFix <= 10 && info.rel > 2.5){ applyDv(computeMatch(s, t)); actCd = 0.8; }
        else if(dFix > 8){ applyDv(computeJoinApproach(s, t, starGM, pls)); actCd = 0.8; }
        else if(info.rel > 1.2){ applyDv(computeMatch(s, t)); actCd = 0.8; }
      }
    } else if(phase === 'final'){
      if(needDock && !established) phase = 'join';
      else if(actCd <= 0){
        if(info.closing < 0.5){
          const pm = info.dist || 1;
          const dvx = t.vx + (info.dx / pm) * 0.9 - s.vx;
          const dvy = t.vy + (info.dy / pm) * 0.9 - s.vy;
          const dvz = t.vz + (info.dz / pm) * 0.9 - s.vz;
          applyDv({ dvx, dvy, dvz, cost: Math.hypot(dvx, dvy, dvz) });
          actCd = 0.8;
        } else if(info.closing > 1.3 || info.rel > V_CONTACT){
          applyDv(computeBrake(s, t));
          actCd = 0.8;
        }
      }
    }
    if(timeTotal >= nextSampleT){
      samples.push([s.x, s.y, s.z]);
      sampleTimes.push(timeTotal);
      if(samples.length > 400){
        let j = 0;
        for(let i = 0; i < samples.length; i += 2){ samples[j] = samples[i]; sampleTimes[j] = sampleTimes[i]; j++; }
        samples.length = j;
        sampleTimes.length = j;
        sampleStride *= 2;
      }
      nextSampleT += sampleStride;
    }
    if(job.done) break;
  }
    if(!job.done && timeTotal >= maxT){
      job.result = Object.assign({ ok: false, planetCross, dvTotal, timeTotal, samples }, fin(0));
      job.done = true;
    }
    job.iterCount = iterCount; job.timeTotal = timeTotal;
    return job.done;
  };
  return job;
}

function computePlanEstimate(ship, target, starGM, closingScale, opts){
  const job = createPlanEstimateJob(ship, target, starGM, closingScale, opts);
  job.step(Infinity);
  return job.result;
}


function addOrbitState(base, rel){
  return {
    x: base.x + rel.x, y: base.y + rel.y, z: base.z + rel.z,
    vx: base.vx + rel.vx, vy: base.vy + rel.vy, vz: base.vz + rel.vz
  };
}

function buildSystemPlanets(sys){
  const list = sys.planets.map((p, i)=>{
    const st = orbitState(sys.starGM, p.r, 0.7 + i*1.35, p.inc, p.node);
    const body = makeBody(st, p.color, p.r > 250*SCALE_K ? 9 : 7, p.name, p.gm);
    /* 惑星の表面半径は実寸（2026-11-20 本人裁定）: 旧方式（軌道半径×0.0035）は
       つむぎを木星の約3倍の球として描き・判定していた。dispR は surfaceRadius
       経由で物理の表面でもあるため、SYSTEMS 側に実半径（km）を持たせて使う。
       表示では実寸の点になり、位置は画面マーカー（情報層）が示す */
    body.dispR = p.radius || 6000;
    return body;
  });
  sys.planets.forEach((p, i)=>{
    if(!p.moon) return;
    const host = list[i], m = p.moon;
    const mSt = addOrbitState(host, orbitState(host.gm, m.orbitR, m.phase, m.inc, 0));
    const moon = makeBody(mSt, m.color, m.dispR, '衛星「' + m.name + '」', m.gm);
    moon.moonOf = p.name;
    moon.isMoon = true;
    moon.dispR = m.dispR;
    list.push(moon);
  });
  return list;
}

function computeDepSep(anchor, target){
  /* 出発分離の方向（2026-11-19 出発モデル組み直し）: 旧モデルは「星から外向き
     0.55＋進行方向 0.85＋目標方向 0.9」の混合で、位相によっては目的地と70°も
     ずれた向きに離舷し、港内で横向きの速度をためて本航行の初手で軌道が横に
     折れた。分離は港の形で決まる短い移動である: 自船バースのアーム方向
     （モデル座標 berth_06 = (300, 38, 0) を、接舷位置の計算と同一の基底
     R／T'／N で写した向き）へ、ステーションの構造を離れるまで進む。
     目標は関与しない——向きは港の事実で、航路はその先で計画が決める。
     target 引数は呼び出し互換のため残す。 */
  if(!anchor) return { x: 1, y: 0, z: 0 };
  const rp = Math.hypot(anchor.x, anchor.y, anchor.z) || 1;
  const R = { x: anchor.x / rp, y: anchor.y / rp, z: anchor.z / rp };
  const vp = Math.hypot(anchor.vx, anchor.vy, anchor.vz) || 1;
  const Tv = { x: anchor.vx / vp, y: anchor.vy / vp, z: anchor.vz / vp };
  let N = { x: R.y * Tv.z - R.z * Tv.y, y: R.z * Tv.x - R.x * Tv.z, z: R.x * Tv.y - R.y * Tv.x };
  const nm = Math.hypot(N.x, N.y, N.z) || 1;
  N = { x: N.x / nm, y: N.y / nm, z: N.z / nm };
  const T = { x: N.y * R.z - N.z * R.y, y: N.z * R.x - N.x * R.z, z: N.x * R.y - N.y * R.x };
  const sx = R.x * 300 + T.x * 38, sy = R.y * 300 + T.y * 38, sz = R.z * 300 + T.z * 38;
  const sm = Math.hypot(sx, sy, sz) || 1;
  return { x: sx / sm, y: sy / sm, z: sz / sm };
}

function combineEstimateEnsemble(a, b){
  const risk = (a.impactRisk && b.impactRisk) ? (a.impactRisk.minDist <= b.impactRisk.minDist ? a.impactRisk : b.impactRisk) : (a.impactRisk || b.impactRisk || null);
  return Object.assign({}, b, {
    ok: !!(a.ok && b.ok),
    impactRisk: risk,
    timeout: !!(a.timeout || b.timeout),
    ensemble: { rk4: { dvTotal: a.dvTotal, ok: a.ok }, euler: { dvTotal: b.dvTotal, ok: b.ok } }
  });
}
function computePlanEstimateEnsemble(ship, target, starGM, closingScale, opts){
  const a = computePlanEstimate(ship, target, starGM, closingScale, opts);
  const b = computePlanEstimate(ship, target, starGM, closingScale, Object.assign({}, opts, { integrator: 'euler' }));
  return combineEstimateEnsemble(a, b);
}
/* 刻み実行版アンサンブル（第2段b、#51）: RK4 本体→双子の順に進め、終われば結合する。
   同期版と計算の順序・内容は同一で、結果は一致する（テストで機械確認する） */
function createPlanEstimateEnsembleJob(ship, target, starGM, closingScale, opts){
  const ja = createPlanEstimateJob(ship, target, starGM, closingScale, opts);
  const jb = createPlanEstimateJob(ship, target, starGM, closingScale, Object.assign({}, opts, { integrator: 'euler' }));
  const job = { done: false, result: null, a: ja, b: jb, iterCount: 0,
    step(maxIter, maxMs){
      if(this.done) return true;
      if(!ja.done) ja.step(maxIter, maxMs);
      else if(!jb.done) jb.step(maxIter, maxMs);
      this.iterCount = ja.iterCount + jb.iterCount;
      if(ja.done && jb.done){ this.result = combineEstimateEnsemble(ja.result, jb.result); this.done = true; }
      return this.done;
    } };
  return job;
}

/* ==== /ORDER LOGIC ==== */
return { SCALE_K, WARP_EDGE, orbitState, makeBody, STAR_SURFACE_R, V_IAF, V_FINAL, V_CONTACT, MD_EXIT_V, surfaceRadius, impactMargin, vicinityRadius, inVicinityOf, planCadenceFor, relInfo, safeClosing, approachClosing, rk4StepState, starAccFn, fullAccFn, accExcluding, dynStep, encounterCap, planCadence, propRK4, predictTargetPos, computeApproach, orbitPeriapsis, captureApoCap, captureOrbitInBand, captureSettlesOk, captureOrbitStable72h, captureGateAt, captureOpportunity, captureOrbitConfirmOk, computeCapture, computeBrake, computeMatch, computeHold, approachFix, computeJoinApproach, computeDescent, moonBasePointIn, findDescentBurn, fastestOrbitCap, predictClosest, simulateHarborExit, computePlanEstimate, createPlanEstimateJob, createPlanEstimateEnsembleJob, addOrbitState, buildSystemPlanets, computeDepSep, computePlanEstimateEnsemble };
}));
