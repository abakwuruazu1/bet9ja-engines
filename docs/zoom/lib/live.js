// LIVE / IN-PLAY ENGINE
// Findings from 4,253 captured matches (all leagues):
//  - goals and corners are spread evenly over minutes 1-90 (no stoppage time, no late surge)
//  - the current score does not change either team's scoring rate afterwards
//  - first-half output barely predicts second-half output beyond pre-match strength
// So remaining goals ~ Poisson(pre-match λ × minutes-left / 90), added to the current score.
const ZLive = (() => {
  const pois = (l, max) => { const a = new Array(max + 1); let p = Math.exp(-l); a[0] = p; for (let k = 1; k <= max; k++) { p *= l / k; a[k] = p; } return a; };
  const R = (h, a) => (h > a ? '1' : h < a ? '2' : 'X');

  // Live minute from round start time. 1 match minute ≈ 1 real minute, ~0.5 min lead-in, ~1.6 min half-time break.
  function estMinute(startTs, now, sp, maxEvent, cal = { lead: 0.5, ht: 1.6 }) {
    const e = (now - startTs) / 60000;
    let m = sp ? Math.max(45, e - cal.lead - cal.ht) : Math.min(45, e - cal.lead);
    m = Math.max(m, maxEvent || 0, 0);
    return Math.min(90, m);
  }

  // pre = ZModel.ctxFor(...) result (pre-match λ). st = live state
  function ctx(pre, st) {
    const t = Math.min(90, Math.max(0, st.minute));
    const rem = (90 - t) / 90;
    const remHT = t < 45 ? (45 - t) / 90 : 0;
    const lh = pre.lh * rem, la = pre.la * rem, ch = pre.ch * rem, ca = pre.ca * rem;
    return {
      t, rem, lh, la, ch, ca, st,
      gH: pois(lh, 10), gA: pois(la, 10),
      htH: pois(pre.lh * remHT, 6), htA: pois(pre.la * remHT, 6),
      cH: pois(ch, 20), cA: pois(ca, 20)
    };
  }

  // ---- Site anchoring. The site runs the simulation and knows the true ratings (its pre-match win
  // probabilities beat our model: log-loss 0.972 vs 0.994 on 600 matches). Its live win probabilities
  // already include score and time, so we solve for the remaining λ (home, away) that reproduce them,
  // then derive every other market from those λ.
  function finalHA(hg, ag, lh, la) {
    const a = pois(lh, 10), b = pois(la, 10); let H = 0, A = 0;
    for (let i = 0; i <= 10; i++) for (let j = 0; j <= 10; j++) { const p = a[i] * b[j]; if (hg + i > ag + j) H += p; else if (hg + i < ag + j) A += p; }
    return [H, A];
  }
  function solveWP(st, wp, init) {
    if (!wp || wp.length < 3) return null;
    const s = wp[0] + wp[1] + wp[2]; if (!s) return null;
    const tH = wp[0] / s, tA = wp[2] / s;
    // integer-% probabilities near 0/100 carry little information about λ
    if (Math.min(tH, tA) < 0.02 && Math.max(tH, tA) > 0.9) return null;
    let x = [Math.log(Math.max(0.02, init[0])), Math.log(Math.max(0.02, init[1]))];
    const f = v => { const [H, A] = finalHA(st.hg, st.ag, Math.exp(v[0]), Math.exp(v[1])); return [H - tH, A - tA]; };
    for (let it = 0; it < 12; it++) {
      const r = f(x); if (Math.abs(r[0]) + Math.abs(r[1]) < 0.002) break;
      const e = 1e-3, r0 = f([x[0] + e, x[1]]), r1 = f([x[0], x[1] + e]);
      const J = [[(r0[0] - r[0]) / e, (r1[0] - r[0]) / e], [(r0[1] - r[1]) / e, (r1[1] - r[1]) / e]];
      const det = J[0][0] * J[1][1] - J[0][1] * J[1][0]; if (Math.abs(det) < 1e-9) return null;
      let dx = [(J[1][1] * r[0] - J[0][1] * r[1]) / det, (-J[1][0] * r[0] + J[0][0] * r[1]) / det];
      const step = Math.max(Math.abs(dx[0]), Math.abs(dx[1])); if (step > 1) dx = dx.map(d => d / step);
      x = [Math.min(2, Math.max(-6, x[0] - dx[0])), Math.min(2, Math.max(-6, x[1] - dx[1]))];
    }
    const r = f(x); if (Math.abs(r[0]) + Math.abs(r[1]) > 0.03) return null;
    return [Math.exp(x[0]), Math.exp(x[1])];
  }
  // Same as ctx() but goal λ pulled toward the site-implied λ (weight w). Corners stay on our model.
  function ctxAnchored(pre, st, wp, w = 0.8) {
    const base = ctx(pre, st);
    const sol = solveWP(st, wp, [base.lh, base.la]);
    if (!sol) return Object.assign(base, { anchored: false });
    const lh = w * sol[0] + (1 - w) * base.lh, la = w * sol[1] + (1 - w) * base.la;
    const k = base.rem > 0 ? 1 / base.rem : 0; // scale for the half-time window
    const remHT = base.t < 45 ? (45 - base.t) / 90 : 0;
    return Object.assign(base, {
      lh, la, gH: pois(lh, 10), gA: pois(la, 10),
      htH: pois(lh * k * remHT, 6), htA: pois(la * k * remHT, 6),
      anchored: true, siteLh: sol[0], siteLa: sol[1]
    });
  }

  // sum over remaining goals grid: f(finalHome, finalAway, addH, addA)
  function sumG(c, f) { let p = 0; for (let i = 0; i <= 10; i++) for (let j = 0; j <= 10; j++) if (f(c.st.hg + i, c.st.ag + j, i, j)) p += c.gH[i] * c.gA[j]; return p; }
  function sumC(c, f) { let p = 0; for (let i = 0; i <= 20; i++) for (let j = 0; j <= 20; j++) if (f(c.st.hc + i, c.st.ac + j)) p += c.cH[i] * c.cA[j]; return p; }

  // Market catalogue; lines adapt to the current state. Each returns {id,name,opts:[{k,p}], resolve(final,state,nextGoal,nextCorner)}
  function markets(c) {
    const s = c.st, tot = s.hg + s.ag, ctot = s.hc + s.ac, out = [];
    const add = (id, name, opts, group) => out.push({ id, name, group, opts });
    add('L1X2', 'Final result 1X2', [['1', sumG(c, (h, a) => h > a)], ['X', sumG(c, (h, a) => h === a)], ['2', sumG(c, (h, a) => h < a)]], 'Result');
    add('LDC', 'Double chance', [['1X', sumG(c, (h, a) => h >= a)], ['12', sumG(c, (h, a) => h !== a)], ['X2', sumG(c, (h, a) => h <= a)]], 'Result');
    const pNone = Math.exp(-(c.lh + c.la)), share = (c.lh + c.la) ? c.lh / (c.lh + c.la) : 0.5;
    add('LNG', 'Next goal', [['Home', (1 - pNone) * share], ['None', pNone], ['Away', (1 - pNone) * (1 - share)]], 'Goals');
    add('LROU0.5', 'Another goal (rest of match)', [['Yes', 1 - pNone], ['No', pNone]], 'Goals');
    add('LROU1.5', '2+ more goals (rest of match)', [['Yes', sumG(c, (h, a, i, j) => i + j >= 2)], ['No', sumG(c, (h, a, i, j) => i + j < 2)]], 'Goals');
    for (const l of [tot + 0.5, tot + 1.5, tot + 2.5]) add('LOU' + l, `Final total O/U ${l}`, [['Over', sumG(c, (h, a) => h + a > l)], ['Under', sumG(c, (h, a) => h + a < l)]], 'Goals');
    if (!(s.hg > 0 && s.ag > 0)) add('LGG', 'Both teams to score (final)', [['GG', sumG(c, (h, a) => h > 0 && a > 0)], ['NG', sumG(c, (h, a) => !(h > 0 && a > 0))]], 'Goals');
    add('LHOU', `Home team O/U ${s.hg + 0.5}`, [['Over', sumG(c, h => h > s.hg)], ['Under', sumG(c, h => h <= s.hg)]], 'Team');
    add('LAOU', `Away team O/U ${s.ag + 0.5}`, [['Over', sumG(c, (h, a) => a > s.ag)], ['Under', sumG(c, (h, a) => a <= s.ag)]], 'Team');
    if (c.t < 45) {
      const pht = f => { let p = 0; for (let i = 0; i <= 6; i++) for (let j = 0; j <= 6; j++) if (f(s.hg + i, s.ag + j)) p += c.htH[i] * c.htA[j]; return p; };
      add('LHT', 'Half-time result', [['1', pht((h, a) => h > a)], ['X', pht((h, a) => h === a)], ['2', pht((h, a) => h < a)]], 'Half');
      add('LHTOU', `1st-half O/U ${tot + 0.5}`, [['Over', pht((h, a) => h + a > tot)], ['Under', pht((h, a) => h + a <= tot)]], 'Half');
    }
    const cs = []; for (let i = 0; i <= 4; i++) for (let j = 0; j <= 4; j++) cs.push([(s.hg + i) + '-' + (s.ag + j), c.gH[i] * c.gA[j]]);
    cs.sort((x, y) => y[1] - x[1]);
    add('LCS', 'Final correct score (top 8)', cs.slice(0, 8), 'Result');
    if (s.hc != null) {
      const cl = Math.round(ctot + c.ch + c.ca) + 0.5;
      for (const l of [cl - 1, cl, cl + 1]) if (l > ctot) add('LCOU' + l, `Total corners O/U ${l}`, [['Over', sumC(c, (h, a) => h + a > l)], ['Under', sumC(c, (h, a) => h + a < l)]], 'Corners');
      const cNone = Math.exp(-(c.ch + c.ca)), csh = (c.ch + c.ca) ? c.ch / (c.ch + c.ca) : 0.5;
      add('LNC', 'Next corner', [['Home', (1 - cNone) * csh], ['None', cNone], ['Away', (1 - cNone) * (1 - csh)]], 'Corners');
      add('LC1X2', 'Most corners (final)', [['Home', sumC(c, (h, a) => h > a)], ['Equal', sumC(c, (h, a) => h === a)], ['Away', sumC(c, (h, a) => h < a)]], 'Corners');
    }
    out.forEach(mk => { mk.opts = mk.opts.map(([k, p]) => ({ k, p })); });
    return out;
  }

  // ---- state of a finished match at minute T (for backtesting)
  function stateAt(m, T) {
    const c = (arr) => (arr || []).filter(x => x <= T).length;
    return { minute: T, hg: c(m.hGoals), ag: c(m.aGoals), hc: c(m.hcMin), ac: c(m.acMin) };
  }
  function nextGoal(m, T) {
    const h = (m.hGoals || []).filter(x => x > T), a = (m.aGoals || []).filter(x => x > T);
    if (!h.length && !a.length) return 'None';
    if (!a.length) return 'Home'; if (!h.length) return 'Away';
    return Math.min(...h) <= Math.min(...a) ? 'Home' : 'Away';
  }
  // which option of a live market won, given the finished match
  function resolve(mkId, m, T) {
    const st = stateAt(m, T), fh = m.hg, fa = m.ag, ft = fh + fa;
    switch (mkId) {
      case 'L1X2': return R(fh, fa);
      case 'LNG': return nextGoal(m, T);
      case 'LROU0.5': return ft > st.hg + st.ag ? 'Yes' : 'No';
      case 'LOU+0.5': return ft > st.hg + st.ag + 0.5 ? 'Over' : 'Under';
      case 'LOU+1.5': return ft > st.hg + st.ag + 1.5 ? 'Over' : 'Under';
      case 'LGG': return fh > 0 && fa > 0 ? 'GG' : 'NG';
      case 'LNC': {
        const h = (m.hcMin || []).filter(x => x > T), a = (m.acMin || []).filter(x => x > T);
        if (!h.length && !a.length) return 'None'; if (!a.length) return 'Home'; if (!h.length) return 'Away';
        return Math.min(...h) <= Math.min(...a) ? 'Home' : 'Away';
      }
      case 'LHT': return T < 45 ? R(m.hth, m.hta) : null;
    }
    return null;
  }
  // relative-line probabilities used in backtest (lines move with the score, so test them relative to current total)
  function relProbs(c) {
    const s = c.st, tot = s.hg + s.ag;
    const all = markets(c); const by = Object.fromEntries(all.map(x => [x.id, x]));
    const pk = mk => mk && Object.fromEntries(mk.opts.map(o => [o.k, o.p]));
    return {
      'L1X2': pk(by.L1X2), 'LNG': pk(by.LNG), 'LROU0.5': pk(by['LROU0.5']),
      'LOU+0.5': pk(by['LOU' + (tot + 0.5)]), 'LOU+1.5': pk(by['LOU' + (tot + 1.5)]),
      'LGG': pk(by.LGG), 'LNC': pk(by.LNC), 'LHT': pk(by.LHT)
    };
  }
  const BT_MARKETS = { 'L1X2': 'Final 1X2', 'LNG': 'Next goal', 'LROU0.5': 'Another goal', 'LOU+0.5': 'Final total O/U (current+0.5)', 'LOU+1.5': 'Final total O/U (current+1.5)', 'LGG': 'GG (when not yet both scored)', 'LNC': 'Next corner', 'LHT': 'Half-time result (1st half only)' };

  // Walk-forward in-play backtest. Baseline = what someone who sees ONLY score + minute (no team strength)
  // would estimate: historical frequency of each outcome for the same minute/score-difference/total bucket.
  async function backtest(matches, o, { lastRounds = 150, checkpoints = [15, 30, 45, 60, 75, 85], onProgress } = {}) {
    const ZM = (typeof ZModel !== 'undefined') ? ZModel : require('./model.js');
    const groups = []; let cur = null;
    for (const m of matches) { const key = m.season + '|' + m.round; if (!cur || cur.key !== key) { cur = { key, ts: m.ts, ms: [] }; groups.push(cur); } cur.ms.push(m); }
    const startIdx = Math.max(0, groups.length - lastRounds);
    const hist = [], cond = {}, res = {};
    const bucket = (T, st) => T + '|' + Math.max(-2, Math.min(2, st.hg - st.ag)) + '|' + Math.min(4, st.hg + st.ag);
    const rec = (id, T, eng, probs, win) => {
      if (!probs || win == null || probs[win] == null) return;
      for (const key of [id + '|all', id + '|' + T]) {
        const s = ((res[key] = res[key] || {})[eng] = (res[key] || {})[eng] || { n: 0, hit: 0, ll: 0 });
        const best = Object.entries(probs).sort((a, b) => b[1] - a[1])[0][0];
        s.n++; if (best === win) s.hit++; s.ll += -Math.log(Math.max(1e-6, probs[win]));
      }
    };
    let evaluated = 0;
    for (let gi = 0; gi < groups.length; gi++) {
      const G = groups[gi];
      const ok = G.ms.every(m => Array.isArray(m.hGoals));
      if (gi >= startIdx && hist.length >= 60 && ok) {
        const S = ZM.prepare(hist, G.ts, o);
        for (const m of G.ms) {
          const pre = ZM.ctxFor(S, m.home, m.away);
          for (const T of checkpoints) {
            const st = stateAt(m, T);
            const P = relProbs(ctx(pre, st));
            for (const id of Object.keys(BT_MARKETS)) {
              const win = resolve(id, m, T); if (win == null || !P[id]) continue;
              rec(id, T, 'model', P[id], win);
              const cb = (cond[id] || {})[bucket(T, st)];
              if (cb && cb.n >= 20) { const keys = Object.keys(P[id]); const bp = {}; keys.forEach(k => { bp[k] = ((cb.c[k] || 0) + 0.5) / (cb.n + 0.5 * keys.length); }); rec(id, T, 'base', bp, win); rec(id, T, 'model_vs', P[id], win); }
            }
          }
          evaluated++;
        }
      }
      for (const m of G.ms) {
        hist.push(m);
        if (!Array.isArray(m.hGoals)) continue;
        for (const T of checkpoints) {
          const st = stateAt(m, T);
          for (const id of Object.keys(BT_MARKETS)) {
            const win = resolve(id, m, T); if (win == null) continue;
            const b = ((cond[id] = cond[id] || {})[bucket(T, st)] = (cond[id] || {})[bucket(T, st)] || { n: 0, c: {} });
            b.n++; b.c[win] = (b.c[win] || 0) + 1;
          }
        }
      }
      if (onProgress && gi % 3 === 0) { onProgress(gi / groups.length); await new Promise(r => setTimeout(r, 0)); }
    }
    return { res, evaluated, checkpoints, markets: BT_MARKETS };
  }

  return { estMinute, ctx, ctxAnchored, solveWP, markets, stateAt, nextGoal, resolve, backtest, BT_MARKETS };
})();
if (typeof module !== 'undefined') module.exports = ZLive;
