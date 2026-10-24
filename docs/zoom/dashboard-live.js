/* Live in-play tab, live match detail, value tracker and in-play backtest */
const LIVE_MK = [
  ['L1X2', 'Final result 1X2'], ['LDC', 'Double chance'], ['LNG', 'Next goal'], ['LROU0.5', 'Another goal (rest of match)'],
  ['LROU1.5', '2+ more goals'], ['LOU+0.5', 'Final O/U (current goals +0.5)'], ['LOU+1.5', 'Final O/U (current +1.5)'], ['LOU+2.5', 'Final O/U (current +2.5)'],
  ['LGG', 'Both teams to score'], ['LHOU', 'Home team another goal'], ['LAOU', 'Away team another goal'], ['LHT', 'Half-time result (1st half)'],
  ['LHTOU', 'Another 1st-half goal'], ['LCS', 'Final correct score'], ['LCOU', 'Total corners O/U (middle line)'], ['LNC', 'Next corner'], ['LC1X2', 'Most corners']
];
St.preCache = {};
let liveRenderTimer = null, liveModalId = null;

chrome.storage.onChanged.addListener((ch, area) => {
  if (area !== 'session' || !ch.live) return;
  St.live = ch.live.newValue;
  if (St.tab === 'live' && !liveRenderTimer) liveRenderTimer = setTimeout(() => { liveRenderTimer = null; renderLive(true); }, 1000);
  if (liveModalId) showLiveMatch(liveModalId, true);
});
function liveTick() { if (St.live && !liveRenderTimer) renderLive(true); }

// pre-match model state per league (cached until the data reloads)
function preState(comp) {
  const hist = CM(comp); if (hist.length < 60) return null;
  const key = comp + ':' + hist.length + ':' + St.set.halfLifeH + ':' + St.set.prior;
  if (St.preCache[comp] && St.preCache[comp].key === key) return St.preCache[comp].S;
  const S = ZModel.prepare(hist, hist[hist.length - 1].ts + 1, modelOpts());
  St.preCache[comp] = { key, S };
  return S;
}
function liveEval(r, m, now) {
  const S = preState(r.comp); if (!S) return null;
  const pre = ZModel.ctxFor(S, m.home, m.away);
  const maxEv = Math.max(0, ...m.hGoals, ...m.aGoals, ...m.hcMin, ...m.acMin);
  const minute = ZLive.estMinute(ZParse.parseT(r.time), now, m.sp, maxEv);
  const st = { minute, hg: m.hg || 0, ag: m.ag || 0, hc: m.hc ?? 0, ac: m.ac ?? 0 };
  const c = St.set.liveMode === 'engine' ? ZLive.ctx(pre, st) : ZLive.ctxAnchored(pre, st, m.wp, St.set.anchorW);
  const mks = ZLive.markets(c);
  const by = Object.fromEntries(mks.map(x => [x.id, x]));
  const ng = by.LNG && Object.fromEntries(by.LNG.opts.map(o => [o.k, o.p]));
  const evH = m.ngH && ng ? ng.Home * m.ngH - 1 : null, evA = m.ngA && ng ? ng.Away * m.ngA - 1 : null;
  return { pre, c, mks, by, minute, ng, evH, evA };
}
function pickMk(E, key, m) {
  const tot = m.hg + m.ag;
  if (key.startsWith('LOU+')) return E.by['LOU' + (tot + parseFloat(key.slice(4)))];
  if (key === 'LCOU') { const c = E.mks.filter(x => x.id.startsWith('LCOU')); return c[Math.floor(c.length / 2)] || c[0]; }
  return E.by[key];
}
function minLabel(E, m) {
  if (E.minute >= 90) return '<b>FT</b>';
  if (!m.sp && E.minute >= 45) return '<b class="warnc">HT</b>';
  return `<b class="good">${Math.floor(E.minute)}'</b>`;
}

function renderLive(keepScroll) {
  if (St.tab !== 'live') return;
  const y = window.scrollY;
  const L = St.live, now = Date.now();
  const age = L ? (now - L.at) / 1000 : Infinity;
  const feedOk = age < 45;
  let html = `<div class="controls">${compSel('liveComp', St.ui.liveComp, true)}
    <label>Market<select data-ui="liveMk">${LIVE_MK.map(([k, l]) => `<option value="${k}" ${St.ui.liveMk === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    <label>Min probability %<input type="number" data-ui="liveMinP" value="${St.ui.liveMinP || 0}" min="0" max="100" style="width:110px;min-width:0"></label>
    <label>Show<select data-ui="liveValue"><option value="0" ${St.ui.liveValue === '0' ? 'selected' : ''}>All live matches</option><option value="1" ${St.ui.liveValue === '1' ? 'selected' : ''}>Only next-goal value (edge ≥ ${Math.round(St.set.valueEdge * 100)}%)</option></select></label></div>`;
  html += `<div class="kpis"><div class="kpi"><div class="v ${feedOk ? 'good' : 'bad'}">${feedOk ? '● LIVE' : '● OFFLINE'}</div><div class="l">${L ? 'last update ' + Math.round(age) + 's ago' : 'no live data received yet'}${L && L.lsDown ? ' · site push feed reconnecting' : ''}</div></div>`;
  if (!feedOk) {
    view.innerHTML = html + `</div><div class="card"><h3>Live feed not connected</h3><p>In-play data comes from the site's own live page. The extension keeps it open as a pinned tab — if it was closed, reopen it:</p><button class="btn" data-act="openLive">Open live feed tab</button><p class="mute" style="font-size:13px;margin-top:10px">Keep Chrome open. The pinned tab can stay in the background; the engine reads it every ~2 seconds.</p></div>`;
    return;
  }
  const rounds = (L.rounds || []).filter(r => St.ui.liveComp === 'all' || +St.ui.liveComp === r.comp).filter(r => !r.finished).sort((a, b) => ZParse.parseT(b.time) - ZParse.parseT(a.time));
  const nLive = rounds.reduce((s, r) => s + r.matches.length, 0);
  // value alerts
  const alerts = [];
  const rows = {};
  for (const r of rounds) {
    rows[r.comp] = [];
    for (const m of r.matches) {
      const E = liveEval(r, m, L.at); if (!E) continue;
      const mk = pickMk(E, St.ui.liveMk, m);
      const best = mk ? mk.opts.slice().sort((a, b) => b.p - a.p)[0] : null;
      const val = Math.max(E.evH ?? -1, E.evA ?? -1);
      rows[r.comp].push({ r, m, E, mk, best, val });
      if (E.minute < 89 && val >= St.set.valueEdge) alerts.push({ r, m, E, side: (E.evH ?? -1) >= (E.evA ?? -1) ? 'Home' : 'Away' });
    }
  }
  html += `<div class="kpi"><div class="v">${nLive}</div><div class="l">matches in play (${rounds.length} leagues)</div></div>
    <div class="kpi"><div class="v ${alerts.length ? 'good' : ''}">${alerts.length}</div><div class="l">next-goal value spots now</div></div>
    <div class="kpi"><div class="v" style="font-size:20px">${St.set.liveMode === 'engine' ? 'Engine ratings' : 'Site-anchored'}</div><div class="l">live model (change in Settings)</div></div></div>`;
  if (alerts.length) {
    html += `<div class="card" style="margin-bottom:16px;border-color:var(--acc2)"><h3>⚡ Next-goal value now <small>our probability × site odds − 1 ≥ ${Math.round(St.set.valueEdge * 100)}%</small></h3><table><tr><th>League</th><th>Min</th><th>Match</th><th class="n">Score</th><th>Bet</th><th class="n">Site odds</th><th class="n">Our prob</th><th class="n">Fair odds</th><th class="n">Edge</th></tr>
    ${alerts.sort((a, b) => Math.max(b.E.evH ?? -1, b.E.evA ?? -1) - Math.max(a.E.evH ?? -1, a.E.evA ?? -1)).map(({ r, m, E, side }) => { const p = E.ng[side], o = side === 'Home' ? m.ngH : m.ngA, ev = side === 'Home' ? E.evH : E.evA; return `<tr class="click" data-act="liveMatch" data-id="${m.matchId}"><td>${esc(cname(r.comp))}</td><td>${minLabel(E, m)}</td><td>${esc(tn(m.home))} v ${esc(tn(m.away))}</td><td class="n"><b>${m.hg}-${m.ag}</b></td><td><span class="pill pick">${side === 'Home' ? esc(tshort(m.home)) : esc(tshort(m.away))} next goal</span></td><td class="n">${f2(o)}</td><td class="n">${pp(p)}</td><td class="n">${odds(p)}</td><td class="n good"><b>+${(ev * 100).toFixed(1)}%</b></td></tr>`; }).join('')}</table>
    <p class="mute" style="font-size:13px">"Next goal" bets lose if no further goal is scored. Track how these spots actually perform in the Value tracker below before staking.</p></div>`;
  }
  const minP = (+St.ui.liveMinP || 0) / 100;
  html += `<div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(660px,1fr))">`;
  for (const r of rounds) {
    let list = rows[r.comp] || [];
    if (St.ui.liveValue === '1') list = list.filter(x => x.val >= St.set.valueEdge && x.E.minute < 89);
    list = list.filter(x => !x.best || x.best.p >= minP);
    if (!list.length) continue;
    html += `<div class="card"><h3>${esc(cname(r.comp))} · Round ${r.round} <small>kick-off ${fmtT(ZParse.parseT(r.time))}</small></h3><div style="overflow-x:auto"><table>
      <tr><th>Min</th><th>Match</th><th class="n">Score</th><th class="n">Crn</th><th>Our pick</th><th class="n">Site WP H/D/A</th><th class="n">NG odds H/A</th><th class="n">Edge H/A</th></tr>
      ${list.map(({ m, E, best }) => `<tr class="click" data-act="liveMatch" data-id="${m.matchId}"><td>${minLabel(E, m)}</td><td>${esc(tshort(m.home))} v ${esc(tshort(m.away))}</td><td class="n"><b>${m.hg}-${m.ag}</b></td><td class="n mute">${m.hc ?? 0}-${m.ac ?? 0}</td>
        <td>${best ? `<span class="pill pick">${esc(best.k)}</span> <b>${pp(best.p)}</b>` : '<span class="mute">–</span>'}</td>
        <td class="n mute">${m.wp ? m.wp.join('/') : '–'}</td><td class="n">${m.ngH != null ? f2(m.ngH) : '–'} / ${m.ngA != null ? f2(m.ngA) : '–'}</td>
        <td class="n">${evCell(E.evH)} / ${evCell(E.evA)}</td></tr>`).join('')}</table></div></div>`;
  }
  html += `</div>${!nLive ? '<div class="empty">No matches in play right now — rounds run back-to-back, so the next one starts within minutes.</div>' : ''}
  <div class="card" style="margin-top:16px"><h3>📈 Value tracker <small>how the next-goal edges flagged by this engine have actually performed</small></h3><div id="vtBox">${St.vt ? vtHTML(St.vt) : '<p class="mute">Calculating…</p>'}</div></div>
  <div class="note">How the live engine works: Zoom matches play in real time (1 match minute ≈ 1 real minute). Testing on 4,253 captured matches showed goals and corners arrive evenly across the 90 minutes and the score does not change scoring rates, so the engine projects the rest of the match from each team's pre-match strength and the minutes left. The <b>Edge</b> columns compare that with the site's own next-goal odds.</div>`;
  view.innerHTML = html;
  if (keepScroll) window.scrollTo(0, y);
  if (!St.vt || Date.now() - St.vt.at > 60000) computeValueTracker();
}
const evCell = ev => (ev == null ? '–' : `<span class="${ev >= St.set.valueEdge ? 'good' : ev > 0 ? '' : 'mute'}">${ev > 0 ? '+' : ''}${(ev * 100).toFixed(0)}%</span>`);

function showLiveMatch(id, refresh) {
  const L = St.live; if (!L) return;
  let r = null, m = null;
  for (const rr of L.rounds) { const x = rr.matches.find(z => z.matchId === id); if (x) { r = rr; m = x; break; } }
  if (!m) { if (!refresh) $('#modalBody').innerHTML = '<p class="mute">This match is no longer live.</p>'; return; }
  if (refresh && $('#modal').classList.contains('hidden')) { liveModalId = null; return; }
  liveModalId = id;
  const E = liveEval(r, m, L.at);
  const ev = [];
  m.hGoals.forEach(x => ev.push([x, 'H', '⚽'])); m.aGoals.forEach(x => ev.push([x, 'A', '⚽']));
  m.hcMin.forEach(x => ev.push([x, 'H', '⛳'])); m.acMin.forEach(x => ev.push([x, 'A', '⛳']));
  ev.sort((a, b) => b[0] - a[0]);
  const wp = m.wp || [];
  const ours = E && E.by.L1X2 ? Object.fromEntries(E.by.L1X2.opts.map(o => [o.k, o.p])) : {};
  $('#modalBody').innerHTML = `
    <div class="mute">${esc(cname(r.comp))} · round ${r.round} · kick-off ${fmtT(ZParse.parseT(r.time))} · <span class="good">● live, updates automatically</span></div>
    <div class="split" style="align-items:center;margin:14px 0"><div class="team-h" style="text-align:right">${esc(tn(m.home))}</div><div class="team-h">${esc(tn(m.away))}</div></div>
    <div class="score">${m.hg} - ${m.ag}</div><div style="text-align:center">${E ? minLabel(E, m) : ''} <span class="mute">· corners ${m.hc}-${m.ac} · pre-match xG ${E ? f2(E.pre.lh) + '-' + f2(E.pre.la) : '–'} · remaining xG ${E ? f2(E.c.lh) + '-' + f2(E.c.la) : '–'}${E && E.c.anchored ? ` <span class="tag">anchored to site · site-implied ${f2(E.c.siteLh)}-${f2(E.c.siteLa)}</span>` : ''}</span></div>
    ${E ? `<div class="split" style="margin-top:16px">
      <div class="card"><h3>Engine vs site</h3><table>
        <tr><th></th><th class="n">Home</th><th class="n">Draw</th><th class="n">Away</th></tr>
        <tr><td>Our final 1X2</td><td class="n">${pp(ours['1'])}</td><td class="n">${pp(ours.X)}</td><td class="n">${pp(ours['2'])}</td></tr>
        <tr><td>Site win probability</td><td class="n">${wp[0] ?? '–'}%</td><td class="n">${wp[1] ?? '–'}%</td><td class="n">${wp[2] ?? '–'}%</td></tr>
        <tr><td>Our next-goal prob</td><td class="n">${pp(E.ng.Home)}</td><td class="n mute">none ${pp(E.ng.None)}</td><td class="n">${pp(E.ng.Away)}</td></tr>
        <tr><td>Site next-goal odds</td><td class="n">${m.ngH != null ? f2(m.ngH) : '–'}</td><td></td><td class="n">${m.ngA != null ? f2(m.ngA) : '–'}</td></tr>
        <tr><td>Edge</td><td class="n">${evCell(E.evH)}</td><td></td><td class="n">${evCell(E.evA)}</td></tr>
      </table>${m.gs ? `<p class="mute" style="font-size:13px">Site anytime-scorer offer: ${esc(ZParse.clean(String(m.gs.name).replace(/^\(\w+\)\s*/, '')))} @ ${m.gs.odds}</p>` : ''}</div>
      <div class="card"><h3>Timeline</h3><div class="scroll" style="max-height:260px"><table>${ev.map(([mn, s, ic]) => `<tr><td class="n">${mn}'</td><td>${s === 'H' ? ic : ''}</td><td>${s === 'A' ? ic : ''}</td></tr>`).join('') || '<tr><td class="mute">No events yet</td></tr>'}</table></div></div>
    </div>
    <div class="card" style="margin-top:16px"><h3>All in-play markets</h3><table><tr><th>Market</th><th>Options (probability · fair odds)</th></tr>
      ${E.mks.map(mk => { const b = mk.opts.slice().sort((a, b2) => b2.p - a.p)[0]; return `<tr><td>${esc(mk.name)}</td><td style="white-space:normal">${mk.opts.map(o => `<span class="pill ${o === b ? 'pick' : ''}" style="margin:2px">${esc(o.k)} ${pp(o.p)} · ${odds(o.p)}</span>`).join(' ')}</td></tr>`; }).join('')}</table></div>` : '<p class="mute">Not enough history in this league to model yet.</p>'}`;
  $('#modal').classList.remove('hidden');
}
document.getElementById('modalX').addEventListener('click', () => { liveModalId = null; });

// ---- value tracker: replays logged live snapshots against what actually happened
async function computeValueTracker(force) {
  if (St.vtBusy) return; St.vtBusy = true;
  try {
    const docs = await ZDB.getAll('live');
    const byId = new Map(St.matches.map(m => [m.matchId, m]));
    const bets = { engine: [], anchored: [] }; let snaps = 0, finishedDocs = 0;
    const SC = {};
    for (const d of docs) {
      const fin = byId.get(d.matchId);
      if (!fin || !fin.hGoals) continue; // only judge once the final result is captured
      finishedDocs++;
      const hist = CM(d.comp).filter(x => x.ts < d.ts); if (hist.length < 60) continue;
      const k = d.comp + '|' + d.ts;
      const S = SC[k] || (SC[k] = ZModel.prepare(hist, d.ts, modelOpts()));
      const pre = ZModel.ctxFor(S, d.home, d.away);
      const taken = new Set();
      for (const s of d.snaps) {
        if (s.min >= 89 || s.ngH == null) continue; snaps++;
        const stt = { minute: s.min, hg: s.hg, ag: s.ag, hc: s.hc, ac: s.ac };
        for (const mode of ['engine', 'anchored']) {
          const c = mode === 'engine' ? ZLive.ctx(pre, stt) : ZLive.ctxAnchored(pre, stt, s.wp, St.set.anchorW);
          if (mode === 'anchored' && !c.anchored) continue;
          const pN = Math.exp(-(c.lh + c.la)), sh = c.lh / ((c.lh + c.la) || 1);
          const pH = (1 - pN) * sh, pA = (1 - pN) * (1 - sh);
          for (const [side, p, o] of [['Home', pH, s.ngH], ['Away', pA, s.ngA]]) {
            if (!o) continue;
            const ev = p * o - 1, key = mode + '|' + side + '|' + s.hg + '-' + s.ag;
            if (ev < St.set.valueEdge || taken.has(key)) continue;
            taken.add(key);
            const outcome = ZLive.nextGoal(fin, Math.floor(s.min));
            bets[mode].push({ side, p, o, ev, win: outcome === side });
          }
        }
      }
    }
    const sum = B => { const n = B.length; return { n, w: B.filter(b => b.win).length, profit: B.reduce((s, b) => s + (b.win ? b.o - 1 : -1), 0), expW: B.reduce((s, b) => s + b.p, 0), avgO: n ? B.reduce((s, b) => s + b.o, 0) / n : 0 }; };
    St.vt = { at: Date.now(), engine: sum(bets.engine), anchored: sum(bets.anchored), docs: docs.length, finishedDocs, snaps };
  } finally { St.vtBusy = false; }
  const box = document.getElementById('vtBox'); if (box) box.innerHTML = vtHTML(St.vt);
}
function vtHTML(v) {
  if (!v.docs) return '<p class="mute">Nothing logged yet. Every live match is recorded minute-by-minute (score, corners, site odds); once those matches finish and their results are captured, each flagged edge is settled here automatically.</p>';
  const row = (label, x) => x.n ? `<tr><td>${label}</td><td class="n">${x.n}</td><td class="n">${pc(100 * x.w / x.n)}</td><td class="n mute">${pc(100 * x.expW / x.n)}</td><td class="n">${f2(x.avgO)}</td><td class="n ${x.profit >= 0 ? 'good' : 'bad'}"><b>${x.profit >= 0 ? '+' : ''}${(100 * x.profit / x.n).toFixed(1)}%</b></td></tr>` : `<tr><td>${label}</td><td class="n">0</td><td colspan="4" class="mute">no settled edges yet</td></tr>`;
  return `<table><tr><th>Live model</th><th class="n">Edges settled</th><th class="n">Won</th><th class="n">Model expected</th><th class="n">Avg odds</th><th class="n">ROI (flat stake)</th></tr>
    ${row('Site-anchored', v.anchored)}${row('Engine ratings', v.engine)}</table>
    <p class="mute" style="font-size:13px">${v.docs} live matches logged, ${v.finishedDocs} settled · one edge counted per match, score and side. If "Won" keeps landing below "Model expected", the model is overrating its edges. Treat anything under ~300 settled edges as noise. <a href="#" data-act="vt">Recalculate</a></p>`;
}

// ---- in-play backtest
async function runLiveBacktest() {
  const o = modelOpts();
  const comps = St.ui.btComp === 'all' ? St.comps.map(c => c.id).filter(id => CM(id).length >= 80) : [+St.ui.btComp];
  $('#btProg').style.display = 'block';
  const agg = {}; let evaluated = 0;
  for (let ci = 0; ci < comps.length; ci++) {
    const r = await ZLive.backtest(CM(comps[ci]), o, { lastRounds: +St.ui.btRounds, onProgress: p => { $('#btProg span').style.width = (100 * (ci + p) / comps.length) + '%'; } });
    evaluated += r.evaluated;
    for (const k in r.res) for (const e in r.res[k]) { const A = ((agg[k] = agg[k] || {})[e] = (agg[k] || {})[e] || { n: 0, hit: 0, ll: 0 }); for (const f in A) A[f] += r.res[k][e][f]; }
  }
  $('#btProg span').style.width = '100%';
  St.btLive = { agg, evaluated };
  drawLiveBacktest(St.btLive);
}
function drawLiveBacktest(R) {
  const out = $('#btLiveOut'); if (!out) return;
  if (!R.evaluated) { out.innerHTML = '<div class="empty">Not enough matches with goal minutes yet.</div>'; return; }
  const cell = s => (s && s.n ? `${pc(100 * s.hit / s.n)} <span class="mute">ll ${(s.ll / s.n).toFixed(3)}</span>` : '–');
  const row = (k, label) => { const A = R.agg[k]; if (!A) return ''; const gain = A.base && A.model_vs ? ((A.base.ll - A.model_vs.ll) / A.base.ll * 100) : null; return `<tr><td>${label}</td><td class="n">${A.model_vs ? A.model_vs.n : 0}</td><td class="n">${cell(A.model_vs)}</td><td class="n">${cell(A.base)}</td><td class="n ${gain > 0.5 ? 'good' : gain < -0.5 ? 'bad' : 'mute'}">${gain == null ? '–' : (gain > 0 ? '+' : '') + gain.toFixed(1) + '%'}</td></tr>`; };
  out.innerHTML = `<div class="card" style="margin-top:16px"><h3>In-play backtest <small>${R.evaluated.toLocaleString()} matches, each checked at 15', 30', 45', 60', 75' and 85'</small></h3>
  <table><tr><th>Market</th><th class="n">N</th><th class="n">Live engine (acc · log-loss)</th><th class="n">Score + minute only</th><th class="n">Skill</th></tr>
  ${Object.entries(ZLive.BT_MARKETS).map(([k, l]) => row(k + '|all', l)).join('')}
  <tr><td colspan="5" class="mute" style="padding-top:14px">Final 1X2 by minute</td></tr>
  ${[15, 30, 45, 60, 75, 85].map(T => row('L1X2|' + T, `Final 1X2 at ${T}'`)).join('')}
  <tr><td colspan="5" class="mute" style="padding-top:14px">Next goal by minute</td></tr>
  ${[15, 30, 45, 60, 75, 85].map(T => row('LNG|' + T, `Next goal at ${T}'`)).join('')}
  </table><p class="mute" style="font-size:13px">"Score + minute only" = how often each outcome happened historically from the same minute, goal difference and goal total — i.e. what you'd know without team strength. Positive skill means the live engine's probabilities are sharper. It is not a profit figure: the bookmaker's live odds also know team strength. The Value tracker on the Live tab measures that.</p></div>`;
}
