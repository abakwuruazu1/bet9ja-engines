// Accumulator ("slip") builder shared by the football and tennis dashboards.
// You give: target total odds, allowed markets, number of selections, limits.
// It returns the combination of selections (max one per match) that reaches the target odds with the
// HIGHEST chance that every selection wins, according to the engine's probabilities.
//
// Odds: Bet9ja's Zoom odds aren't readable by the extension, so each selection's odds are ESTIMATED as
// fair odds reduced by the bookmaker's margin:  odds ≈ 1 / (p × (1 + margin)). Type the real odds in
// the slip and everything recalculates.
const ZSlip = (() => {
  const STEP = 0.02; // log-odds bucket for the search
  const estOdds = (p, m) => Math.max(1.01, Math.floor(100 / (p * (1 + m))) / 100);

  // cands: [{ mkey, p, ...anything }]  opts: { target, minLegs, maxLegs, minP, maxLegOdds, minLegOdds, margin, perMatch }
  function build(cands, o) {
    const T = Math.log(o.target), Bmax = Math.ceil(T / STEP);
    const byMatch = new Map();
    for (const c of cands) {
      c.odds = c.oddsOverride || estOdds(c.p, o.margin);
      if (c.p < o.minP || c.odds > o.maxLegOdds || c.odds < (o.minLegOdds || 1.05)) continue;
      if (!byMatch.has(c.mkey)) byMatch.set(c.mkey, []);
      byMatch.get(c.mkey).push(c);
    }
    let states = new Map([['0|0', { n: 0, lp: 0, lo: 0, picks: [] }]]);
    for (const list of byMatch.values()) {
      list.sort((a, b) => b.p - a.p); const top = list.slice(0, o.perMatch || 30);
      const next = new Map(states);
      for (const s of states.values()) {
        if (s.n >= o.maxLegs) continue;
        for (const c of top) {
          const lo = s.lo + Math.log(c.odds), lp = s.lp + Math.log(c.p);
          const b = Math.min(Math.floor(lo / STEP), Bmax), key = (s.n + 1) + '|' + b;
          const cur = next.get(key);
          if (!cur || lp > cur.lp) next.set(key, { n: s.n + 1, lp, lo, picks: s.picks.concat([c]) });
        }
      }
      states = next;
    }
    const done = [...states.values()].filter(s => s.lo >= T - 1e-9 && s.n >= o.minLegs && s.n <= o.maxLegs);
    const byLegs = {};
    done.forEach(s => { if (!byLegs[s.n] || s.lp > byLegs[s.n].lp) byLegs[s.n] = s; });
    const best = done.sort((a, b) => b.lp - a.lp)[0] || null;
    // closest we could get if the target is unreachable
    const reach = [...states.values()].filter(s => s.n >= 1).sort((a, b) => b.lo - a.lo)[0];
    return { best, byLegs, maxReach: reach ? Math.exp(reach.lo) : 1, pool: [...byMatch.values()].reduce((s, l) => s + l.length, 0), matches: byMatch.size };
  }
  const prod = (legs, f) => legs.reduce((a, l) => a * f(l), 1);

  // Calibration: how often did picks the engine rated at probability p ACTUALLY win, per market?
  // Bins of 5%; each bin shrinks toward the raw probability with a prior worth K picks.
  const K = 40;
  function newCal() { return {}; }
  function addCal(cal, cands) { for (const c of cands) { const b = ((cal[c.mkId] = cal[c.mkId] || {})[Math.min(19, Math.floor(c.p * 20))] = (cal[c.mkId] || {})[Math.min(19, Math.floor(c.p * 20))] || [0, 0]); b[0]++; if (c.won) b[1]++; } }
  function applyCal(cal, mkId, p) { const b = cal[mkId] && cal[mkId][Math.min(19, Math.floor(p * 20))]; if (!b) return p; return Math.min(0.99, Math.max(0.01, (b[1] + K * p) / (b[0] + K))); }
  function calN(cal) { let n = 0; for (const m in cal) for (const k in cal[m]) n += cal[m][k][0]; return n; }

  // Backtest: slots = [[cand,...]] where each cand has .won (bool). Build a slip per slot, settle it.
  // slots must be OLDEST FIRST. Calibration only ever uses slots before the one being tested.
  async function backtest(slots, o, onProgress) {
    let n = 0, won = 0, sumP = 0, stake = 0, ret = 0; const rows = []; const cal = newCal();
    for (let i = 0; i < slots.length; i++) {
      const raw = slots[i];
      if (i >= 5) {
        const cands = o.calibrate ? raw.map(c => Object.assign({}, c, { p: applyCal(cal, c.mkId, c.p) })) : raw;
        const r = build(cands, o);
        if (r.best) {
          const legs = r.best.picks, P = prod(legs, l => l.p), odds = prod(legs, l => l.odds), ok = legs.every(l => l.won);
          n++; sumP += P; stake += 1; if (ok) { won++; ret += odds; }
          rows.push({ legs: legs.length, P, odds, ok, hits: legs.filter(l => l.won).length });
        }
      }
      addCal(cal, raw);
      if (onProgress && i % 5 === 0) { onProgress(i / slots.length); await new Promise(res => setTimeout(res, 0)); }
    }
    return { n, won, avgP: n ? sumP / n : 0, roi: stake ? ret / stake - 1 : 0, rows };
  }
  async function backtestOld(slots, o, onProgress) {
    let n = 0, won = 0, sumP = 0, stake = 0, ret = 0; const rows = [];
    for (let i = 0; i < slots.length; i++) {
      const r = build(slots[i], o); if (!r.best) continue;
      const legs = r.best.picks, P = prod(legs, l => l.p), odds = prod(legs, l => l.odds), ok = legs.every(l => l.won);
      n++; sumP += P; stake += 1; if (ok) { won++; ret += odds; }
      rows.push({ legs: legs.length, P, odds, ok, hits: legs.filter(l => l.won).length });
      if (onProgress && i % 5 === 0) { onProgress(i / slots.length); await new Promise(res => setTimeout(res, 0)); }
    }
    return { n, won, avgP: n ? sumP / n : 0, roi: stake ? ret / stake - 1 : 0, rows };
  }

  // ---------------- UI
  // adapter: { key, title, markets:[{group,id,name}], defaultMarkets:[], sources:[{id,name}], horizonDefault,
  //            candidates(settings) -> {cands, note}, backtestSlots(settings, onProgress) -> Promise<slots>,
  //            describe(c) -> {when, comp, event, market, pick} }
  function mount(view, A) {
    if (!view.__slMk) { view.__slMk = true; view.addEventListener('click', e => { const b = e.target.closest('#sl_mkAll,#sl_mkNone'); if (!b) return; e.preventDefault(); view.querySelectorAll('.sl_mk').forEach(x => { x.checked = b.id === 'sl_mkAll'; }); view.dispatchEvent(new Event('sl_mkchange')); }); view.addEventListener('change', e => { if (e.target.classList && e.target.classList.contains('sl_mk')) view.dispatchEvent(new Event('sl_mkchange')); }); view.addEventListener('sl_mkchange', () => { const n = view.querySelector('#sl_mkn'); if (n) n.textContent = view.querySelectorAll('.sl_mk:checked').length; }); }
    const SK = 'slip_' + A.key;
    let S; try { S = JSON.parse(localStorage.getItem(SK) || 'null'); } catch (e) { S = null; }
    S = Object.assign({ calibrate: true, target: 10, minLegs: 2, maxLegs: 8, minP: 55, maxLegOdds: 3, margin: 8, horizon: A.horizonDefault, markets: A.defaultMarkets, sources: A.sources.map(s => s.id) }, S || {});
    S.sources = S.sources.filter(id => A.sources.some(s => s.id === id)); if (!S.sources.length) S.sources = A.sources.map(s => s.id);
    const save = () => { try { localStorage.setItem(SK, JSON.stringify(S)); } catch (e) { } };
    const groups = {}; A.markets.forEach(m => (groups[m.group] = groups[m.group] || []).push(m));
    const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const pp = p => (p * 100).toFixed(p < 0.01 ? 2 : 1) + '%';
    const num = (id, label, val, step, min, max, w = 110) => `<label>${label}<input type="number" id="sl_${id}" value="${val}" step="${step}" min="${min}" max="${max}" style="width:${w}px;min-width:0"></label>`;
    view.innerHTML = `
    <div class="card"><h3>🧾 Slip builder <small>tell it the total odds you want — it picks the matches and predictions</small></h3>
      <div class="controls">
        ${num('target', 'Target total odds', S.target, 0.5, 1.1, 100000, 130)}
        ${num('minLegs', 'Min selections', S.minLegs, 1, 1, 30)}
        ${num('maxLegs', 'Max selections', S.maxLegs, 1, 1, 30)}
        ${num('minP', 'Min win chance per pick %', S.minP, 1, 1, 99, 150)}
        ${num('maxLegOdds', 'Max odds per pick', S.maxLegOdds, 0.1, 1.05, 1000)}
        ${num('margin', 'Bookmaker margin %', S.margin, 0.5, 0, 40)}
        ${num('horizon', 'Matches starting within (min)', S.horizon, 5, 5, 1440, 170)}
      </div>
      <div style="margin:6px 0 10px"><b>${esc(A.sourceLabel)}</b> ${A.sources.map(s => `<label style="display:inline-flex;flex-direction:row;gap:6px;margin:4px 14px 4px 0;color:var(--text)"><input type="checkbox" class="sl_src" value="${s.id}" ${S.sources.includes(s.id) ? 'checked' : ''}> ${esc(s.name)}</label>`).join('')}</div>
      <details ${S.markets.length ? '' : 'open'}><summary style="cursor:pointer;font-weight:700">Markets allowed (<span id="sl_mkn">${S.markets.length}</span> selected) — click to choose</summary>
        <div style="margin-top:10px;display:flex;gap:8px"><button type="button" class="btn ghost" id="sl_mkAll">☑ Check all</button><button type="button" class="btn ghost" id="sl_mkNone">☐ Uncheck all</button></div>
        <div class="grid" style="margin-top:10px">${Object.entries(groups).map(([g, ms]) => `<div><b>${esc(g)}</b><br>${ms.map(m => `<label style="display:flex;flex-direction:row;gap:6px;margin:3px 0;color:var(--text)"><input type="checkbox" class="sl_mk" value="${m.id}" ${S.markets.includes(m.id) ? 'checked' : ''}> ${esc(m.name)}</label>`).join('')}</div>`).join('')}</div>
      </details>
      <label style="display:flex;flex-direction:row;gap:8px;align-items:center;margin-top:10px;color:var(--text)"><input type="checkbox" id="sl_cal" ${S.calibrate ? 'checked' : ''}> <span><b>Calibrate probabilities on past results</b> <span class="mute">(recommended: corrects the engine wherever it has been over- or under-confident in each market)</span></span></label>
      <div style="margin-top:12px"><button class="btn" id="sl_build">⚡ Build my slip</button> <button class="btn ghost" id="sl_bt">🧪 Backtest these settings</button></div>
    </div>
    <div id="sl_out" style="margin-top:16px"></div><div id="sl_btout" style="margin-top:16px"></div>`;
    const read = () => {
      const g = id => +view.querySelector('#sl_' + id).value;
      Object.assign(S, { target: g('target'), minLegs: Math.max(1, g('minLegs')), maxLegs: Math.max(1, g('maxLegs')), minP: g('minP'), maxLegOdds: g('maxLegOdds'), margin: g('margin'), horizon: g('horizon') });
      if (S.minLegs > S.maxLegs) S.maxLegs = S.minLegs;
      S.markets = [...view.querySelectorAll('.sl_mk:checked')].map(x => x.value); S.calibrate = view.querySelector('#sl_cal').checked;
      S.sources = [...view.querySelectorAll('.sl_src:checked')].map(x => isNaN(+x.value) ? x.value : +x.value);
      save();
      return { calibrate: S.calibrate, target: S.target, minLegs: S.minLegs, maxLegs: S.maxLegs, minP: S.minP / 100, maxLegOdds: S.maxLegOdds, margin: S.margin / 100, horizon: S.horizon, markets: S.markets, sources: S.sources };
    };
    const out = view.querySelector('#sl_out');
    view.querySelector('#sl_build').onclick = () => {
      const o = read();
      if (!o.markets.length) { out.innerHTML = '<div class="note">Tick at least one market.</div>'; return; }
      out.innerHTML = '<div class="card"><h3>Building…</h3><p class="mute" id="sl_stage"></p></div>';
      setTimeout(async () => {
        const { cands, note } = A.candidates(o);
        let calInfo = null;
        if (o.calibrate && cands.length) {
          const ck = o.markets.slice().sort().join(',') + '|' + o.sources.slice().sort().join(',');
          if (!A._cal || A._cal.key !== ck || Date.now() - A._cal.at > 15 * 60e3) {
            const st = view.querySelector('#sl_stage'); if (st) st.textContent = 'Calibrating on past rounds (once every 15 min)…';
            const slots = await A.backtestSlots(o, () => {}); const cal = newCal(); slots.forEach(sl => addCal(cal, sl));
            A._cal = { key: ck, at: Date.now(), cal, n: calN(cal) };
          }
          cands.forEach(c => { c.praw = c.p; c.p = applyCal(A._cal.cal, c.mkId, c.p); });
          calInfo = A._cal.n;
        }
        if (!cands.length) { out.innerHTML = `<div class="card"><h3>No matches available</h3><p>${note || 'No upcoming fixtures with predictions in that time window.'}</p></div>`; return; }
        const r = build(cands, o);
        if (!r.best) {
          out.innerHTML = `<div class="card"><h3>Can't reach ${o.target} odds with these settings</h3><p>${r.matches} matches · ${r.pool} eligible picks. The highest total odds possible is about <b>${r.maxReach.toFixed(2)}</b>.</p><p class="mute">Try: more selections, a lower minimum win chance per pick, a higher max odds per pick, more markets or a longer time window.</p></div>`;
          return;
        }
        renderSlip(r, o, calInfo);
      }, 20);
    };
    function renderSlip(r, o, calInfo) {
      const legs = r.best.picks;
      out.innerHTML = `<div class="card" style="border-color:var(--acc2)"><h3>Your slip <small>${legs.length} selections from ${r.matches} matches checked · ${r.pool} possible picks</small></h3>
        <div class="kpis" id="sl_kpis"></div>
        <div style="overflow-x:auto"><table><tr><th>When</th><th>${esc(A.sourceLabel)}</th><th>Match</th><th>Market</th><th>Pick</th><th class="n">Win chance${calInfo ? ' (calibrated)' : ''}</th><th class="n">Est. odds</th><th>Real Bet9ja odds</th><th class="n">Pick EV</th></tr>
        ${legs.map((l, i) => { const d = A.describe(l); return `<tr><td>${esc(d.when)}</td><td class="mute">${esc(d.comp)}</td><td><b>${esc(d.event)}</b></td><td>${esc(d.market)}</td><td><span class="pill pick">${esc(d.pick)}</span></td><td class="n"><b>${pp(l.p)}</b>${l.praw != null && Math.abs(l.praw - l.p) > 0.005 ? `<div class="mute" style="font-size:12px">raw ${pp(l.praw)}</div>` : ''}</td><td class="n">${l.odds.toFixed(2)}</td><td><input type="number" step="0.01" min="1.01" data-leg="${i}" placeholder="${l.odds.toFixed(2)}" style="width:90px;min-width:0"></td><td class="n" data-ev="${i}">–</td></tr>`; }).join('')}</table></div>
        ${calInfo ? `<p class="mute" style="font-size:13px">Win chances are calibrated on ${calInfo.toLocaleString()} past picks in these markets: each raw engine probability is corrected by how often picks at that level actually won.</p>` : ''}
        <p class="mute" style="font-size:13px">Type each pick's real Bet9ja odds to replace the estimate. The slip win chance assumes the selections are independent (different matches).</p>
        <div class="note" id="sl_msg"></div>
        <h3 style="margin-top:16px">Same target with a different number of selections</h3>
        <table><tr><th class="n">Selections</th><th class="n">Slip win chance</th><th class="n">Est. total odds</th></tr>${Object.values(r.byLegs).sort((a, b) => a.n - b.n).map(s => `<tr${s === r.best ? ' style="font-weight:800"' : ''}><td class="n">${s.n}${s === r.best ? ' ✓' : ''}</td><td class="n">${pp(Math.exp(s.lp))}</td><td class="n">${Math.exp(s.lo).toFixed(2)}</td></tr>`).join('')}</table></div>`;
      const recalc = () => {
        let P = 1, O = 1, real = 0;
        legs.forEach((l, i) => { const v = +out.querySelector(`[data-leg="${i}"]`).value; const od = v > 1 ? v : l.odds; if (v > 1) real++; P *= l.p; O *= od; const ev = l.p * od - 1; const c = out.querySelector(`[data-ev="${i}"]`); c.textContent = (ev > 0 ? '+' : '') + (ev * 100).toFixed(1) + '%'; c.className = 'n ' + (ev > 0 ? 'good' : 'bad'); });
        const ret = P * O;
        out.querySelector('#sl_kpis').innerHTML = `<div class="kpi"><div class="v">${O.toFixed(2)}</div><div class="l">Total odds ${real === legs.length ? '(your real odds)' : real ? `(${real} real, ${legs.length - real} estimated)` : '(estimated)'}</div></div>
          <div class="kpi"><div class="v good">${pp(P)}</div><div class="l">Chance the whole slip wins (engine)</div></div>
          <div class="kpi"><div class="v">1 in ${(1 / P).toFixed(1)}</div><div class="l">Expect to win about once every this many slips</div></div>
          <div class="kpi"><div class="v ${ret >= 1 ? 'good' : 'bad'}">₦${(ret * 100).toFixed(0)}</div><div class="l">Average return per ₦100 staked</div></div>`;
        out.querySelector('#sl_msg').innerHTML = ret >= 1
          ? `At these odds the engine rates this slip as <b>value</b>: it expects ₦${(ret * 100).toFixed(0)} back per ₦100 over many slips. Check the backtest before trusting it.`
          : `At these odds you get back ₦${(ret * 100).toFixed(0)} per ₦100 on average over many slips. The bookmaker's margin is charged on every pick, so <b>more selections cost more</b>. This slip is simply the most likely way to reach ${o.target} odds.`;
      };
      out.querySelectorAll('[data-leg]').forEach(i => i.addEventListener('input', recalc));
      recalc();
    }
    view.querySelector('#sl_bt').onclick = async () => {
      const o = read(); const bo = view.querySelector('#sl_btout');
      if (!o.markets.length) { bo.innerHTML = '<div class="note">Tick at least one market.</div>'; return; }
      bo.innerHTML = '<div class="card"><h3>Backtesting…</h3><div class="progress"><span id="sl_prog"></span></div></div>';
      const prog = p => { const e = view.querySelector('#sl_prog'); if (e) e.style.width = (p * 100).toFixed(0) + '%'; };
      const slots = (await A.backtestSlots(o, p => prog(p * 0.8))).slice().reverse(); // oldest first
      const r = await backtest(slots, o, p => prog(0.8 + p * 0.2));
      if (!r.n) { bo.innerHTML = '<div class="card"><h3>Backtest</h3><p class="mute">No past rounds could produce a slip with these settings (or not enough history yet).</p></div>'; return; }
      const legsAvg = r.rows.reduce((s, x) => s + x.legs, 0) / r.n, hitsAvg = r.rows.reduce((s, x) => s + x.hits / x.legs, 0) / r.n;
      bo.innerHTML = `<div class="card"><h3>🧪 Backtest: these exact settings on past rounds <small>each slip built only from data available before it${o.calibrate ? ' · calibrated on earlier rounds only' : ''}</small></h3>
        <div class="kpis"><div class="kpi"><div class="v">${r.n}</div><div class="l">Slips built (avg ${legsAvg.toFixed(1)} selections)</div></div>
        <div class="kpi"><div class="v">${r.won} <span class="mute" style="font-size:16px">(${pp(r.won / r.n)})</span></div><div class="l">Slips that won · engine expected ${pp(r.avgP)}</div></div>
        <div class="kpi"><div class="v">${pp(hitsAvg)}</div><div class="l">Individual picks that won</div></div>
        <div class="kpi"><div class="v ${r.roi >= 0 ? 'good' : 'bad'}">${r.roi >= 0 ? '+' : ''}${(r.roi * 100).toFixed(1)}%</div><div class="l">Profit at the estimated odds (flat stake)</div></div></div>
        <p class="mute" style="font-size:13px">If "Slips that won" sits close to "engine expected", the engine's slip probabilities are honest. Profit uses estimated odds with your margin setting; real Bet9ja odds may differ. Small samples swing a lot.</p></div>`;
    };
  }
  return { build, backtest, mount, estOdds, newCal, addCal, applyCal };
})();
if (typeof module !== 'undefined') module.exports = ZSlip;
