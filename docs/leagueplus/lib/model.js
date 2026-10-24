// Probability engines for League Plus.
//  fair   : Bet9ja's own odds with the margin removed (per market group)
//  mkt    : one Poisson score model fitted to Bet9ja's 1X2 + O/U + GG prices; prices EVERY selection consistently,
//           so selections Bet9ja prices out of line with its own main markets stand out
//  team   : time-decayed attack/defence ratings learned from captured results (independent of the odds)
//  blend  : average of team and mkt
const LPModel = (() => {
  const MAXG = 10;
  const pois = (l, n) => { const a = new Array(n + 1); let p = Math.exp(-l); a[0] = p; for (let k = 1; k <= n; k++) { p *= l / k; a[k] = p; } return a; };
  function matrix(lh, la) { const ph = pois(lh, MAXG), pa = pois(la, MAXG), M = []; for (let i = 0; i <= MAXG; i++) { M[i] = []; for (let j = 0; j <= MAXG; j++) M[i][j] = ph[i] * pa[j]; } return M; }
  // P(team reaches a 1-goal lead at some point): goals ~ Poisson(lh+la), each home with prob q
  function leadProb(lh, la, side) {
    const L = lh + la; if (L <= 0) return 0; const q = side === 'h' ? lh / L : la / L, pN = pois(L, 14);
    let dist = { 0: 1 }, reached = 0, res = 0;
    for (let n = 1; n <= 14; n++) {
      const nd = {}; for (const d in dist) { const v = dist[d], up = +d + 1, dn = +d - 1; if (up === 1) reached += v * q; else nd[up] = (nd[up] || 0) + v * q; nd[dn] = (nd[dn] || 0) + v * (1 - q); }
      dist = nd; res += pN[n] * reached;
    }
    return res;
  }
  // which scorelines (i*11+j) win each selection — computed once per catalogue
  const MASKS = new WeakMap();
  function mask(cat, id) {
    let C = MASKS.get(cat); if (!C) { C = new Map(); MASKS.set(cat, C); }
    let m = C.get(id); if (m) return m;
    const c = cat[id], L = []; for (let i = 0; i <= MAXG; i++) for (let j = 0; j <= MAXG; j++) if (LPCat.settle(c, i, j, null)) L.push(i * 11 + j);
    m = Int16Array.from(L); C.set(id, m); return m;
  }
  // probability of every selection in cat under a (lh, la) Poisson model
  function selProbs(cat, ids, lh, la) {
    const M = matrix(lh, la), out = new Map();
    for (const id of ids) {
      const c = cat[id]; if (!c) continue;
      if (c.type === 2 || c.cond) { out.set(id, leadProb(lh, la, c.name.trim().startsWith('1') ? 'h' : 'a')); continue; }
      const mk = mask(cat, id); let p = 0; for (let k = 0; k < mk.length; k++) { const x = mk[k]; p += M[(x / 11) | 0][x % 11]; }
      out.set(id, p);
    }
    return out;
  }
  // margin removal
  function fair(cat, om) {
    const sums = {}, F1 = (() => { let s = 0; for (const [id, o] of om) if (cat[id] && cat[id].mId === 1) s += 1 / o; return s || 1.05; })();
    for (const [id, o] of om) { const c = cat[id]; if (!c) continue; const k = LPCat.mkey(c); sums[k] = (sums[k] || 0) + 1 / o; }
    const out = new Map();
    for (const [id, o] of om) {
      const c = cat[id]; if (!c) continue; const k = LPCat.mkey(c);
      const F = c.group === 'ex' ? sums[k] : c.group === 'pair' ? sums[k] / 2 : F1;
      out.set(id, Math.min(0.995, (1 / o) / Math.max(F, 1)));
    }
    return out;
  }
  // fit (lh, la) to the fair 1X2, O/U 1.5/2.5/3.5 and GG prices
  function fitMarket(cat, fp) {
    const tgt = []; // [selId, p]
    for (const [id, p] of fp) { const c = cat[id]; if (!c) continue; if (c.mId === 1 || c.mId === 3 || (c.mId === 5 && ['1.5', '2.5', '3.5'].includes(c.sub))) tgt.push([id, p]); }
    if (!tgt.length) return null;
    const ids = tgt.map(t => t[0]);
    const err = (lh, la) => { const sp = selProbs(cat, ids, lh, la); let e = 0; for (const [id, p] of tgt) e += (sp.get(id) - p) ** 2; return e; };
    let lh = 1.4, la = 1.1, best = err(lh, la), step = 0.4;
    while (step > 0.004) {
      let moved = false;
      for (const [dh, da] of [[step, 0], [-step, 0], [0, step], [0, -step], [step, step], [-step, -step], [step, -step], [-step, step]]) {
        const h = Math.max(0.05, lh + dh), a = Math.max(0.05, la + da), e = err(h, a);
        if (e < best) { best = e; lh = h; la = a; moved = true; }
      }
      if (!moved) step /= 2;
    }
    return { lh, la, err: best };
  }
  // team ratings per competition from finished matches (time-decayed Poisson, shrunk to league mean)
  function fitTeams(matches, refTs, o = {}) {
    const hl = (o.halfLifeH || 6) * 3600e3, prior = o.prior ?? 4;
    const W = matches.map(m => Math.pow(0.5, Math.max(0, refTs - m.ts) / hl));
    let sw = 0, sH = 0, sA = 0; matches.forEach((m, i) => { sw += W[i]; sH += W[i] * m.hg; sA += W[i] * m.ag; });
    const muH = sw ? sH / sw : 1.4, muA = sw ? sA / sw : 1.1;
    const teams = new Set(); matches.forEach(m => { teams.add(m.home); teams.add(m.away); });
    const att = {}, def = {}; teams.forEach(t => { att[t] = 1; def[t] = 1; });
    for (let it = 0; it < 10; it++) {
      const nA = {}, dA = {}, nD = {}, dD = {}; teams.forEach(t => { nA[t] = prior; dA[t] = prior; nD[t] = prior; dD[t] = prior; });
      matches.forEach((m, i) => { const w = W[i], h = m.home, a = m.away; nA[h] += w * m.hg; dA[h] += w * muH * def[a]; nA[a] += w * m.ag; dA[a] += w * muA * def[h]; nD[h] += w * m.ag; dD[h] += w * muA * att[a]; nD[a] += w * m.hg; dD[a] += w * muH * att[h]; });
      let ma = 0; teams.forEach(t => { att[t] = nA[t] / dA[t]; def[t] = nD[t] / dD[t]; ma += att[t]; }); ma /= teams.size || 1;
      teams.forEach(t => { att[t] /= ma; def[t] *= ma; });
    }
    return { muH, muA, att, def, n: matches.length };
  }
  const teamLam = (T, h, a) => [T.muH * (T.att[h] ?? 1) * (T.def[a] ?? 1), T.muA * (T.att[a] ?? 1) * (T.def[h] ?? 1)];

  // all engines for one fixture. fx: {odds, sk, home, away}; selStr: selection string; T: team fit or null
  function evaluate(cat, fx, selStr, T) {
    const om = LPParse.oddsMap(fx.odds, selStr), ids = [...om.keys()];
    const fp = fair(cat, om), fit = fitMarket(cat, fp);
    const mp = fit ? selProbs(cat, ids, fit.lh, fit.la) : new Map();
    let tp = new Map(), tl = null;
    if (T && T.n >= 30) { tl = teamLam(T, fx.home, fx.away); tp = selProbs(cat, ids, tl[0], tl[1]); }
    const rows = ids.map(id => {
      const o = om.get(id), f = fp.get(id), m = mp.get(id), t = tp.get(id);
      return { id, odds: o, fair: f, mkt: m ?? f, team: t ?? null, blend: t != null && m != null ? (t + m) / 2 : (m ?? f) };
    });
    return { rows, fit, tl, om };
  }
  return { evaluate, fair, fitMarket, fitTeams, teamLam, selProbs, leadProb, matrix };
})();
if (typeof module !== 'undefined') module.exports = LPModel;
