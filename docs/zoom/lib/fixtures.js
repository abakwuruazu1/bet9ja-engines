// Upcoming-fixture inference.
// Zoom seasons are double round-robins (20 teams -> 38 rounds) where round N + (teams-1)
// is round N with home/away swapped (verified on live data). So once a season passes its
// half-way point, every remaining fixture is known in advance.
const ZFix = (() => {
  function upcoming(compMatches) {
    if (!compMatches.length) return null;
    const latestSeason = compMatches.reduce((a, m) => (m.seasonTs > a.seasonTs ? m : a)).season;
    const ms = compMatches.filter(m => m.season === latestSeason);
    const rounds = {};
    ms.forEach(m => { (rounds[m.round] = rounds[m.round] || []).push(m); });
    const ids = Object.keys(rounds).map(Number).sort((a, b) => a - b);
    const last = ids[ids.length - 1];
    const perRound = Math.max(...ids.map(i => rounds[i].length));
    const nTeams = perRound * 2, half = nTeams - 1, perSeason = 2 * half;
    const ts = ids.map(i => rounds[i][0].ts);
    const diffs = []; for (let i = 1; i < ts.length; i++) diffs.push((ts[i] - ts[i - 1]) / (ids[i] - ids[i - 1]));
    diffs.sort((a, b) => a - b);
    const interval = diffs.length ? diffs[Math.floor(diffs.length / 2)] : 95 * 60e3;
    const lastTs = rounds[last][0].ts;
    const list = [];
    for (let r = last + 1; r <= perSeason; r++) {
      const src = r > half ? rounds[r - half] : null;
      list.push({
        round: r, ts: lastTs + (r - last) * interval,
        fixtures: src ? src.map(m => ({ home: m.away, away: m.home, mirrorOf: m.matchId })) : null
      });
    }
    return { season: latestSeason, last, perSeason, half, nTeams, interval, lastTs, list, seasonEnds: last >= perSeason };
  }
  return { upcoming };
})();
if (typeof module !== 'undefined') module.exports = ZFix;
