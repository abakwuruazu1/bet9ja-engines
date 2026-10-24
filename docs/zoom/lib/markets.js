// Market catalogue. Each option has a predicate f evaluated on:
//   kind 'ft'      f(homeGoals, awayGoals)                     full time
//   kind 'ht'      f(htHome, htAway)                           half time
//   kind 'half'    f(htHome, htAway, 2ndHalfHome, 2ndHalfAway) both halves
//   kind 'corners' f(homeCorners, awayCorners)
// exclusive=true  -> exactly one option wins (pick = most likely option)
// exclusive=false -> options overlap (double chance, multigoals)
const ZMarkets = (() => {
  const R = (h, a) => (h > a ? '1' : h < a ? '2' : 'X');
  const M = [];
  const add = (group, id, name, kind, opts, exclusive = true) =>
    M.push({ group, id, name, kind, exclusive, opts: opts.map(([k, f]) => ({ k, f })) });

  // ---- Main
  add('Main', '1X2', '1X2 (Full time)', 'ft', [['1', (h, a) => h > a], ['X', (h, a) => h === a], ['2', (h, a) => h < a]]);
  add('Main', 'DC', 'Double Chance', 'ft', [['1X', (h, a) => h >= a], ['12', (h, a) => h !== a], ['X2', (h, a) => h <= a]], false);
  add('Main', 'GG', 'GG / NG (Both teams to score)', 'ft', [['GG', (h, a) => h > 0 && a > 0], ['NG', (h, a) => !(h > 0 && a > 0)]]);
  // ---- Goals
  [0.5, 1.5, 2.5, 3.5, 4.5, 5.5].forEach(l => add('Goals', 'OU' + l, 'Over/Under ' + l, 'ft', [['Over', (h, a) => h + a > l], ['Under', (h, a) => h + a < l]]));
  add('Goals', 'TG', 'Exact total goals', 'ft', [0, 1, 2, 3, 4, 5].map(n => [String(n), (h, a) => h + a === n]).concat([['6+', (h, a) => h + a >= 6]]));
  add('Goals', 'MG', 'Multigoals', 'ft', [[1, 2], [1, 3], [2, 3], [2, 4], [3, 5], [4, 6]].map(([x, y]) => [x + '-' + y, (h, a) => h + a >= x && h + a <= y]), false);
  add('Goals', 'OE', 'Odd / Even goals', 'ft', [['Odd', (h, a) => (h + a) % 2 === 1], ['Even', (h, a) => (h + a) % 2 === 0]]);
  // ---- Team goals
  [0.5, 1.5, 2.5].forEach(l => {
    add('Team goals', 'HOU' + l, 'Home team O/U ' + l, 'ft', [['Over', (h) => h > l], ['Under', (h) => h < l]]);
    add('Team goals', 'AOU' + l, 'Away team O/U ' + l, 'ft', [['Over', (h, a) => a > l], ['Under', (h, a) => a < l]]);
  });
  add('Team goals', 'WTN', 'Win to nil', 'ft', [['Home WTN', (h, a) => h > a && a === 0], ['Away WTN', (h, a) => a > h && h === 0], ['Neither', (h, a) => !((h > a && a === 0) || (a > h && h === 0))]]);
  add('Team goals', 'CSH', 'Home clean sheet', 'ft', [['Yes', (h, a) => a === 0], ['No', (h, a) => a > 0]]);
  add('Team goals', 'CSA', 'Away clean sheet', 'ft', [['Yes', (h) => h === 0], ['No', (h) => h > 0]]);
  // ---- Correct score
  const cs = [];
  for (let i = 0; i <= 4; i++) for (let j = 0; j <= 4; j++) cs.push([i + '-' + j, (h, a) => h === i && a === j]);
  cs.push(['Other', (h, a) => h > 4 || a > 4]);
  add('Correct score', 'CS', 'Correct score', 'ft', cs);
  // ---- Combos
  add('Combos', '1X2GG', '1X2 & GG/NG', 'ft', ['1', 'X', '2'].flatMap(r => [[r + ' & GG', (h, a) => R(h, a) === r && h > 0 && a > 0], [r + ' & NG', (h, a) => R(h, a) === r && !(h > 0 && a > 0)]]));
  add('Combos', '1X2OU', '1X2 & O/U 2.5', 'ft', ['1', 'X', '2'].flatMap(r => [[r + ' & Over', (h, a) => R(h, a) === r && h + a > 2.5], [r + ' & Under', (h, a) => R(h, a) === r && h + a < 2.5]]));
  add('Combos', 'GGOU', 'GG/NG & O/U 2.5', 'ft', [['GG & Over', (h, a) => h > 0 && a > 0 && h + a > 2.5], ['GG & Under', (h, a) => h > 0 && a > 0 && h + a < 2.5], ['NG & Over', (h, a) => !(h > 0 && a > 0) && h + a > 2.5], ['NG & Under', (h, a) => !(h > 0 && a > 0) && h + a < 2.5]]);
  // ---- Half time
  add('Half time', 'HT1X2', 'Half-time 1X2', 'ht', [['1', (h, a) => h > a], ['X', (h, a) => h === a], ['2', (h, a) => h < a]]);
  add('Half time', 'HTOU0.5', 'Half-time O/U 0.5', 'ht', [['Over', (h, a) => h + a > 0.5], ['Under', (h, a) => h + a < 0.5]]);
  add('Half time', 'HTOU1.5', 'Half-time O/U 1.5', 'ht', [['Over', (h, a) => h + a > 1.5], ['Under', (h, a) => h + a < 1.5]]);
  add('Half time', 'HTGG', 'Half-time GG/NG', 'ht', [['GG', (h, a) => h > 0 && a > 0], ['NG', (h, a) => !(h > 0 && a > 0)]]);
  add('Half time', 'HTFT', 'Half-time / Full-time', 'half',
    ['1', 'X', '2'].flatMap(x => ['1', 'X', '2'].map(y => [x + '/' + y, (a, b, c, d) => R(a, b) === x && R(a + c, b + d) === y])));
  add('Half time', '2H1X2', '2nd-half 1X2', 'half', [['1', (a, b, c, d) => c > d], ['X', (a, b, c, d) => c === d], ['2', (a, b, c, d) => c < d]]);
  add('Half time', '2HOU0.5', '2nd-half O/U 0.5', 'half', [['Over', (a, b, c, d) => c + d > 0.5], ['Under', (a, b, c, d) => c + d < 0.5]]);
  add('Half time', '2HOU1.5', '2nd-half O/U 1.5', 'half', [['Over', (a, b, c, d) => c + d > 1.5], ['Under', (a, b, c, d) => c + d < 1.5]]);
  add('Half time', 'HSH', 'Highest scoring half', 'half', [['1st', (a, b, c, d) => a + b > c + d], ['2nd', (a, b, c, d) => a + b < c + d], ['Equal', (a, b, c, d) => a + b === c + d]]);
  add('Half time', 'GBH', 'Goal in both halves', 'half', [['Yes', (a, b, c, d) => a + b > 0 && c + d > 0], ['No', (a, b, c, d) => !(a + b > 0 && c + d > 0)]]);
  // ---- Corners
  [7.5, 8.5, 9.5, 10.5, 11.5, 12.5].forEach(l => add('Corners', 'COU' + l, 'Total corners O/U ' + l, 'corners', [['Over', (h, a) => h + a > l], ['Under', (h, a) => h + a < l]]));
  add('Corners', 'C1X2', 'Most corners', 'corners', [['Home', (h, a) => h > a], ['Equal', (h, a) => h === a], ['Away', (h, a) => h < a]]);
  add('Corners', 'COE', 'Corners odd/even', 'corners', [['Odd', (h, a) => (h + a) % 2 === 1], ['Even', (h, a) => (h + a) % 2 === 0]]);

  const byId = Object.fromEntries(M.map(m => [m.id, m]));

  // Which options a finished match satisfies -> array of booleans (same order as opts)
  function hits(match, mk) {
    const m = match;
    switch (mk.kind) {
      case 'ft': return mk.opts.map(o => o.f(m.hg, m.ag));
      case 'ht': return mk.opts.map(o => o.f(m.hth, m.hta));
      case 'half': return mk.opts.map(o => o.f(m.hth, m.hta, m.hg - m.hth, m.ag - m.hta));
      case 'corners': return (m.hc == null) ? null : mk.opts.map(o => o.f(m.hc, m.ac));
    }
    return null;
  }
  return { list: M, byId, hits, R };
})();
if (typeof module !== 'undefined') module.exports = ZMarkets;
