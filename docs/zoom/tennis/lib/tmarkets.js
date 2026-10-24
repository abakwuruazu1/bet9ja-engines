// Tennis markets derived from the exact outcome distribution (TMarkov.matchOutcomes).
// Every market carries a resolver so it can be backtested on finished matches.
const TMarkets = (() => {
  const setsWon = sets => sets.reduce((a, [x, y]) => [a[0] + (x > y), a[1] + (y > x)], [0, 0]);
  const games = sets => sets.reduce((a, [x, y]) => [a[0] + x, a[1] + y], [0, 0]);
  const hasTB = sets => sets.some(([x, y]) => x + y === 13);

  // id, name, group, options: [label, predicate(sets)]
  const DEF = [];
  const add = (group, id, name, opts) => DEF.push({ group, id, name, opts: opts.map(([k, f]) => ({ k, f })) });
  add('Match', 'MW', 'Match winner', [['P1', s => setsWon(s)[0] === 2], ['P2', s => setsWon(s)[1] === 2]]);
  add('Match', 'SB', 'Set betting (correct score)', [['2-0', s => setsWon(s).join('-') === '2-0'], ['2-1', s => setsWon(s).join('-') === '2-1'], ['1-2', s => setsWon(s).join('-') === '1-2'], ['0-2', s => setsWon(s).join('-') === '0-2']]);
  add('Match', 'TS', 'Total sets (match goes to a 3rd set)', [['3 sets', s => s.length === 3], ['2 sets', s => s.length === 2]]);
  add('Match', 'SH', 'Set handicap P1 -1.5', [['P1 -1.5', s => setsWon(s).join('-') === '2-0'], ['P2 +1.5', s => setsWon(s).join('-') !== '2-0']]);
  add('Match', 'SH2', 'Set handicap P2 -1.5', [['P2 -1.5', s => setsWon(s).join('-') === '0-2'], ['P1 +1.5', s => setsWon(s).join('-') !== '0-2']]);
  add('Match', 'S1MW', '1st set winner / match winner', [['P1/P1', s => s[0][0] > s[0][1] && setsWon(s)[0] === 2], ['P1/P2', s => s[0][0] > s[0][1] && setsWon(s)[1] === 2], ['P2/P1', s => s[0][1] > s[0][0] && setsWon(s)[0] === 2], ['P2/P2', s => s[0][1] > s[0][0] && setsWon(s)[1] === 2]]);
  add('Match', 'TB', 'Tie-break in match', [['Yes', s => hasTB(s)], ['No', s => !hasTB(s)]]);
  for (const l of [18.5, 19.5, 20.5, 21.5, 22.5, 23.5, 24.5, 25.5]) add('Games', 'TG' + l, 'Total games O/U ' + l, [['Over', s => games(s)[0] + games(s)[1] > l], ['Under', s => games(s)[0] + games(s)[1] < l]]);
  add('Games', 'OE', 'Total games odd/even', [['Odd', s => (games(s)[0] + games(s)[1]) % 2 === 1], ['Even', s => (games(s)[0] + games(s)[1]) % 2 === 0]]);
  for (const h of [1.5, 2.5, 3.5, 4.5, 5.5]) add('Games', 'GH' + h, `Game handicap P1 -${h}`, [[`P1 -${h}`, s => games(s)[0] - games(s)[1] > h], [`P2 +${h}`, s => games(s)[0] - games(s)[1] < h]]);
  for (const h of [1.5, 2.5, 3.5, 4.5, 5.5]) add('Games', 'GH2' + h, `Game handicap P2 -${h}`, [[`P2 -${h}`, s => games(s)[1] - games(s)[0] > h], [`P1 +${h}`, s => games(s)[1] - games(s)[0] < h]]);
  for (const l of [9.5, 10.5, 11.5, 12.5]) {
    add('Games', 'P1G' + l, `Player 1 games O/U ${l}`, [['Over', s => games(s)[0] > l], ['Under', s => games(s)[0] < l]]);
    add('Games', 'P2G' + l, `Player 2 games O/U ${l}`, [['Over', s => games(s)[1] > l], ['Under', s => games(s)[1] < l]]);
  }
  add('1st set', 'S1', '1st set winner', [['P1', s => s[0][0] > s[0][1]], ['P2', s => s[0][1] > s[0][0]]]);
  for (const l of [8.5, 9.5, 10.5, 12.5]) add('1st set', 'S1TG' + l, `1st set total games O/U ${l}`, [['Over', s => s[0][0] + s[0][1] > l], ['Under', s => s[0][0] + s[0][1] < l]]);
  add('1st set', 'S1TB', '1st set tie-break', [['Yes', s => s[0][0] + s[0][1] === 13], ['No', s => s[0][0] + s[0][1] !== 13]]);
  const SCS = ['6-0', '6-1', '6-2', '6-3', '6-4', '7-5', '7-6', '0-6', '1-6', '2-6', '3-6', '4-6', '5-7', '6-7'];
  add('1st set', 'S1CS', '1st set correct score', SCS.map(k => [k, s => s[0].join('-') === k]));
  add('2nd set', 'S2', '2nd set winner', [['P1', s => s[1][0] > s[1][1]], ['P2', s => s[1][1] > s[1][0]]]);
  for (const l of [8.5, 9.5, 10.5]) add('2nd set', 'S2TG' + l, `2nd set total games O/U ${l}`, [['Over', s => s[1][0] + s[1][1] > l], ['Under', s => s[1][0] + s[1][1] < l]]);
  const byId = Object.fromEntries(DEF.map(m => [m.id, m]));

  function compute(outs) {
    return DEF.map(mk => ({ id: mk.id, name: mk.name, group: mk.group, opts: mk.opts.map(o => ({ k: o.k, p: outs.reduce((s, x) => s + (o.f(x.sets) ? x.p : 0), 0) })) }));
  }
  function resolve(mk, sets) { const o = mk.opts.find(o => o.f(sets)); return o ? o.k : null; }

  // Live-only markets from a live state
  function liveExtras(pA, pB, st) {
    const T = (typeof TMarkov !== 'undefined') ? TMarkov : require('./tmarkov.js');
    const out = [];
    const tbNow = st.ga === 6 && st.gb === 6;
    // current game / tie-break
    let g1;
    if (tbNow) g1 = T.tbFrom(pA, pB, st.server, st.pts[0], st.pts[1]);
    else { const sp = st.server === 1 ? st.pts[0] : st.pts[1], rp = st.server === 1 ? st.pts[1] : st.pts[0]; const h = T.gameFrom(st.server === 1 ? pA : pB, sp, rp); g1 = st.server === 1 ? h : 1 - h; }
    out.push({ id: 'LCG', name: tbNow ? 'Tie-break winner' : `Current game winner (${st.server === 1 ? 'P1' : 'P2'} serving)`, group: 'Live', opts: [{ k: 'P1', p: g1 }, { k: 'P2', p: 1 - g1 }] });
    if (!tbNow) out.push({ id: 'LBRK', name: 'Break of serve in current game', group: 'Live', opts: [{ k: 'Break', p: st.server === 1 ? 1 - g1 : g1 }, { k: 'Hold', p: st.server === 1 ? g1 : 1 - g1 }] });
    const sd = T.setDist(pA, pB, st);
    let s1 = 0, tot = {}; for (const k in sd) { const [a, b] = k.split('-').map(Number); if (a > b) s1 += sd[k]; tot[a + b] = (tot[a + b] || 0) + sd[k]; }
    out.push({ id: 'LCS', name: 'Current set winner', group: 'Live', opts: [{ k: 'P1', p: s1 }, { k: 'P2', p: 1 - s1 }] });
    const cur = st.ga + st.gb; const line = Math.max(cur, 8) + 0.5 + (cur >= 9 ? 0 : 1);
    let ov = 0; for (const n in tot) if (+n > line) ov += tot[n];
    out.push({ id: 'LCSTG', name: `Current set total games O/U ${line}`, group: 'Live', opts: [{ k: 'Over', p: ov }, { k: 'Under', p: 1 - ov }] });
    const top = Object.entries(sd).sort((a, b) => b[1] - a[1]).slice(0, 6);
    out.push({ id: 'LCSCS', name: 'Current set correct score (top 6)', group: 'Live', opts: top.map(([k, p]) => ({ k, p })) });
    return out;
  }
  return { DEF, byId, compute, resolve, liveExtras, setsWon, games };
})();
if (typeof module !== 'undefined') module.exports = TMarkets;
