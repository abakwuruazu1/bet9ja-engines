// Background side of the live feed: keeps the latest in-play state in session storage (for the
// dashboard) and logs a per-match timeline to IndexedDB (score, corners, site odds, site win prob).
const LIVE_URL = 'https://zoomapi.bet9ja.com/zoom/live/all-live?clientId=202&notMobile=1&offset=3600000';
let liveLast = 0, livePendingWrite = null, liveCache = new Map(), livePending = new Map();

async function onLiveSnap(d) {
  if (!d || !Array.isArray(d.rounds) || d.at <= liveLast) return;
  liveLast = d.at;
  await chrome.storage.session.set({ live: { at: d.at, lsDown: d.lsDown, rounds: d.rounds } });
  // timeline log
  const changed = [];
  for (const r of d.rounds) {
    const startTs = ZParse.parseT(r.time);
    for (const m of r.matches) {
      const maxEv = Math.max(0, ...(m.hGoals || []), ...(m.aGoals || []), ...(m.hcMin || []), ...(m.acMin || []));
      const minute = +ZLive.estMinute(startTs, d.at, m.sp, maxEv).toFixed(1);
      const snap = { at: d.at, min: minute, hg: m.hg, ag: m.ag, hc: m.hc, ac: m.ac, sp: m.sp, wp: m.wp, ngH: m.ngH, ngA: m.ngA };
      const sig = [m.hg, m.ag, m.hc, m.ac, m.ngH, m.ngA, (m.wp || []).join('/'), Math.floor(minute)].join('|');
      let doc = liveCache.get(m.matchId);
      if (!doc) {
        doc = (await ZDB.get('live', m.matchId)) || { matchId: m.matchId, comp: r.comp, round: r.round, time: r.time, ts: startTs, home: m.home, away: m.away, snaps: [] };
        liveCache.set(m.matchId, doc);
      }
      if (doc.sig === sig) continue;
      doc.sig = sig;
      doc.snaps.push(snap);
      Object.assign(doc, { hGoals: m.hGoals, aGoals: m.aGoals, hcMin: m.hcMin, acMin: m.acMin, hg: m.hg, ag: m.ag, hc: m.hc, ac: m.ac, hth: m.hth, hta: m.hta, last: d.at });
      changed.push(doc);
    }
  }
  if (changed.length) {
    changed.forEach(doc => livePending.set(doc.matchId, doc));
    if (!livePendingWrite) livePendingWrite = setTimeout(() => {
      const batch = [...livePending.values()].map(x => Object.assign({}, x));
      livePending.clear(); livePendingWrite = null;
      ZDB.putMany('live', batch).catch(() => {});
    }, 2000);
  }
  if (liveCache.size > 400) liveCache = new Map([...liveCache.entries()].slice(-200));
}

// Keep one zoom live tab open (pinned, not discarded) so the push feed keeps flowing.
async function ensureLiveTab() {
  const st = await getSettings();
  if (!st.liveTab) return;
  const tabs = await chrome.tabs.query({ url: ['https://zoomapi.bet9ja.com/*', 'https://www.zoomscores.ng/*', 'https://zoomscores.ng/*'] });
  if (tabs.length) {
    for (const t of tabs) if (t.discarded) chrome.tabs.reload(t.id);
    chrome.tabs.update(tabs[0].id, { autoDiscardable: false }).catch(() => {});
    return;
  }
  const t = await chrome.tabs.create({ url: LIVE_URL, pinned: true, active: false });
  chrome.tabs.update(t.id, { autoDiscardable: false }).catch(() => {});
}

// Snapshots arrive every ~1.5 s; process them strictly one after another.
let liveChain = Promise.resolve();
function queueLiveSnap(d) { liveChain = liveChain.then(() => onLiveSnap(d)).catch(() => {}); }
