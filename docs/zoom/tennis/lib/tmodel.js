// Player rating model for Zoom Tennis.
//   logit P(server wins point) = mu + s[server] - s[returner]
//   s[i] ~ Normal(beta * seedScore(i), tau²)   (seedScore from the player's position in the player list:
//                                               lower id = higher seed; verified: corr ≈ -0.3 with point share)
// Fitted by MAP (Newton steps) on point counts from every captured game. Separate fit per tournament.
const TModel = (() => {
  const sig = x => 1 / (1 + Math.exp(-x));
  const seedScore = rank => -Math.log1p(rank) + 2.0; // rank 0 = top seed -> 2.0 ; rank 63 -> -2.16

  // matches: [{p1,p2,serve:[[w,n],[w,n]] }]  serve[0] = player1's serve points won / played
  // ranks: Map playerId -> rank (0 = top)
  function fit(matches, ranks, o = {}) {
    const tau = o.tau ?? 0.12, betaPrior = o.betaPrior ?? 0.03, iters = o.iters ?? 25, decay = o.decay ?? 0;
    const players = new Set(); matches.forEach(m => { players.add(m.p1); players.add(m.p2); });
    ranks && ranks.forEach((v, k) => players.add(k));
    const s = {}; players.forEach(p => (s[p] = 0));
    const sc = p => (ranks && ranks.has(p) ? seedScore(ranks.get(p)) : 0);
    let mu = 0.2, beta = betaPrior;
    // obs: [server, returner, won, n, weight]
    const obs = [];
    const tMax = matches.reduce((a, m) => Math.max(a, m.ts || 0), 0);
    matches.forEach(m => {
      const w = decay ? Math.pow(0.5, (tMax - (m.ts || tMax)) / (decay * 3600e3)) : 1;
      if (m.serve[0][1]) obs.push([m.p1, m.p2, m.serve[0][0], m.serve[0][1], w]);
      if (m.serve[1][1]) obs.push([m.p2, m.p1, m.serve[1][0], m.serve[1][1], w]);
    });
    for (let it = 0; it < iters; it++) {
      // mu
      let g = 0, h = 0;
      for (const [a, b, w, n, wt] of obs) { const p = sig(mu + s[a] - s[b]); g += wt * (w - n * p); h += wt * n * p * (1 - p); }
      mu += g / (h + 1e-9);
      // beta (players' prior centre) – weak prior around betaPrior
      let gb = -(beta - betaPrior) / 0.0004, hb = 1 / 0.0004;
      players.forEach(p => { const x = sc(p); gb += (s[p] - beta * x) * x / (tau * tau); hb += x * x / (tau * tau); });
      beta += gb / hb;
      // players
      const G = {}, H = {};
      players.forEach(p => { G[p] = -(s[p] - beta * sc(p)) / (tau * tau); H[p] = 1 / (tau * tau); });
      for (const [a, b, w, n, wt] of obs) {
        const p = sig(mu + s[a] - s[b]), r = wt * (w - n * p), v = wt * n * p * (1 - p);
        G[a] += r; H[a] += v; G[b] -= r; H[b] += v;
      }
      players.forEach(p => { s[p] += G[p] / H[p]; });
    }
    return { mu, beta, s, sc };
  }
  // serve-point probabilities for a pairing (unknown player -> seed prior)
  function probs(F, p1, p2) {
    const a = F.s[p1] ?? F.beta * F.sc(p1), b = F.s[p2] ?? F.beta * F.sc(p2);
    return { pA: sig(F.mu + a - b), pB: sig(F.mu + b - a), r1: a, r2: b };
  }
  return { fit, probs, seedScore, sig };
})();
if (typeof module !== 'undefined') module.exports = TModel;
