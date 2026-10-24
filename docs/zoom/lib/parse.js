// Converts raw API payloads into flat records. Shared by background, dashboard and tests.
const ZParse = (() => {
  // "06-10-2026 18:30:00" (dd-mm-yyyy, site server time) -> ms. Treated as UTC for arithmetic only.
  function parseT(s) {
    if (!s) return 0;
    const m = String(s).match(/(\d{2})-(\d{2})-(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?/);
    if (m) return Date.UTC(+m[3], +m[2] - 1, +m[1], +m[4], +m[5], +(m[6] || 0));
    const m2 = String(s).match(/(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})(?::(\d{2}))?/);
    if (m2) return Date.UTC(+m2[1], +m2[2] - 1, +m2[3], +m2[4], +m2[5], +(m2[6] || 0));
    return 0;
  }
  const clean = n => String(n || '').replace(/^Z(.*)Z$/, '$1').replace(/^Z\./, '').trim();
  function scorers(o) {
    if (!o || Array.isArray(o)) return [];
    return Object.entries(o).map(([name, mins]) => ({ name: clean(name), mins: mins || [] }));
  }
  function toRec(compId, season, round, m) {
    return {
      matchId: m.matchId, comp: compId, season, seasonTs: parseT(season),
      round: round.id, time: round.time, ts: parseT(round.time),
      home: m.homeTeam, away: m.awayTeam,
      hg: m.homeScore, ag: m.awayScore,
      hth: m.halfTimeHomeScore, hta: m.halfTimeAwayScore,
      hGoals: m.eventsHome || [], aGoals: m.eventsAway || [],
      hc: m.homeCornerScore, ac: m.awayCornerScore,
      hthc: m.halfTimeHomeCornerScore, htac: m.halfTimeAwayCornerScore,
      hcMin: m.minuteCornerHome || [], acMin: m.minuteCornerAway || [],
      scH: scorers(m.goalscorersHome), scA: scorers(m.goalscorersAway),
      earlyH: m.earlyHome || 0, earlyA: m.earlyAway || 0,
      goldH: m.homeGoldenGoals || [], goldA: m.awayGoldenGoals || []
    };
  }
  // shotTypes: 1 off-target H, 2 off-target A, 3 on-target H, 4 on-target A, 5 GK save H, 6 GK save A
  function deep(matchId, d) {
    const tl = (d && d.matchTimelineInfo) || {};
    const bp = tl.ballPossession || {};
    const ft = bp.FULLTIME || {}, ht = bp.HALFTIME || {};
    const shots = tl.shotsInfo || {};
    const c = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
    Object.values(shots).forEach(v => { c[v] = (c[v] || 0) + 1; });
    const poss = Object.entries(bp).filter(([k]) => /^\d+$/.test(k)).map(([k, v]) => [+k, v.home]).sort((a, b) => a[0] - b[0]);
    return {
      matchId, ok: true, at: Date.now(),
      possH: ft.home, possA: ft.away, htPossH: ht.home, htPossA: ht.away, possTimeline: poss,
      offH: c[1], offA: c[2], onH: c[3], onA: c[4], saveH: c[5], saveA: c[6], shotMins: shots,
      wp: d && d.winningProbabilities ? d.winningProbabilities : null,
      ouHome: d && d.overUnderAvgGoalHome || null, ouAway: d && d.overUnderAvgGoalAway || null
    };
  }
  return { parseT, toRec, deep, clean };
})();
if (typeof module !== 'undefined') module.exports = ZParse;
