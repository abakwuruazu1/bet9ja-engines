// Walk-forward backtest: each round is predicted using ONLY matches played before it.
// Engines: 'model' (ratings + seed prior + exact Markov), 'base' (historical frequency of each outcome).
const TBacktest = (() => {
  const TM = () => (typeof TMarkov !== 'undefined' ? TMarkov : require('./tmarkov.js'));
  const MO = () => (typeof TModel !== 'undefined' ? TModel : require('./tmodel.js'));
  const MK = () => (typeof TMarkets !== 'undefined' ? TMarkets : require('./tmarkets.js'));

  function rankMap(list) { // list of matches in one tournament -> Map id -> rank
    let mn = Infinity; list.forEach(m => { mn = Math.min(mn, m.p1, m.p2); });
    const r = new Map(); list.forEach(m => { r.set(m.p1, m.p1 - mn); r.set(m.p2, m.p2 - mn); }); return r;
  }

  async function run(matches, o, { lastRounds = 1000, minHist = 30, onProgress } = {}) {
    const T = TM(), M = MO(), K = MK();
    const ms = matches.filter(m => m.serve && m.sets && m.sets.length >= 2).sort((a, b) => a.ts - b.ts || a.matchId - b.matchId);
    const groups = []; let cur = null;
    for (const m of ms) { const key = m.comp + '|' + m.ts; if (!cur || cur.key !== key) { cur = { key, comp: m.comp, ts: m.ts, ms: [] }; groups.push(cur); } cur.ms.push(m); }
    const start = Math.max(0, groups.length - lastRounds);
    const res = {}, cal = {};
    const freq = {}; // comp -> mkId -> {n, c:{k:count}}
    const rec = (id, eng, probs, win) => {
      const s = ((res[id] = res[id] || {})[eng] = (res[id] || {})[eng] || { n: 0, hit: 0, ll: 0 });
      const best = Object.entries(probs).sort((a, b) => b[1] - a[1])[0][0];
      s.n++; if (best === win) s.hit++; s.ll += -Math.log(Math.max(1e-6, probs[win] ?? 1e-6));
      if (eng === 'model') { const C = (cal[id] = cal[id] || Array.from({ length: 10 }, () => [0, 0, 0])); for (const k in probs) { const b = C[Math.min(9, Math.floor(probs[k] * 10))]; b[0] += probs[k]; b[1] += k === win ? 1 : 0; b[2]++; } }
    };
    let evaluated = 0;
    for (let gi = 0; gi < groups.length; gi++) {
      const G = groups[gi];
      const hist = ms.filter(m => m.comp === G.comp && m.ts < G.ts);
      if (gi >= start && hist.length >= minHist) {
        const tour = ms.filter(m => m.comp === G.comp && m.tour === G.ms[0].tour);
        const F = M.fit(hist.slice(-(o.maxHist || 2000)), rankMap(tour), o);
        for (const m of G.ms) {
          const { pA, pB } = M.probs(F, m.p1, m.p2);
          const outs = T.matchOutcomes(pA, pB);
          const mk = K.compute(outs);
          for (const x of mk) {
            const def = K.byId[x.id]; if (def.id.startsWith('S2') && m.sets.length < 2) continue;
            const win = K.resolve(def, m.sets); if (win == null) continue;
            const probs = Object.fromEntries(x.opts.map(q => [q.k, q.p]));
            rec(x.id, 'model', probs, win);
            const F2 = (freq[m.comp] || {})[x.id];
            if (F2 && F2.n >= 20) { const bp = {}; def.opts.forEach(q => { bp[q.k] = ((F2.c[q.k] || 0) + 0.5) / (F2.n + 0.5 * def.opts.length); }); rec(x.id, 'base', bp, win); rec(x.id, 'model_vs', probs, win); }
          }
          evaluated++;
        }
      }
      for (const m of G.ms) for (const def of K.DEF) {
        const win = K.resolve(def, m.sets); if (win == null) continue;
        const F2 = ((freq[m.comp] = freq[m.comp] || {})[def.id] = (freq[m.comp] || {})[def.id] || { n: 0, c: {} });
        F2.n++; F2.c[win] = (F2.c[win] || 0) + 1;
      }
      if (onProgress && gi % 2 === 0) { onProgress(gi / groups.length); await new Promise(r => setTimeout(r, 0)); }
    }
    return { res, cal, evaluated };
  }
  return { run, rankMap };
})();
if (typeof module !== 'undefined') module.exports = TBacktest;
