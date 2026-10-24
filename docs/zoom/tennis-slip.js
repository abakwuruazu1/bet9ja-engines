/* Tennis slip builder tab */
function tennisMarketProbs(outs, defs) {
  const r = {}; for (const d of defs) r[d.id] = Object.fromEntries(d.opts.map(o => [o.k, outs.reduce((s, x) => s + (o.f(x.sets) ? x.p : 0), 0)])); return r;
}
function rSlip() {
  const sources = St.comps.filter(c => fitFor(c.id).n >= 20).map(c => ({ id: c.id, name: c.name }));
  ZSlip.mount(view, {
    key: 'tennis', sourceLabel: 'Tournament', sources, horizonDefault: 60,
    markets: TMarkets.DEF.map(m => ({ group: m.group, id: m.id, name: m.name })),
    defaultMarkets: ['MW', 'SH', 'SH2', 'GH1.5', 'GH21.5'],
    candidates(o) {
      const now = Date.now(), cands = []; let known = 0;
      for (const c of o.sources) {
        if (fitFor(c).n < 20) continue;
        const ups = upcoming(c).filter(f => f.ts && f.ts > now - 60e3 && f.ts <= now + o.horizon * 60e3);
        for (const f of ups) {
          known++;
          const P = pair(c, f.p1, f.p2);
          for (const x of P.mk) if (o.markets.includes(x.id)) for (const op of x.opts) cands.push({ mkey: f.id, p: op.p, comp: c, ts: f.ts, f, mkId: x.id, k: op.k });
        }
      }
      return { cands, note: known ? '' : 'No upcoming tennis fixtures in that time window. A fixture appears as soon as both players are known in the draw. Try a longer window.' };
    },
    async backtestSlots(o, onProgress) {
      const defs = TMarkets.DEF.filter(d => o.markets.includes(d.id)); const per = [];
      for (let i = 0; i < o.sources.length; i++) {
        const c = o.sources[i], ms = CM(c).filter(m => m.serve && m.sets.length >= 2);
        const groups = []; let cur = null;
        for (const m of ms) { if (!cur || cur.ts !== m.ts) { cur = { ts: m.ts, ms: [] }; groups.push(cur); } cur.ms.push(m); }
        const rounds = [];
        for (let gi = Math.max(0, groups.length - 40); gi < groups.length; gi++) {
          const G = groups[gi], hist = ms.filter(m => m.ts < G.ts); if (hist.length < 30) continue;
          const F = TModel.fit(hist, TBacktest.rankMap(ms.filter(m => m.tour === G.ms[0].tour)), mOpts());
          rounds.push(G.ms.map(m => { const pr = TModel.probs(F, m.p1, m.p2); const probs = tennisMarketProbs(TMarkov.matchOutcomes(pr.pA, pr.pB), defs); const won = {}; defs.forEach(d => { const w = TMarkets.resolve(d, m.sets); won[d.id] = Object.fromEntries(d.opts.map(q => [q.k, q.k === w])); }); return { m, probs, won }; }));
          onProgress((i + (gi + 1) / groups.length) / o.sources.length); await new Promise(r => setTimeout(r, 0));
        }
        per.push(rounds);
      }
      const len = Math.max(0, ...per.map(x => x.length)), slots = [];
      for (let j = 0; j < len; j++) {
        const cands = [];
        per.forEach(rounds => { const R = rounds[rounds.length - 1 - j]; if (!R) return; R.forEach(x => { for (const id in x.probs) for (const k in x.probs[id]) cands.push({ mkey: x.m.matchId, mkId: id, p: x.probs[id][k], won: x.won[id][k] }); }); });
        slots.push(cands);
      }
      return slots;
    },
    describe(l) { return { when: fmtT(l.ts) + ' · ' + PHASE[l.f.ph], comp: cname(l.comp), event: pn(l.f.p1) + ' v ' + pn(l.f.p2), market: lbl(TMarkets.byId[l.mkId].name, l.f.p1, l.f.p2), pick: lbl(l.k, l.f.p1, l.f.p2) }; }
  });
  view.insertAdjacentHTML('beforeend', `<div class="note">Tennis backtests showed the engine adds most on match winner, set betting, set/game handicaps, player games and set winners. Totals, odd/even and tie-break markets are close to their historical rates.</div>`);
}
