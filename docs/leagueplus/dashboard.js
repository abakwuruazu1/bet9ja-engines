/* League Plus Engine – dashboard */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pc = x => (x == null || isNaN(x) ? '–' : (+x).toFixed(1) + '%');
const pp = p => (p == null || isNaN(p) ? '–' : (p * 100).toFixed(1) + '%');
const f2 = x => (x == null || isNaN(x) ? '–' : (+x).toFixed(2));
const fmtT = ts => new Date(ts).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
const fmtTs = ts => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const ago = ts => { if (!ts) return 'never'; const s = Math.round((Date.now() - ts) / 1000); return s < 60 ? s + 's ago' : s < 3600 ? Math.round(s / 60) + ' min ago' : (s / 3600).toFixed(1) + ' h ago'; };
const bar = (p, cls = '') => `<div class="bar ${cls}"><span style="width:${Math.max(0, Math.min(100, p))}%"></span></div>`;
const ENG = { mkt: 'Bet9ja market model', fair: 'Bet9ja fair odds', team: 'Team ratings', blend: 'Blend (team + market)' };

const St = {
  init: null, cat: null, comps: [], matches: [], byComp: new Map(), selsets: {}, up: [], standings: {}, status: null, tab: 'overview', teamCache: {}, vf: null,
  ui: Object.assign({ comp: 'all', mk: '1', eng: 'mkt', minEdge: 3, maxOdds: 10, vComp: 'all', vEng: 'team', vEdge: 3, vHours: 0, vMk: 'ALL', rComp: null, tComp: null, halfLifeH: 6 }, (() => { try { return JSON.parse(localStorage.getItem('lpui') || '{}'); } catch (e) { return {}; } })())
};
const saveUI = () => { try { localStorage.setItem('lpui', JSON.stringify(St.ui)); } catch (e) { } };
const cname = id => (St.comps.find(c => c.id === +id) || {}).name || 'League ' + id;
const CM = c => St.byComp.get(+c) || [];

async function load() {
  const [init, ms, meta, { lpstatus }] = await Promise.all([LPDB.get('meta', 'init'), LPDB.getAll('matches'), LPDB.getAll('meta'), chrome.storage.local.get('lpstatus')]);
  St.status = lpstatus; St.init = init;
  if (init) { St.cat = LPCat.build(init); St.comps = init.games.flatMap(g => g.leagues.filter(l => l.enabled).map(l => ({ id: l.id, name: l.name, game: g.id }))); }
  St.matches = ms.sort((a, b) => a.ts - b.ts || a.idx - b.idx);
  St.byComp = new Map(); St.matches.forEach(m => { if (!St.byComp.has(m.comp)) St.byComp.set(m.comp, []); St.byComp.get(m.comp).push(m); });
  St.selsets = {}; St.up = []; St.standings = {};
  meta.forEach(x => { if (x.key.startsWith('sel:')) St.selsets[x.key] = x.value; else if (x.key.startsWith('up:')) St.up.push(...x.fixtures); else if (x.key.startsWith('st:')) (x.standings || []).forEach(s => { St.standings[s.competition] = s; }); });
  St.teamCache = {};
  syncLine();
}
function syncLine() {
  const s = St.status || {};
  $('#syncLine').innerHTML = `${St.matches.length.toLocaleString()} matches recorded · ${new Set(St.matches.map(m => m.game + ':' + m.roundId)).size} rounds · last check ${ago(s.lastSync)}${s.log && s.log.length ? ' · <span class="bad">' + s.log.length + ' warning(s)</span>' : ''}`;
}
$('#btnSync').addEventListener('click', async () => { $('#btnSync').disabled = true; await chrome.runtime.sendMessage({ type: 'lpSyncNow' }); await load(); render(true); $('#btnSync').disabled = false; });
chrome.storage.onChanged.addListener(async ch => {
  if (!ch.lpstatus) return; const prev = St.status && St.status.lastAdded; St.status = ch.lpstatus.newValue; syncLine();
  if (St.status.lastAdded !== prev || ['next', 'overview'].includes(St.tab)) { await load(); if (['overview', 'next', 'results', 'tables'].includes(St.tab)) render(true); }
});
$('#tabs').addEventListener('click', e => { const b = e.target.closest('button[data-tab]'); if (!b) return; document.querySelectorAll('#tabs button').forEach(x => x.classList.toggle('on', x === b)); St.tab = b.dataset.tab; render(); });
const view = $('#view');
view.addEventListener('change', e => { const k = e.target.dataset.ui; if (!k) return; St.ui[k] = e.target.type === 'number' ? +e.target.value : e.target.value; saveUI(); if (k.startsWith('v')) St.vf = null; render(true); });
view.addEventListener('click', e => {
  const t = e.target.closest('[data-act]'); if (!t) return; if (t.tagName === 'A') e.preventDefault();
  if (t.dataset.act === 'match') showMatch(t.dataset.key);
  if (t.dataset.act === 'vf') runValueFinder();
  if (t.dataset.act === 'export') exportJSON();
  if (t.dataset.act === 'csv') exportCSV();
  if (t.dataset.act === 'import') $('#impFile').click();
  if (t.dataset.act === 'clear') clearDB();
  if (t.dataset.act === 'saveSet') { St.ui.halfLifeH = +$('#set_hl').value || 6; saveUI(); St.teamCache = {}; $('#setMsg').textContent = 'Saved ✓'; }
});
$('#modalX').addEventListener('click', () => $('#modal').classList.add('hidden'));
$('#modal').addEventListener('click', e => { if (e.target.id === 'modal') $('#modal').classList.add('hidden'); });
function render(keep) {
  const y = window.scrollY;
  if (!St.init) { view.innerHTML = '<div class="empty"><h2>Starting up…</h2><p>The first capture runs within 30 seconds. Keep Chrome open.</p></div>'; return; }
  ({ overview: rOverview, next: rNext, slip: rSlip, value: rValue, results: rResults, tables: rTables, settings: rSettings })[St.tab]();
  if (keep) window.scrollTo(0, y);
}

// ---------------- helpers
function markets() { // market keys present in the catalogue, in a sensible order
  const seen = new Map();
  Object.values(St.cat).sort((a, b) => a.mId - b.mId || String(a.sub).localeCompare(String(b.sub)) || a.id - b.id).forEach(c => { const k = LPCat.mkey(c); if (!seen.has(k)) seen.set(k, { key: k, label: LPCat.mlabel(c), group: c.market, ids: [] }); seen.get(k).ids.push(c.id); });
  return [...seen.values()];
}
const selLabel = (c, home, away) => { if (c.mId === 1) return c.name === '1' ? home + ' win' : c.name === '2' ? away + ' win' : 'Draw'; if (c.mId === 2) return c.name === '1X' ? home + ' or draw' : c.name === 'X2' ? away + ' or draw' : home + ' or ' + away; return c.full; };
function teamFit(comp) {
  const c = St.teamCache[comp]; const hist = CM(comp);
  if (c && c.n === hist.length) return c.T;
  const T = LPModel.fitTeams(hist.slice(-3000), Date.now(), { halfLifeH: St.ui.halfLifeH });
  St.teamCache[comp] = { n: hist.length, T }; return T;
}
const engP = (r, eng) => (eng === 'team' ? r.team : r[eng]);
const evalCache = new Map();
function evalFx(fx) {
  const k = fx.key + ':' + St.ui.halfLifeH + ':' + CM(fx.comp).length; if (evalCache.has(k)) return evalCache.get(k);
  const ev = LPModel.evaluate(St.cat, fx, St.selsets[fx.sk] || '', teamFit(fx.comp)); evalCache.set(k, ev); if (evalCache.size > 400) evalCache.clear(); return ev;
}
const openFx = () => St.up.filter(f => f.close > Date.now());
const compSel = (name, val, all = true) => `<label>League<select data-ui="${name}">${all ? `<option value="all" ${val === 'all' ? 'selected' : ''}>All leagues</option>` : ''}${St.comps.map(c => `<option value="${c.id}" ${+val === c.id ? 'selected' : ''}>${esc(c.name)} (${CM(c.id).length})</option>`).join('')}</select></label>`;
const mkSel = (name, val, withAll) => { const g = {}; markets().forEach(m => (g[m.group] = g[m.group] || []).push(m)); return `<label>Market<select data-ui="${name}">${withAll ? `<option value="ALL" ${val === 'ALL' ? 'selected' : ''}>All markets</option>` : ''}${Object.entries(g).map(([n, ms]) => `<optgroup label="${esc(n)}">${ms.map(m => `<option value="${m.key}" ${val === m.key ? 'selected' : ''}>${esc(m.label)}</option>`).join('')}</optgroup>`).join('')}</select></label>`; };
const engSel = (name, val, opts = ['mkt', 'fair', 'team', 'blend']) => `<label>Probability engine<select data-ui="${name}">${opts.map(k => `<option value="${k}" ${val === k ? 'selected' : ''}>${ENG[k]}</option>`).join('')}</select></label>`;
const countdown = ts => { const s = Math.max(0, Math.round((ts - Date.now()) / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
setInterval(() => document.querySelectorAll('[data-cd]').forEach(e => { e.textContent = countdown(+e.dataset.cd); }), 1000);

// ---------------- OVERVIEW
function rOverview() {
  const s = St.status || {};
  const hrs = s.firstSync ? (Date.now() - s.firstSync) / 3600e3 : 0;
  const cards = St.comps.map(c => {
    const ms = CM(c.id), last = ms[ms.length - 1], fx = openFx().filter(f => f.comp === c.id), st = St.standings[c.id];
    const top = st ? String(st.value).split('|').slice(0, 5).map((r, i) => { const [t, pts, form] = r.split('-'); return `<tr><td>${i + 1}</td><td><b>${esc(t)}</b></td><td class="n">${pts}</td><td><span class="form">${String(form || '').split('').map(x => `<i class="${x}">${x}</i>`).join('')}</span></td></tr>`; }).join('') : '';
    return `<div class="card"><h3>${esc(c.name)} <small>${ms.length} matches recorded</small></h3>
      ${fx.length ? `<div>Next round: <b>${fx.length} matches</b> · betting closes in <span class="cd good" data-cd="${fx[0].close}">${countdown(fx[0].close)}</span> · week ${fx[0].week}</div>` : '<div class="mute">Waiting for the next round…</div>'}
      ${last ? `<div class="mute">Last result recorded ${ago(last.ts + 60e3)} (week ${last.week})</div>` : ''}
      ${top ? `<table style="margin-top:8px">${top}</table>` : ''}</div>`;
  }).join('');
  view.innerHTML = `<div class="kpis">
    <div class="kpi"><div class="v">${St.matches.length.toLocaleString()}</div><div class="l">Matches recorded with Bet9ja odds</div></div>
    <div class="kpi"><div class="v">${new Set(St.matches.map(m => m.game + ':' + m.roundId)).size}</div><div class="l">Rounds recorded</div></div>
    <div class="kpi"><div class="v">${hrs.toFixed(1)} h</div><div class="l">Recording for</div></div>
    <div class="kpi"><div class="v">${ago(s.lastSync)}</div><div class="l">Last check (every 30 s)</div></div></div>
  ${s.log && s.log.length ? `<div class="note"><b>Warnings</b><br>${s.log.map(esc).join('<br>')}</div>` : ''}
  <div class="grid">${cards}</div>
  <div class="note"><b>Keep Chrome open.</b> Bet9ja's League Plus feed only shows the round about to start and the one that just finished, so this engine records every round as it happens (one every ~6 minutes per league). The longer it runs, the stronger the team ratings, the value finder and the backtests get.</div>`;
}

// ---------------- NEXT ROUND
function rNext() {
  const mks = markets(); if (!mks.find(m => m.key === St.ui.mk)) St.ui.mk = '1';
  const M = mks.find(m => m.key === St.ui.mk), eng = St.ui.eng, minE = (St.ui.minEdge || 0) / 100;
  const fxs = openFx().filter(f => St.ui.comp === 'all' || f.comp === +St.ui.comp);
  let h = `<div class="controls">${compSel('comp', St.ui.comp)}${mkSel('mk', St.ui.mk)}${engSel('eng', eng)}<label>Value if edge ≥ %<input type="number" data-ui="minEdge" value="${St.ui.minEdge}" step="0.5" style="width:110px;min-width:0"></label><label>Value picks: max odds<input type="number" data-ui="maxOdds" value="${St.ui.maxOdds}" step="1" style="width:110px;min-width:0"></label></div>`;
  if (!fxs.length) { view.innerHTML = h + '<div class="empty">No round open for betting right now — the next one appears within a minute.</div>'; return; }
  const teamNote = eng === 'team' || eng === 'blend' ? fxs.some(f => teamFit(f.comp).n < 30) ? '<div class="note">Team ratings need at least 30 recorded matches per league; leagues below that fall back to the market model.</div>' : '' : '';
  // value across ALL markets
  const vals = [];
  for (const fx of fxs) { const ev = evalFx(fx); for (const r of ev.rows) { const p = engP(r, eng); if (p == null) continue; const e = p * r.odds - 1; if (e >= minE && r.odds >= 1.2 && r.odds <= (St.ui.maxOdds || 1e9)) vals.push({ fx, r, p, e }); } }
  vals.sort((a, b) => b.e - a.e);
  h += teamNote + `<div class="card" style="margin-bottom:16px"><h3>💰 Value picks in this round <small>${ENG[eng]} chance × Bet9ja odds − 1 ≥ ${St.ui.minEdge}% · any market · odds ≤ ${St.ui.maxOdds}</small></h3>
    ${vals.length ? `<div class="scroll" style="max-height:360px"><table><tr><th>League</th><th>Match</th><th>Market</th><th>Pick</th><th class="n">Bet9ja odds</th><th class="n">Engine chance</th><th class="n">Fair (Bet9ja)</th><th class="n">Edge</th></tr>${vals.slice(0, 60).map(v => { const c = St.cat[v.r.id]; return `<tr><td>${esc(cname(v.fx.comp))}</td><td><b>${esc(v.fx.home)} v ${esc(v.fx.away)}</b></td><td>${esc(LPCat.mlabel(c))}</td><td><span class="pill pick">${esc(selLabel(c, v.fx.home, v.fx.away))}</span></td><td class="n">${f2(v.r.odds)}</td><td class="n">${pp(v.p)}</td><td class="n mute">${pp(v.r.fair)}</td><td class="n good"><b>+${(v.e * 100).toFixed(1)}%</b></td></tr>`; }).join('')}</table></div>` : `<p class="mute">No selection reaches a ${St.ui.minEdge}% edge with the ${ENG[eng]}. ${eng === 'mkt' || eng === 'fair' ? 'That is expected: Bet9ja\'s prices are internally consistent, so the market model mostly agrees with them. Try Team ratings once enough rounds are recorded.' : ''}</p>`}
    <p class="mute" style="font-size:13px">Check the Value finder tab: it shows how picks like these have actually paid on recorded rounds before you trust them.</p></div>`;
  const byComp = {}; fxs.forEach(f => (byComp[f.comp] = byComp[f.comp] || []).push(f));
  h += `<div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(560px,1fr))">`;
  for (const comp in byComp) {
    const L = byComp[comp];
    h += `<div class="card"><h3>${esc(cname(comp))} · week ${L[0].week} <small>closes in <span class="cd" data-cd="${L[0].close}">${countdown(L[0].close)}</span></small></h3><div style="overflow-x:auto"><table><tr><th>Match</th>${M.ids.map(id => `<th class="n">${esc(St.cat[id].name)}</th>`).join('')}</tr>`;
    for (const fx of L) {
      const ev = evalFx(fx);
      h += `<tr><td><b>${esc(fx.home)}</b> v <b>${esc(fx.away)}</b></td>${M.ids.map(id => { const r = ev.rows.find(x => x.id === id); if (!r) return '<td class="n mute">–</td>'; const p = engP(r, eng); const e = p != null ? p * r.odds - 1 : null; return `<td class="n"><span class="odd ${e != null && e >= minE ? 'val' : ''}">${f2(r.odds)}</span><div class="gm">${pp(p)}${e != null ? ` · ${e >= 0 ? '+' : ''}${(e * 100).toFixed(0)}%` : ''}</div></td>`; }).join('')}</tr>`;
    }
    h += `</table></div></div>`;
  }
  view.innerHTML = h + `</div><div class="note">Each cell: Bet9ja odds, then the engine's chance and its edge (chance × odds − 1). Bet9ja's margin is about 5% on 1X2, GG/NG and over/under and about 18% on correct score, so most edges are negative.</div>`;
}

// ---------------- SLIP BUILDER (real odds)
function rSlip() {
  const eng = St.ui.eng;
  const mk = markets();
  ZSlip.mount(view, {
    key: 'leagueplus', realOdds: true, sourceLabel: 'League', sources: St.comps.map(c => ({ id: c.id, name: c.name })), horizonDefault: 8,
    markets: mk.map(m => ({ group: m.group, id: m.key, name: m.label })), defaultMarkets: ['1', '2', '3', '5@1.5', '5@2.5'],
    candidates(o) {
      const now = Date.now(), cands = [];
      const fxs = openFx().filter(f => o.sources.includes(f.comp) && f.close <= now + o.horizon * 60e3 && f.close > now + 15e3);
      for (const fx of fxs) { const ev = evalFx(fx); for (const r of ev.rows) { const c = St.cat[r.id]; const k = LPCat.mkey(c); if (!o.markets.includes(k)) continue; const p = engP(r, eng); if (p == null) continue; cands.push({ mkey: fx.key, mkId: k, p, oddsOverride: r.odds, fx, id: r.id }); } }
      return { cands, note: 'No League Plus round is open for betting in that window. A new round opens every few minutes.' };
    },
    async backtestSlots(o, onProgress) {
      // past rounds grouped by game; slot j = j-th most recent round of every selected league
      const perGame = {};
      const ms = St.matches.filter(m => o.sources.includes(m.comp) && m.odds && St.selsets[m.sk]);
      ms.forEach(m => { ((perGame[m.game] = perGame[m.game] || {})[m.roundId] = (perGame[m.game] || {})[m.roundId] || []).push(m); });
      const lists = Object.values(perGame).map(r => Object.keys(r).sort((a, b) => b - a).slice(0, 60).map(id => r[id]));
      const len = Math.max(0, ...lists.map(l => l.length)), slots = [];
      const tf = {};
      for (let j = 0; j < len; j++) {
        const cands = [];
        for (const L of lists) {
          const R = L[j]; if (!R) continue;
          for (const m of R) {
            let T = null;
            if (eng === 'team' || eng === 'blend') { const key = m.comp + ':' + m.roundId; T = tf[key] || (tf[key] = LPModel.fitTeams(CM(m.comp).filter(x => x.ts < m.ts).slice(-3000), m.ts, { halfLifeH: St.ui.halfLifeH })); }
            const ev = LPModel.evaluate(St.cat, m, St.selsets[m.sk], T);
            for (const r of ev.rows) { const c = St.cat[r.id]; const k = LPCat.mkey(c); if (!o.markets.includes(k)) continue; const p = engP(r, eng); if (p == null) continue; const w = LPCat.settle(c, m.hg, m.ag, m.goals); if (w == null) continue; cands.push({ mkey: m.key, mkId: k, p, oddsOverride: r.odds, won: w }); }
          }
        }
        slots.push(cands); onProgress(j / len); await new Promise(r => setTimeout(r, 0));
      }
      return slots;
    },
    describe(l) { const c = St.cat[l.id]; return { when: 'closes ' + fmtTs(l.fx.close), comp: cname(l.fx.comp), event: l.fx.home + ' v ' + l.fx.away, market: LPCat.mlabel(c), pick: selLabel(c, l.fx.home, l.fx.away) }; },
    slipNote: legs => { const soon = Math.min(...legs.map(l => l.fx.close)); return `<div class="note">⏱ Bet before <b>${fmtTs(soon)}</b> — betting on the first match closes in <span class="cd" data-cd="${soon}">${countdown(soon)}</span>.</div>`; }
  });
  view.insertAdjacentHTML('beforeend', `<div class="note">Probabilities: <b>${ENG[eng]}</b> (change on the Next round tab). Odds are Bet9ja's real prices for the open round, so the slip's total odds are what Bet9ja pays. Because each pick carries Bet9ja's margin, the slip that reaches your target with the fewest, lowest-margin picks gives the best chance.</div>`);
}

// ---------------- VALUE FINDER (history with real odds)
function rValue() {
  view.innerHTML = `<div class="controls">${compSel('vComp', St.ui.vComp)}${engSel('vEng', St.ui.vEng, ['team', 'blend', 'fair'])}<label>Edge needed %<input type="number" data-ui="vEdge" value="${St.ui.vEdge}" step="0.5" style="width:110px;min-width:0"></label><label>Value picks: max odds<input type="number" data-ui="maxOdds" value="${St.ui.maxOdds}" step="1" style="width:110px;min-width:0"></label><label>Period<select data-ui="vHours">${[[0, 'All recorded'], [6, 'Last 6 hours'], [24, 'Last 24 hours'], [72, 'Last 3 days']].map(([k, l]) => `<option value="${k}" ${+St.ui.vHours === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>${mkSel('vMk', St.ui.vMk, true)}<button class="btn" data-act="vf">▶ Analyse recorded rounds</button></div>
  <div class="note">Uses every recorded match with Bet9ja's real pre-match odds. For each market it shows: what you'd have made backing <b>every</b> selection, how accurate Bet9ja's prices were, and what you'd have made backing only the picks the engine rated as value at the time (team ratings are rebuilt using only matches before each round).</div>
  <div id="vfProg" class="progress" style="display:none"><span></span></div><div id="vfOut"></div>`;
  if (St.vf) drawVF(St.vf);
}
async function runValueFinder() {
  const eng = St.ui.vEng, minE = St.ui.vEdge / 100, since = +St.ui.vHours ? Date.now() - St.ui.vHours * 3600e3 : 0;
  const ms = St.matches.filter(m => (St.ui.vComp === 'all' || m.comp === +St.ui.vComp) && m.ts >= since && m.odds && St.selsets[m.sk]);
  const prog = () => $('#vfProg span') || { style: {} }; if ($('#vfProg')) $('#vfProg').style.display = 'block';
  const A = {}, bands = {}, tf = {};
  const BANDS = [[1, 1.3], [1.3, 1.6], [1.6, 2], [2, 3], [3, 5], [5, 10], [10, 1e9]];
  const add = (o, k) => (o[k] = o[k] || { n: 0, w: 0, stake: 0, ret: 0, fp: 0, odds: 0, vn: 0, vw: 0, vret: 0 });
  for (let i = 0; i < ms.length; i++) {
    const m = ms[i];
    let T = null;
    if (eng !== 'fair') { const key = m.comp + ':' + m.roundId; T = tf[key] || (tf[key] = LPModel.fitTeams(CM(m.comp).filter(x => x.ts < m.ts).slice(-3000), m.ts, { halfLifeH: St.ui.halfLifeH })); }
    const om = LPParse.oddsMap(m.odds, St.selsets[m.sk]); const fp = LPModel.fair(St.cat, om);
    let tp = null; if (T && T.n >= 30) { const l = LPModel.teamLam(T, m.home, m.away); tp = LPModel.selProbs(St.cat, [...om.keys()], l[0], l[1]); }
    for (const [id, o] of om) {
      const c = St.cat[id]; if (!c) continue; const k = LPCat.mkey(c);
      if (St.ui.vMk !== 'ALL' && k !== St.ui.vMk) continue;
      const w = LPCat.settle(c, m.hg, m.ag, m.goals); if (w == null) continue;
      const f = fp.get(id); const p = eng === 'fair' ? f : eng === 'team' ? (tp ? tp.get(id) : null) : (tp ? (tp.get(id) + f) / 2 : null);
      for (const r of [add(A, k), add(bands, BANDS.findIndex(([a, b]) => o >= a && o < b))]) {
        r.n++; r.stake++; r.odds += o; r.fp += f; if (w) { r.w++; r.ret += o; }
        if (p != null && p * o - 1 >= minE && o <= (St.ui.maxOdds || 1e9)) { r.vn++; if (w) { r.vw++; r.vret += o; } }
      }
    }
    if (i % 25 === 0) { prog().style.width = (100 * i / ms.length) + '%'; await new Promise(r => setTimeout(r, 0)); }
  }
  prog().style.width = '100%';
  St.vf = { A, bands, BANDS, n: ms.length, eng, minE }; drawVF(St.vf);
}
function drawVF(R) {
  const out = $('#vfOut'); if (!out) return;
  if (!R.n) { out.innerHTML = '<div class="empty">No recorded matches in that selection yet.</div>'; return; }
  const lab = Object.fromEntries(markets().map(m => [m.key, m.label]));
  const roi = (ret, n) => (n ? ret / n - 1 : null);
  const cell = x => (x == null ? '<span class="mute">–</span>' : `<b class="${x >= 0 ? 'good' : 'bad'}">${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%</b>`);
  const rows = Object.entries(R.A).sort((a, b) => (roi(b[1].ret, b[1].n) ?? -9) - (roi(a[1].ret, a[1].n) ?? -9)).map(([k, r]) => `<tr><td>${esc(lab[k] || k)}</td><td class="n">${r.n.toLocaleString()}</td><td class="n">${pc(100 * r.w / r.n)}</td><td class="n mute">${pc(100 * r.fp / r.n)}</td><td class="n">${f2(r.odds / r.n)}</td><td class="n">${cell(roi(r.ret, r.n))}</td><td class="n">${r.vn}</td><td class="n">${r.vn ? pc(100 * r.vw / r.vn) : '–'}</td><td class="n">${cell(roi(r.vret, r.vn))}</td></tr>`).join('');
  const bl = ['1.00–1.30', '1.30–1.60', '1.60–2.00', '2.00–3.00', '3.00–5.00', '5.00–10.0', '10.0+'];
  const brows = Object.entries(R.bands).sort((a, b) => a[0] - b[0]).map(([i, r]) => `<tr><td>${bl[i]}</td><td class="n">${r.n.toLocaleString()}</td><td class="n">${pc(100 * r.w / r.n)}</td><td class="n mute">${pc(100 * r.fp / r.n)}</td><td class="n">${cell(roi(r.ret, r.n))}</td><td class="n">${r.vn}</td><td class="n">${cell(roi(r.vret, r.vn))}</td></tr>`).join('');
  out.innerHTML = `<div class="kpis"><div class="kpi"><div class="v">${R.n.toLocaleString()}</div><div class="l">Recorded matches analysed</div></div></div>
  <div class="card"><h3>By market <small>flat ₦1 stakes · "value picks" = ${ENG[R.eng]} edge ≥ ${(R.minE * 100).toFixed(1)}% at the time, odds ≤ ${St.ui.maxOdds}</small></h3><div class="scroll" style="max-height:none"><table>
    <tr><th>Market</th><th class="n">Selections</th><th class="n">Won</th><th class="n">Bet9ja fair said</th><th class="n">Avg odds</th><th class="n">Profit backing all</th><th class="n">Value picks</th><th class="n">Won</th><th class="n">Profit on value picks</th></tr>${rows}</table></div>
    <p class="mute" style="font-size:13px">"Won" vs "Bet9ja fair said": if they match, Bet9ja's prices are accurate in that market. Profit backing all ≈ minus the margin. A market is only worth betting if "Profit on value picks" stays positive over a large sample (hundreds of picks).</p></div>
  <div class="card" style="margin-top:16px"><h3>By odds range <small>is there a favourite–longshot bias?</small></h3><table><tr><th>Odds</th><th class="n">Selections</th><th class="n">Won</th><th class="n">Bet9ja fair said</th><th class="n">Profit backing all</th><th class="n">Value picks</th><th class="n">Profit on value picks</th></tr>${brows}</table></div>`;
}

// ---------------- RESULTS
function rResults() {
  if (!St.ui.rComp || !St.comps.some(c => c.id === +St.ui.rComp)) St.ui.rComp = St.comps[0]?.id;
  const ms = CM(St.ui.rComp).slice().reverse().slice(0, 240);
  const byR = []; ms.forEach(m => { let r = byR.find(x => x.id === m.roundId); if (!r) { r = { id: m.roundId, week: m.week, ts: m.ts, ms: [] }; byR.push(r); } r.ms.push(m); });
  view.innerHTML = `<div class="controls">${compSel('rComp', St.ui.rComp, false)}</div><div class="grid">${byR.map(r => `<div class="card"><h3>Week ${r.week} <small>${fmtT(r.ts)}</small></h3><table>${r.ms.sort((a, b) => a.idx - b.idx).map(m => `<tr class="click" data-act="match" data-key="${m.key}"><td>${esc(m.home)}</td><td class="n"><b>${m.hg} - ${m.ag}</b><div class="gm">${m.goals.map(([mn, s]) => mn + "'" + (s === 'h' ? 'H' : 'A')).join(' ')}</div></td><td>${esc(m.away)}</td></tr>`).join('')}</table></div>`).join('') || '<div class="empty">No results recorded yet.</div>'}</div>`;
}
function showMatch(key) {
  const m = St.matches.find(x => x.key === key); if (!m) return;
  const om = LPParse.oddsMap(m.odds, St.selsets[m.sk] || ''); const fp = LPModel.fair(St.cat, om);
  const groups = {}; for (const [id, o] of om) { const c = St.cat[id]; if (!c) continue; (groups[LPCat.mlabel(c)] = groups[LPCat.mlabel(c)] || []).push({ c, o, f: fp.get(id), w: LPCat.settle(c, m.hg, m.ag, m.goals) }); }
  $('#modalBody').innerHTML = `<div class="mute">${esc(cname(m.comp))} · week ${m.week} · ${fmtT(m.ts)}</div><div class="score" style="margin:10px 0">${esc(m.home)} ${m.hg} - ${m.ag} ${esc(m.away)}</div>
  <div class="mute" style="text-align:center">Goals: ${m.goals.map(([mn, s]) => `${mn}' ${s === 'h' ? esc(m.home) : esc(m.away)}`).join(' · ') || 'none'}</div>
  <div class="card" style="margin-top:14px"><h3>Every market with Bet9ja's pre-match odds <small>green = won</small></h3><div class="scroll" style="max-height:460px"><table>${Object.entries(groups).map(([g, L]) => `<tr><td><b>${esc(g)}</b></td><td style="white-space:normal">${L.map(x => `<span class="pill ${x.w ? 'pick' : ''}" style="margin:2px" title="fair ${pp(x.f)}">${esc(selLabel(x.c, m.home, m.away))} @ ${f2(x.o)}</span>`).join(' ')}</td></tr>`).join('')}</table></div></div>`;
  $('#modal').classList.remove('hidden');
}

// ---------------- TABLES & TEAMS
function rTables() {
  if (!St.ui.tComp || !St.comps.some(c => c.id === +St.ui.tComp)) St.ui.tComp = St.comps[0]?.id;
  const c = +St.ui.tComp, st = St.standings[c], ms = CM(c), T = teamFit(c);
  const rows = st ? String(st.value).split('|').map(r => r.split('-')) : [];
  const ts = {}; ms.forEach(m => { for (const [t, gf, ga] of [[m.home, m.hg, m.ag], [m.away, m.ag, m.hg]]) { const x = ts[t] = ts[t] || { P: 0, W: 0, D: 0, L: 0, GF: 0, GA: 0, O25: 0, GG: 0 }; x.P++; x.GF += gf; x.GA += ga; if (gf > ga) x.W++; else if (gf < ga) x.L++; else x.D++; if (gf + ga > 2.5) x.O25++; if (gf && ga) x.GG++; } });
  view.innerHTML = `<div class="controls">${compSel('tComp', c, false)}</div><div class="split">
  <div class="card"><h3>Bet9ja league table <small>${st ? 'week ' + st.week : ''}</small></h3><table><tr><th>#</th><th>Team</th><th class="n">Pts</th><th>Form</th></tr>${rows.map(([t, pts, form], i) => `<tr><td>${i + 1}</td><td><b>${esc(t)}</b></td><td class="n">${pts}</td><td><span class="form">${String(form || '').split('').map(x => `<i class="${x}">${x}</i>`).join('')}</span></td></tr>`).join('') || '<tr><td class="mute">Not loaded yet</td></tr>'}</table></div>
  <div class="card"><h3>Recorded team stats <small>${ms.length} matches · rating = attack × defence strength</small></h3><div class="scroll" style="max-height:620px"><table><tr><th>Team</th><th class="n">P</th><th class="n">W-D-L</th><th class="n">Goals</th><th class="n">O2.5</th><th class="n">GG</th><th class="n">Attack</th><th class="n">Defence</th></tr>
  ${Object.entries(ts).sort((a, b) => (T.att[b[0]] / T.def[b[0]]) - (T.att[a[0]] / T.def[a[0]])).map(([t, x]) => `<tr><td><b>${esc(t)}</b></td><td class="n">${x.P}</td><td class="n">${x.W}-${x.D}-${x.L}</td><td class="n">${x.GF}:${x.GA}</td><td class="n">${pc(100 * x.O25 / x.P)}</td><td class="n">${pc(100 * x.GG / x.P)}</td><td class="n">${f2(T.att[t])}</td><td class="n">${f2(T.def[t])}</td></tr>`).join('')}</table></div>
  <p class="mute" style="font-size:13px">Attack above 1 scores more than average; defence below 1 concedes less than average.</p></div></div>`;
}

// ---------------- SETTINGS
function rSettings() {
  view.innerHTML = `<div class="card"><h3>Team ratings</h3><div class="controls"><label>Memory half-life (hours)<input type="number" id="set_hl" value="${St.ui.halfLifeH}" step="1" min="1" style="width:120px;min-width:0"></label><button class="btn" data-act="saveSet">Save</button> <span id="setMsg" class="good"></span></div></div>
  <div class="card" style="margin-top:16px"><h3>Data</h3><button class="btn ghost" data-act="csv">Export matches CSV (with main odds)</button> <button class="btn ghost" data-act="export">Export full backup (JSON)</button> <button class="btn ghost" data-act="import">Import backup</button><input type="file" id="impFile" accept=".json" style="display:none"> <button class="btn danger" data-act="clear">Clear database</button>
  <p class="mute" style="font-size:13px">${St.matches.length.toLocaleString()} matches stored in this browser. Export a backup now and then — the site keeps no history, so this data exists only here.</p></div>`;
  $('#impFile').addEventListener('change', importJSON);
}
function download(name, text, type) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); }
async function exportJSON() { download(`leagueplus-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify({ v: 1, matches: await LPDB.getAll('matches'), meta: (await LPDB.getAll('meta')).filter(x => !x.key.startsWith('up:')) }), 'application/json'); }
function exportCSV() {
  const pick = [101, 102, 103, 104, 105, 106, 107, 108, 155, 156, 109, 110, 157, 158];
  const L = [['league', 'week', 'time', 'home', 'away', 'home_goals', 'away_goals', 'goal_minutes', ...pick.map(id => (St.cat[id] ? LPCat.mlabel(St.cat[id]) + ' ' + St.cat[id].name : id))].join(',')];
  St.matches.forEach(m => { const om = LPParse.oddsMap(m.odds, St.selsets[m.sk] || ''); L.push([cname(m.comp), m.week, new Date(m.ts).toISOString(), m.home, m.away, m.hg, m.ag, '"' + m.goals.map(([mn, s]) => mn + s).join(' ') + '"', ...pick.map(id => om.get(id) || '')].join(',')); });
  download(`leagueplus-matches-${new Date().toISOString().slice(0, 10)}.csv`, L.join('\n'), 'text/csv');
}
async function importJSON(e) { const f = e.target.files[0]; if (!f) return; try { const d = JSON.parse(await f.text()); await LPDB.putMany('matches', d.matches || []); await LPDB.putMany('meta', d.meta || []); await load(); render(); alert(`Imported ${(d.matches || []).length} matches.`); } catch (err) { alert('Import failed: ' + err.message); } }
async function clearDB() { if (!confirm('Delete ALL recorded League Plus data from this browser?')) return; await LPDB.clear('matches'); await LPDB.clear('meta'); await load(); render(); }

(async () => { await load(); render(); setInterval(() => { syncLine(); }, 15000); })();
