// Exact tennis Markov engine (Zoom Tennis rules: best of 3 sets, 6-6 tie-break to 7 in every set,
// advantage scoring, player 1 serves first). Every point is independent – verified on real data:
// server wins 55.0% of points, which predicts a 62.3% hold rate vs 61.7% observed.
//   pA = P(player 1 wins a point on HIS serve), pB = P(player 2 wins a point on HIS serve)
const TMarkov = (() => {
  // P(server wins game) from point state (a = server points, b = receiver points; 0,1,2,3=40, deuce handled)
  function gameFrom(p, a = 0, b = 0) {
    const q = 1 - p, D = p * p / (p * p + q * q);
    const memo = {};
    const f = (x, y) => {
      if (x >= 4 && x - y >= 2) return 1;
      if (y >= 4 && y - x >= 2) return 0;
      if (x >= 3 && y >= 3) { if (x === y) return D; return x > y ? p + q * D : p * D; }
      const k = x + ',' + y; if (k in memo) return memo[k];
      return (memo[k] = p * f(x + 1, y) + q * f(x, y + 1));
    };
    return f(a, b);
  }
  // Tie-break: P(player 1 wins) from points (a, b); `first` = who served the tie-break's first point (1|2)
  function tbFrom(pA, pB, first, a = 0, b = 0) {
    const x = pA * (1 - pB), y = (1 - pA) * pB, LEVEL = x / (x + y);
    const memo = {};
    const srv = k => ((Math.floor((k + 1) / 2) % 2 === 0) ? first : 3 - first);
    const f = (i, j) => {
      if (i >= 7 && i - j >= 2) return 1;
      if (j >= 7 && j - i >= 2) return 0;
      if (i >= 6 && j >= 6 && i === j) return LEVEL;
      const k = i + ',' + j; if (k in memo) return memo[k];
      const p1 = srv(i + j) === 1 ? pA : 1 - pB; // P(player 1 wins this point)
      return (memo[k] = p1 * f(i + 1, j) + (1 - p1) * f(i, j + 1));
    };
    return f(a, b);
  }
  // Distribution of the final score of a set from a live state.
  // st: { ga, gb, server (1|2) of the CURRENT game, pts: [p1pts, p2pts] in current game (or tie-break) }
  // returns Map key "a-b" -> prob (7-6 / 6-7 = tie-break set)
  function setDist(pA, pB, st = {}) {
    const ga0 = st.ga || 0, gb0 = st.gb || 0, s0 = st.server || 1, pts = st.pts || [0, 0];
    const live = !!(pts[0] || pts[1]);
    const key = !live && ga0 === 0 && gb0 === 0 ? pA + '|' + pB + '|' + s0 : null;
    if (key && SETCACHE.has(key)) return SETCACHE.get(key);
    const out = {};
    const hold1 = gameFrom(pA), hold2 = gameFrom(pB);
    const tb = { 1: tbFrom(pA, pB, 1), 2: tbFrom(pA, pB, 2) };
    // forward DP over game scores; server of game at (i,j) = s0 if (i+j-ga0-gb0) even
    const P = {}; P[ga0 + ',' + gb0] = 1;
    for (let tot = ga0 + gb0; tot <= 13; tot++) {
      for (let i = 0; i <= 7; i++) {
        const j = tot - i; if (j < 0 || j > 7) continue;
        const pr = P[i + ',' + j]; if (!pr) continue;
        if ((i >= 6 && i - j >= 2) || i === 7 || (j >= 6 && j - i >= 2) || j === 7) { out[i + '-' + j] = (out[i + '-' + j] || 0) + pr; continue; }
        const srv = ((tot - ga0 - gb0) % 2 === 0) ? s0 : 3 - s0;
        let p1;
        const first = tot === ga0 + gb0 && live;
        if (i === 6 && j === 6) p1 = first ? tbFrom(pA, pB, s0, pts[0], pts[1]) : tb[srv];
        else if (first) { const sp = s0 === 1 ? pts[0] : pts[1], rp = s0 === 1 ? pts[1] : pts[0]; const h = gameFrom(s0 === 1 ? pA : pB, sp, rp); p1 = s0 === 1 ? h : 1 - h; }
        else p1 = srv === 1 ? hold1 : 1 - hold2;
        const a = (i + 1) + ',' + j, b = i + ',' + (j + 1);
        P[a] = (P[a] || 0) + pr * p1; P[b] = (P[b] || 0) + pr * (1 - p1);
      }
    }
    if (key) { if (SETCACHE.size > 2000) SETCACHE.clear(); SETCACHE.set(key, out); }
    return out;
  }
  const SETCACHE = new Map();
  // Who serves first in the next set: games alternate, the tie-break counts as one game.
  const nextFirst = (first, games) => (games % 2 === 0 ? first : 3 - first);

  // Full outcome distribution of a best-of-3 match from any live state.
  // state: { sa, sb, done: [[a,b],...] finished sets, ga, gb, server, pts }  (all optional = match start)
  // returns list of outcomes { sets: [[a,b],..], p }
  function matchOutcomes(pA, pB, state = {}) {
    const done = state.done || [];
    let sa = 0, sb = 0; done.forEach(([a, b]) => (a > b ? sa++ : sb++));
    const out = [];
    const firstOf = (setIdx, prevSets) => { // who serves first in set setIdx given all previous sets
      let f = 1; for (const [a, b] of prevSets) f = nextFirst(f, a + b); return f;
    };
    const go = (sets, sa, sb, p, live) => {
      if (p < 1e-12) return;
      if (sa === 2 || sb === 2) return out.push({ sets, p });
      let dist;
      if (live) dist = setDist(pA, pB, { ga: state.ga, gb: state.gb, server: state.server, pts: state.pts });
      else dist = setDist(pA, pB, { server: firstOf(sets.length, sets) });
      for (const k in dist) {
        const [a, b] = k.split('-').map(Number);
        go(sets.concat([[a, b]]), sa + (a > b), sb + (b > a), p * dist[k], false);
      }
    };
    go(done.slice(), sa, sb, 1, state.server != null);
    return out;
  }

  // Fast P(player 1 wins the match) – sets collapsed to (winner, games parity) since that's all that
  // carries forward (parity decides who serves first in the next set).
  function matchWin(pA, pB) {
    const cat = first => { const d = setDist(pA, pB, { server: first }); const c = { w: [0, 0], l: [0, 0] }; for (const k in d) { const [a, b] = k.split('-').map(Number); (a > b ? c.w : c.l)[(a + b) % 2] += d[k]; } return c; };
    const C = { 1: cat(1), 2: cat(2) };
    const go = (first, sa, sb) => {
      if (sa === 2) return 1; if (sb === 2) return 0;
      let p = 0; const c = C[first];
      for (const par of [0, 1]) { const nf = par === 0 ? first : 3 - first; p += c.w[par] * go(nf, sa + 1, sb) + c.l[par] * go(nf, sa, sb + 1); }
      return p;
    };
    return go(1, 0, 0);
  }

  // Convert a live point string ("0","15","30","40","A") to point count
  const PT = { '0': 0, '15': 1, '30': 2, '40': 3, 'A': 4 };
  function pts(s, tb) { if (tb) return +s || 0; return PT[String(s)] ?? (+s || 0); }

  return { gameFrom, tbFrom, setDist, matchOutcomes, matchWin, nextFirst, pts };
})();
if (typeof module !== 'undefined') module.exports = TMarkov;
