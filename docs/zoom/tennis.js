/* Zoom Tennis Stats & Prediction Engine – dashboard */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const f1 = x => (x == null || isNaN(x) ? '–' : (+x).toFixed(1));
const f2 = x => (x == null || isNaN(x) ? '–' : (+x).toFixed(2));
const pc = x => (x == null || isNaN(x) ? '–' : (+x).toFixed(1) + '%');
const pp = p => (p == null || isNaN(p) ? '–' : (p * 100).toFixed(1) + '%');
const odds = p => (p > 0 ? (1 / p).toFixed(2) : '–');
const fmtT = ts => new Date(ts).toLocaleString([], { weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
const ago = ts => { if (!ts) return 'never'; const s = Math.round((Date.now() - ts) / 1000); return s < 60 ? s + 's ago' : s < 3600 ? Math.round(s / 60) + ' min ago' : Math.round(s / 3600) + ' h ago'; };
const until = ts => { const s = Math.round((ts - Date.now()) / 60000); return s >= 0 ? 'in ' + s + ' min' : Math.abs(s) + ' min ago'; };
const bar = (p, cls = '') => `<div class="bar ${cls}"><span style="width:${Math.max(0, Math.min(100, p))}%"></span></div>`;
const PHASE = { 1: 'Final', 2: 'Semi-finals', 3: 'Quarter-finals', 4: 'Round of 16', 5: 'Round of 32', 6: 'Round of 64' };
const ROUND_MIN = 40; // a new round starts every 40 minutes in each tournament

const St = {
  set: null, init: null, players: {}, comps: [], matches: [], byComp: new Map(), draws: {}, status: null, tlive: null,
  fitCache: {}, pairCache: new Map(), tab: 'overview', bt: null,
  ui: Object.assign({ comp: null, scope: 'cur', p1: null, p2: null, mk: 'MW', boardComp: 'all', minP: 0, liveComp: 'all', liveMk: 'MW', btComp: 'all', btRounds: 400, btMk: 'MW', player: null, tour: null }, (() => { try { return JSON.parse(localStorage.getItem('tui') || '{}'); } catch (e) { return {}; } })())
};
const saveUI = () => { try { localStorage.setItem('tui', JSON.stringify(St.ui)); } catch (e) { } };
const pn = id => (St.players[id] ? St.players[id].name : '#' + id);
const cname = id => { const c = St.comps.find(x => x.id === +id); return c ? c.name : 'Tournament ' + id; };
const CM = c => St.byComp.get(+c) || [];

// ---------------- data
async function load() {
  St.set = await getSettings();
  const [init, ms, meta, { tstatus }] = await Promise.all([TDB.get('meta', 'init'), TDB.getAll('matches'), TDB.getAll('meta'), chrome.storage.local.get('tstatus')]);
  try { St.tlive = (await chrome.storage.session.get('tlive')).tlive || null; } catch (e) { St.tlive = null; }
  St.init = init; St.status = tstatus; St.players = init ? init.players : {}; St.comps = init ? init.comps : [];
  St.matches = ms.filter(m => m.sets && m.sets.length).sort((a, b) => a.ts - b.ts || a.matchId - b.matchId);
  St.byComp = new Map(); St.matches.forEach(m => { if (!St.byComp.has(m.comp)) St.byComp.set(m.comp, []); St.byComp.get(m.comp).push(m); });
  St.draws = {}; meta.filter(x => x.key.startsWith('draw:')).forEach(x => { St.draws[x.comp] = x.draw; });
  St.fitCache = {}; St.pairCache = new Map(); St.winCache = new Map();
  if (!St.ui.comp || !St.comps.some(c => c.id === +St.ui.comp)) St.ui.comp = St.comps[0]?.id || null;
  syncLine();
}
function tours(c) { const s = new Map(); CM(c).forEach(m => s.set(m.tour, m.tourTs)); return [...s.entries()].sort((a, b) => b[1] - a[1]).map(x => x[0]); }
function scoped(c, scope) { const t = tours(c); if (scope === 'cur') return CM(c).filter(m => m.tour === t[0]); if (scope === 'prev') return CM(c).filter(m => m.tour === t[1]); return CM(c); }
// player rank (seed) = id − lowest id in that tournament's 64-player block
function ranksFor(c) {
  const r = new Map(); const byTour = {};
  CM(c).forEach(m => { (byTour[m.tour] = byTour[m.tour] || []).push(m); });
  Object.entries(byTour).sort((a, b) => Date.parse(a[0]) - Date.parse(b[0])).forEach(([, list]) => TBacktest.rankMap(list).forEach((v, k) => r.set(k, v)));
  const d = St.draws[c];
  if (d && d.phases && d.phases[6]) { const ids = d.phases[6].flatMap(m => [m.playerOneId, m.playerTwoId]).filter(Boolean); const mn = Math.min(...ids); ids.forEach(i => r.set(i, i - mn)); }
  return r;
}
const mOpts = () => ({ tau: St.set.tTau, betaPrior: St.set.tBeta });
function fitFor(c) {
  if (St.fitCache[c]) return St.fitCache[c];
  const hist = CM(c).filter(m => m.serve);
  return (St.fitCache[c] = { F: TModel.fit(hist, ranksFor(c), mOpts()), ranks: ranksFor(c), n: hist.length });
}
function pair(c, p1, p2) {
  const k = c + ':' + p1 + ':' + p2; if (St.pairCache.has(k)) return St.pairCache.get(k);
  const { F } = fitFor(c); const pr = TModel.probs(F, p1, p2);
  const outs = TMarkov.matchOutcomes(pr.pA, pr.pB);
  const res = Object.assign(pr, { outs, mk: TMarkets.compute(outs) });
  St.pairCache.set(k, res); return res;
}
const mkProbs = (mk, id) => { const x = mk.find(m => m.id === id); return x ? Object.fromEntries(x.opts.map(o => [o.k, o.p])) : null; };
const pick = probs => Object.entries(probs).sort((a, b) => b[1] - a[1])[0];
const lbl = (k, p1, p2, short) => String(k).replace(/\bP1\b/g, short ? sn(p1) : pn(p1)).replace(/\bP2\b/g, short ? sn(p2) : pn(p2));
const sn = id => { const n = pn(id); return n.length > 12 ? n.slice(0, 11) + '…' : n; };

// ---------------- header / sync
function syncLine() {
  const s = St.status || {};
  $('#syncLine').innerHTML = `${s.running ? '<span class="warnc">● capturing…</span> ' : ''}${St.matches.length.toLocaleString()} matches · ${St.matches.filter(m => m.det).length.toLocaleString()} with point-by-point detail · last capture ${ago(s.lastSync)}${s.log && s.log.length ? ' · <span class="bad">' + s.log.length + ' warning(s)</span>' : ''}`;
  $('#btnSync').disabled = !!s.running;
}
$('#btnSync').addEventListener('click', async () => { $('#btnSync').disabled = true; await chrome.runtime.sendMessage({ type: 'tennisSyncNow' }); await load(); render(); });
chrome.storage.onChanged.addListener(async (ch, area) => {
  if (area === 'local' && ch.tstatus) { const prev = St.status && St.status.lastSync; St.status = ch.tstatus.newValue; syncLine(); if (!St.status.running && St.status.lastSync !== prev) { await load(); if (!['predict', 'backtest', 'settings'].includes(St.tab)) render(); } }
  if (area === 'session' && ch.tlive) { St.tlive = ch.tlive.newValue; if (St.tab === 'live' && !liveTimer) liveTimer = setTimeout(() => { liveTimer = null; renderLive(true); }, 800); if (modalLive) showLiveMatch(modalLive, true); }
});
let liveTimer = null, modalLive = null;

// ---------------- tabs & events
$('#tabs').addEventListener('click', e => { const b = e.target.closest('button[data-tab]'); if (!b) return; document.querySelectorAll('#tabs button').forEach(x => x.classList.toggle('on', x === b)); St.tab = b.dataset.tab; render(); });
const view = $('#view');
view.addEventListener('change', e => {
  const k = e.target.dataset.ui; if (!k) return;
  St.ui[k] = e.target.type === 'number' ? +e.target.value : e.target.value;
  if (k === 'comp') { St.ui.p1 = null; St.ui.p2 = null; St.ui.player = null; St.ui.tour = null; }
  saveUI(); render(true);
});
view.addEventListener('input', e => { if (e.target.dataset.odds != null) evCell(e.target); });
view.addEventListener('click', e => {
  const t = e.target.closest('[data-act]'); if (!t) return; if (t.tagName === 'A') e.preventDefault();
  const a = t.dataset.act;
  if (a === 'match') showMatch(+t.dataset.id);
  if (a === 'live') showLiveMatch(+t.dataset.id);
  if (a === 'fix') { St.ui.comp = +t.dataset.comp; St.ui.p1 = +t.dataset.p1; St.ui.p2 = +t.dataset.p2; saveUI(); document.querySelector('#tabs [data-tab=predict]').click(); }
  if (a === 'swap') { [St.ui.p1, St.ui.p2] = [St.ui.p2, St.ui.p1]; saveUI(); render(true); }
  if (a === 'player') { St.ui.comp = +t.dataset.comp; St.ui.player = +t.dataset.id; saveUI(); document.querySelector('#tabs [data-tab=players]').click(); }
  if (a === 'bt') runBacktest();
  if (a === 'openLive') chrome.runtime.sendMessage({ type: 'openTennisTab' }).then(() => { t.textContent = 'Opened ✓ — data arrives in a few seconds'; });
  if (a === 'saveSet') saveSet();
  if (a === 'export') exportJSON();
  if (a === 'csv') exportCSV();
  if (a === 'import') $('#impFile').click();
  if (a === 'clear') clearDB();
  if (a === 'calib') { St.calib = null; liveCalibration(); }
});
$('#modalX').addEventListener('click', () => { $('#modal').classList.add('hidden'); modalLive = null; });
$('#modal').addEventListener('click', e => { if (e.target.id === 'modal') { $('#modal').classList.add('hidden'); modalLive = null; } });

function render(keepScroll) {
  const y = window.scrollY;
  if (!St.comps.length) { view.innerHTML = `<div class="empty"><h2>No tennis data yet</h2><p>The first capture runs in the background — click <b>Capture now</b> if nothing appears within a minute.</p></div>`; return; }
  ({ overview: rOverview, live: renderLive, stats: rStats, players: rPlayers, results: rResults, predict: rPredict, board: rBoard, slip: rSlip, outright: rOutright, backtest: rBacktest, settings: rSettings })[St.tab]();
  if (keepScroll) window.scrollTo(0, y);
}
const compSel = (name, val, all = false) => `<label>Tournament<select data-ui="${name}">${all ? `<option value="all" ${val === 'all' ? 'selected' : ''}>All tournaments</option>` : ''}${St.comps.map(c => `<option value="${c.id}" ${+val === c.id ? 'selected' : ''}>${esc(c.name)} (${CM(c.id).length})</option>`).join('')}</select></label>`;
const scopeSel = v => `<label>Data<select data-ui="scope">${[['cur', 'Current tournament'], ['prev', 'Previous tournament'], ['all', 'All captured']].map(([k, l]) => `<option value="${k}" ${v === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>`;
function playersOf(c) {
  const ids = new Set(); const d = St.draws[c];
  if (d && d.phases && d.phases[6]) d.phases[6].forEach(m => { if (m.playerOneId) ids.add(m.playerOneId); if (m.playerTwoId) ids.add(m.playerTwoId); });
  if (!ids.size) CM(c).forEach(m => { ids.add(m.p1); ids.add(m.p2); });
  const r = ranksFor(c); return [...ids].sort((a, b) => (r.get(a) ?? 99) - (r.get(b) ?? 99));
}
const playerSel = (name, c, val, label) => { const r = ranksFor(c); return `<label>${label}<select data-ui="${name}">${playersOf(c).map(p => `<option value="${p}" ${+val === p ? 'selected' : ''}>${esc(pn(p))} (seed #${(r.get(p) ?? 0) + 1})</option>`).join('')}</select></label>`; };
const mkSel = (name, val, withLive = false, withAll = false) => {
  const g = {}; TMarkets.DEF.forEach(m => (g[m.group] = g[m.group] || []).push(m));
  const liveOpts = withLive ? `<optgroup label="Live"><option value="LCG" ${val === 'LCG' ? 'selected' : ''}>Current game winner</option><option value="LBRK" ${val === 'LBRK' ? 'selected' : ''}>Break in current game</option><option value="LCS" ${val === 'LCS' ? 'selected' : ''}>Current set winner</option><option value="LCSTG" ${val === 'LCSTG' ? 'selected' : ''}>Current set total games</option></optgroup>` : '';
  return `<label>Market<select data-ui="${name}">${withAll ? `<option value="ALL" ${val === 'ALL' ? 'selected' : ''}>★ All markets</option>` : ''}${liveOpts}${Object.entries(g).map(([k, ms]) => `<optgroup label="${k}">${ms.map(m => `<option value="${m.id}" ${val === m.id ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</optgroup>`).join('')}</select></label>`;
};

// ---------------- schedule helpers (from the draw)
function roundOrder() { const o = []; [[6, 4], [5, 2], [4, 1], [3, 1], [2, 1], [1, 1]].forEach(([ph, n]) => { for (let i = 1; i <= n; i++) o.push([ph, i]); }); return o; }
function tourStartTs(c) { const t = tours(c)[0]; return t ? Date.parse(t) : null; }
function upcoming(c) {
  const d = St.draws[c]; if (!d || !d.phases) return [];
  const liveIds = new Set(); (St.tlive && St.tlive.comps || []).forEach(x => x.matches.forEach(m => liveIds.add(m.id)));
  const done = new Set(CM(c).map(m => m.matchId));
  const start = tourStartTs(c); const ord = roundOrder(); const out = [];
  for (const ph of [6, 5, 4, 3, 2, 1]) (d.phases[ph] || []).forEach((m, i) => {
    if (m.status !== 1 || !m.playerOneId || liveIds.has(m.matchId) || done.has(m.matchId)) return;
    const ip = ph === 6 ? Math.floor(i / 8) + 1 : ph === 5 ? Math.floor(i / 8) + 1 : 1;
    const k = ord.findIndex(([a, b]) => a === ph && b === ip);
    out.push({ c, id: m.matchId, p1: m.playerOneId, p2: m.playerTwoId, ph, ip, ts: start ? start + k * ROUND_MIN * 60e3 : null });
  });
  // a fixture whose estimated start is long past belongs to a tournament whose results haven't synced yet
  return out.filter(f => !f.ts || f.ts > Date.now() - 45 * 60e3).sort((a, b) => (a.ts || 0) - (b.ts || 0));
}

// ---------------- OVERVIEW
function rOverview() {
  const s = St.status || {};
  const cards = St.comps.map(c => {
    const t = tours(c.id), cur = CM(c.id).filter(m => m.tour === t[0]);
    const L = (s.comps || {})[c.id] || {};
    const lastPh = cur.length ? Math.min(...cur.map(m => m.phase)) : null;
    const champ = CM(c.id).filter(m => m.phase === 1).slice(-3).reverse();
    const lc = St.tlive && (St.tlive.comps || []).find(x => x.comp === c.id);
    const up = upcoming(c.id);
    return `<div class="card"><h3>${esc(c.name)} ${L.paused ? '<span class="tag">paused</span>' : ''}<small>${CM(c.id).length} matches · ${t.length} tournament(s)</small></h3>
      <div>Current tournament started ${t[0] ? fmtT(Date.parse(t[0])) : '–'} · ${cur.length}/63 matches played${lastPh ? ` · reached <b>${PHASE[lastPh]}</b>` : ''}</div>
      ${lc ? `<div class="good" style="margin-top:4px">● Live now: ${PHASE[lc.phase]}${lc.phase >= 5 ? ' #' + lc.ip : ''} — ${lc.matches.filter(m => m.status === 1).length} in play</div>` : ''}
      ${up.length ? `<div class="mute">Next: ${PHASE[up[0].ph]} · ${up[0].ts ? fmtT(up[0].ts) + ' (' + until(up[0].ts) + ')' : ''} · ${up.length} fixtures known</div>` : ''}
      ${L.err ? `<div class="bad" style="font-size:13px">${esc(L.err)}</div>` : ''}
      ${champ.length ? `<div style="margin-top:10px"><b>Recent finals</b><table>${champ.map(m => `<tr class="click" data-act="match" data-id="${m.matchId}"><td>${fmtT(m.ts)}</td><td>🏆 <b>${esc(pn(m.w))}</b></td><td class="mute">${esc(pn(m.w === m.p1 ? m.p2 : m.p1))}</td><td class="n">${m.sets.map(s => s.join('-')).join(' ')}</td></tr>`).join('')}</table></div>` : ''}</div>`;
  }).join('');
  view.innerHTML = `<div class="kpis">
    <div class="kpi"><div class="v">${St.matches.length.toLocaleString()}</div><div class="l">Matches captured</div></div>
    <div class="kpi"><div class="v">${St.matches.filter(m => m.det).length.toLocaleString()}</div><div class="l">With point-by-point detail</div></div>
    <div class="kpi"><div class="v">${new Set(St.matches.map(m => m.comp + m.tour)).size}</div><div class="l">Tournaments stored</div></div>
    <div class="kpi"><div class="v">${ago(s.lastSync)}</div><div class="l">Last capture (+${s.added || 0} matches, +${s.detailed || 0} details)</div></div></div>
  ${s.log && s.log.length ? `<div class="note"><b>Capture warnings</b><br>${s.log.map(esc).join('<br>')}</div>` : ''}
  <div class="grid">${cards}</div>
  <div class="note">Each Zoom tournament is a 64-player knockout (best of 3 sets, tie-break at 6-6) with a new round every 40 minutes. The site keeps only the current and previous tournament, so older history exists only because this engine saved it.</div>`;
}

// ---------------- STATS
function aggStats(ms) {
  const o = { n: ms.length }; if (!ms.length) return o;
  let p1w = 0, three = 0, games = 0, tbM = 0, setsN = 0, tbSets = 0, fav = 0, favN = 0;
  const setScore = {}, tg = {}, sb = {};
  let hold = [0, 0], srvPts = [0, 0], det = 0, bpGames = 0;
  ms.forEach(m => {
    if (m.w === m.p1) p1w++; if (m.sets.length === 3) three++;
    const G = m.sets.reduce((s, [a, b]) => s + a + b, 0); games += G; tg[G] = (tg[G] || 0) + 1;
    if (m.sets.some(([a, b]) => a + b === 13)) tbM++;
    m.sets.forEach(([a, b]) => { setsN++; if (a + b === 13) tbSets++; const k = Math.max(a, b) + '-' + Math.min(a, b); setScore[k] = (setScore[k] || 0) + 1; });
    const sw = TMarkets.setsWon(m.sets).join('-'); sb[sw] = (sb[sw] || 0) + 1;
    if (m.serve) { det++; for (const s of [0, 1]) { srvPts[0] += m.serve[s][0]; srvPts[1] += m.serve[s][1]; hold[0] += m.holds[s][0]; hold[1] += m.holds[s][1]; } }
  });
  return Object.assign(o, { p1w: 100 * p1w / ms.length, three: 100 * three / ms.length, avgGames: games / ms.length, tbM: 100 * tbM / ms.length, tbSets: 100 * tbSets / setsN, setScore, tg, sb, det, hold: hold[1] ? 100 * hold[0] / hold[1] : null, srv: srvPts[1] ? 100 * srvPts[0] / srvPts[1] : null, setsN, freq: marketFreq(ms) });
}
function marketFreq(ms) { const out = {}; TMarkets.DEF.forEach(mk => { let n = 0; const c = {}; ms.forEach(m => { if (mk.id.startsWith('S2') && m.sets.length < 2) return; const w = TMarkets.resolve(mk, m.sets); if (w == null) return; n++; c[w] = (c[w] || 0) + 1; }); out[mk.id] = { n, pct: Object.fromEntries(mk.opts.map(o => [o.k, n ? 100 * (c[o.k] || 0) / n : 0])) }; }); return out; }
function rStats() {
  const c = St.ui.comp, ms = scoped(c, St.ui.scope), A = aggStats(ms);
  let h = `<div class="controls">${compSel('comp', c)}${scopeSel(St.ui.scope)}</div>`;
  if (!A.n) { view.innerHTML = h + '<div class="empty">No matches in scope.</div>'; return; }
  // better seed win % by phase
  const r = ranksFor(c); const byPh = {};
  ms.forEach(m => { const b = (byPh[m.phase] = byPh[m.phase] || [0, 0]); const fav = (r.get(m.p1) ?? 0) < (r.get(m.p2) ?? 0) ? m.p1 : m.p2; b[1]++; if (m.w === fav) b[0]++; });
  const ss = Object.entries(A.setScore).sort((a, b) => b[1] - a[1]); const tg = Object.entries(A.tg).sort((a, b) => a[0] - b[0]); const mxTg = Math.max(...tg.map(x => x[1]));
  h += `<div class="kpis">
    <div class="kpi"><div class="v">${A.n}</div><div class="l">Matches</div></div>
    <div class="kpi"><div class="v">${pc(A.three)}</div><div class="l">Went to a 3rd set</div></div>
    <div class="kpi"><div class="v">${f1(A.avgGames)}</div><div class="l">Games per match</div></div>
    <div class="kpi"><div class="v">${pc(A.tbM)}</div><div class="l">Matches with a tie-break (${pc(A.tbSets)} of sets)</div></div>
    <div class="kpi"><div class="v">${pc(A.hold)}</div><div class="l">Service games held</div></div>
    <div class="kpi"><div class="v">${pc(A.srv)}</div><div class="l">Points won on serve</div></div>
    <div class="kpi"><div class="v">${pc(A.p1w)}</div><div class="l">Player 1 (serves first) wins</div></div></div>
  <div class="grid">
    <div class="card"><h3>Set scores <small>winner first</small></h3><div class="hbars">${ss.map(([k, v]) => `<div class="r"><span>${k}</span>${bar(100 * v / A.setsN * 3)}<span class="n">${pc(100 * v / A.setsN)}</span></div>`).join('')}</div></div>
    <div class="card"><h3>Total games per match</h3><div class="hbars">${tg.map(([k, v]) => `<div class="r"><span>${k} games</span>${bar(100 * v / mxTg, 'vio')}<span class="n">${pc(100 * v / A.n)}</span></div>`).join('')}</div></div>
    <div class="card"><h3>Set betting results</h3><div class="hbars">${['2-0', '2-1', '1-2', '0-2'].map(k => `<div class="r"><span>P1 ${k}</span>${bar(100 * (A.sb[k] || 0) / A.n * 2, 'blue')}<span class="n">${pc(100 * (A.sb[k] || 0) / A.n)}</span></div>`).join('')}</div></div>
    <div class="card"><h3>Better seed wins <small>by round</small></h3><table>${[6, 5, 4, 3, 2, 1].filter(p => byPh[p]).map(p => `<tr><td>${PHASE[p]}</td><td class="n">${byPh[p][1]}</td><td class="n"><b>${pc(100 * byPh[p][0] / byPh[p][1])}</b></td></tr>`).join('')}</table><p class="mute" style="font-size:13px">Seed = position in the site's player list (lower id = stronger). The draw itself is random.</p></div>
  </div>
  <div class="grid" style="margin-top:16px">${['Match', 'Games', '1st set', '2nd set'].map(g => `<div class="card"><h3>${g} markets <small>how often each outcome happened</small></h3><table>${TMarkets.DEF.filter(m => m.group === g && m.id !== 'S1CS').map(mk => `<tr><td>${esc(mk.name)}</td><td style="white-space:normal">${mk.opts.map(o => `<span class="pill" style="margin:2px">${esc(o.k)} <b>${f1(A.freq[mk.id].pct[o.k])}%</b></span>`).join(' ')}</td></tr>`).join('')}</table></div>`).join('')}</div>`;
  view.innerHTML = h;
}

// ---------------- PLAYERS
function playerTable(c, ms) {
  const P = {}; const r = ranksFor(c); const { F } = fitFor(c);
  const row = id => P[id] || (P[id] = { id, M: 0, W: 0, sW: 0, sL: 0, gW: 0, gL: 0, srv: [0, 0], ret: [0, 0], hold: [0, 0], brk: [0, 0], tbW: 0, tbL: 0, titles: 0 });
  ms.forEach(m => {
    const a = row(m.p1), b = row(m.p2); a.M++; b.M++; (m.w === m.p1 ? a : b).W++;
    if (m.phase === 1) (m.w === m.p1 ? a : b).titles++;
    m.sets.forEach(([x, y]) => { a.gW += x; a.gL += y; b.gW += y; b.gL += x; if (x > y) { a.sW++; b.sL++; } else { b.sW++; a.sL++; } if (x + y === 13) { if (x > y) { a.tbW++; b.tbL++; } else { b.tbW++; a.tbL++; } } });
    if (m.serve) {
      a.srv[0] += m.serve[0][0]; a.srv[1] += m.serve[0][1]; b.srv[0] += m.serve[1][0]; b.srv[1] += m.serve[1][1];
      a.ret[0] += m.serve[1][1] - m.serve[1][0]; a.ret[1] += m.serve[1][1]; b.ret[0] += m.serve[0][1] - m.serve[0][0]; b.ret[1] += m.serve[0][1];
      a.hold[0] += m.holds[0][0]; a.hold[1] += m.holds[0][1]; b.hold[0] += m.holds[1][0]; b.hold[1] += m.holds[1][1];
      a.brk[0] += m.holds[1][1] - m.holds[1][0]; a.brk[1] += m.holds[1][1]; b.brk[0] += m.holds[0][1] - m.holds[0][0]; b.brk[1] += m.holds[0][1];
    }
  });
  Object.values(P).forEach(p => { p.rank = r.get(p.id); p.rating = F.s[p.id] ?? F.beta * F.sc(p.id); });
  return Object.values(P);
}
function rPlayers() {
  const c = St.ui.comp, ms = scoped(c, St.ui.scope);
  const rows = playerTable(c, ms).sort((a, b) => b.rating - a.rating);
  let h = `<div class="controls">${compSel('comp', c)}${scopeSel(St.ui.scope)}</div>`;
  if (St.ui.player && rows.some(r => r.id === +St.ui.player)) h += playerProfile(c, +St.ui.player);
  h += `<div class="card"><h3>Players <small>sorted by engine rating (all captured history) · click a player for the profile</small></h3><div class="scroll" style="max-height:none"><table>
  <tr><th>#</th><th>Player</th><th class="n">Seed</th><th class="n">Rating</th><th class="n">W-L</th><th class="n">Sets</th><th class="n">Games</th><th class="n">Serve pts</th><th class="n">Return pts</th><th class="n">Hold</th><th class="n">Break</th><th class="n">TB W-L</th><th class="n">Titles</th></tr>
  ${rows.map((p, i) => `<tr class="click" data-act="player" data-comp="${c}" data-id="${p.id}"><td>${i + 1}</td><td><b>${esc(pn(p.id))}</b></td><td class="n mute">${p.rank != null ? '#' + (p.rank + 1) : '–'}</td><td class="n">${(p.rating * 100).toFixed(1)}</td><td class="n">${p.W}-${p.M - p.W}</td><td class="n">${p.sW}-${p.sL}</td><td class="n">${p.gW}-${p.gL}</td><td class="n">${p.srv[1] ? pc(100 * p.srv[0] / p.srv[1]) : '–'}</td><td class="n">${p.ret[1] ? pc(100 * p.ret[0] / p.ret[1]) : '–'}</td><td class="n">${p.hold[1] ? pc(100 * p.hold[0] / p.hold[1]) : '–'}</td><td class="n">${p.brk[1] ? pc(100 * p.brk[0] / p.brk[1]) : '–'}</td><td class="n">${p.tbW}-${p.tbL}</td><td class="n">${p.titles ? '🏆 ' + p.titles : ''}</td></tr>`).join('')}</table></div>
  <p class="mute" style="font-size:13px">Rating = the engine's strength estimate (point-level, ×100). +10 means roughly a 2.5-point higher serve and return percentage than an average player.</p></div>`;
  view.innerHTML = h;
}
function playerProfile(c, id) {
  const ms = CM(c).filter(m => m.p1 === id || m.p2 === id).slice().reverse();
  const W = ms.filter(m => m.w === id).length;
  return `<div class="card" style="margin-bottom:16px"><h3>${esc(pn(id))} <small>${W}-${ms.length - W} in all captured matches</small></h3><div class="scroll" style="max-height:340px"><table>
  <tr><th>When</th><th>Round</th><th>Opponent</th><th>Result</th><th>Score</th></tr>
  ${ms.map(m => { const opp = m.p1 === id ? m.p2 : m.p1; const won = m.w === id; const sets = m.sets.map(([a, b]) => (m.p1 === id ? `${a}-${b}` : `${b}-${a}`)).join(' '); return `<tr class="click" data-act="match" data-id="${m.matchId}"><td>${fmtT(m.ts)}</td><td>${PHASE[m.phase]}</td><td>${esc(pn(opp))}</td><td class="${won ? 'good' : 'bad'}"><b>${won ? 'W' : 'L'}</b></td><td>${sets}</td></tr>`; }).join('')}</table></div></div>`;
}

// ---------------- RESULTS
function rResults() {
  const c = St.ui.comp, t = tours(c); if (!St.ui.tour || !t.includes(St.ui.tour)) St.ui.tour = t[0];
  const ms = CM(c).filter(m => m.tour === St.ui.tour);
  const byR = {}; ms.forEach(m => (byR[m.ts] = byR[m.ts] || []).push(m));
  view.innerHTML = `<div class="controls">${compSel('comp', c)}<label>Tournament<select data-ui="tour">${t.map(x => `<option value="${x}" ${x === St.ui.tour ? 'selected' : ''}>${fmtT(Date.parse(x))}</option>`).join('')}</select></label></div>
  <div class="grid">${Object.keys(byR).sort((a, b) => b - a).map(ts => { const L = byR[ts]; return `<div class="card"><h3>${PHASE[L[0].phase]}${L[0].phase >= 5 ? ' #' + L[0].ip : ''} <small>${fmtT(+ts)}</small></h3><table>${L.map(m => `<tr class="click" data-act="match" data-id="${m.matchId}"><td class="${m.w === m.p1 ? 'lean' : 'mute'}">${esc(pn(m.p1))}</td><td class="n">${m.sets.map(s => `<span class="setcell">${s[0]}-${s[1]}</span>`).join('')}</td><td class="${m.w === m.p2 ? 'lean' : 'mute'}">${esc(pn(m.p2))}</td></tr>`).join('')}</table></div>`; }).join('') || '<div class="empty">No results</div>'}</div>`;
}
function showMatch(id) {
  modalLive = null;
  const m = St.matches.find(x => x.matchId === id); if (!m) return;
  const P = pair(m.comp, m.p1, m.p2); const mw = mkProbs(P.mk, 'MW');
  let gh = '';
  if (m.g) {
    let cs = 0, ga = 0, gb = 0;
    gh = `<table class="gh"><tr><th>Set</th><th>Games</th><th>Server</th><th>Game won by</th><th>Points (P1-P2)</th></tr>${m.g.map(([set, srv, win, a, b, tb]) => {
      if (set !== cs) { cs = set; ga = 0; gb = 0; } win === 1 ? ga++ : gb++;
      const brk = !tb && srv !== win;
      return `<tr><td>${set}</td><td><b>${ga}-${gb}</b></td><td>${tb ? 'Tie-break' : esc(sn(srv === 1 ? m.p1 : m.p2))}</td><td class="${brk ? 'brk' : ''}">${esc(sn(win === 1 ? m.p1 : m.p2))}${brk ? ' (break)' : ''}</td><td>${a}-${b}</td></tr>`;
    }).join('')}</table>`;
  }
  const st = m.serve ? `<table><tr><th></th><th class="n">${esc(sn(m.p1))}</th><th class="n">${esc(sn(m.p2))}</th></tr>
    <tr><td>Points won on serve</td><td class="n">${m.serve[0][0]}/${m.serve[0][1]} (${pc(100 * m.serve[0][0] / m.serve[0][1])})</td><td class="n">${m.serve[1][0]}/${m.serve[1][1]} (${pc(100 * m.serve[1][0] / m.serve[1][1])})</td></tr>
    <tr><td>Service games held</td><td class="n">${m.holds[0][0]}/${m.holds[0][1]}</td><td class="n">${m.holds[1][0]}/${m.holds[1][1]}</td></tr>
    <tr><td>Breaks of serve</td><td class="n">${m.holds[1][1] - m.holds[1][0]}</td><td class="n">${m.holds[0][1] - m.holds[0][0]}</td></tr></table>` : '<p class="mute">Point-by-point detail not captured yet.</p>';
  $('#modalBody').innerHTML = `<div class="mute">${esc(cname(m.comp))} · ${PHASE[m.phase]} · ${fmtT(m.ts)} · match #${m.matchId}</div>
    <div class="split" style="align-items:center;margin:14px 0"><div class="team-h" style="text-align:right">${m.w === m.p1 ? '🏆 ' : ''}${esc(pn(m.p1))}</div><div class="team-h">${esc(pn(m.p2))}${m.w === m.p2 ? ' 🏆' : ''}</div></div>
    <div class="score">${m.sets.map(s => s.join('-')).join('&nbsp;&nbsp; ')}</div>
    <div class="mute" style="text-align:center">Engine's current view of this pairing: ${esc(sn(m.p1))} ${pp(mw.P1)} · ${esc(sn(m.p2))} ${pp(mw.P2)}</div>
    <div class="split" style="margin-top:16px"><div class="card"><h3>Match stats</h3>${st}</div><div class="card"><h3>Game by game</h3><div class="scroll" style="max-height:360px">${gh || '<p class="mute">Not captured yet.</p>'}</div></div></div>`;
  $('#modal').classList.remove('hidden');
}

// ---------------- PREDICTOR
function marketTable(mk, p1, p2, probs, base) {
  const pk = pick(probs);
  return `<div class="pickbox" style="margin-bottom:14px"><div class="mute">${esc(lbl(mk.name, p1, p2))}</div><div class="prob-big">${esc(lbl(pk[0], p1, p2))} <span class="good">${pp(pk[1])}</span></div><div class="mute">Fair odds ${odds(pk[1])} — only worth betting if the bookmaker pays more than this</div></div>
  <table><tr><th>Option</th><th class="n">Engine</th>${base ? '<th class="n">Historical rate</th>' : ''}<th class="n">Fair odds</th><th>Bookie odds</th><th class="n">Edge (EV)</th></tr>
  ${mk.opts.map(o => `<tr><td><b>${esc(lbl(o.k, p1, p2))}</b>${o.k === pk[0] ? ' <span class="pill pick">pick</span>' : ''}</td><td class="n">${pp(probs[o.k])}</td>${base ? `<td class="n mute">${f1(base.pct[o.k])}%</td>` : ''}<td class="n">${odds(probs[o.k])}</td><td><input type="number" step="0.01" min="1" style="width:90px;min-width:0" data-odds="${probs[o.k]}" placeholder="e.g. 1.85"></td><td class="n" data-ev>–</td></tr>`).join('')}</table>`;
}
function evCell(inp) { const p = +inp.dataset.odds, o = +inp.value, cell = inp.closest('tr').querySelector('[data-ev]'); if (!o || o <= 1) { cell.textContent = '–'; cell.className = 'n'; return; } const ev = p * o - 1; cell.textContent = (ev * 100).toFixed(1) + '%'; cell.className = 'n ' + (ev > 0 ? 'good' : 'bad'); }
function rPredict() {
  const c = St.ui.comp, pl = playersOf(c);
  const up = upcoming(c);
  if (!St.ui.p1 || !pl.includes(+St.ui.p1)) { St.ui.p1 = up[0] ? up[0].p1 : pl[0]; St.ui.p2 = up[0] ? up[0].p2 : pl[1]; }
  if (!St.ui.p2 || !pl.includes(+St.ui.p2) || +St.ui.p2 === +St.ui.p1) St.ui.p2 = pl.find(p => p !== +St.ui.p1);
  const p1 = +St.ui.p1, p2 = +St.ui.p2;
  let h = `<div class="controls">${compSel('comp', c)}${playerSel('p1', c, p1, 'Player 1 (serves first)')}<button class="btn ghost" data-act="swap" title="Swap">⇄</button>${playerSel('p2', c, p2, 'Player 2')}${mkSel('mk', St.ui.mk, false, true)}</div>`;
  if (up.length) h += `<div class="card" style="margin-bottom:16px"><h3>Upcoming fixtures <small>from the live draw – click to predict</small></h3>${[...new Set(up.map(u => u.ts))].slice(0, 2).map(ts => { const L = up.filter(u => u.ts === ts); return `<div style="margin:6px 0"><b>${PHASE[L[0].ph]}${L[0].ph >= 5 ? ' #' + L[0].ip : ''}</b> <span class="mute">${ts ? fmtT(ts) + ' (' + until(ts) + ')' : ''}</span><br>${L.map(f => `<button class="btn ghost small" style="margin:3px" data-act="fix" data-comp="${c}" data-p1="${f.p1}" data-p2="${f.p2}">${esc(sn(f.p1))} v ${esc(sn(f.p2))}</button>`).join('')}</div>`; }).join('')}</div>`;
  const { F, n } = fitFor(c);
  if (n < 20) { view.innerHTML = h + '<div class="empty">Need at least 20 matches with point detail in this tournament to predict. Capture is filling this in.</div>'; return; }
  const P = pair(c, p1, p2); const freq = marketFreq(CM(c));
  const mw = mkProbs(P.mk, 'MW'), sb = mkProbs(P.mk, 'SB');
  const eg = P.outs.reduce((s, o) => s + o.p * o.sets.reduce((x, [a, b]) => x + a + b, 0), 0);
  const h2h = CM(c).filter(m => (m.p1 === p1 && m.p2 === p2) || (m.p1 === p2 && m.p2 === p1)).slice(-6).reverse();
  const r = ranksFor(c);
  const recent = id => CM(c).filter(m => m.p1 === id || m.p2 === id).slice(-8).map(m => (m.w === id ? 'W' : 'L'));
  let main;
  if (St.ui.mk === 'ALL') main = `<div class="card"><h3>All markets <small>sorted by confidence</small></h3><table><tr><th>Market</th><th>Pick</th><th class="n">Prob</th><th class="n">Fair odds</th><th>2nd</th><th class="n">Historical rate of pick</th></tr>${P.mk.map(x => ({ x, s: x.opts.slice().sort((a, b) => b.p - a.p) })).sort((a, b) => b.s[0].p - a.s[0].p).map(({ x, s }) => `<tr><td>${esc(lbl(x.name, p1, p2))}</td><td><span class="pill pick">${esc(lbl(s[0].k, p1, p2, true))}</span></td><td class="n"><b>${pp(s[0].p)}</b></td><td class="n">${odds(s[0].p)}</td><td class="mute">${esc(lbl(s[1].k, p1, p2, true))} ${pp(s[1].p)}</td><td class="n mute">${f1(freq[x.id].pct[s[0].k])}%</td></tr>`).join('')}</table></div>`;
  else { const x = P.mk.find(m => m.id === St.ui.mk) || P.mk[0]; main = `<div class="card">${marketTable(TMarkets.byId[x.id], p1, p2, Object.fromEntries(x.opts.map(o => [o.k, o.p])), freq[x.id])}</div>`; }
  h += `<div class="split" style="margin-bottom:16px">
    <div class="card"><div class="team-h">${esc(pn(p1))} <span class="mute">vs</span> ${esc(pn(p2))}</div><table style="margin-top:10px">
      <tr><td>Seeds</td><td class="n">#${(r.get(p1) ?? 0) + 1} v #${(r.get(p2) ?? 0) + 1}</td></tr>
      <tr><td>Points won on own serve (engine)</td><td class="n"><b>${pp(P.pA)}</b> – <b>${pp(P.pB)}</b></td></tr>
      <tr><td>Hold probability</td><td class="n">${pp(TMarkov.gameFrom(P.pA))} – ${pp(TMarkov.gameFrom(P.pB))}</td></tr>
      <tr><td>Match winner</td><td class="n"><b>${pp(mw.P1)}</b> – <b>${pp(mw.P2)}</b></td></tr>
      <tr><td>Expected total games</td><td class="n">${f1(eg)}</td></tr>
      <tr><td>Recent form</td><td class="n"><span class="form">${recent(p1).map(x => `<i class="${x}">${x}</i>`).join('')}</span> · <span class="form">${recent(p2).map(x => `<i class="${x}">${x}</i>`).join('')}</span></td></tr>
    </table></div>
    <div class="card"><h3>Set betting</h3><div class="hbars">${['2-0', '2-1', '1-2', '0-2'].map(k => `<div class="r"><span>${k}</span>${bar(sb[k] * 200)}<span class="n">${pp(sb[k])}</span></div>`).join('')}</div>
      <h3 style="margin-top:14px">Head to head</h3><table>${h2h.map(m => `<tr class="click" data-act="match" data-id="${m.matchId}"><td>${fmtT(m.ts)}</td><td>🏆 ${esc(sn(m.w))}</td><td class="n">${m.sets.map(s => s.join('-')).join(' ')}</td></tr>`).join('') || '<tr><td class="mute">No previous meetings captured</td></tr>'}</table></div></div>
  ${main}
  <div class="note">Zoom tennis is simulated point by point, and testing confirmed each point is independent. The engine estimates each player's serve and return strength from every captured point, then computes every market exactly. Check the Backtest tab before trusting a market, and only bet where the bookmaker's odds beat the fair odds.</div>`;
  view.innerHTML = h;
}

// ---------------- ROUND BOARD
function rBoard() {
  const bc = St.ui.boardComp, mkId = TMarkets.byId[St.ui.mk] ? St.ui.mk : 'MW';
  const comps = bc === 'all' ? St.comps.map(c => c.id) : [+bc];
  const rows = [];
  for (const c of comps) {
    if (fitFor(c).n < 20) continue;
    const up = upcoming(c); if (!up.length) continue;
    const ts = up[0].ts; up.filter(u => u.ts === ts).forEach(f => { const P = pair(c, f.p1, f.p2); const pr = mkProbs(P.mk, mkId); const s = Object.entries(pr).sort((a, b) => b[1] - a[1]); rows.push({ c, f, s }); });
  }
  rows.sort((a, b) => b.s[0][1] - a.s[0][1]);
  const shown = rows.filter(r => r.s[0][1] * 100 >= (+St.ui.minP || 0));
  view.innerHTML = `<div class="controls">${compSel('boardComp', bc, true)}${mkSel('mk', mkId)}<label>Min probability %<input type="number" data-ui="minP" value="${St.ui.minP || 0}" min="0" max="100" style="width:110px;min-width:0"></label></div>
  <div class="card"><h3>${esc(TMarkets.byId[mkId].name)} — next round in ${bc === 'all' ? 'every tournament' : esc(cname(bc))} <small>${shown.length} fixtures, sorted by confidence</small></h3>
  ${rows.length ? `<div class="scroll" style="max-height:none"><table><tr><th>Tournament</th><th>Round</th><th>Match</th><th>Pick</th><th class="n">Prob</th><th class="n">Fair odds</th><th>2nd</th><th></th></tr>
  ${shown.map(({ c, f, s }) => `<tr><td>${esc(cname(c))}</td><td class="mute">${PHASE[f.ph]}${f.ph >= 5 ? ' #' + f.ip : ''} · ${f.ts ? fmtT(f.ts) : ''}</td><td><b>${esc(pn(f.p1))}</b> v <b>${esc(pn(f.p2))}</b></td><td><span class="pill pick">${esc(lbl(s[0][0], f.p1, f.p2, true))}</span></td><td class="n"><b class="${s[0][1] >= St.set.tConf ? 'good' : ''}">${pp(s[0][1])}</b></td><td class="n">${odds(s[0][1])}</td><td class="mute">${esc(lbl(s[1][0], f.p1, f.p2, true))} ${pp(s[1][1])}</td><td><button class="btn ghost small" data-act="fix" data-comp="${c}" data-p1="${f.p1}" data-p2="${f.p2}">Detail</button></td></tr>`).join('')}</table></div>` : '<div class="empty">No upcoming fixtures known right now. They appear as soon as both players of a match are decided.</div>'}</div>`;
}

// ---------------- OUTRIGHT (tournament winner via bracket)
function bracketOdds(c) {
  const d = St.draws[c]; if (!d || !d.phases || !d.phases[6]) return null;
  const P = d.phases; const liveById = new Map(); (St.tlive && St.tlive.comps || []).filter(x => x.comp === c).forEach(x => x.matches.forEach(m => liveById.set(m.id, m)));
  const { F } = fitFor(c); const WC = St.winCache || (St.winCache = new Map());
  const winP = (a, b) => { const k = c + ':' + a + ':' + b; if (!WC.has(k)) { const pr = TModel.probs(F, a, b); WC.set(k, TMarkov.matchWin(pr.pA, pr.pB)); } return WC.get(k); };
  // dist[ph][i] = Map player -> P(player wins match i of phase ph)
  const dist = {};
  for (let ph = 6; ph >= 1; ph--) {
    dist[ph] = (P[ph] || []).map((m, i) => {
      const out = new Map();
      if (m.status === 2 && m.winnerId) { out.set(m.winnerId, 1); return out; }
      const A = ph === 6 ? new Map([[m.playerOneId, 1]]) : (m.playerOneId ? new Map([[m.playerOneId, 1]]) : dist[ph + 1][2 * i]);
      const B = ph === 6 ? new Map([[m.playerTwoId, 1]]) : (m.playerTwoId ? new Map([[m.playerTwoId, 1]]) : dist[ph + 1][2 * i + 1]);
      const lv = liveById.get(m.matchId);
      if (lv && lv.status === 1 && m.playerOneId) { const p = liveWin(c, lv); out.set(m.playerOneId, p); out.set(m.playerTwoId, 1 - p); return out; }
      for (const [a, pa] of A) for (const [b, pb] of B) { if (!a || !b) continue; const w = winP(a, b); out.set(a, (out.get(a) || 0) + pa * pb * w); out.set(b, (out.get(b) || 0) + pa * pb * (1 - w)); }
      return out;
    });
  }
  const reach = ph => { const m = new Map(); (dist[ph] || []).forEach(x => x.forEach((v, k) => m.set(k, (m.get(k) || 0) + v))); return m; };
  return { win: reach(1), final: reach(2), sf: reach(3), qf: reach(4) };
}
function rOutright() {
  const c = St.ui.comp; const B = bracketOdds(c);
  let h = `<div class="controls">${compSel('comp', c)}</div>`;
  if (!B || fitFor(c).n < 20) { view.innerHTML = h + '<div class="empty">Need the current draw and at least 20 detailed matches.</div>'; return; }
  const r = ranksFor(c);
  const rows = [...B.win.entries()].filter(([, p]) => p > 0.0005).sort((a, b) => b[1] - a[1]);
  const alive = rows.length;
  h += `<div class="card"><h3>${esc(cname(c))} — chance to win the tournament <small>${alive} players still alive · live matches use their live score</small></h3><table>
  <tr><th>Player</th><th class="n">Seed</th><th class="n">Reach QF</th><th class="n">Reach SF</th><th class="n">Reach final</th><th class="n">Win</th><th class="n">Fair odds</th><th></th></tr>
  ${rows.map(([id, p]) => `<tr><td><b>${esc(pn(id))}</b></td><td class="n mute">#${(r.get(id) ?? 0) + 1}</td><td class="n">${pp(B.qf.get(id))}</td><td class="n">${pp(B.sf.get(id))}</td><td class="n">${pp(B.final.get(id))}</td><td class="n"><b>${pp(p)}</b></td><td class="n">${odds(p)}</td><td style="min-width:120px">${bar(p * 100 / rows[0][1])}</td></tr>`).join('')}</table>
  <p class="mute" style="font-size:13px">Computed exactly through the remaining bracket: every possible opponent in every later round, weighted by the chance of meeting them.</p></div>`;
  view.innerHTML = h;
}

// ---------------- LIVE
const SET_DONE = (a, b) => (a >= 6 && a - b >= 2) || (b >= 6 && b - a >= 2) || a === 7 || b === 7;
function liveState(m) {
  const done = (m.done || []).slice(); let ga = m.ga || 0, gb = m.gb || 0;
  if (SET_DONE(ga, gb) && done.length < (m.sets || []).length) { done.push([ga, gb]); ga = 0; gb = 0; }
  const tb = ga === 6 && gb === 6;
  return { done, ga, gb, server: m.server || 1, pts: [TMarkov.pts(m.pa, tb), TMarkov.pts(m.pb, tb)] };
}
function liveEval(c, m) {
  const { F } = fitFor(c); const pr = TModel.probs(F, m.p1, m.p2); const st = liveState(m);
  const outs = TMarkov.matchOutcomes(pr.pA, pr.pB, st);
  const mk = TMarkets.compute(outs).filter(x => !(x.id.startsWith('S1') && st.done.length >= 1) && !(x.id.startsWith('S2') && st.done.length >= 2));
  const extras = TMarkets.liveExtras(pr.pA, pr.pB, st);
  const pre = pair(c, m.p1, m.p2);
  return { pr, st, outs, mk, extras, all: extras.concat(mk), mw: mkProbs(mk, 'MW'), preMw: mkProbs(pre.mk, 'MW') };
}
const liveWin = (c, m) => { const { F } = fitFor(c); const pr = TModel.probs(F, m.p1, m.p2); return TMarkov.matchOutcomes(pr.pA, pr.pB, liveState(m)).filter(o => TMarkets.setsWon(o.sets)[0] === 2).reduce((a, o) => a + o.p, 0); };
function scoreLine(m, st) {
  const sets = st.done.map(s => `<span class="setcell">${s[0]}</span>`).join('') + `<span class="setcell cur">${st.ga}</span>`;
  const sets2 = st.done.map(s => `<span class="setcell">${s[1]}</span>`).join('') + `<span class="setcell cur">${st.gb}</span>`;
  return [sets, sets2];
}
function renderLive(keep) {
  if (St.tab !== 'live') return;
  const y = window.scrollY; const L = St.tlive; const age = L ? (Date.now() - L.at) / 1000 : Infinity;
  let h = `<div class="controls">${compSel('liveComp', St.ui.liveComp, true)}${mkSel('liveMk', St.ui.liveMk, true)}</div>
  <div class="kpis"><div class="kpi"><div class="v ${age < 45 ? 'good' : 'bad'}">${age < 45 ? '● LIVE' : '● OFFLINE'}</div><div class="l">${L ? 'last update ' + Math.round(age) + 's ago' : 'no live data yet'}</div></div>`;
  if (age >= 45) { view.innerHTML = h + `</div><div class="card"><h3>Live feed not connected</h3><p>In-play data comes from the site's own live tennis page, which the extension keeps open as a pinned tab.</p><button class="btn" data-act="openLive">Open live tennis tab</button></div>`; return; }
  const comps = (L.comps || []).filter(x => St.ui.liveComp === 'all' || +St.ui.liveComp === x.comp);
  const nLive = comps.reduce((s, x) => s + x.matches.filter(m => m.status === 1).length, 0);
  h += `<div class="kpi"><div class="v">${nLive}</div><div class="l">matches in play</div></div></div><div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(620px,1fr))">`;
  for (const x of comps) {
    if (fitFor(x.comp).n < 20) continue;
    h += `<div class="card"><h3>${esc(cname(x.comp))} · ${PHASE[x.phase]}${x.phase >= 5 ? ' #' + x.ip : ''} <small>started ${fmtT(Date.parse(x.roundStart))} · next round ${until(Date.parse(x.nextRound))}</small></h3><div style="overflow-x:auto"><table>
      <tr><th>Player</th><th>Sets / games</th><th class="n">Pts</th><th class="n">Win now</th><th class="n">Pre-match</th><th>Pick (${esc(St.ui.liveMk)})</th></tr>`;
    for (const m of x.matches) {
      if (m.status === 2) { h += `<tr class="mute"><td>${m.winner === m.p1 ? '🏆 ' : ''}${esc(sn(m.p1))}<br>${m.winner === m.p2 ? '🏆 ' : ''}${esc(sn(m.p2))}</td><td>${(m.sets || []).map(s => `<span class="setcell">${s[0]}</span>`).join('')}<br>${(m.sets || []).map(s => `<span class="setcell">${s[1]}</span>`).join('')}</td><td class="n">FT</td><td></td><td></td><td></td></tr>`; continue; }
      if (m.status !== 1) continue;
      const E = liveEval(x.comp, m); const [s1, s2] = scoreLine(m, E.st);
      const mk = E.all.find(k => k.id === St.ui.liveMk); const b = mk ? mk.opts.slice().sort((a, c2) => c2.p - a.p)[0] : null;
      const tb = E.st.ga === 6 && E.st.gb === 6;
      h += `<tr class="click" data-act="live" data-id="${m.id}"><td>${E.st.server === 1 ? '<span class="srv"></span>' : '<span style="display:inline-block;width:14px"></span>'}${esc(sn(m.p1))}<br>${E.st.server === 2 ? '<span class="srv"></span>' : '<span style="display:inline-block;width:14px"></span>'}${esc(sn(m.p2))}</td>
        <td>${s1}<br>${s2}</td><td class="n"><span class="pt">${tb ? E.st.pts[0] : esc(m.pa)}</span><br><span class="pt">${tb ? E.st.pts[1] : esc(m.pb)}</span></td>
        <td class="n"><b>${pp(E.mw.P1)}</b><br><b>${pp(E.mw.P2)}</b></td><td class="n mute">${pp(E.preMw.P1)}<br>${pp(E.preMw.P2)}</td>
        <td>${b ? `<span class="pill pick">${esc(lbl(b.k, m.p1, m.p2, true))}</span> <b>${pp(b.p)}</b>` : '<span class="mute">–</span>'}</td></tr>`;
    }
    h += `</table></div></div>`;
  }
  h += `</div>${!nLive ? '<div class="empty">No tennis matches in play right now.</div>' : ''}
  <div class="card" style="margin-top:16px"><h3>📈 Live accuracy tracker <small>are the live win probabilities honest?</small></h3><div id="calBox">${St.calib ? calibHTML(St.calib) : '<p class="mute">Calculating…</p>'}</div></div>
  <div class="note">The site's live tennis feed has no odds, so the engine prices every market itself from the exact score (sets, games, points, server). Type the bookmaker's live odds into a match to see the edge.</div>`;
  view.innerHTML = h;
  if (keep) window.scrollTo(0, y);
  if (!St.calib || Date.now() - St.calib.at > 120000) liveCalibration();
}
function showLiveMatch(id, refresh) {
  const L = St.tlive; if (!L) return; let comp = null, m = null;
  for (const x of L.comps || []) { const f = x.matches.find(z => z.id === id); if (f) { comp = x; m = f; break; } }
  if (refresh && $('#modal').classList.contains('hidden')) { modalLive = null; return; }
  if (!m || m.status !== 1) { if (!refresh) { $('#modalBody').innerHTML = '<p class="mute">This match is no longer live.</p>'; $('#modal').classList.remove('hidden'); } return; }
  modalLive = id;
  // keep typed odds across refreshes
  const typed = {}; document.querySelectorAll('#modalBody input[data-key]').forEach(i => { if (i.value) typed[i.dataset.key] = i.value; });
  const E = liveEval(comp.comp, m); const [s1, s2] = scoreLine(m, E.st); const tb = E.st.ga === 6 && E.st.gb === 6;
  $('#modalBody').innerHTML = `<div class="mute">${esc(cname(comp.comp))} · ${PHASE[comp.phase]} · <span class="good">● live, updates automatically</span></div>
    <table style="margin:14px 0;font-size:20px"><tr><td>${E.st.server === 1 ? '<span class="srv"></span>' : ''}<b>${esc(pn(m.p1))}</b></td><td>${s1}</td><td><span class="pt">${tb ? E.st.pts[0] : esc(m.pa)}</span></td><td class="n"><b class="good">${pp(E.mw.P1)}</b></td></tr>
    <tr><td>${E.st.server === 2 ? '<span class="srv"></span>' : ''}<b>${esc(pn(m.p2))}</b></td><td>${s2}</td><td><span class="pt">${tb ? E.st.pts[1] : esc(m.pb)}</span></td><td class="n"><b class="good">${pp(E.mw.P2)}</b></td></tr></table>
    <div class="mute">Points won on own serve (engine): ${esc(sn(m.p1))} ${pp(E.pr.pA)} · ${esc(sn(m.p2))} ${pp(E.pr.pB)} · pre-match win ${pp(E.preMw.P1)} / ${pp(E.preMw.P2)}</div>
    <div class="card" style="margin-top:14px"><h3>All live markets <small>type bookmaker odds to see the edge</small></h3><table><tr><th>Market</th><th>Option</th><th class="n">Prob</th><th class="n">Fair odds</th><th>Bookie odds</th><th class="n">Edge</th></tr>
    ${E.all.map(x => x.opts.map((o, i) => `<tr><td>${i === 0 ? esc(lbl(x.name, m.p1, m.p2)) : ''}</td><td>${esc(lbl(o.k, m.p1, m.p2, true))}</td><td class="n">${pp(o.p)}</td><td class="n">${odds(o.p)}</td><td><input type="number" step="0.01" min="1" style="width:80px;min-width:0" data-odds="${o.p}" data-key="${x.id}|${o.k}" value="${esc(typed[x.id + '|' + o.k] || '')}"></td><td class="n" data-ev>–</td></tr>`).join('')).join('')}</table></div>`;
  document.querySelectorAll('#modalBody input[data-odds]').forEach(i => { if (i.value) evCell(i); });
  $('#modalBody').oninput = e => { if (e.target.dataset.odds != null) evCell(e.target); };
  $('#modal').classList.remove('hidden');
}
async function liveCalibration() {
  if (St.calibBusy) return; St.calibBusy = true;
  try {
    const docs = await TDB.getAll('live'); const fin = new Map(St.matches.map(m => [m.matchId, m]));
    const B = Array.from({ length: 10 }, () => [0, 0, 0]); let n = 0, ll = 0, settled = 0;
    for (const d of docs) {
      const m = fin.get(d.matchId); if (!m) continue; settled++;
      const hist = CM(d.comp).filter(x => x.ts < m.ts && x.serve); if (hist.length < 20) continue;
      const F = TModel.fit(hist, ranksFor(d.comp), mOpts()); const pr = TModel.probs(F, d.p1, d.p2);
      const step = Math.max(1, Math.floor(d.snaps.length / 12));
      for (let i = 0; i < d.snaps.length; i += step) {
        const s = d.snaps[i]; const st = liveState({ done: s.done, ga: s.ga, gb: s.gb, pa: s.pa, pb: s.pb, server: s.server, sets: (s.done || []).concat([[s.ga, s.gb]]) });
        const p = TMarkov.matchOutcomes(pr.pA, pr.pB, st).filter(o => TMarkets.setsWon(o.sets)[0] === 2).reduce((a, o) => a + o.p, 0);
        const y = m.w === m.p1 ? 1 : 0; const b = B[Math.min(9, Math.floor(p * 10))]; b[0] += p; b[1] += y; b[2]++; n++; ll += -Math.log(Math.max(1e-6, y ? p : 1 - p));
      }
    }
    St.calib = { at: Date.now(), B, n, ll: n ? ll / n : null, docs: docs.length, settled };
  } finally { St.calibBusy = false; }
  const box = $('#calBox'); if (box) box.innerHTML = calibHTML(St.calib);
}
function calibHTML(c) {
  if (!c.docs) return '<p class="mute">Nothing logged yet. Every live match is recorded point by point; once results are captured, the live win probabilities are checked against what actually happened.</p>';
  if (!c.n) return `<p class="mute">${c.docs} live matches logged, ${c.settled} settled — not enough history yet to score them.</p>`;
  return `<table><tr><th>Engine said P1 wins</th><th class="n">Snapshots</th><th class="n">Engine average</th><th class="n">Actually won</th></tr>${c.B.map((b, i) => b[2] ? `<tr><td>${i * 10}–${i * 10 + 10}%</td><td class="n">${b[2]}</td><td class="n">${pc(100 * b[0] / b[2])}</td><td class="n"><b>${pc(100 * b[1] / b[2])}</b></td></tr>` : '').join('')}</table>
  <p class="mute" style="font-size:13px">${c.docs} live matches logged, ${c.settled} settled, ${c.n} snapshots scored · log-loss ${f2(c.ll)}. If "Actually won" tracks "Engine average", the live probabilities are honest. Small samples swing. <a href="#" data-act="calib">Recalculate</a></p>`;
}

// ---------------- BACKTEST
function rBacktest() {
  view.innerHTML = `<div class="controls">${compSel('btComp', St.ui.btComp, true)}<label>Evaluate last N rounds<input type="number" data-ui="btRounds" value="${St.ui.btRounds}" min="5" max="5000" style="width:120px;min-width:0"></label>${mkSel('btMk', St.ui.btMk)}<button class="btn" data-act="bt">▶ Run backtest</button></div>
  <div class="note">Walk-forward test: each round is predicted using <b>only</b> matches played before it. "Historical rate" = how often each outcome happened before, which is what you'd know without the engine. Skill = log-loss improvement over that; near 0% means no real edge.</div>
  <div id="btProg" class="progress" style="display:none"><span></span></div><div id="btOut"></div>`;
  if (St.bt) drawBT(St.bt);
}
async function runBacktest() {
  const comps = St.ui.btComp === 'all' ? St.comps.map(c => c.id) : [+St.ui.btComp];
  $('#btProg').style.display = 'block';
  const agg = {}, cal = {}; let ev = 0;
  for (let i = 0; i < comps.length; i++) {
    const r = await TBacktest.run(CM(comps[i]).filter(m => m.serve), mOpts(), { lastRounds: +St.ui.btRounds, onProgress: p => { $('#btProg span').style.width = (100 * (i + p) / comps.length) + '%'; } });
    ev += r.evaluated;
    for (const k in r.res) for (const e in r.res[k]) { const A = ((agg[k] = agg[k] || {})[e] = (agg[k] || {})[e] || { n: 0, hit: 0, ll: 0 }); for (const f in A) A[f] += r.res[k][e][f]; }
    for (const k in r.cal) { const A = (cal[k] = cal[k] || Array.from({ length: 10 }, () => [0, 0, 0])); r.cal[k].forEach((b, j) => { A[j][0] += b[0]; A[j][1] += b[1]; A[j][2] += b[2]; }); }
  }
  $('#btProg span').style.width = '100%';
  St.bt = { agg, cal, ev }; drawBT(St.bt);
}
function drawBT(R) {
  const out = $('#btOut'); if (!out) return;
  if (!R.ev) { out.innerHTML = '<div class="empty">Not enough detailed history yet (needs 30+ matches per tournament before the test window).</div>'; return; }
  const cell = s => (s && s.n ? `${pc(100 * s.hit / s.n)} <span class="mute">ll ${(s.ll / s.n).toFixed(3)}</span>` : '–');
  const rows = TMarkets.DEF.filter(d => R.agg[d.id]).map(d => { const A = R.agg[d.id]; const g = A.base && A.model_vs ? (A.base.ll - A.model_vs.ll) / A.base.ll * 100 : null; return `<tr><td>${esc(d.name)}</td><td class="n">${A.model_vs ? A.model_vs.n : 0}</td><td class="n">${cell(A.model_vs)}</td><td class="n">${cell(A.base)}</td><td class="n ${g > 0.5 ? 'good' : g < -0.5 ? 'bad' : 'mute'}">${g == null ? '–' : (g > 0 ? '+' : '') + g.toFixed(1) + '%'}</td></tr>`; }).join('');
  const C = R.cal[St.ui.btMk];
  const calib = C ? `<div class="calib">${C.map(b => { const pr = b[2] ? b[0] / b[2] : 0, ob = b[2] ? b[1] / b[2] : 0; return `<div title="${b[2]} predictions"><span style="height:${pr * 100}%;background:#3b4a63"></span><span style="height:${ob * 100}%;background:var(--acc)"></span></div>`; }).join('')}</div><div class="mute" style="font-size:13px;margin-top:6px">Each pair = a 10% probability bucket. Grey = what the engine predicted, green = what happened.</div>` : '';
  out.innerHTML = `<div class="kpis"><div class="kpi"><div class="v">${R.ev.toLocaleString()}</div><div class="l">Matches evaluated</div></div></div>
  <div class="card"><h3>Engine vs historical rates</h3><div class="scroll" style="max-height:none"><table><tr><th>Market</th><th class="n">N</th><th class="n">Engine (pick accuracy · log-loss)</th><th class="n">Historical rate</th><th class="n">Skill</th></tr>${rows}</table></div></div>
  <div class="card" style="margin-top:16px"><h3>Calibration — ${esc(TMarkets.byId[St.ui.btMk].name)}</h3>${calib}</div>`;
}

// ---------------- SETTINGS
function rSettings() {
  const s = St.set; const f = (k, l, step, help) => `<label>${l}<input type="number" step="${step}" id="set_${k}" value="${s[k]}" style="width:140px;min-width:0">${help ? `<span class="mute" style="font-size:12px">${help}</span>` : ''}</label>`;
  view.innerHTML = `<div class="card"><h3>Capture</h3><div class="controls">
    <label>Live tennis tab<select id="set_tennisLiveTab"><option value="1" ${s.tennisLiveTab ? 'selected' : ''}>Keep it open (pinned)</option><option value="0" ${!s.tennisLiveTab ? 'selected' : ''}>Don't open automatically</option></select></label>
    ${f('tDetailLimit', 'Point-by-point details per run', 10)}</div><p class="mute" style="font-size:13px">Capture runs on the same schedule as football (every ${s.syncMin} min).</p></div>
  <div class="card" style="margin-top:16px"><h3>Prediction model</h3><div class="controls">${f('tTau', 'Rating spread (tau)', 0.01, 'default 0.05')}${f('tBeta', 'Seed prior strength', 0.01, 'default 0.05')}${f('tConf', 'High-confidence threshold', 0.01)}</div>
  <p class="mute" style="font-size:13px">Defaults were tuned by walk-forward backtest on real Zoom tennis data. Re-run the Backtest after changing them.</p><button class="btn" data-act="saveSet">Save</button> <span id="setMsg" class="good"></span></div>
  <div class="card" style="margin-top:16px"><h3>Data</h3><button class="btn ghost" data-act="csv">Export matches CSV</button> <button class="btn ghost" data-act="export">Export full backup (JSON)</button> <button class="btn ghost" data-act="import">Import backup</button><input type="file" id="impFile" accept=".json" style="display:none"> <button class="btn danger" data-act="clear">Clear tennis database</button></div>`;
  $('#impFile').addEventListener('change', importJSON);
}
async function saveSet() {
  const n = k => +$('#set_' + k).value;
  St.set = await saveSettings({ tennisLiveTab: $('#set_tennisLiveTab').value === '1', tDetailLimit: n('tDetailLimit'), tTau: n('tTau'), tBeta: n('tBeta'), tConf: n('tConf') });
  St.fitCache = {}; St.pairCache = new Map(); St.winCache = new Map(); St.bt = null; $('#setMsg').textContent = 'Saved ✓';
}
function download(name, text, type) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); }
async function exportJSON() { download(`zoom-tennis-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify({ v: 1, matches: await TDB.getAll('matches'), meta: await TDB.getAll('meta'), live: await TDB.getAll('live') }), 'application/json'); }
function exportCSV() {
  const q = v => { const s = String(v ?? ''); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const L = [['matchId', 'tournament', 'started', 'round', 'time', 'player1', 'player2', 'winner', 'sets', 'p1_serve_pts_won', 'p1_serve_pts', 'p2_serve_pts_won', 'p2_serve_pts', 'p1_holds', 'p1_service_games', 'p2_holds', 'p2_service_games'].join(',')];
  St.matches.forEach(m => L.push([m.matchId, cname(m.comp), m.tour, PHASE[m.phase], m.time, pn(m.p1), pn(m.p2), pn(m.w), m.sets.map(s => s.join('-')).join(' '), ...(m.serve ? [m.serve[0][0], m.serve[0][1], m.serve[1][0], m.serve[1][1], m.holds[0][0], m.holds[0][1], m.holds[1][0], m.holds[1][1]] : ['', '', '', '', '', '', '', ''])].map(q).join(',')));
  download(`zoom-tennis-matches-${new Date().toISOString().slice(0, 10)}.csv`, L.join('\n'), 'text/csv');
}
async function importJSON(e) { const f = e.target.files[0]; if (!f) return; try { const d = JSON.parse(await f.text()); await TDB.putMany('matches', d.matches || []); await TDB.putMany('meta', d.meta || []); await TDB.putMany('live', d.live || []); await load(); render(); alert(`Imported ${(d.matches || []).length} matches.`); } catch (err) { alert('Import failed: ' + err.message); } }
async function clearDB() { if (!confirm('Delete ALL captured tennis data from this browser?')) return; for (const s of ['matches', 'meta', 'live']) await TDB.clear(s); await load(); render(); }

(async () => { await load(); render(); setInterval(() => { syncLine(); if (St.tab === 'live' && !liveTimer) renderLive(true); }, 10000); })();
