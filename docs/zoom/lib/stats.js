// Descriptive statistics: league aggregates, team profiles, tables, streaks.
const ZStats = (() => {
  const MK = (typeof ZMarkets !== 'undefined') ? ZMarkets : require('./markets.js');
  const BK = [[1, 15], [16, 30], [31, 45], [46, 60], [61, 75], [76, 90], [91, 200]];
  const BKL = ['1-15', '16-30', '31-45', '46-60', '61-75', '76-90', '90+'];
  const bucket = (arr, mins) => (mins || []).forEach(x => { const i = BK.findIndex(([a, b]) => x >= a && x <= b); if (i >= 0) arr[i]++; });
  const pct = (a, b) => (b ? (100 * a / b) : 0);

  function marketFreq(ms) {
    const out = {};
    for (const mk of MK.list) {
      let n = 0; const c = {};
      for (const m of ms) { const h = MK.hits(m, mk); if (!h) continue; n++; mk.opts.forEach((o, i) => { if (h[i]) c[o.k] = (c[o.k] || 0) + 1; }); }
      out[mk.id] = { n, pct: Object.fromEntries(mk.opts.map(o => [o.k, pct(c[o.k] || 0, n)])) };
    }
    return out;
  }

  function league(ms, deepMap) {
    const n = ms.length; const o = { n };
    if (!n) return o;
    let hg = 0, ag = 0, hth = 0, hta = 0, hc = 0, ac = 0, hthc = 0, htac = 0, fgN = 0, fgSum = 0, earlyH = 0, earlyA = 0, gold = 0;
    const gb = Array(7).fill(0), cb = Array(7).fill(0), cs = {}, tg = {}, tc = {}, sc = {};
    const d = { n: 0, possH: 0, onH: 0, onA: 0, offH: 0, offA: 0, saveH: 0, saveA: 0, wpN: 0, wpFavHit: 0 };
    for (const m of ms) {
      hg += m.hg; ag += m.ag; hth += m.hth; hta += m.hta;
      if (m.hc != null) { hc += m.hc; ac += m.ac; hthc += m.hthc || 0; htac += m.htac || 0; tc[m.hc + m.ac] = (tc[m.hc + m.ac] || 0) + 1; }
      bucket(gb, m.hGoals); bucket(gb, m.aGoals); bucket(cb, m.hcMin); bucket(cb, m.acMin);
      const all = (m.hGoals || []).concat(m.aGoals || []);
      if (all.length) { fgN++; fgSum += Math.min(...all); }
      cs[m.hg + '-' + m.ag] = (cs[m.hg + '-' + m.ag] || 0) + 1;
      tg[m.hg + m.ag] = (tg[m.hg + m.ag] || 0) + 1;
      if (m.earlyH) earlyH++; if (m.earlyA) earlyA++;
      gold += (m.goldH || []).length + (m.goldA || []).length;
      (m.scH || []).forEach(s => { const k = s.name + '|' + m.home; sc[k] = (sc[k] || 0) + s.mins.length; });
      (m.scA || []).forEach(s => { const k = s.name + '|' + m.away; sc[k] = (sc[k] || 0) + s.mins.length; });
      const dp = deepMap && deepMap.get(m.matchId);
      if (dp && dp.ok) {
        d.n++; d.possH += dp.possH || 0; d.onH += dp.onH; d.onA += dp.onA; d.offH += dp.offH; d.offA += dp.offA; d.saveH += dp.saveH; d.saveA += dp.saveA;
        if (dp.wp) { d.wpN++; const fav = dp.wp.home >= dp.wp.away ? (dp.wp.home >= dp.wp.draw ? '1' : 'X') : (dp.wp.away >= dp.wp.draw ? '2' : 'X'); if (fav === MK.R(m.hg, m.ag)) d.wpFavHit++; }
      }
    }
    const nc = ms.filter(m => m.hc != null).length || 1;
    Object.assign(o, {
      avgGoals: (hg + ag) / n, avgHome: hg / n, avgAway: ag / n, avgHT: (hth + hta) / n, avg2H: (hg + ag - hth - hta) / n,
      htShare: (hg + ag) ? (hth + hta) / (hg + ag) : 0,
      avgCorners: (hc + ac) / nc, avgHC: hc / nc, avgAC: ac / nc, avgHTCorners: (hthc + htac) / nc,
      goalBuckets: gb, cornerBuckets: cb, bucketLabels: BKL,
      firstGoalAvg: fgN ? fgSum / fgN : null, noGoalPct: pct(n - fgN, n),
      cs: Object.entries(cs).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, pct(v, n)]),
      totalGoals: tg, totalCorners: tc,
      early: { home: pct(earlyH, n), away: pct(earlyA, n) }, goldenGoals: gold,
      scorers: Object.entries(sc).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([k, v]) => { const [name, team] = k.split('|'); return { name, team: +team, goals: v }; }),
      deep: d.n ? { n: d.n, possH: d.possH / d.n, onH: d.onH / d.n, onA: d.onA / d.n, offH: d.offH / d.n, offA: d.offA / d.n, saveH: d.saveH / d.n, saveA: d.saveA / d.n, wpN: d.wpN, wpFavPct: pct(d.wpFavHit, d.wpN) } : null,
      markets: marketFreq(ms)
    });
    return o;
  }

  // Team perspective of a match
  function persp(m, t) {
    const home = m.home === t;
    const gf = home ? m.hg : m.ag, ga = home ? m.ag : m.hg;
    return {
      m, home, opp: home ? m.away : m.home, gf, ga,
      htgf: home ? m.hth : m.hta, htga: home ? m.hta : m.hth,
      cf: home ? m.hc : m.ac, ca: home ? m.ac : m.hc,
      res: gf > ga ? 'W' : gf < ga ? 'L' : 'D',
      gMinF: home ? m.hGoals : m.aGoals, gMinA: home ? m.aGoals : m.hGoals,
      sc: home ? m.scH : m.scA
    };
  }

  function rec(list) {
    const r = { P: 0, W: 0, D: 0, L: 0, GF: 0, GA: 0, Pts: 0, CS: 0, FTS: 0, GG: 0, O15: 0, O25: 0, O35: 0, CF: 0, CA: 0, HTW: 0, HTD: 0, HTL: 0 };
    list.forEach(p => {
      r.P++; r[p.res]++; r.GF += p.gf; r.GA += p.ga; r.Pts += p.res === 'W' ? 3 : p.res === 'D' ? 1 : 0;
      if (p.ga === 0) r.CS++; if (p.gf === 0) r.FTS++; if (p.gf && p.ga) r.GG++;
      const t = p.gf + p.ga; if (t > 1.5) r.O15++; if (t > 2.5) r.O25++; if (t > 3.5) r.O35++;
      r.CF += p.cf || 0; r.CA += p.ca || 0;
      if (p.htgf > p.htga) r.HTW++; else if (p.htgf < p.htga) r.HTL++; else r.HTD++;
    });
    return r;
  }

  function streaks(list) { // list newest last
    const tests = {
      'Unbeaten': p => p.res !== 'L', 'Winless': p => p.res !== 'W', 'Wins': p => p.res === 'W', 'Losses': p => p.res === 'L',
      'Draws': p => p.res === 'D', 'GG': p => p.gf > 0 && p.ga > 0, 'NG': p => !(p.gf > 0 && p.ga > 0),
      'Over 2.5': p => p.gf + p.ga > 2.5, 'Under 2.5': p => p.gf + p.ga < 2.5, 'Scored': p => p.gf > 0,
      'Failed to score': p => p.gf === 0, 'Clean sheet': p => p.ga === 0, 'Conceded': p => p.ga > 0
    };
    const out = {};
    for (const [k, f] of Object.entries(tests)) { let c = 0; for (let i = list.length - 1; i >= 0 && f(list[i]); i--) c++; out[k] = c; }
    return out;
  }

  function team(t, ms, deepMap) {
    const all = ms.filter(m => m.home === t || m.away === t).sort((a, b) => a.ts - b.ts).map(m => persp(m, t));
    const H = all.filter(p => p.home), A = all.filter(p => !p.home);
    const gfB = Array(7).fill(0), gaB = Array(7).fill(0); const sc = {};
    all.forEach(p => { bucket(gfB, p.gMinF); bucket(gaB, p.gMinA); (p.sc || []).forEach(s => { sc[s.name] = (sc[s.name] || 0) + s.mins.length; }); });
    const d = { n: 0, poss: 0, on: 0, off: 0, onA: 0 };
    all.forEach(p => { const dp = deepMap && deepMap.get(p.m.matchId); if (dp && dp.ok) { d.n++; d.poss += p.home ? dp.possH : dp.possA; d.on += p.home ? dp.onH : dp.onA; d.off += p.home ? dp.offH : dp.offA; d.onA += p.home ? dp.onA : dp.onH; } });
    return {
      list: all, all: rec(all), home: rec(H), away: rec(A), streaks: streaks(all),
      gfB, gaB, scorers: Object.entries(sc).sort((a, b) => b[1] - a[1]).slice(0, 10),
      deep: d.n ? { n: d.n, poss: d.poss / d.n, on: d.on / d.n, off: d.off / d.n, onA: d.onA / d.n } : null
    };
  }

  function table(ms) {
    const T = {};
    const row = id => T[id] || (T[id] = { id, P: 0, W: 0, D: 0, L: 0, GF: 0, GA: 0, Pts: 0, form: [] });
    ms.slice().sort((a, b) => a.ts - b.ts).forEach(m => {
      const h = row(m.home), a = row(m.away);
      h.P++; a.P++; h.GF += m.hg; h.GA += m.ag; a.GF += m.ag; a.GA += m.hg;
      if (m.hg > m.ag) { h.W++; a.L++; h.Pts += 3; h.form.push('W'); a.form.push('L'); }
      else if (m.hg < m.ag) { a.W++; h.L++; a.Pts += 3; h.form.push('L'); a.form.push('W'); }
      else { h.D++; a.D++; h.Pts++; a.Pts++; h.form.push('D'); a.form.push('D'); }
    });
    return Object.values(T).sort((x, y) => y.Pts - x.Pts || (y.GF - y.GA) - (x.GF - x.GA) || y.GF - x.GF);
  }

  return { league, team, table, persp, marketFreq, BKL };
})();
if (typeof module !== 'undefined') module.exports = ZStats;
