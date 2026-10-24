// Prediction engines
//  POISSON : Dixon-Coles style time-decayed attack/defence ratings per league (goals and corners),
//            half-split from league half-time share; every market derived from score distributions.
//  FORM    : frequency engine – home team's last N HOME games + away team's last N AWAY games,
//            shrunk toward the league base rate.
//  BLEND   : weighted mix of POISSON and FORM.
//  BASE    : league base rate (what "always bet the most common outcome" would give) – the benchmark.
//  ZOOM    : the site's own published win probabilities (1X2 only, from deep stats) – reference.
const ZModel = (() => {
  const MK = (typeof ZMarkets !== 'undefined') ? ZMarkets : require('./markets.js');

  function pois(l, max) {
    const a = new Array(max + 1);
    let p = Math.exp(-l); a[0] = p;
    for (let k = 1; k <= max; k++) { p *= l / k; a[k] = p; }
    return a;
  }

  // Generic time-decayed Poisson strength fit (used for goals and corners)
  function fitStrength(ms, W, gH, gA, prior) {
    let sw = 0, sH = 0, sA = 0;
    ms.forEach((m, i) => { const w = W[i]; sw += w; sH += w * gH(m); sA += w * gA(m); });
    const muH = sw ? sH / sw : 1.4, muA = sw ? sA / sw : 1.1;
    const teams = new Set(); ms.forEach(m => { teams.add(m.home); teams.add(m.away); });
    const att = {}, def = {};
    teams.forEach(t => { att[t] = 1; def[t] = 1; });
    for (let it = 0; it < 12; it++) {
      const nA = {}, dA = {}, nD = {}, dD = {};
      teams.forEach(t => { nA[t] = prior; dA[t] = prior; nD[t] = prior; dD[t] = prior; });
      ms.forEach((m, i) => {
        const w = W[i], h = m.home, a = m.away, x = gH(m), y = gA(m);
        nA[h] += w * x; dA[h] += w * muH * def[a];
        nA[a] += w * y; dA[a] += w * muA * def[h];
        nD[h] += w * y; dD[h] += w * muA * att[a];
        nD[a] += w * x; dD[a] += w * muH * att[h];
      });
      let ma = 0;
      teams.forEach(t => { att[t] = nA[t] / dA[t]; def[t] = nD[t] / dD[t]; ma += att[t]; });
      ma /= teams.size || 1;
      teams.forEach(t => { att[t] /= ma; def[t] *= ma; });
    }
    return { muH, muA, att, def };
  }
  const lam = (f, h, a) => [f.muH * (f.att[h] ?? 1) * (f.def[a] ?? 1), f.muA * (f.att[a] ?? 1) * (f.def[h] ?? 1)];

  function tau(x, y, l, m, r) {
    if (x === 0 && y === 0) return 1 - l * m * r;
    if (x === 0 && y === 1) return 1 + l * r;
    if (x === 1 && y === 0) return 1 + m * r;
    if (x === 1 && y === 1) return 1 - r;
    return 1;
  }

  // Fit everything from history (matches strictly before refTs, same league)
  function prepare(hist, refTs, o) {
    const ms = hist.slice(-o.maxHist);
    const hl = o.halfLifeH * 3600e3;
    const W = ms.map(m => Math.pow(0.5, Math.max(0, refTs - m.ts) / hl));
    const g = fitStrength(ms, W, m => m.hg, m => m.ag, o.prior);
    const withC = ms.filter(m => m.hc != null);
    const Wc = withC.map(m => Math.pow(0.5, Math.max(0, refTs - m.ts) / hl));
    const c = fitStrength(withC, Wc, m => m.hc, m => m.ac, o.prior);
    // half-time share
    let sH = 0, sA = 0, tH = 0, tA = 0;
    ms.forEach((m, i) => { sH += W[i] * m.hth; tH += W[i] * m.hg; sA += W[i] * m.hta; tA += W[i] * m.ag; });
    const shareH = tH ? Math.min(0.7, Math.max(0.25, sH / tH)) : 0.44;
    const shareA = tA ? Math.min(0.7, Math.max(0.25, sA / tA)) : 0.44;
    // Dixon-Coles rho by grid search
    let rho = 0, best = -Infinity;
    const L = ms.map(m => lam(g, m.home, m.away));
    for (let r = -0.2; r <= 0.2001; r += 0.02) {
      let ll = 0;
      for (let i = 0; i < ms.length; i++) {
        const m = ms[i]; if (m.hg > 1 || m.ag > 1) continue;
        const t = tau(m.hg, m.ag, L[i][0], L[i][1], r);
        ll += W[i] * Math.log(Math.max(t, 1e-6));
      }
      if (ll > best) { best = ll; rho = r; }
    }
    return { g, c, rho: +rho.toFixed(2), shareH, shareA, totS: o.totShrink ?? 1, n: ms.length };
  }

  // Total-goal shrink: keeps the home/away ratio (what drives 1X2) but pulls the expected TOTAL
  // toward the league mean – backtests showed raw totals are over-dispersed in Zoom.
  function shrinkTot(lh, la, muH, muA, s) {
    if (s >= 1) return [lh, la];
    const T = lh + la, M = muH + muA, T2 = M + (T - M) * s;
    return [lh * T2 / T, la * T2 / T];
  }

  function ctxFor(S, h, a) {
    const [lh, la] = shrinkTot(...lam(S.g, h, a), S.g.muH, S.g.muA, S.totS ?? 1);
    const [ch, ca] = shrinkTot(...lam(S.c, h, a), S.c.muH, S.c.muA, S.totS ?? 1);
    const ph = pois(lh, 10), pa = pois(la, 10);
    const mat = []; let tot = 0;
    for (let i = 0; i <= 10; i++) { mat[i] = []; for (let j = 0; j <= 10; j++) { const v = Math.max(0, ph[i] * pa[j] * tau(i, j, lh, la, S.rho)); mat[i][j] = v; tot += v; } }
    for (let i = 0; i <= 10; i++) for (let j = 0; j <= 10; j++) mat[i][j] /= tot;
    return {
      lh, la, ch, ca, mat,
      hH: pois(lh * S.shareH, 6), hA: pois(la * S.shareA, 6),
      sH: pois(lh * (1 - S.shareH), 6), sA: pois(la * (1 - S.shareA), 6),
      cH: pois(ch, 25), cA: pois(ca, 25)
    };
  }

  function norm(out, mk) {
    if (!mk.exclusive) return out;
    const s = Object.values(out).reduce((x, y) => x + y, 0) || 1;
    for (const k in out) out[k] /= s;
    return out;
  }

  function poissonProbs(ctx, mk) {
    const out = {};
    for (const o of mk.opts) {
      let p = 0;
      if (mk.kind === 'ft') {
        for (let i = 0; i <= 10; i++) for (let j = 0; j <= 10; j++) if (o.f(i, j)) p += ctx.mat[i][j];
      } else if (mk.kind === 'ht') {
        for (let i = 0; i <= 6; i++) for (let j = 0; j <= 6; j++) if (o.f(i, j)) p += ctx.hH[i] * ctx.hA[j];
      } else if (mk.kind === 'half') {
        for (let a = 0; a <= 6; a++) for (let b = 0; b <= 6; b++) {
          const pab = ctx.hH[a] * ctx.hA[b]; if (pab < 1e-7) continue;
          for (let c = 0; c <= 6; c++) for (let d = 0; d <= 6; d++) if (o.f(a, b, c, d)) p += pab * ctx.sH[c] * ctx.sA[d];
        }
      } else if (mk.kind === 'corners') {
        for (let i = 0; i <= 25; i++) for (let j = 0; j <= 25; j++) if (o.f(i, j)) p += ctx.cH[i] * ctx.cA[j];
      }
      out[o.k] = p;
    }
    return norm(out, mk);
  }

  // League base-rate counter (cumulative)
  function newBase() { return { n: {}, c: {} }; }
  function addBase(B, m) {
    for (const mk of MK.list) {
      const h = MK.hits(m, mk); if (!h) continue;
      B.n[mk.id] = (B.n[mk.id] || 0) + 1;
      const c = B.c[mk.id] || (B.c[mk.id] = {});
      mk.opts.forEach((o, i) => { if (h[i]) c[o.k] = (c[o.k] || 0) + 1; });
    }
  }
  function baseProbs(B, mk) {
    const n = B.n[mk.id] || 0, c = B.c[mk.id] || {}, k = mk.opts.length;
    const out = {};
    mk.opts.forEach(o => { out[o.k] = mk.exclusive ? ((c[o.k] || 0) + 1) / (n + k) : ((c[o.k] || 0) + 0.5) / (n + 1); });
    return norm(out, mk);
  }

  // Form engine. homeHist = home team's recent HOME matches, awayHist = away team's recent AWAY matches
  function formProbs(mk, homeHist, awayHist, base, alpha) {
    const out = {};
    const cnt = {};
    let n = 0;
    for (const m of homeHist.concat(awayHist)) {
      const h = MK.hits(m, mk); if (!h) continue; n++;
      mk.opts.forEach((o, i) => { if (h[i]) cnt[o.k] = (cnt[o.k] || 0) + 1; });
    }
    mk.opts.forEach(o => { out[o.k] = ((cnt[o.k] || 0) + alpha * base[o.k]) / (n + alpha); });
    return norm(out, mk);
  }

  function blend(p1, p2, w, mk) {
    const out = {};
    for (const k in p1) out[k] = w * p1[k] + (1 - w) * (p2[k] ?? p1[k]);
    return norm(out, mk);
  }

  function zoomProbs(deep, mk) {
    if (mk.id !== '1X2' || !deep || !deep.wp) return null;
    const s = (deep.wp.home || 0) + (deep.wp.draw || 0) + (deep.wp.away || 0);
    if (!s) return null;
    return { '1': deep.wp.home / s, 'X': deep.wp.draw / s, '2': deep.wp.away / s };
  }

  function pick(probs) {
    let bk = null, bp = -1;
    for (const k in probs) if (probs[k] > bp) { bp = probs[k]; bk = k; }
    return { k: bk, p: bp };
  }

  // Full prediction for one fixture, given league history (sorted by ts)
  function leagueBase(hist) { const B = newBase(); hist.forEach(m => addBase(B, m)); return B; }
  function predict(hist, h, a, o, refTs, S, B) {
    refTs = refTs || (hist.length ? hist[hist.length - 1].ts + 1 : Date.now());
    S = S || prepare(hist, refTs, o);
    const ctx = ctxFor(S, h, a);
    B = B || leagueBase(hist);
    const hh = hist.filter(m => m.home === h).slice(-o.formN);
    const ah = hist.filter(m => m.away === a).slice(-o.formN);
    const markets = {};
    for (const mk of MK.list) {
      const base = baseProbs(B, mk);
      const poisson = poissonProbs(ctx, mk);
      const form = formProbs(mk, hh, ah, base, o.alpha);
      markets[mk.id] = { base, poisson, form, blend: blend(poisson, form, o.blendW, mk) };
    }
    return { S, ctx, markets, nHome: hh.length, nAway: ah.length };
  }

  // Walk-forward backtest for one league. matches sorted by ts. Never uses a match before it is played.
  async function backtest(matches, o, { lastRounds = 150, onProgress, deepMap, markets } = {}) {
    const mks = markets ? MK.list.filter(m => markets.includes(m.id)) : MK.list;
    const groups = [];
    let cur = null;
    for (const m of matches) {
      const key = m.season + '|' + m.round;
      if (!cur || cur.key !== key) { cur = { key, ts: m.ts, ms: [] }; groups.push(cur); }
      cur.ms.push(m);
    }
    const startIdx = Math.max(0, groups.length - lastRounds);
    const hist = [], B = newBase(), homeH = {}, awayH = {};
    const res = {}; // mkId -> engine -> stats
    const calib = {}; // mkId -> engine -> [ [p,hit] ]
    const engines = ['base', 'poisson', 'form', 'blend', 'zoom'];
    const rec = (mk, eng, probs, hitArr) => {
      const R = (res[mk.id] = res[mk.id] || {});
      const s = (R[eng] = R[eng] || { n: 0, hit: 0, ll: 0, brier: 0, hcN: 0, hcHit: 0 });
      const pk = pick(probs);
      const idx = mk.opts.findIndex(x => x.k === pk.k);
      s.n++;
      if (hitArr[idx]) s.hit++;
      if (pk.p >= o.conf) { s.hcN++; if (hitArr[idx]) s.hcHit++; }
      let br = 0;
      mk.opts.forEach((op, i) => { const y = hitArr[i] ? 1 : 0; br += (probs[op.k] - y) ** 2; });
      s.brier += br / mk.opts.length;
      if (mk.exclusive) { const wi = hitArr.indexOf(true); s.ll += -Math.log(Math.max(1e-6, probs[mk.opts[wi].k])); }
      const CM = (calib[mk.id] = calib[mk.id] || {});
      const C = (CM[eng] = CM[eng] || Array.from({ length: 10 }, () => [0, 0, 0]));
      mk.opts.forEach((op, i) => { const p = probs[op.k]; const b = C[Math.min(9, Math.floor(p * 10))]; b[0] += p; b[1] += hitArr[i] ? 1 : 0; b[2]++; });
    };
    let evaluated = 0;
    for (let gi = 0; gi < groups.length; gi++) {
      const G = groups[gi];
      if (gi >= startIdx && hist.length >= 60) {
        const S = prepare(hist, G.ts, o);
        for (const m of G.ms) {
          const ctx = ctxFor(S, m.home, m.away);
          const hh = (homeH[m.home] || []).slice(-o.formN), ah = (awayH[m.away] || []).slice(-o.formN);
          for (const mk of mks) {
            const hitArr = MK.hits(m, mk); if (!hitArr) continue;
            const base = baseProbs(B, mk);
            const poisson = poissonProbs(ctx, mk);
            const form = formProbs(mk, hh, ah, base, o.alpha);
            rec(mk, 'base', base, hitArr);
            rec(mk, 'poisson', poisson, hitArr);
            rec(mk, 'form', form, hitArr);
            rec(mk, 'blend', blend(poisson, form, o.blendW, mk), hitArr);
            const z = zoomProbs(deepMap && deepMap.get(m.matchId), mk);
            if (z) rec(mk, 'zoom', z, hitArr);
          }
          evaluated++;
        }
      }
      for (const m of G.ms) {
        hist.push(m); addBase(B, m);
        (homeH[m.home] = homeH[m.home] || []).push(m);
        (awayH[m.away] = awayH[m.away] || []).push(m);
      }
      if (onProgress && gi % 3 === 0) { onProgress(gi / groups.length); await new Promise(r => setTimeout(r, 0)); }
    }
    return { res, calib, evaluated, engines };
  }

  // Walk-forward predictions for the slip backtest: for each of the last N rounds, every match's
  // probabilities (chosen engine) for the given markets, computed only from earlier matches.
  async function walkPreds(matches, o, { lastRounds = 60, markets, eng = 'blend', onProgress } = {}) {
    const mks = MK.list.filter(m => markets.includes(m.id));
    const groups = []; let cur = null;
    for (const m of matches) { const key = m.season + '|' + m.round; if (!cur || cur.key !== key) { cur = { key, ts: m.ts, ms: [] }; groups.push(cur); } cur.ms.push(m); }
    const startIdx = Math.max(0, groups.length - lastRounds);
    const hist = [], B = newBase(), homeH = {}, awayH = {}, out = [];
    for (let gi = 0; gi < groups.length; gi++) {
      const G = groups[gi];
      if (gi >= startIdx && hist.length >= 60) {
        const S = prepare(hist, G.ts, o); const R = { ts: G.ts, matches: [] };
        for (const m of G.ms) {
          const ctx = ctxFor(S, m.home, m.away);
          const hh = (homeH[m.home] || []).slice(-o.formN), ah = (awayH[m.away] || []).slice(-o.formN);
          const probs = {}, won = {};
          for (const mk of mks) {
            const hit = MK.hits(m, mk); if (!hit) continue;
            const base = baseProbs(B, mk), po = poissonProbs(ctx, mk);
            const pr = eng === 'poisson' ? po : eng === 'base' ? base : eng === 'form' ? formProbs(mk, hh, ah, base, o.alpha) : blend(po, formProbs(mk, hh, ah, base, o.alpha), o.blendW, mk);
            probs[mk.id] = pr; won[mk.id] = Object.fromEntries(mk.opts.map((x, i) => [x.k, hit[i]]));
          }
          R.matches.push({ m, probs, won });
        }
        out.push(R);
      }
      for (const m of G.ms) { hist.push(m); addBase(B, m); (homeH[m.home] = homeH[m.home] || []).push(m); (awayH[m.away] = awayH[m.away] || []).push(m); }
      if (onProgress && gi % 3 === 0) { onProgress(gi / groups.length); await new Promise(r => setTimeout(r, 0)); }
    }
    return out;
  }

  return { pois, leagueBase, prepare, ctxFor, poissonProbs, formProbs, baseProbs, newBase, addBase, blend, pick, predict, backtest, walkPreds, zoomProbs };
})();
if (typeof module !== 'undefined') module.exports = ZModel;
