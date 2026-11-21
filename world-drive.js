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
      events: []           /* { t, type: 'depart'|'burn'|'arrive', shipId, ... } */
    };
  }

  function addShip(world, id, name) {
    const ship = { id, name, x: world.station.x, y: world.station.y, z: world.station.z,
      vx: world.station.vx, vy: world.station.vy, vz: world.station.vz,
      gm: 0, radius: 5, isShip: true, isMoon: false,
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
     決まり、arriveT の固定到着は使わない。 */
  function filePlan(world, filing) {
    const ship = world.ships.find(s => s.id === filing.shipId);
    if (!ship) throw new Error('ship not found: ' + filing.shipId);
    ship.filing = Object.assign({}, filing, { firedBurns: 0, departed: false, arrived: false });
    return ship.filing;
  }

  function bodyByName(world, name) {
    if (world.station.name === name) return world.station;
    return world.planets.find(p => p.name === name) || null;
  }

  /* 世界を時刻 T まで進める（前進のみ）。天体・ステーション・航行中の船を
     伝播し、申告の噴射と到着を時刻どおりに適用して出来事を記録する。
     ドック中の船は係留先に追随する。イベント時刻では刻みを割って正確に
     着地させる。
     刻みは推定器（flight-core のメインループ＋propStar）と同じ規則にする
     （2026-11-22 の運航試験で特定: 計画は推定器の刻みでの実行を前提に
     作られており、駆動の刻みが違うと重力井戸の中で軌跡が分かれて到着が
     再現できない。細刻みの連成 RK4 では対月距離 215,245 の非束縛、
     推定器の規則では 6,597 の束縛到着で再現した）:
       メイン刻み h = min(航行中の船の dynStep(BIG_EST) と目標との
       encounterCap、イベントまでの残り)、船が天体の 300,000 以内では
       20 秒 cap。サブステップは天体系＋ステーション＋各船の目標の
       最速軌道周期の 1%（capP、最低 20 秒）で割り、全ボディを hs の
       逐次 RK4 で進める（惑星=恒星のみ／月=自分以外／ステーション・船
       =全重力、順序は船→ステーション→天体系） */
  function advanceTo(world, T) {
    if (T < world.now) throw new Error('advanceTo cannot go backward: now=' + world.now + ' T=' + T);
    const BIG_EST = 0.75 * (FC.SCALE_K || 386700);
    const sAcc = FC.starAccFn(world.starGM);
    const accFull = FC.fullAccFn(world.starGM, world.planets);
    const accsP = world.planets.map((_, i) => world.planets[i].isMoon ? FC.accExcluding(world.starGM, world.planets, i) : sAcc);
    while (world.now < T) {
      /* 次のイベント時刻（申告の出発・噴射・到着）までで刻みを割る */
      let nextEv = T;
      for (const s of world.ships) {
        const f = s.filing; if (!f) continue;
        if (!f.departed && f.departT > world.now && f.departT < nextEv) nextEv = f.departT;
        if (f.departed && !f.arrived) {
          const guiding = f.guidance && world.now >= f.departT + f.guidance.fromT;
          if (!guiding) {
            const b = f.burns[f.firedBurns];
            if (b) { const bt = f.departT + b.atT; if (bt > world.now && bt < nextEv) nextEv = bt; }
          }
          if (f.guidance) {
            const gt = f.departT + f.guidance.fromT;
            if (gt > world.now && gt < nextEv) nextEv = gt;
          } else if (f.arriveT > world.now && f.arriveT < nextEv) nextEv = f.arriveT;
        }
      }
      const flying = world.ships.filter(s => !s.dockedAt);
      /* メイン刻み: 航行中の船がいれば推定器の規則、いなければ天体系の
         維持に dynStep（上限 900）を使う */
      let h = nextEv - world.now;
      if (flying.length) {
        for (const s of flying) {
          h = Math.min(h, FC.dynStep(s.x, s.y, s.z, world.starGM, world.planets, BIG_EST));
          const dest = s.filing && s.filing.arriveBodyName ? bodyByName(world, s.filing.arriveBodyName) : null;
          if (dest) h = Math.min(h, FC.encounterCap(s, dest));
          let dMin = Infinity;
          for (const p of world.planets) { if (!p.gm) continue; const d = Math.hypot(s.x - p.x, s.y - p.y, s.z - p.z); if (d < dMin) dMin = d; }
          if (dMin < 300000) h = Math.min(h, 20);
          /* 終端誘導中は推定器の final と同じ 8 秒刻みにする */
          if (s.filing && s.filing.guidance && s.filing.departed && world.now >= s.filing.departT + s.filing.guidance.fromT) h = Math.min(h, 8);
        }
      } else {
        h = Math.min(h, 900);
        for (const b of world.planets.concat([world.station])) h = Math.min(h, FC.dynStep(b.x, b.y, b.z, world.starGM, world.planets, 900));
      }
      if (!(h > 0)) h = nextEv - world.now;
      /* サブステップ幅 capP: 天体系＋ステーション＋各船の目標について、
         最強重力源まわりの周期の 1%（最低 20 秒）の最小値 */
      let capP = h;
      const consider = (b) => {
        let bGm = world.starGM, bD = Math.hypot(b.x, b.y, b.z);
        for (const q of world.planets) { if (q !== b && q.gm > 0) { const d = Math.hypot(b.x - q.x, b.y - q.y, b.z - q.z); if (d > 1 && q.gm / (d * d) > bGm / Math.max(1, bD * bD)) { bGm = q.gm; bD = d; } } }
        if (bGm > 0 && bD > 0) capP = Math.min(capP, Math.max(20, 2 * Math.PI * Math.sqrt(Math.pow(bD, 3) / bGm) * 0.01));
      };
      for (const p of world.planets) consider(p);
      consider(world.station);
      for (const s of flying) { const dest = s.filing && s.filing.arriveBodyName ? bodyByName(world, s.filing.arriveBodyName) : null; if (dest && dest !== world.station) consider(dest); }
      const nSub = Math.min(400, Math.max(1, Math.ceil(h / Math.max(1, capP))));
      const hs = h / nSub;
      for (let k = 0; k < nSub; k++) {
        for (const s of flying) FC.rk4StepState(s, hs, accFull);
        FC.rk4StepState(world.station, hs, accFull);
        for (let i = 0; i < world.planets.length; i++) FC.rk4StepState(world.planets[i], hs, accsP[i]);
      }
      world.now += h;
      /* ドック中の船は係留先に追随 */
      for (const s of world.ships) if (s.dockedAt) {
        s.x = s.dockedAt.x; s.y = s.dockedAt.y; s.z = s.dockedAt.z;
        s.vx = s.dockedAt.vx; s.vy = s.dockedAt.vy; s.vz = s.dockedAt.vz;
      }
      /* イベント適用（この刻みの終端時刻に一致するもの） */
      for (const s of world.ships) {
        const f = s.filing; if (!f) continue;
        if (!f.departed && world.now >= f.departT) {
          f.departed = true; s.dockedAt = null;
          s.x = f.initState.x; s.y = f.initState.y; s.z = f.initState.z;
          s.vx = f.initState.vx; s.vy = f.initState.vy; s.vz = f.initState.vz;
          world.events.push({ t: world.now, type: 'depart', shipId: s.id, from: f.fromName, to: f.toName });
          /* 新しく航行中になった船は次の刻みから伝播に加わる必要があるため再構築する */
          return advanceTo(world, T);
        }
        if (f.departed && !f.arrived) {
          if (f.guidance && world.now >= f.departT + f.guidance.fromT) {
            /* 終端誘導の再実行（推定器 final の誘導則、needDock=false）:
               エンベロープ内なら到着、接近が鈍ければ接近噴射、速すぎれば
               ブレーキ。噴射列の fromT 以後は読まない */
            const dest = bodyByName(world, f.arriveBodyName);
            const info = FC.relInfo(s, dest);
            const ad = f.guidance.arrivalDist || 90;
            if (info.dist <= Math.max(ad * 3, 300) && info.rel <= 4) {
              f.arrived = true;
              s.dockedAt = dest;
              world.events.push({ t: world.now, type: 'arrive', shipId: s.id, at: f.arriveBodyName, guided: true });
              return advanceTo(world, T);
            }
            /* 接近目標は距離連動（推定器 cruise の approachClosing）。
               0.9 固定だと開始位置が遠い時に接近が遅れ、0.2 級の小噴射が
               何百発も積み上がる（2026-11-22 の効率診断）。ブレーキの
               上限も同じ目標に連動させる */
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
              f.lastGuideBurnT = world.now;
              world.events.push({ t: world.now, type: 'burn', shipId: s.id, cost: dv.cost, guided: true });
            }
          } else {
            const b = f.burns[f.firedBurns];
            if (b && world.now >= f.departT + b.atT) {
              s.vx += b.dvx; s.vy += b.dvy; s.vz += b.dvz;
              s.dvUsed = (s.dvUsed || 0) + (b.cost || 0); f.firedBurns++;
              world.events.push({ t: world.now, type: 'burn', shipId: s.id, cost: b.cost || 0 });
            }
            if (!f.guidance && world.now >= f.arriveT) {
              f.arrived = true;
              const dest = bodyByName(world, f.arriveBodyName);
              if (dest) s.dockedAt = dest;
              world.events.push({ t: world.now, type: 'arrive', shipId: s.id, at: f.arriveBodyName });
              return advanceTo(world, T);
            }
          }
        }
      }
    }
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
