/* Football slip builder tab */
function footballPickLabel(mkId, k, m) {
  const H = tn(m.home), A = tn(m.away);
  if (mkId === '1X2' || mkId === 'HT1X2' || mkId === '2H1X2') return k === '1' ? H + ' win' : k === '2' ? A + ' win' : 'Draw';
  if (mkId === 'DC') return k === '1X' ? H + ' or draw' : k === 'X2' ? A + ' or draw' : H + ' or ' + A;
  if (mkId === 'HTFT') return k.split('/').map(x => (x === '1' ? tshort(m.home) : x === '2' ? tshort(m.away) : 'Draw')).join(' / ');
  if (/^1X2(GG|OU)$/.test(mkId)) return k.replace(/^1/, tshort(m.home)).replace(/^2/, tshort(m.away)).replace(/^X/, 'Draw');
  return k;
}
function renderSlipTab() {
  const eng = St.ui.eng || 'blend';
  const sources = St.comps.filter(c => CM(c.id).length >= 60).map(c => ({ id: c.id, name: c.name }));
  ZSlip.mount(view, {
    key: 'football', sourceLabel: 'League', sources, horizonDefault: 100,
    markets: ZMarkets.list.map(m => ({ group: m.group, id: m.id, name: m.name })),
    defaultMarkets: ['1X2', 'DC', 'OU1.5', 'OU2.5', 'GG'],
    candidates(o) {
      const now = Date.now(), cands = []; let known = 0;
      for (const c of o.sources) {
        const hist = CM(c); if (hist.length < 60) continue;
        const up = ZFix.upcoming(hist); if (!up) continue;
        const rounds = up.list.filter(r => r.fixtures && r.ts > now && r.ts <= now + o.horizon * 60e3);
        if (!rounds.length) continue;
        const opts = modelOpts(), refTs = hist[hist.length - 1].ts + 1, S = ZModel.prepare(hist, refTs, opts), B = ZModel.leagueBase(hist);
        for (const r of rounds) for (const f of r.fixtures) {
          known++;
          const P = ZModel.predict(hist, f.home, f.away, opts, refTs, S, B);
          const m = { home: f.home, away: f.away };
          for (const id of o.markets) {
            const mk = ZMarkets.byId[id], pr = P.markets[id] && P.markets[id][eng]; if (!pr) continue;
            for (const k in pr) cands.push({ mkey: c + ':' + r.round + ':' + f.home, p: pr[k], comp: c, ts: r.ts, round: r.round, m, mkId: id, k });
          }
        }
      }
      return { cands, note: known ? '' : 'No upcoming fixtures are known in that time window. Zoom fixtures are known in advance only from round 20 of a season (rounds 20–38 mirror 1–19). Try a longer window, or wait for the next capture.' };
    },
    async backtestSlots(o, onProgress) {
      const per = [];
      for (let i = 0; i < o.sources.length; i++) {
        per.push(await ZModel.walkPreds(CM(o.sources[i]), modelOpts(), { lastRounds: 120, markets: o.markets, eng, onProgress: p => onProgress((i + p) / o.sources.length) }));
      }
      const len = Math.max(0, ...per.map(x => x.length)), slots = [];
      for (let j = 0; j < len; j++) {
        const cands = [];
        per.forEach((rounds, li) => { const R = rounds[rounds.length - 1 - j]; if (!R) return; R.matches.forEach(x => { for (const id in x.probs) for (const k in x.probs[id]) cands.push({ mkey: li + ':' + x.m.matchId, mkId: id, p: x.probs[id][k], won: x.won[id][k] }); }); });
        slots.push(cands);
      }
      return slots;
    },
    describe(l) { return { when: fmtT(l.ts) + ' · R' + l.round, comp: cname(l.comp), event: tn(l.m.home) + ' v ' + tn(l.m.away), market: ZMarkets.byId[l.mkId].name, pick: footballPickLabel(l.mkId, l.k, l.m) }; }
  });
  view.insertAdjacentHTML('beforeend', `<div class="note">Probabilities come from the <b>${{ blend: 'Blend', poisson: 'Poisson', form: 'Form', base: 'League base' }[eng] || eng}</b> engine (change it on the Predictor tab). Backtests showed real skill on 1X2, half-time and corner-winner markets; goal totals and GG/NG are close to coin-flips, so slips built from those are mostly luck.</div>`);
}
