/* world-drive.js — 世界の駆動（台帳 #155/#156/#158）
   会話・画面・保存先から独立した世界の駆動部。世界の状態は「申告＋時刻 T」
   から導出され、誰も見ていなくても時刻から再構成できる。
   ブラウザでは window.WorldDrive、Node では module.exports として読み込む。
   物理は flight-core.js の階層モデルと積分器をそのまま使う（惑星=恒星重力
   のみ／月・ステーション・船=全重力）。刻みは推定器の規則に一致させる。 */
(function (global, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(require('./flight-core.js')); }
  else { global.WorldDrive = factory(global.FlightCore); }
})(typeof self !== 'undefined' ? self : this, function (FC) {
  'use strict';

  /* 世界を作る。sysDef は game.html の SYSTEMS と同じ形式。
     stationDef: { hostName, orbitR, phase } — 宿主惑星の周りのステーション。
     戻り値の world は駆動の内部状態（天体・ステーション・船）を持つ。 */
  function createWorld(sysDef, stationDef) {
    const planets = FC.buildSystemPlanets(sysDef);
    const host = planets.find(p => p.name === stationDef.hostName);
    if (!host) throw new Error('station host not found: ' + stationDef.hostName);
    const station = FC.makeBody(
      FC.addOrbitState(host, FC.orbitState(host.gm, stationDef.orbitR, stationDef.phase, 0, 0)),
      0x2dd4bf, 11, stationDef.name, 0);
    station.isStation = true;
    return {
      sys: sysDef, starGM: sysDef.starGM, planets, station,
      ships: [],           /* { id, name, dockedAt（天体 or station）, filing, dvUsed } */
      now: 0,
      bodyNow: 0,          /* 天体の内部時刻（固定刻み伝播の現在位置） */
      bodyHist: null,      /* グリッド点ごとの天体状態の履歴（stepBodies が記録） */
      events: []           /* { t, type: 'depart'|'burn'|'arrive', shipId, ... } */
    };
  }

  function addShip(world, id, name) {
    const ship = { id, name, x: world.station.x, y: world.station.y, z: world.station.z,
      vx: world.station.vx, vy: world.station.vy, vz: world.station.vz,
      gm: 0, radius: 5, isShip: true, isMoon: false, t: 0,
      dockedAt: world.station, filing: null, dvUsed: 0 };
    world.ships.push(ship);
    return ship;
  }

  /* 申告を登録する。filing:
     { id, shipId, fromName, toName, departT, initState:{x,y,z,vx,vy,vz},
       burns:[{ atT（出発からの経過秒）, dvx, dvy, dvz, cost }], arriveT, arriveBodyName }
     状態は保存しない——船の位置はこの申告と時刻から導出される。
     filing.guidance = { fromT, arrivalDist } を付けると、fromT 以後の
     噴射列は使わず、駆動が推定器の final と同じ誘導則を再実行する
     （終端誘導の再実行型、2026-11-22 の設計追記 A 案）。到着は誘導側の
     エンベロープ判定（dist ≤ max(arrivalDist×3, 300) かつ rel ≤ 4）で
     決まり、arriveT の固定到着は使わない。
     filing.descent = { bodyName, waitS, burn:{dvx,dvy,dvz,cost} } を
     付けると降下便になる（game.html の updateDescent と同じ状態機械）:
     departT に捕捉軌道へ置かれ、waitS 後に降下噴射 1 発、基地点まで
     3,000 以内で終端制動（computeDescent を距離で 6/10 秒間隔に再実行）、
     基地点 40 以内・相対速度 2.2 以下で着陸（月へドック）。
     filing.anchorName がある場合、initState はその天体に対する相対状態
     として解釈し、出発時に実行側の天体の実状態へ足して復元する。
     生成側と実行側では世界の刻み列が違い、天体の絶対位置がわずかに
     ずれるため、絶対座標の initState では出発時の相対関係が崩れる
     （2026-11-22 の観覧通し検証で実証：誘導 Δv が 29 → 4,371 に悪化）。 */
  function initFiling(filing) {
    return Object.assign({}, filing, { firedBurns: 0, departed: false, arrived: false });
  }

  /* 申告を登録する。同じ船に未完了の申告があればキューに積み、到着・
     着陸のたびに次の申告へ自動で付け替える（便の連なり＝ダイヤ）。
     次便の departT までは船は係留先に留まる（捕捉軌道の待機と同じ形） */
  function filePlan(world, filing) {
    const ship = world.ships.find(s => s.id === filing.shipId);
    if (!ship) throw new Error('ship not found: ' + filing.shipId);
    if (!ship.queue) ship.queue = [];
    if (ship.filing && !ship.filing.arrived) { ship.queue.push(initFiling(filing)); return ship.queue[ship.queue.length - 1]; }
    ship.filing = initFiling(filing);
    return ship.filing;
  }

  function promoteNextFiling(world, ship) {
    if (ship.queue && ship.queue.length) {
      ship.filing = ship.queue.shift();
      world.events.push({ t: world.now, type: 'filed', shipId: ship.id, id: ship.filing.id });
      return true;
    }
    return false;
  }

  function bodyByName(world, name) {
    if (world.station.name === name) return world.station;
    return world.planets.find(p => p.name === name) || null;
  }

  /* 天体（惑星・月・ステーション）の伝播は船から分離し、絶対時刻の
     グリッド（BODY_STEP 秒の倍数）でのみ区切る固定刻みの独立パスで
     進める。呼び出し粒度や他船の有無で刻み列が変わると、速い天体
     （ステーション、周期 2,567 秒）の位相が大きくずれて計画の幾何が
     崩れるため（2026-11-22 の決定性実測：位置 13,981・速度 34.27）。
     グリッド列は世界の定義だけで決まるため、生成側・実行側・観覧側で
     天体の状態が一致する */
  const BODY_STEP = 10;
  function bodySnap(world) {
    return world.planets.concat([world.station]).map(b => ({ x: b.x, y: b.y, z: b.z, vx: b.vx, vy: b.vy, vz: b.vz }));
  }
  function stepBodies(world, toT) {
    const sAcc = FC.starAccFn(world.starGM);
    const accFull = FC.fullAccFn(world.starGM, world.planets);
    const accsP = world.planets.map((_, i) => world.planets[i].isMoon ? FC.accExcluding(world.starGM, world.planets, i) : sAcc);
    if (!world.bodyHist) world.bodyHist = [bodySnap(world)];
    const gridT = Math.floor(toT / BODY_STEP) * BODY_STEP;
    while (world.bodyNow < gridT) {
      FC.rk4StepState(world.station, BODY_STEP, accFull);
      for (let i = 0; i < world.planets.length; i++) FC.rk4StepState(world.planets[i], BODY_STEP, accsP[i]);
      world.bodyNow += BODY_STEP;
      world.bodyHist.push(bodySnap(world));
    }
  }

  /* 天体をグリッド点まで進め、時刻 t まで外挿した見かけの状態で fn を
     実行し、終わったらグリッド状態へ復元する。外挿は正の状態（グリッド
     列）へ影響しないため、天体の決定性は保たれる */
  function withBodiesAt(world, t, fn) {
    stepBodies(world, t);
    const bodies = world.planets.concat([world.station]);
    const saved = bodies.map(b => ({ b, x: b.x, y: b.y, z: b.z, vx: b.vx, vy: b.vy, vz: b.vz }));
    /* 時刻 t の状態はグリッド履歴から構築する。他の船の処理で bodyNow が
       t より先に進んでいる場合でも、過去の時刻の状態を正しく返せる
       （履歴が無い場合は現在の状態で代用する） */
    const gridT = Math.floor(t / BODY_STEP) * BODY_STEP;
    const hist = world.bodyHist && world.bodyHist[Math.round(gridT / BODY_STEP)];
    if (hist) bodies.forEach((b, i) => { b.x = hist[i].x; b.y = hist[i].y; b.z = hist[i].z; b.vx = hist[i].vx; b.vy = hist[i].vy; b.vz = hist[i].vz; });
    const rem = t - gridT;
    if (rem > 1e-9) {
      const sAcc = FC.starAccFn(world.starGM);
      const accFull = FC.fullAccFn(world.starGM, world.planets);
      const accsP = world.planets.map((_, i) => world.planets[i].isMoon ? FC.accExcluding(world.starGM, world.planets, i) : sAcc);
      FC.rk4StepState(world.station, rem, accFull);
      for (let i = 0; i < world.planets.length; i++) FC.rk4StepState(world.planets[i], rem, accsP[i]);
    }
    try { return fn(); }
    finally { for (const sv of saved) { sv.b.x = sv.x; sv.b.y = sv.y; sv.b.z = sv.z; sv.b.vx = sv.vx; sv.b.vy = sv.vy; sv.b.vz = sv.vz; } }
  }

  /* 1 隻をその船専用の刻み列で T まで進める。船同士は重力で相互作用
     しない（gm = 0）ため、船ごとに独立に伝播できる。共通の刻みで全船を
     進める方式では、他船の存在が刻み列を変えて各船の軌跡が推定と
     ずれる（2026-11-22 の観覧通し検証：区間2 の誘導 Δv が 29 → 4,251
     に悪化）。船ごとの伝播なら単独検証の刻み列が複数船でも再現される */
  function advanceShip(world, s, T) {
    const BIG_EST = 0.75 * (FC.SCALE_K || 386700);
    const accFull = FC.fullAccFn(world.starGM, world.planets);
    if (s.t == null) s.t = 0;
    while (s.t < T) {
      const f = s.filing;
      /* 出発時刻が既に到来している申告は、時刻を進めずに即座に出発
         させる。初期状態は出発時刻の天体との相対で意味を持つため、
         発火が遅れると相対関係が崩れる（申告は現在時刻で作られる） */
      if (f && !f.departed && f.departT <= s.t) {
        withBodiesAt(world, s.t, () => {
          f.departed = true; s.dockedAt = null;
          if (f.descent) f.descStage = 'wait';
          if (f.anchorName) {
            const a = bodyByName(world, f.anchorName);
            s.x = a.x + f.initState.x; s.y = a.y + f.initState.y; s.z = a.z + f.initState.z;
            s.vx = a.vx + f.initState.vx; s.vy = a.vy + f.initState.vy; s.vz = a.vz + f.initState.vz;
          } else {
            s.x = f.initState.x; s.y = f.initState.y; s.z = f.initState.z;
            s.vx = f.initState.vx; s.vy = f.initState.vy; s.vz = f.initState.vz;
          }
          world.events.push({ t: s.t, type: 'depart', shipId: s.id, from: f.fromName, to: f.toName });
        });
        continue;
      }
      /* 次のイベント時刻までで刻みを割る */
      let nextEv = T;
      if (f) {
        if (!f.departed && f.departT > s.t && f.departT < nextEv) nextEv = f.departT;
        if (f.departed && !f.arrived && f.descent && f.descStage === 'wait') {
          const bt = f.departT + f.descent.waitS;
          if (bt > s.t && bt < nextEv) nextEv = bt;
        }
        if (f.departed && !f.arrived) {
          const guiding = f.guidance && s.t >= f.departT + f.guidance.fromT;
          if (!guiding) {
            const b = f.burns[f.firedBurns];
            if (b) { const bt = f.departT + b.atT; if (bt > s.t && bt < nextEv) nextEv = bt; }
          }
          if (f.guidance) {
            const gt = f.departT + f.guidance.fromT;
            if (gt > s.t && gt < nextEv) nextEv = gt;
          } else if (f.arriveT != null && f.arriveT > s.t && f.arriveT < nextEv) nextEv = f.arriveT;
        }
      }
      let h = nextEv - s.t;
      if (!s.dockedAt) {
        h = Math.min(h, FC.dynStep(s.x, s.y, s.z, world.starGM, world.planets, BIG_EST));
        const dest = f && f.arriveBodyName ? bodyByName(world, f.arriveBodyName) : null;
        if (dest) h = Math.min(h, FC.encounterCap(s, dest));
        let dMin = Infinity;
        for (const p of world.planets) { if (!p.gm) continue; const d = Math.hypot(s.x - p.x, s.y - p.y, s.z - p.z); if (d < dMin) dMin = d; }
        if (dMin < 300000) h = Math.min(h, 20);
        if (f && f.guidance && f.departed && s.t >= f.departT + f.guidance.fromT) h = Math.min(h, 8);
        if (f && f.descent && f.departed) h = Math.min(h, 6);
      }
      if (!(h > 0)) h = nextEv - s.t;
      if (!(h > 0)) break;
      const tEnd = s.t + h;
      if (!s.dockedAt) {
        /* サブステップ幅 capP: 天体系＋ステーション＋自船の目標 */
        let capP = h;
        const consider = (b) => {
          let bGm = world.starGM, bD = Math.hypot(b.x, b.y, b.z);
          for (const q of world.planets) { if (q !== b && q.gm > 0) { const d = Math.hypot(b.x - q.x, b.y - q.y, b.z - q.z); if (d > 1 && q.gm / (d * d) > bGm / Math.max(1, bD * bD)) { bGm = q.gm; bD = d; } } }
          if (bGm > 0 && bD > 0) capP = Math.min(capP, Math.max(20, 2 * Math.PI * Math.sqrt(Math.pow(bD, 3) / bGm) * 0.01));
        };
        for (const p of world.planets) consider(p);
        consider(world.station);
        const dest = f && f.arriveBodyName ? bodyByName(world, f.arriveBodyName) : null;
        if (dest && dest !== world.station) consider(dest);
        const nSub = Math.min(400, Math.max(1, Math.ceil(h / Math.max(1, capP))));
        const hs = h / nSub;
        /* 船の伝播は推定器の propStar と同じ逐次更新（船→ステーション→
           惑星）で、天体もサブステップごとに進める。天体の起点はこの
           ステップの開始時刻のグリッド＋外挿状態で、伝播後に復元される
           ため、天体の正の状態（グリッド列）の決定性は保たれる。天体を
           ステップ終端の位置に固定すると重力場が階段状になり、長時間の
           transfer で推定との乖離が増幅する（2026-11-22 の切り分け） */
        const sAcc = FC.starAccFn(world.starGM);
        const accsP = world.planets.map((_, i) => world.planets[i].isMoon ? FC.accExcluding(world.starGM, world.planets, i) : sAcc);
        withBodiesAt(world, s.t, () => {
          for (let k = 0; k < nSub; k++) {
            FC.rk4StepState(s, hs, accFull);
            FC.rk4StepState(world.station, hs, accFull);
            for (let i = 0; i < world.planets.length; i++) FC.rk4StepState(world.planets[i], hs, accsP[i]);
          }
        });
      }
      s.t = tEnd;
      if (!f) continue;
      /* イベント適用（この刻みの終端時刻に一致するもの） */
      withBodiesAt(world, s.t, () => {
        if (!f.departed && s.t >= f.departT) {
          f.departed = true; s.dockedAt = null;
          if (f.descent) f.descStage = 'wait';
          if (f.anchorName) {
            const a = bodyByName(world, f.anchorName);
            s.x = a.x + f.initState.x; s.y = a.y + f.initState.y; s.z = a.z + f.initState.z;
            s.vx = a.vx + f.initState.vx; s.vy = a.vy + f.initState.vy; s.vz = a.vz + f.initState.vz;
          } else {
            s.x = f.initState.x; s.y = f.initState.y; s.z = f.initState.z;
            s.vx = f.initState.vx; s.vy = f.initState.vy; s.vz = f.initState.vz;
          }
          world.events.push({ t: s.t, type: 'depart', shipId: s.id, from: f.fromName, to: f.toName });
          return;
        }
        if (f.departed && !f.arrived && f.descent) {
          /* 降下の状態機械（game.html updateDescent と同じ規則） */
          const moon = bodyByName(world, f.descent.bodyName);
          const bp = FC.moonBasePointIn(moon, world.planets);
          const distB = Math.hypot(bp.x - s.x, bp.y - s.y, bp.z - s.z);
          const relB = Math.hypot(s.vx - bp.vx, s.vy - bp.vy, s.vz - bp.vz);
          if (distB <= 40 && relB <= 2.2) {
            f.arrived = true; f.descStage = 'landed';
            s.dockedAt = moon;
            world.events.push({ t: s.t, type: 'land', shipId: s.id, at: f.descent.bodyName });
            promoteNextFiling(world, s);
            return;
          }
          if (f.descStage === 'wait' && s.t >= f.departT + f.descent.waitS) {
            const b = f.descent.burn;
            s.vx += b.dvx; s.vy += b.dvy; s.vz += b.dvz;
            s.dvUsed = (s.dvUsed || 0) + (b.cost || 0);
            f.descStage = 'coast';
            world.events.push({ t: s.t, type: 'burn', shipId: s.id, cost: b.cost || 0, descent: true });
          } else if (f.descStage === 'coast' && distB <= 3000) {
            f.descStage = 'brake'; f.descNextT = 0;
          } else if (f.descStage === 'brake') {
            const cad = distB < 600 ? 6 : 10;
            if (s.t - (f.descNextT || 0) >= cad) {
              f.descNextT = s.t;
              const dv = FC.computeDescent(s, bp, moon);
              if (dv && dv.cost > 0.01) {
                s.vx += dv.dvx; s.vy += dv.dvy; s.vz += dv.dvz;
                s.dvUsed = (s.dvUsed || 0) + dv.cost;
                world.events.push({ t: s.t, type: 'burn', shipId: s.id, cost: dv.cost, descent: true });
              }
            }
          }
          return;
        }
        if (f.departed && !f.arrived && !f.descent) {
          if (f.guidance && s.t >= f.departT + f.guidance.fromT) {
            /* 終端誘導の再実行: エンベロープ内なら到着、接近が鈍ければ
               接近噴射、速すぎればブレーキ。噴射列の fromT 以後は読まない。
               接近目標は距離連動（approachClosing、効率診断 2026-11-22） */
            const dest = bodyByName(world, f.arriveBodyName);
            const info = FC.relInfo(s, dest);
            const ad = f.guidance.arrivalDist || 90;
            if (info.dist <= Math.max(ad * 3, 300) && info.rel <= 4) {
              f.arrived = true;
              s.dockedAt = dest;
              world.events.push({ t: s.t, type: 'arrive', shipId: s.id, at: f.arriveBodyName, guided: true });
              promoteNextFiling(world, s);
              return;
            }
            let dv = null;
            const tgtClose = FC.approachClosing(info.dist);
            if (info.closing < tgtClose * 0.85) {
              const pm = info.dist || 1;
              const dvx = dest.vx + (info.dx / pm) * tgtClose - s.vx;
              const dvy = dest.vy + (info.dy / pm) * tgtClose - s.vy;
              const dvz = dest.vz + (info.dz / pm) * tgtClose - s.vz;
              dv = { dvx, dvy, dvz, cost: Math.hypot(dvx, dvy, dvz) };
            } else if (info.rel > Math.max(FC.V_CONTACT, tgtClose * 1.6)) {
              const limit = Math.max(FC.V_CONTACT, tgtClose * 1.6);
              const scale = (info.rel - limit) / info.rel;
              dv = { dvx: -info.rvx * scale, dvy: -info.rvy * scale, dvz: -info.rvz * scale, cost: info.rel - limit };
            }
            if (dv && dv.cost > 0.01) {
              s.vx += dv.dvx; s.vy += dv.dvy; s.vz += dv.dvz;
              s.dvUsed = (s.dvUsed || 0) + dv.cost;
              f.lastGuideBurnT = s.t;
              world.events.push({ t: s.t, type: 'burn', shipId: s.id, cost: dv.cost, guided: true });
            }
          } else {
            const b = f.burns[f.firedBurns];
            if (b && s.t >= f.departT + b.atT) {
              s.vx += b.dvx; s.vy += b.dvy; s.vz += b.dvz;
              s.dvUsed = (s.dvUsed || 0) + (b.cost || 0); f.firedBurns++;
              world.events.push({ t: s.t, type: 'burn', shipId: s.id, cost: b.cost || 0 });
            }
            if (!f.guidance && f.arriveT != null && s.t >= f.arriveT) {
              f.arrived = true;
              const dest = bodyByName(world, f.arriveBodyName);
              if (dest) s.dockedAt = dest;
              world.events.push({ t: s.t, type: 'arrive', shipId: s.id, at: f.arriveBodyName });
              promoteNextFiling(world, s);
              return;
            }
          }
        }
      });
    }
  }

  /* 船の次のイベント時刻（s.t より後で最も近いもの）。無ければ Infinity */
  function nextEventT(world, s) {
    const f = s.filing;
    if (!f) return Infinity;
    let nextEv = Infinity;
    if (!f.departed && f.departT > s.t && f.departT < nextEv) nextEv = f.departT;
    if (f.departed && !f.arrived && f.descent && f.descStage === 'wait') {
      const bt = f.departT + f.descent.waitS;
      if (bt > s.t && bt < nextEv) nextEv = bt;
    }
    if (f.departed && !f.arrived) {
      const guiding = f.guidance && s.t >= f.departT + f.guidance.fromT;
      if (!guiding) {
        const b = f.burns[f.firedBurns];
        if (b) { const bt = f.departT + b.atT; if (bt > s.t && bt < nextEv) nextEv = bt; }
      }
      if (f.guidance) {
        const gt = f.departT + f.guidance.fromT;
        if (gt > s.t && gt < nextEv) nextEv = gt;
      } else if (f.arriveT != null && f.arriveT > s.t && f.arriveT < nextEv) nextEv = f.arriveT;
    }
    return nextEv;
  }

  /* 世界を時刻 T まで進める（前進のみ）。船ごとに独立に伝播し、天体は
     固定刻みのグリッドで進める。メインループは全船の最も近いイベント
     時刻まで全船を揃えて進める — 船を1隻ずつ T まで進めると、後の船の
     イベント時刻が天体の内部時刻（bodyNow）より過去になり、その船は
     未来の天体状態で初期状態の復元や判定をしてしまうため */
  function advanceTo(world, T) {
    if (T < world.now) throw new Error('advanceTo cannot go backward: now=' + world.now + ' T=' + T);
    for (const s of world.ships) if (s.t == null) s.t = world.now;
    let guard = 0;
    while (world.now < T) {
      if (++guard > 100000) throw new Error('advanceTo: too many segments');
      let segT = T;
      for (const s of world.ships) { const ne = nextEventT(world, s); if (ne < segT) segT = ne; }
      /* イベントが無い区間は、船の刻みが細かくならないよう区間を
         適度な長さに区切る（各船の刻み規則は advanceShip が守る） */
      if (segT - world.now > 20000) segT = world.now + 20000;
      for (const s of world.ships) advanceShip(world, s, segT);
      world.now = segT;
      withBodiesAt(world, segT, () => {
        for (const s of world.ships) if (s.dockedAt) {
          s.x = s.dockedAt.x; s.y = s.dockedAt.y; s.z = s.dockedAt.z;
          s.vx = s.dockedAt.vx; s.vy = s.dockedAt.vy; s.vz = s.dockedAt.vz;
        }
      });
    }
    stepBodies(world, T);
    world.events.sort((a, b) => a.t - b.t);
    return world;
  }

  /* 時刻 T の世界スナップショット（表示・検証用）。状態そのものではなく
     その時点の写しを返す。 */
  function snapshot(world) {
    const pick = b => ({ name: b.name, x: b.x, y: b.y, z: b.z, vx: b.vx, vy: b.vy, vz: b.vz });
    return { t: world.now, planets: world.planets.map(pick), station: pick(world.station),
      ships: world.ships.map(s => Object.assign(pick(s), { id: s.id, dockedAt: s.dockedAt ? s.dockedAt.name : null, dvUsed: s.dvUsed || 0 })) };
  }

  return { createWorld, addShip, filePlan, advanceTo, snapshot, bodyByName };
});
