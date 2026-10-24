/* Zoom Stats & Prediction Engine – dashboard */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const f1 = x => (x == null || isNaN(x) ? '–' : (+x).toFixed(1));
const f2 = x => (x == null || isNaN(x) ? '–' : (+x).toFixed(2));
const pc = x => (x == null || isNaN(x) ? '–' : (+x).toFixed(1) + '%');
const pp = p => (p == null ? '–' : (p * 100).toFixed(1) + '%');
const odds = p => (p > 0 ? (1 / p).toFixed(2) : '–');

const St = {
  init: null, teams: {}, comps: [], matches: [], byComp: new Map(), deep: new Map(), standings: {},
  set: null, status: null, tab: 'overview', btResult: null, predOut: null,
  ui: Object.assign({ comp: null, scope: 'cur', team: null, home: null, away: null, mk: '1X2', eng: 'blend', group: 'one', season: null, boardRound: null, boardComp: null, minP: 0, btComp: 'all', btRounds: 150, btMk: '1X2', btEng: 'blend', manual: {}, liveComp: 'all', liveMk: 'L1X2', liveMinP: 0, liveValue: '0' }, JSON.parse(localStorage.getItem('zui') || '{}'))
};
const saveUI = () => localStorage.setItem('zui', JSON.stringify(St.ui));

const tn = id => (St.teams[id] ? St.teams[id].name : '#' + id);
const tshort = id => (St.teams[id] ? St.teams[id].short : '#' + id);
const cname = id => { const c = St.comps.find(x => x.id === +id); return c ? c.name : 'League ' + id; };
const fmtT = ts => new Date(ts).toLocaleString([], { weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
const ago = ts => { if (!ts) return 'never'; const s = Math.round((Date.now() - ts) / 1000); return s < 60 ? s + 's ago' : s < 3600 ? Math.round(s / 60) + ' min ago' : Math.round(s / 3600) + ' h ago'; };
const until = ts => { const s = Math.round((ts - Date.now()) / 60000); return s >= 0 ? 'in ' + s + ' min' : Math.abs(s) + ' min ago'; };
const formStrip = arr => `<span class="form">${arr.map(r => `<i class="${r}">${r}</i>`).join('')}</span>`;
const bar = (p, cls = '') => `<div class="bar ${cls}"><span style="width:${Math.max(0, Math.min(100, p))}%"></span></div>`;

// ---------- data
async function load() {
  St.set = await getSettings();
  const [init, ms, deep, stds, { status }] = await Promise.all([ZDB.get('meta', 'init'), ZDB.getAll('matches'), ZDB.getAll('deep'), ZDB.getAll('standings'), chrome.storage.local.get('status')]);
  St.init = init; St.status = status;
  St.teams = init ? init.teams : {};
  St.comps = init ? init.comps : [];
  St.matches = ms;
  St.byComp = new Map();
  ms.sort((a, b) => a.ts - b.ts || a.matchId - b.matchId).forEach(m => { if (!St.byComp.has(m.comp)) St.byComp.set(m.comp, []); St.byComp.get(m.comp).push(m); });
  St.deep = new Map(deep.map(d => [d.matchId, d]));
  St.standings = Object.fromEntries(stds.map(s => [s.comp, s]));
  if (!St.ui.comp || !St.byComp.has(+St.ui.comp)) St.ui.comp = St.comps.find(c => St.byComp.has(c.id))?.id || St.comps[0]?.id || null;
  updateSyncLine();
}
const CM = c => St.byComp.get(+c) || [];
function seasonsOf(c) { const s = new Map(); CM(c).forEach(m => s.set(m.season, m.seasonTs)); return [...s.entries()].sort((a, b) => b[1] - a[1]).map(x => x[0]); }
function scoped(c, scope) {
  const ms = CM(c); const ss = seasonsOf(c);
  if (scope === 'cur') return ms.filter(m => m.season === ss[0]);
  if (scope === 'prev') return ms.filter(m => m.season === ss[1]);
  if (scope === 'last100') return ms.slice(-100);
  if (scope === 'last300') return ms.slice(-300);
  return ms;
}
function teamsOf(c) {
  const ms = CM(c); const ss = seasonsOf(c);
  const ids = new Set(ms.filter(m => m.season === ss[0]).flatMap(m => [m.home, m.away]));
  if (!ids.size) { const comp = St.comps.find(x => x.id === +c); (comp?.competitors || []).forEach(i => ids.add(i)); }
  return [...ids].sort((a, b) => tn(a).localeCompare(tn(b)));
}
const modelOpts = () => ({ halfLifeH: St.set.halfLifeH, prior: St.set.prior, maxHist: St.set.maxHist, formN: St.set.formN, alpha: St.set.alpha, blendW: St.set.blendW, conf: St.set.conf, totShrink: St.set.totShrink });

// ---------- shared controls
const compSel = (name, val, all = false) => `<label>League<select data-ui="${name}">${all ? `<option value="all" ${val === 'all' ? 'selected' : ''}>All leagues</option>` : ''}${St.comps.map(c => `<option value="${c.id}" ${+val === c.id ? 'selected' : ''}>${esc(c.name)} (${CM(c.id).length})</option>`).join('')}</select></label>`;
const scopeSel = val => `<label>Data scope<select data-ui="scope">${[['cur', 'Current season'], ['prev', 'Previous season'], ['last100', 'Last 100 matches'], ['last300', 'Last 300 matches'], ['all', 'All captured history']].map(([k, l]) => `<option value="${k}" ${val === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>`;
const teamSel = (name, c, val, label) => `<label>${label}<select data-ui="${name}">${teamsOf(c).map(t => `<option value="${t}" ${+val === t ? 'selected' : ''}>${esc(tn(t))}</option>`).join('')}</select></label>`;
const mkSel = (name, val, withAll = false) => {
  const groups = {}; ZMarkets.list.forEach(m => (groups[m.group] = groups[m.group] || []).push(m));
  return `<label>Market<select data-ui="${name}">${withAll ? `<option value="ALL" ${val === 'ALL' ? 'selected' : ''}>★ All markets</option>` : ''}${Object.entries(groups).map(([g, ms]) => `<optgroup label="${g}">${ms.map(m => `<option value="${m.id}" ${val === m.id ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</optgroup>`).join('')}</select></label>`;
};
const engSel = (name, val) => `<label>Engine<select data-ui="${name}">${[['blend', 'Blend (Poisson + Form)'], ['poisson', 'Poisson / Dixon-Coles'], ['form', 'Form frequency'], ['base', 'League base rate']].map(([k, l]) => `<option value="${k}" ${val === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>`;

// ---------- header / sync
function updateSyncLine() {
  const s = St.status || {};
  const run = s.running ? '<span class="warnc">● capturing…</span> ' : '';
  $('#syncLine').innerHTML = `${run}${(s.total ?? St.matches.length).toLocaleString()} matches · ${St.deep.size.toLocaleString()} deep stats · last capture ${ago(s.lastSync)}${s.log && s.log.length ? ' · <span class="bad">' + s.log.length + ' warning(s)</span>' : ''}`;
  $('#btnSync').disabled = !!s.running;
}
$('#btnSync').addEventListener('click', async () => {
  $('#btnSync').disabled = true;
  await chrome.runtime.sendMessage({ type: 'syncNow' });
  await load(); render();
});
chrome.storage.onChanged.addListener(async (ch) => {
  if (!ch.status) return;
  const prev = St.status && St.status.lastSync;
  St.status = ch.status.newValue; updateSyncLine();
  if (!St.status.running && St.status.lastSync !== prev) {
    await load();
    if (['overview', 'league', 'team', 'results'].includes(St.tab)) render();
  }
});

// ---------- tabs
$('#tabs').addEventListener('click', e => {
  const b = e.target.closest('button[data-tab]'); if (!b) return;
  document.querySelectorAll('#tabs button').forEach(x => x.classList.toggle('on', x === b));
  St.tab = b.dataset.tab; render();
});
const view = $('#view');
view.addEventListener('change', e => {
  const k = e.target.dataset.ui; if (!k) return;
  St.ui[k] = e.target.type === 'number' ? +e.target.value : e.target.value;
  if (k === 'comp') { St.ui.team = null; St.ui.home = null; St.ui.away = null; St.ui.season = null; }
  saveUI();
  if (St.tab === 'predict' && ['home', 'away', 'mk', 'eng', 'comp'].includes(k)) { renderPredict(true); return; }
  render();
});
view.addEventListener('click', e => {
  const t = e.target.closest('[data-act]'); if (!t) return;
  if (t.tagName === 'A') e.preventDefault();
  const a = t.dataset.act;
  if (a === 'match') showMatch(+t.dataset.id);
  if (a === 'fix') { St.ui.comp = +t.dataset.comp; St.ui.home = +t.dataset.h; St.ui.away = +t.dataset.a; saveUI(); document.querySelector('#tabs [data-tab=predict]').click(); }
  if (a === 'swap') { [St.ui.home, St.ui.away] = [St.ui.away, St.ui.home]; saveUI(); renderPredict(true); }
  if (a === 'bt') runBacktest();
  if (a === 'btLive') runLiveBacktest();
  if (a === 'liveMatch') showLiveMatch(+t.dataset.id);
  if (a === 'openLive') chrome.runtime.sendMessage({ type: 'openLiveTab' }).then(() => { t.textContent = 'Opened ✓ — data arrives in a few seconds'; });
  if (a === 'vt') { St.vt = null; computeValueTracker(true); }
  if (a === 'addfix') addManual();
  if (a === 'delfix') { const c = St.ui.boardComp; St.ui.manual[c].splice(+t.dataset.i, 1); saveUI(); render(); }
  if (a === 'saveSet') saveSet();
  if (a === 'export') exportJSON();
  if (a === 'csv') exportCSV();
  if (a === 'import') $('#impFile').click();
  if (a === 'clear') clearDB();
  if (a === 'deepAll') { t.disabled = true; chrome.runtime.sendMessage({ type: 'syncNow', deepLimit: 400 }).then(() => load()).then(render); }
});
view.addEventListener('input', e => { if (e.target.dataset.odds != null) updateEV(e.target); });

function render() {
  if (!St.comps.length) { view.innerHTML = `<div class="empty"><h2>No data yet</h2><p>The first capture is running in the background. Click <b>Capture now</b> if nothing appears in a minute.</p><p class="mute">If capture keeps failing, open <a href="https://www.zoomscores.ng" target="_blank">zoomscores.ng</a> in a tab — the engine can relay through it.</p></div>`; return; }
  ({ overview: renderOverview, league: renderLeague, team: renderTeam, results: renderResults, predict: renderPredict, board: renderBoard, slip: renderSlipTab, live: renderLive, backtest: renderBacktest, settings: renderSettings })[St.tab]();
}

// ---------- OVERVIEW
function renderOverview() {
  const s = St.status || {};
  const seasons = new Set(St.matches.map(m => m.comp + m.season)).size;
  const cards = St.comps.map(c => {
    const ms = CM(c.id); const up = ZFix.upcoming(ms); const L = (s.leagues || {})[c.id] || {};
    const std = St.standings[c.id];
    const nx = up && up.list[0];
    const top = std ? std.rows.slice(0, 5).map(r => `<tr><td>${r.position}</td><td>${esc(tn(r.competitorId))}</td><td class="n">${r.played}</td><td class="n">${r.goalsFor}:${r.goalsAgainst}</td><td class="n"><b>${r.points}</b></td><td>${formStrip(r.form || [])}</td></tr>`).join('') : '';
    return `<div class="card"><h3>${esc(c.name)} ${L.ok === false ? '<span class="tag" style="background:#4a2426;color:#ffb3b6">error</span>' : L.paused ? '<span class="tag" style="background:#4a3d1f;color:#f5d58a">paused</span>' : ''}<small>${ms.length} matches · ${seasonsOf(c.id).length} season(s)</small></h3>
      ${up ? `<div>Season round <b>${up.last}</b> / ${up.perSeason} finished</div>
      ${nx ? `<div class="mute">Next: round ${nx.round} · ${fmtT(nx.ts)} (${until(nx.ts)}) ${nx.fixtures ? '<span class="tag">fixtures known</span>' : ''}</div>` : '<div class="mute">Season finished – new season starting</div>'}` : '<div class="mute">No results captured yet</div>'}
      ${L.err ? `<div class="${L.paused ? 'warnc' : 'bad'}" style="font-size:13px;margin-top:6px">${esc(L.err)}</div>` : ''}
      ${top ? `<table style="margin-top:10px"><tr><th>#</th><th>Team</th><th class="n">P</th><th class="n">GD</th><th class="n">Pts</th><th>Form</th></tr>${top}</table>` : ''}</div>`;
  }).join('');
  view.innerHTML = `
  <div class="kpis">
    <div class="kpi"><div class="v">${St.matches.length.toLocaleString()}</div><div class="l">Matches captured</div></div>
    <div class="kpi"><div class="v">${St.comps.length}</div><div class="l">Leagues tracked</div></div>
    <div class="kpi"><div class="v">${seasons}</div><div class="l">League-seasons stored</div></div>
    <div class="kpi"><div class="v">${St.deep.size.toLocaleString()}</div><div class="l">Matches with deep stats</div></div>
    <div class="kpi"><div class="v">${ago(s.lastSync)}</div><div class="l">Last capture (${s.took ? (s.took / 1000).toFixed(0) + 's' : '–'}, +${s.added || 0} new)</div></div>
  </div>
  ${s.log && s.log.length ? `<div class="note"><b>Capture warnings</b><br>${s.log.map(esc).join('<br>')}</div>` : ''}
  <div class="grid">${cards}</div>
  <div class="note">Capture runs automatically every ${St.set.syncMin} min while Chrome is open, and the database keeps growing across seasons. The site only exposes the current and previous season, so anything older exists only because this engine saved it.</div>`;
}

// ---------- LEAGUE
function renderLeague() {
  const c = St.ui.comp, ms = scoped(c, St.ui.scope);
  const L = ZStats.league(ms, St.deep);
  let html = `<div class="controls">${compSel('comp', c)}${scopeSel(St.ui.scope)}</div>`;
  if (!L.n) { view.innerHTML = html + '<div class="empty">No matches in this scope yet.</div>'; return; }
  const M = L.markets;
  const mkRows = g => ZMarkets.list.filter(m => m.group === g).map(mk => `<tr><td>${esc(mk.name)}</td><td>${mk.opts.map(o => `<span class="pill">${esc(o.k)} <b>${f1(M[mk.id].pct[o.k])}%</b></span>`).join(' ')}</td></tr>`).join('');
  const maxB = Math.max(...L.goalBuckets, 1), maxC = Math.max(...L.cornerBuckets, 1);
  const tg = Object.entries(L.totalGoals).sort((a, b) => a[0] - b[0]);
  const isSeason = St.ui.scope === 'cur' || St.ui.scope === 'prev';
  const tbl = isSeason ? ZStats.table(ms) : null;
  html += `
  <div class="kpis">
    <div class="kpi"><div class="v">${L.n}</div><div class="l">Matches</div></div>
    <div class="kpi"><div class="v">${f2(L.avgGoals)}</div><div class="l">Goals / match (H ${f2(L.avgHome)} · A ${f2(L.avgAway)})</div></div>
    <div class="kpi"><div class="v">${f2(L.avgHT)}</div><div class="l">1st-half goals (${pc(L.htShare * 100)} of all)</div></div>
    <div class="kpi"><div class="v">${f1(L.avgCorners)}</div><div class="l">Corners / match (H ${f1(L.avgHC)} · A ${f1(L.avgAC)})</div></div>
    <div class="kpi"><div class="v">${L.firstGoalAvg ? f1(L.firstGoalAvg) + "'" : '–'}</div><div class="l">Avg first-goal minute</div></div>
    <div class="kpi"><div class="v">${pc(M['1X2'].pct['1'])}</div><div class="l">Home wins (X ${pc(M['1X2'].pct.X)} · 2 ${pc(M['1X2'].pct['2'])})</div></div>
    <div class="kpi"><div class="v">${pc(M.GG.pct.GG)}</div><div class="l">Both teams scored</div></div>
    <div class="kpi"><div class="v">${pc(M['OU2.5'].pct.Over)}</div><div class="l">Over 2.5 goals</div></div>
  </div>
  <div class="grid">
    <div class="card"><h3>Goal timing <small>all goals</small></h3><div class="hbars">${L.goalBuckets.map((v, i) => `<div class="r"><span>${L.bucketLabels[i]}'</span>${bar(100 * v / maxB)}<span class="n">${v}</span></div>`).join('')}</div></div>
    <div class="card"><h3>Corner timing</h3><div class="hbars">${L.cornerBuckets.map((v, i) => `<div class="r"><span>${L.bucketLabels[i]}'</span>${bar(100 * v / maxC, 'blue')}<span class="n">${v}</span></div>`).join('')}</div></div>
    <div class="card"><h3>Total goals distribution</h3><div class="hbars">${tg.map(([k, v]) => `<div class="r"><span>${k} goals</span>${bar(100 * v / L.n, 'vio')}<span class="n">${pc(100 * v / L.n)}</span></div>`).join('')}</div></div>
    <div class="card"><h3>Most common correct scores</h3><div class="hbars">${L.cs.slice(0, 10).map(([k, v]) => `<div class="r"><span>${k}</span>${bar(v * 4)}<span class="n">${pc(v)}</span></div>`).join('')}</div></div>
    <div class="card"><h3>Top scorers <small>in scope</small></h3><table>${L.scorers.map(s => `<tr><td>${esc(s.name)}</td><td class="mute">${esc(tn(s.team))}</td><td class="n"><b>${s.goals}</b></td></tr>`).join('')}</table></div>
    <div class="card"><h3>Deep match stats <small>${L.deep ? L.deep.n + ' matches' : 'none yet'}</small></h3>${L.deep ? `<table>
      <tr><td>Home possession</td><td class="n">${pc(L.deep.possH)}</td></tr>
      <tr><td>Shots on target (non-goal) H / A</td><td class="n">${f1(L.deep.onH)} / ${f1(L.deep.onA)}</td></tr>
      <tr><td>Shots off target H / A</td><td class="n">${f1(L.deep.offH)} / ${f1(L.deep.offA)}</td></tr>
      <tr><td>Keeper saves H / A</td><td class="n">${f1(L.deep.saveH)} / ${f1(L.deep.saveA)}</td></tr>
      <tr><td>Site's favourite won (1X2)</td><td class="n">${pc(L.deep.wpFavPct)} <span class="mute">of ${L.deep.wpN}</span></td></tr></table>` : '<p class="mute">Deep stats fill in gradually (possession, shots, saves, site win probability).</p>'}
      <p class="mute" style="font-size:13px">Early-payout flags: home ${pc(L.early.home)}, away ${pc(L.early.away)} · golden goals: ${L.goldenGoals}</p></div>
  </div>
  <div class="grid" style="margin-top:16px">
    ${['Main', 'Goals', 'Team goals', 'Combos', 'Half time', 'Corners'].map(g => `<div class="card"><h3>${g} <small>how often each outcome happened</small></h3><table>${mkRows(g)}</table></div>`).join('')}
  </div>
  ${tbl ? `<div class="card" style="margin-top:16px"><h3>League table <small>computed from captured results</small></h3><div class="scroll"><table><tr><th>#</th><th>Team</th><th class="n">P</th><th class="n">W</th><th class="n">D</th><th class="n">L</th><th class="n">GF</th><th class="n">GA</th><th class="n">GD</th><th class="n">Pts</th><th>Last 5</th></tr>
    ${tbl.map((r, i) => `<tr><td>${i + 1}</td><td>${esc(tn(r.id))}</td><td class="n">${r.P}</td><td class="n">${r.W}</td><td class="n">${r.D}</td><td class="n">${r.L}</td><td class="n">${r.GF}</td><td class="n">${r.GA}</td><td class="n">${r.GF - r.GA}</td><td class="n"><b>${r.Pts}</b></td><td>${formStrip(r.form.slice(-5))}</td></tr>`).join('')}</table></div></div>` : ''}`;
  view.innerHTML = html;
}

// ---------- TEAM
function renderTeam() {
  const c = St.ui.comp; const teams = teamsOf(c);
  if (!St.ui.team || !teams.includes(+St.ui.team)) St.ui.team = teams[0];
  const ms = scoped(c, St.ui.scope);
  const T = ZStats.team(+St.ui.team, ms, St.deep);
  let html = `<div class="controls">${compSel('comp', c)}${teamSel('team', c, St.ui.team, 'Team')}${scopeSel(St.ui.scope)}</div>`;
  if (!T.list.length) { view.innerHTML = html + '<div class="empty">No matches for this team in scope.</div>'; return; }
  const recRow = (l, r) => `<tr><td><b>${l}</b></td><td class="n">${r.P}</td><td class="n">${r.W}</td><td class="n">${r.D}</td><td class="n">${r.L}</td><td class="n">${r.GF}:${r.GA}</td><td class="n">${f2(r.GF / (r.P || 1))}</td><td class="n">${f2(r.GA / (r.P || 1))}</td><td class="n">${pc(100 * r.W / (r.P || 1))}</td><td class="n">${pc(100 * r.GG / (r.P || 1))}</td><td class="n">${pc(100 * r.O15 / (r.P || 1))}</td><td class="n">${pc(100 * r.O25 / (r.P || 1))}</td><td class="n">${pc(100 * r.O35 / (r.P || 1))}</td><td class="n">${pc(100 * r.CS / (r.P || 1))}</td><td class="n">${pc(100 * r.FTS / (r.P || 1))}</td><td class="n">${f1(r.CF / (r.P || 1))}:${f1(r.CA / (r.P || 1))}</td><td class="n">${r.HTW}-${r.HTD}-${r.HTL}</td></tr>`;
  const mx = Math.max(...T.gfB, ...T.gaB, 1);
  html += `
  <div class="kpis">
    <div class="kpi"><div class="v">${esc(tn(+St.ui.team))}</div><div class="l">${esc(cname(c))}</div></div>
    <div class="kpi"><div class="v">${formStrip(T.list.slice(-6).map(p => p.res))}</div><div class="l">Last 6 (newest right)</div></div>
    <div class="kpi"><div class="v">${T.all.Pts}</div><div class="l">Points in scope (${f2(T.all.Pts / T.all.P)}/game)</div></div>
    <div class="kpi"><div class="v">${T.deep ? pc(T.deep.poss) : '–'}</div><div class="l">Avg possession${T.deep ? ` · shots on ${f1(T.deep.on)}` : ''}</div></div>
  </div>
  <div class="card"><h3>Record</h3><div class="scroll"><table><tr><th></th><th class="n">P</th><th class="n">W</th><th class="n">D</th><th class="n">L</th><th class="n">Goals</th><th class="n">GF/g</th><th class="n">GA/g</th><th class="n">Win%</th><th class="n">GG%</th><th class="n">O1.5</th><th class="n">O2.5</th><th class="n">O3.5</th><th class="n">CS%</th><th class="n">FTS%</th><th class="n">Corners f:a</th><th class="n">HT W-D-L</th></tr>
  ${recRow('Overall', T.all)}${recRow('Home', T.home)}${recRow('Away', T.away)}</table></div></div>
  <div class="grid" style="margin-top:16px">
    <div class="card"><h3>Current streaks</h3><table>${Object.entries(T.streaks).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<tr><td>${k}</td><td class="n"><b>${v}</b> in a row</td></tr>`).join('')}</table></div>
    <div class="card"><h3>Goal timing <small>scored (green) / conceded (red)</small></h3><div class="hbars">${T.gfB.map((v, i) => `<div class="r"><span>${ZStats.BKL[i]}'</span><div>${bar(100 * v / mx)}<div class="bar" style="margin-top:3px"><span style="width:${100 * T.gaB[i] / mx}%;background:var(--bad)"></span></div></div><span class="n">${v} / ${T.gaB[i]}</span></div>`).join('')}</div></div>
    <div class="card"><h3>Top scorers</h3><table>${T.scorers.map(([n, g]) => `<tr><td>${esc(n)}</td><td class="n"><b>${g}</b></td></tr>`).join('') || '<tr><td class="mute">No scorer data</td></tr>'}</table></div>
  </div>
  <div class="card" style="margin-top:16px"><h3>Matches <small>click for details</small></h3><div class="scroll"><table><tr><th>When</th><th>Rnd</th><th>Venue</th><th>Opponent</th><th class="n">Score</th><th class="n">HT</th><th class="n">Corners</th><th>Res</th></tr>
  ${T.list.slice().reverse().map(p => `<tr class="click" data-act="match" data-id="${p.m.matchId}"><td>${fmtT(p.m.ts)}</td><td>${p.m.round}</td><td>${p.home ? 'H' : 'A'}</td><td>${esc(tn(p.opp))}</td><td class="n"><b>${p.gf}-${p.ga}</b></td><td class="n">${p.htgf}-${p.htga}</td><td class="n">${p.cf ?? '–'}-${p.ca ?? '–'}</td><td>${formStrip([p.res])}</td></tr>`).join('')}</table></div></div>`;
  view.innerHTML = html;
}

// ---------- RESULTS
function renderResults() {
  const c = St.ui.comp; const ss = seasonsOf(c);
  if (!St.ui.season || !ss.includes(St.ui.season)) St.ui.season = ss[0];
  const ms = CM(c).filter(m => m.season === St.ui.season);
  const rounds = {}; ms.forEach(m => (rounds[m.round] = rounds[m.round] || []).push(m));
  const ids = Object.keys(rounds).map(Number).sort((a, b) => b - a);
  view.innerHTML = `<div class="controls">${compSel('comp', c)}<label>Season (started)<select data-ui="season">${ss.map(s => `<option ${s === St.ui.season ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select></label></div>
  <div class="grid">${ids.map(r => `<div class="card"><h3>Round ${r} <small>${fmtT(rounds[r][0].ts)}</small></h3><table>${rounds[r].map(m => `<tr class="click" data-act="match" data-id="${m.matchId}"><td>${esc(tn(m.home))}</td><td class="n"><b>${m.hg} - ${m.ag}</b><div class="mute" style="font-size:12px">HT ${m.hth}-${m.hta} · C ${m.hc}-${m.ac}</div></td><td>${esc(tn(m.away))}</td></tr>`).join('')}</table></div>`).join('') || '<div class="empty">No rounds</div>'}</div>`;
}

// ---------- MATCH MODAL
function showMatch(id) {
  if (typeof liveModalId !== 'undefined') liveModalId = null;
  const m = St.matches.find(x => x.matchId === id); if (!m) return;
  const d = St.deep.get(id);
  const ev = [];
  (m.hGoals || []).forEach(x => ev.push([x, 'H', '⚽'])); (m.aGoals || []).forEach(x => ev.push([x, 'A', '⚽']));
  (m.hcMin || []).forEach(x => ev.push([x, 'H', '⛳'])); (m.acMin || []).forEach(x => ev.push([x, 'A', '⛳']));
  ev.sort((a, b) => a[0] - b[0]);
  const scorer = (list, min) => { const s = (list || []).find(s => s.mins.includes(min)); return s ? s.name : ''; };
  $('#modalBody').innerHTML = `
    <div class="mute">${esc(cname(m.comp))} · season ${esc(m.season)} · round ${m.round} · ${fmtT(m.ts)} · match #${m.matchId}</div>
    <div class="split" style="align-items:center;margin:14px 0"><div class="team-h" style="text-align:right">${esc(tn(m.home))}</div><div class="team-h">${esc(tn(m.away))}</div></div>
    <div class="score">${m.hg} - ${m.ag}</div><div class="mute" style="text-align:center">HT ${m.hth}-${m.hta} · Corners ${m.hc}-${m.ac} (HT ${m.hthc}-${m.htac})</div>
    <div class="split" style="margin-top:16px">
      <div class="card"><h3>Timeline</h3><table>${ev.map(([mn, s, ic]) => `<tr><td class="n">${mn}'</td><td>${s === 'H' ? ic + ' ' + esc(ic === '⚽' ? scorer(m.scH, mn) : 'corner') : ''}</td><td>${s === 'A' ? ic + ' ' + esc(ic === '⚽' ? scorer(m.scA, mn) : 'corner') : ''}</td></tr>`).join('') || '<tr><td class="mute">No events</td></tr>'}</table></div>
      <div class="card"><h3>Deep stats</h3><div id="deepBox">${deepHTML(d)}</div></div>
    </div>`;
  $('#modal').classList.remove('hidden');
  if (!d || !d.ok) {
    $('#deepBox').insertAdjacentHTML('beforeend', '<p class="mute">Fetching…</p>');
    chrome.runtime.sendMessage({ type: 'deepOne', matchId: id }).then(r => { if (r && r.ok) { St.deep.set(id, r.rec); $('#deepBox').innerHTML = deepHTML(r.rec); } else $('#deepBox').innerHTML = `<p class="bad">${esc(r ? r.err : 'failed')}</p>`; });
  }
}
function deepHTML(d) {
  if (!d || !d.ok) return '<p class="mute">Not captured yet.</p>';
  return `<table>
    <tr><th></th><th class="n">Home</th><th class="n">Away</th></tr>
    <tr><td>Possession</td><td class="n">${pc(d.possH)}</td><td class="n">${pc(d.possA)}</td></tr>
    <tr><td>Possession at HT</td><td class="n">${pc(d.htPossH)}</td><td class="n">${pc(d.htPossA)}</td></tr>
    <tr><td>Shots on target (non-goal)</td><td class="n">${d.onH}</td><td class="n">${d.onA}</td></tr>
    <tr><td>Shots off target</td><td class="n">${d.offH}</td><td class="n">${d.offA}</td></tr>
    <tr><td>Keeper saves</td><td class="n">${d.saveH}</td><td class="n">${d.saveA}</td></tr>
    ${d.wp ? `<tr><td>Site win probability</td><td class="n">${pp(d.wp.home)}</td><td class="n">${pp(d.wp.away)}</td></tr><tr><td>Site draw probability</td><td class="n" colspan="2">${pp(d.wp.draw)}</td></tr>` : ''}
  </table>`;
}
$('#modalX').addEventListener('click', () => $('#modal').classList.add('hidden'));
$('#modal').addEventListener('click', e => { if (e.target.id === 'modal') $('#modal').classList.add('hidden'); });

// ---------- PREDICTOR
function knownFixtureOptions(c) {
  const up = ZFix.upcoming(CM(c));
  if (!up) return '';
  let rows = up.list.filter(r => r.fixtures && r.ts > Date.now() - 60e3).slice(0, 2);
  if (!rows.length) rows = up.list.filter(r => r.fixtures).slice(0, 2);
  if (!rows.length) return '';
  return `<div class="card" style="margin-bottom:16px"><h3>Upcoming fixtures <small>known from the season mirror – click to predict</small></h3>${rows.map(r => `<div style="margin:6px 0"><b>Round ${r.round}</b> <span class="mute">${fmtT(r.ts)} (${until(r.ts)})</span><br>${r.fixtures.map(f => `<button class="btn ghost small" style="margin:3px" data-act="fix" data-comp="${c}" data-h="${f.home}" data-a="${f.away}">${esc(tshort(f.home))} v ${esc(tshort(f.away))}</button>`).join('')}</div>`).join('')}</div>`;
}
function renderPredict(keepScroll) {
  const c = St.ui.comp; const teams = teamsOf(c);
  if (!St.ui.home || !teams.includes(+St.ui.home)) St.ui.home = teams[0];
  if (!St.ui.away || !teams.includes(+St.ui.away) || +St.ui.away === +St.ui.home) St.ui.away = teams.find(t => t !== +St.ui.home);
  const y = window.scrollY;
  const hist = CM(c);
  let html = `<div class="controls">${compSel('comp', c)}${teamSel('home', c, St.ui.home, 'Home team')}<button class="btn ghost" data-act="swap" title="Swap">⇄</button>${teamSel('away', c, St.ui.away, 'Away team')}${mkSel('mk', St.ui.mk, true)}${engSel('eng', St.ui.eng)}</div>`;
  html += knownFixtureOptions(c);
  if (hist.length < 60) { view.innerHTML = html + '<div class="empty">Need at least 60 captured matches in this league to predict.</div>'; return; }
  const h = +St.ui.home, a = +St.ui.away, o = modelOpts();
  const P = ZModel.predict(hist, h, a, o);
  St.predOut = P;
  const eng = St.ui.eng;
  const ctx = P.ctx;
  // top correct scores
  const scores = []; for (let i = 0; i <= 6; i++) for (let j = 0; j <= 6; j++) scores.push([i + '-' + j, ctx.mat[i][j]]);
  scores.sort((x, y) => y[1] - x[1]);
  const h2h = hist.filter(m => (m.home === h && m.away === a) || (m.home === a && m.away === h)).slice(-8).reverse();
  const hf = hist.filter(m => m.home === h).slice(-8).map(m => ZStats.persp(m, h).res);
  const af = hist.filter(m => m.away === a).slice(-8).map(m => ZStats.persp(m, a).res);
  const engName = { blend: 'Blend', poisson: 'Poisson', form: 'Form', base: 'Base' }[eng];

  const mkTable = mk => {
    const R = P.markets[mk.id];
    const pr = R[eng]; const pk = ZModel.pick(pr);
    return `<div class="pickbox" style="margin-bottom:14px"><div class="mute">${esc(mk.name)} · ${engName} engine pick</div><div class="prob-big">${esc(pk.k)} <span class="good">${pp(pk.p)}</span></div><div class="mute">Fair odds ${odds(pk.p)} — only worth betting if the bookmaker pays more than this</div></div>
    <table><tr><th>Option</th><th class="n">Blend</th><th class="n">Poisson</th><th class="n">Form</th><th class="n">League base</th><th class="n">Fair odds (${engName})</th><th>Bookie odds</th><th class="n">Edge (EV)</th></tr>
    ${mk.opts.map(op => `<tr><td><b>${esc(op.k)}</b>${op.k === pk.k ? ' <span class="pill pick">pick</span>' : ''}</td><td class="n">${pp(R.blend[op.k])}</td><td class="n">${pp(R.poisson[op.k])}</td><td class="n">${pp(R.form[op.k])}</td><td class="n mute">${pp(R.base[op.k])}</td><td class="n">${odds(pr[op.k])}</td><td><input type="number" step="0.01" min="1" style="width:90px;min-width:0" data-odds="${pr[op.k]}" placeholder="e.g. 1.85"></td><td class="n" data-ev>–</td></tr>`).join('')}</table>`;
  };

  let main;
  if (St.ui.mk === 'ALL') {
    main = `<div class="card"><h3>All markets <small>${engName} engine · sorted by confidence</small></h3><div class="scroll" style="max-height:none"><table><tr><th>Market</th><th>Pick</th><th class="n">Prob</th><th class="n">Fair odds</th><th>2nd</th><th class="n">League base for pick</th></tr>
    ${ZMarkets.list.map(mk => { const pr = P.markets[mk.id][eng]; const s = Object.entries(pr).sort((x, y) => y[1] - x[1]); return { mk, s, base: P.markets[mk.id].base }; }).sort((x, y) => y.s[0][1] - x.s[0][1]).map(({ mk, s, base }) => `<tr><td>${esc(mk.name)}</td><td><span class="pill pick">${esc(s[0][0])}</span></td><td class="n"><b>${pp(s[0][1])}</b></td><td class="n">${odds(s[0][1])}</td><td class="mute">${esc(s[1][0])} ${pp(s[1][1])}</td><td class="n mute">${pp(base[s[0][0]])}</td></tr>`).join('')}</table></div></div>`;
  } else {
    main = `<div class="card">${mkTable(ZMarkets.byId[St.ui.mk])}</div>`;
  }
  html += `
  <div class="split" style="margin-bottom:16px">
    <div class="card"><div class="team-h">${esc(tn(h))} <span class="mute">vs</span> ${esc(tn(a))}</div>
      <table style="margin-top:10px">
        <tr><td>Expected goals</td><td class="n"><b>${f2(ctx.lh)}</b> – <b>${f2(ctx.la)}</b></td></tr>
        <tr><td>Expected corners</td><td class="n">${f1(ctx.ch)} – ${f1(ctx.ca)}</td></tr>
        <tr><td>${esc(tn(h))} home form (last 8 home)</td><td class="n">${formStrip(hf)}</td></tr>
        <tr><td>${esc(tn(a))} away form (last 8 away)</td><td class="n">${formStrip(af)}</td></tr>
        <tr><td>Model fitted on</td><td class="n mute">${P.S.n} matches · ρ ${P.S.rho} · HT share ${pc(P.S.shareH * 100)}</td></tr>
      </table></div>
    <div class="card"><h3>Most likely scores <small>Poisson</small></h3><div class="hbars">${scores.slice(0, 8).map(([k, v]) => `<div class="r"><span>${k}</span>${bar(v * 600)}<span class="n">${pp(v)}</span></div>`).join('')}</div></div>
  </div>
  ${main}
  <div class="card" style="margin-top:16px"><h3>Head to head <small>last ${h2h.length} captured</small></h3><table>${h2h.map(m => `<tr class="click" data-act="match" data-id="${m.matchId}"><td>${fmtT(m.ts)}</td><td>${esc(tn(m.home))}</td><td class="n"><b>${m.hg}-${m.ag}</b></td><td>${esc(tn(m.away))}</td><td class="mute">HT ${m.hth}-${m.hta} · C ${m.hc}-${m.ac}</td></tr>`).join('') || '<tr><td class="mute">No meetings captured yet</td></tr>'}</table></div>
  <div class="note">Zoom results are simulated. In testing on real captured data, team strength carries a genuine signal for 1X2, half-time and corner-winner markets, while totals and GG/NG sit close to coin-flip. Check the Backtest tab before trusting any market, and only bet where the bookmaker's odds beat the fair odds — the bookmaker builds its margin into every price.</div>`;
  view.innerHTML = html;
  if (keepScroll) window.scrollTo(0, y);
}
function updateEV(inp) {
  const p = +inp.dataset.odds, o = +inp.value;
  const cell = inp.closest('tr').querySelector('[data-ev]');
  if (!o || o <= 1) { cell.textContent = '–'; cell.className = 'n'; return; }
  const ev = p * o - 1;
  cell.textContent = (ev * 100).toFixed(1) + '%';
  cell.className = 'n ' + (ev > 0 ? 'good' : 'bad');
}

// ---------- ROUND BOARD
function addManual() {
  const c = St.ui.boardComp; const h = +$('#mfH').value, a = +$('#mfA').value;
  if (!h || !a || h === a) return;
  (St.ui.manual[c] = St.ui.manual[c] || []).push({ home: h, away: a }); saveUI(); render();
}
function renderBoard() {
  if (!St.ui.boardComp) St.ui.boardComp = 'all';
  const bc = St.ui.boardComp, mk = ZMarkets.byId[St.ui.mk] || ZMarkets.byId['1X2'], eng = St.ui.eng, o = modelOpts();
  const comps = bc === 'all' ? St.comps.map(c => c.id).filter(id => CM(id).length >= 60) : [+bc];
  const rows = [];
  for (const c of comps) {
    const hist = CM(c); if (hist.length < 60) continue;
    const up = ZFix.upcoming(hist);
    let fx = [], label = '';
    const next = up && (up.list.find(r => r.fixtures && r.ts > Date.now() - 60e3) || up.list.find(r => r.fixtures));
    if (next) { fx = next.fixtures; label = `R${next.round} · ${fmtT(next.ts)}`; }
    const manual = St.ui.manual[c] || [];
    if (bc !== 'all' && manual.length) { fx = fx.concat(manual); }
    if (!fx.length) continue;
    const refTs = hist[hist.length - 1].ts + 1;
    const S = ZModel.prepare(hist, refTs, o), B = ZModel.leagueBase(hist);
    for (const f of fx) {
      const P = ZModel.predict(hist, f.home, f.away, o, refTs, S, B);
      const pr = P.markets[mk.id][eng];
      const s = Object.entries(pr).sort((x, y) => y[1] - x[1]);
      rows.push({ c, f, label: f.mirrorOf ? label : 'manual', pick: s[0], second: s[1], base: P.markets[mk.id].base[s[0][0]], xg: [P.ctx.lh, P.ctx.la] });
    }
  }
  rows.sort((x, y) => y.pick[1] - x.pick[1]);
  const shown = rows.filter(r => r.pick[1] * 100 >= (+St.ui.minP || 0));
  const manualUI = bc !== 'all' ? (() => { const teams = teamsOf(bc); const opts = teams.map(t => `<option value="${t}">${esc(tn(t))}</option>`).join(''); const list = (St.ui.manual[bc] || []).map((f, i) => `<span class="pill">${esc(tshort(f.home))} v ${esc(tshort(f.away))} <a href="#" data-act="delfix" data-i="${i}" style="color:var(--bad)">✕</a></span>`).join(' '); return `<div class="card" style="margin-bottom:16px"><h3>Add fixtures manually <small>for rounds whose fixtures aren't known in advance (first half of a season)</small></h3><div class="controls" style="margin:0"><label>Home<select id="mfH">${opts}</select></label><label>Away<select id="mfA">${opts}</select></label><button class="btn" data-act="addfix">Add</button></div><div style="margin-top:8px">${list}</div></div>`; })() : '';
  view.innerHTML = `<div class="controls">${compSel('boardComp', bc, true)}${mkSel('mk', mk.id)}${engSel('eng', eng)}<label>Min probability %<input type="number" data-ui="minP" value="${St.ui.minP || 0}" min="0" max="100" style="width:110px;min-width:0"></label></div>
  ${manualUI}
  <div class="card"><h3>${esc(mk.name)} — next known round${bc === 'all' ? ' in every league' : ''} <small>${shown.length} of ${rows.length} fixtures, sorted by confidence</small></h3>
  ${rows.length ? `<div class="scroll" style="max-height:none"><table><tr><th>League</th><th>Round</th><th>Fixture</th><th class="n">xG</th><th>Pick</th><th class="n">Prob</th><th class="n">Fair odds</th><th>2nd option</th><th class="n">League base</th><th></th></tr>
  ${shown.map(r => `<tr><td>${esc(cname(r.c))}</td><td class="mute">${esc(r.label)}</td><td><b>${esc(tn(r.f.home))}</b> v <b>${esc(tn(r.f.away))}</b></td><td class="n mute">${f2(r.xg[0])}-${f2(r.xg[1])}</td><td><span class="pill pick">${esc(r.pick[0])}</span></td><td class="n"><b class="${r.pick[1] >= St.set.conf ? 'good' : ''}">${pp(r.pick[1])}</b></td><td class="n">${odds(r.pick[1])}</td><td class="mute">${esc(r.second[0])} ${pp(r.second[1])}</td><td class="n mute">${pp(r.base)}</td><td><button class="btn ghost small" data-act="fix" data-comp="${r.c}" data-h="${r.f.home}" data-a="${r.f.away}">Detail</button></td></tr>`).join('')}</table></div>` : `<div class="empty">No upcoming fixtures are known yet. Fixtures become known once a league passes its halfway round (round ${'>'} 19), or add them manually by choosing a single league above.</div>`}</div>`;
}

// ---------- BACKTEST
function renderBacktest() {
  const opts = `<div class="controls">${compSel('btComp', St.ui.btComp, true)}<label>Evaluate last N rounds<input type="number" data-ui="btRounds" value="${St.ui.btRounds}" min="10" max="2000" style="width:120px;min-width:0"></label>${mkSel('btMk', St.ui.btMk)}${engSel('btEng', St.ui.btEng)}<button class="btn" data-act="bt">▶ Run backtest</button><button class="btn ghost" data-act="btLive">▶ Run in-play backtest</button></div>
  <div class="note">Walk-forward test: every match is predicted using <b>only</b> matches played before it, exactly as you would have seen it live. "Base" = always backing the league's most common outcome. A market only has a real edge if an engine beats Base on log-loss — accuracy alone can mislead.</div>
  <div id="btProg" class="progress" style="display:none"><span></span></div><div id="btOut"></div>`;
  view.innerHTML = opts + '<div id="btLiveOut"></div>';
  if (St.btResult) drawBacktest(St.btResult);
  if (St.btLive) drawLiveBacktest(St.btLive);
}
async function runBacktest() {
  const o = modelOpts();
  const comps = St.ui.btComp === 'all' ? St.comps.map(c => c.id).filter(id => CM(id).length >= 80) : [+St.ui.btComp];
  $('#btProg').style.display = 'block';
  const agg = {}; const cal = {}; let evaluated = 0;
  for (let ci = 0; ci < comps.length; ci++) {
    const r = await ZModel.backtest(CM(comps[ci]), o, { lastRounds: +St.ui.btRounds, deepMap: St.deep, onProgress: p => { $('#btProg span').style.width = (100 * (ci + p) / comps.length) + '%'; } });
    evaluated += r.evaluated;
    for (const mk in r.res) for (const e in r.res[mk]) { const A = ((agg[mk] = agg[mk] || {})[e] = (agg[mk] || {})[e] || { n: 0, hit: 0, ll: 0, brier: 0, hcN: 0, hcHit: 0 }); const s = r.res[mk][e]; for (const k in A) A[k] += s[k]; }
    for (const mk in r.calib) for (const e in r.calib[mk]) { const A = ((cal[mk] = cal[mk] || {})[e] = (cal[mk] || {})[e] || Array.from({ length: 10 }, () => [0, 0, 0])); r.calib[mk][e].forEach((b, i) => { A[i][0] += b[0]; A[i][1] += b[1]; A[i][2] += b[2]; }); }
  }
  $('#btProg span').style.width = '100%';
  St.btResult = { agg, cal, evaluated, comps: comps.length, at: Date.now() };
  drawBacktest(St.btResult);
}
function drawBacktest(R) {
  const out = $('#btOut'); if (!out) return;
  if (!R.evaluated) { out.innerHTML = '<div class="empty">Not enough history to evaluate yet (needs 60+ matches before the test window).</div>'; return; }
  const E = ['base', 'poisson', 'form', 'blend', 'zoom'];
  const acc = (s, e) => (s && s.n ? pc(100 * s.hit / s.n) + (e === 'zoom' ? ` <span class="mute">(${s.n})</span>` : '') : '–');
  const rows = ZMarkets.list.filter(mk => R.agg[mk.id]).map(mk => {
    const A = R.agg[mk.id];
    const metric = e => A[e] && A[e].n ? (mk.exclusive ? A[e].ll / A[e].n : A[e].brier / A[e].n) : Infinity;
    const best = ['poisson', 'form', 'blend'].reduce((b, e) => metric(e) < metric(b) ? e : b, 'poisson');
    const gain = (metric('base') - metric(best)) / metric('base') * 100;
    const hc = A[best];
    return `<tr><td>${esc(mk.name)}</td><td class="n">${A.base.n}</td>${E.map(e => `<td class="n ${e === best ? 'lean' : ''}">${acc(A[e], e)}</td>`).join('')}<td>${best}</td><td class="n ${gain > 0.5 ? 'good' : gain < -0.5 ? 'bad' : 'mute'}">${gain > 0 ? '+' : ''}${gain.toFixed(1)}%</td><td class="n">${hc.hcN ? `${hc.hcN} · <b>${pc(100 * hc.hcHit / hc.hcN)}</b>` : '–'}</td></tr>`;
  }).join('');
  const C = (R.cal[St.ui.btMk] || {})[St.ui.btEng];
  const calib = C ? `<div class="calib">${C.map(b => { const pred = b[2] ? b[0] / b[2] : 0, obs = b[2] ? b[1] / b[2] : 0; return `<div title="${b[2]} predictions"><span style="height:${pred * 100}%;background:#3b4a63"></span><span style="height:${obs * 100}%;background:var(--acc)"></span></div>`; }).join('')}</div><div class="mute" style="font-size:13px;margin-top:6px">Each pair = a 10% probability bucket (0–10% … 90–100%). Grey = what the engine predicted, green = what actually happened. Bars of equal height = well-calibrated probabilities.</div>` : '<p class="mute">No calibration data for this market/engine.</p>';
  out.innerHTML = `<div class="kpis"><div class="kpi"><div class="v">${R.evaluated.toLocaleString()}</div><div class="l">Matches evaluated (${R.comps} league${R.comps > 1 ? 's' : ''})</div></div></div>
  <div class="card"><h3>Pick accuracy by engine <small>bold = best-calibrated engine for that market</small></h3><div class="scroll" style="max-height:none"><table><tr><th>Market</th><th class="n">N</th><th class="n">Base</th><th class="n">Poisson</th><th class="n">Form</th><th class="n">Blend</th><th class="n">Site WP</th><th>Best engine</th><th class="n">Skill vs base</th><th class="n">Picks ≥${Math.round(St.set.conf * 100)}% (n · hit)</th></tr>${rows}</table></div>
  <p class="mute" style="font-size:13px">Skill vs base = % improvement in log-loss (exclusive markets) or Brier score (overlapping markets) over the league base rate. Near 0% or negative = no real predictive edge in that market.</p></div>
  <div class="card" style="margin-top:16px"><h3>Calibration — ${esc(ZMarkets.byId[St.ui.btMk].name)} · ${St.ui.btEng}</h3>${calib}</div>`;
}

// ---------- SETTINGS
function renderSettings() {
  const s = St.set;
  const f = (k, l, step = 1, help = '') => `<label>${l}<input type="number" step="${step}" id="set_${k}" value="${s[k]}" style="width:140px;min-width:0">${help ? `<span class="mute" style="font-size:12px">${help}</span>` : ''}</label>`;
  view.innerHTML = `
  <div class="card"><h3>Capture</h3><div class="controls">
    <label>Client ID<input type="text" id="set_clientId" value="${esc(s.clientId)}" style="width:100px;min-width:0"></label>
    ${f('syncMin', 'Capture every (min)', 1)}
    <label>Deep stats<select id="set_deep"><option value="1" ${s.deep ? 'selected' : ''}>On</option><option value="0" ${!s.deep ? 'selected' : ''}>Off</option></select></label>
    ${f('deepPerRun', 'Deep stats per run', 1)}
    <label>Live feed tab<select id="set_liveTab"><option value="1" ${s.liveTab ? 'selected' : ''}>Keep it open (pinned)</option><option value="0" ${!s.liveTab ? 'selected' : ''}>Don't open automatically</option></select></label>
    ${f('valueEdge', 'Live value edge (0.05 = 5%)', 0.01)}
    <label>Live model<select id="set_liveMode"><option value="anchored" ${s.liveMode !== 'engine' ? 'selected' : ''}>Site-anchored (recommended)</option><option value="engine" ${s.liveMode === 'engine' ? 'selected' : ''}>Engine ratings only</option></select></label>
    ${f('anchorW', 'Anchor weight (0–1)', 0.05)}
  </div>
  <div style="margin-top:8px">${St.comps.map(c => `<label style="display:inline-flex;flex-direction:row;gap:6px;margin-right:14px;color:var(--text)"><input type="checkbox" class="compChk" value="${c.id}" ${(s.disabledComps || []).includes(c.id) ? '' : 'checked'}> ${esc(c.name)}</label>`).join('')}</div></div>
  <div class="card" style="margin-top:16px"><h3>Prediction model</h3><div class="controls">
    ${f('halfLifeH', 'Memory half-life (hours)', 12, 'default 336')}
    ${f('prior', 'Strength shrinkage', 0.5, 'default 8')}
    ${f('totShrink', 'Totals shrink (0–1)', 0.05, 'default 0.3')}
    ${f('maxHist', 'Max history / league', 100)}
    ${f('formN', 'Form window (games)', 1)}
    ${f('alpha', 'Form prior weight', 0.5)}
    ${f('blendW', 'Blend weight on Poisson', 0.05)}
    ${f('conf', 'High-confidence threshold', 0.01)}
  </div><p class="mute" style="font-size:13px">Defaults were tuned by walk-forward backtest on real captured Zoom data. Re-run the Backtest tab after changing anything.</p>
  <button class="btn" data-act="saveSet">Save settings</button> <span id="setMsg" class="good"></span></div>
  <div class="card" style="margin-top:16px"><h3>Data</h3>
    <button class="btn ghost" data-act="deepAll">Fetch 400 deep stats now</button>
    <button class="btn ghost" data-act="csv">Export matches CSV</button>
    <button class="btn ghost" data-act="export">Export full backup (JSON)</button>
    <button class="btn ghost" data-act="import">Import backup</button><input type="file" id="impFile" accept=".json" style="display:none">
    <button class="btn danger" data-act="clear">Clear database</button>
    <p class="mute" style="font-size:13px">${St.matches.length.toLocaleString()} matches · ${St.deep.size.toLocaleString()} deep records stored locally in this browser.</p></div>`;
  $('#impFile').addEventListener('change', importJSON);
}
async function saveSet() {
  const num = k => +$('#set_' + k).value;
  const patch = { clientId: $('#set_clientId').value.trim() || '202', syncMin: Math.max(1, num('syncMin')), deep: $('#set_deep').value === '1', deepPerRun: num('deepPerRun'), liveTab: $('#set_liveTab').value === '1', valueEdge: num('valueEdge'), liveMode: $('#set_liveMode').value, anchorW: Math.min(1, Math.max(0, num('anchorW'))), halfLifeH: num('halfLifeH'), prior: num('prior'), totShrink: Math.min(1, Math.max(0, num('totShrink'))), maxHist: num('maxHist'), formN: num('formN'), alpha: num('alpha'), blendW: Math.min(1, Math.max(0, num('blendW'))), conf: num('conf'), disabledComps: [...document.querySelectorAll('.compChk')].filter(x => !x.checked).map(x => +x.value) };
  St.set = await saveSettings(patch);
  await chrome.runtime.sendMessage({ type: 'resetAlarm' });
  St.btResult = null;
  $('#setMsg').textContent = 'Saved ✓';
}
function download(name, text, type) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); }
async function exportJSON() {
  const data = { v: 1, at: Date.now(), matches: await ZDB.getAll('matches'), deep: await ZDB.getAll('deep'), standings: await ZDB.getAll('standings'), meta: await ZDB.getAll('meta'), live: await ZDB.getAll('live') };
  download(`zoom-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(data), 'application/json');
}
function exportCSV() {
  const H = ['matchId', 'league', 'season', 'round', 'time', 'home', 'away', 'hg', 'ag', 'hth', 'hta', 'hc', 'ac', 'hthc', 'htac', 'homeGoalMins', 'awayGoalMins', 'homeCornerMins', 'awayCornerMins', 'homeScorers', 'awayScorers', 'possH', 'onH', 'onA', 'offH', 'offA', 'saveH', 'saveA', 'wpHome', 'wpDraw', 'wpAway'];
  const q = v => { const s = String(v ?? ''); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const lines = [H.join(',')].concat(St.matches.map(m => { const d = St.deep.get(m.matchId) || {}; return [m.matchId, cname(m.comp), m.season, m.round, m.time, tn(m.home), tn(m.away), m.hg, m.ag, m.hth, m.hta, m.hc, m.ac, m.hthc, m.htac, (m.hGoals || []).join(' '), (m.aGoals || []).join(' '), (m.hcMin || []).join(' '), (m.acMin || []).join(' '), (m.scH || []).map(s => s.name + ' ' + s.mins.join('/')).join('; '), (m.scA || []).map(s => s.name + ' ' + s.mins.join('/')).join('; '), d.possH, d.onH, d.onA, d.offH, d.offA, d.saveH, d.saveA, d.wp && d.wp.home, d.wp && d.wp.draw, d.wp && d.wp.away].map(q).join(','); }));
  download(`zoom-matches-${new Date().toISOString().slice(0, 10)}.csv`, lines.join('\n'), 'text/csv');
}
async function importJSON(e) {
  const file = e.target.files[0]; if (!file) return;
  try {
    const d = JSON.parse(await file.text());
    await ZDB.putMany('matches', d.matches || []); await ZDB.putMany('deep', d.deep || []); await ZDB.putMany('standings', d.standings || []); await ZDB.putMany('meta', d.meta || []); await ZDB.putMany('live', d.live || []);
    await load(); render(); alert(`Imported ${(d.matches || []).length} matches.`);
  } catch (err) { alert('Import failed: ' + err.message); }
}
async function clearDB() {
  if (!confirm('Delete ALL captured matches and stats from this browser? Export a backup first if you want to keep them.')) return;
  for (const s of ['matches', 'deep', 'standings', 'meta', 'live']) await ZDB.clear(s);
  await load(); render();
}

// ---------- boot
(async () => {
  await load();
  try { St.live = (await chrome.storage.session.get('live')).live || null; } catch (e) { St.live = null; }
  render();
  setInterval(() => { if (St.tab === 'overview') updateSyncLine(); if (St.tab === 'live') liveTick(); }, 5000);
})();
