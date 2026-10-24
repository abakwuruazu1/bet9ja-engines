// Tennis: database, API client, parsing, capture (shared by background + tennis dashboard)
const TDB = (() => {
  const NAME = 'zoomTennisDB', VER = 1; let dbp = null;
  function open() {
    if (dbp) return dbp;
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open(NAME, VER);
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains('matches')) db.createObjectStore('matches', { keyPath: 'matchId' }).createIndex('comp', 'comp');
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
        if (!db.objectStoreNames.contains('live')) db.createObjectStore('live', { keyPath: 'matchId' });
      };
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    return dbp;
  }
  const reqP = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  async function putMany(store, items) {
    if (!items.length) return 0; const db = await open();
    return new Promise((res, rej) => { const t = db.transaction(store, 'readwrite'); const s = t.objectStore(store); items.forEach(i => s.put(i)); t.oncomplete = () => res(items.length); t.onerror = () => rej(t.error); });
  }
  return {
    open, putMany, put: (s, i) => putMany(s, [i]),
    get: async (s, k) => reqP((await open()).transaction(s).objectStore(s).get(k)),
    getAll: async s => reqP((await open()).transaction(s).objectStore(s).getAll()),
    keys: async s => reqP((await open()).transaction(s).objectStore(s).getAllKeys()),
    count: async s => reqP((await open()).transaction(s).objectStore(s).count()),
    clear: async s => { const db = await open(); return new Promise((res, rej) => { const t = db.transaction(s, 'readwrite'); t.objectStore(s).clear(); t.oncomplete = res; t.onerror = () => rej(t.error); }); }
  };
})();

const TAPI = (() => {
  const BASE = 'https://tennis-api.ng.zoomvirtualsports.com/';
  async function call(path) {
    const r = await fetch(BASE + path, { cache: 'no-store', credentials: 'omit' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    if (!j || j.status === -1) throw new Error((j && j.error && j.error.message) || 'API error');
    return j.data;
  }
  return {
    init: () => call('Competition/Init'),
    results: (comp, prev) => call(`TournamentResult/Results?isPrevious=${prev ? 1 : 0}&competitionId=${comp}`),
    draw: (comp, prev) => call(`TournamentResult/Statistics?isPrevious=${prev ? 1 : 0}&competitionId=${comp}`),
    details: matchId => call('MatchResult/Details?matchId=' + matchId)
  };
})();

const TParse = (() => {
  const RANK = { '0': 0, '15': 1, '30': 2, '40': 3, 'A': 4, 'V': 5 };
  const cleanName = n => String(n || '').replace(/^Z(.+?)Z\.\w+$/, '$1').replace(/^PLAYER_(\d+)\.\w+$/, 'Player $1').replace(/\.\w+$/, '');
  // points won by player1 / player2 from a pointSequence like ["15-0","15-15",...]
  function seqPoints(seq) {
    let a = 0, b = 0, pa = 0, pb = 0;
    for (const s of seq || []) {
      const [x, y] = String(s).split('-'); const nx = RANK[x] ?? +x, ny = RANK[y] ?? +y;
      if (nx > pa || ny < pb) a++; else b++;
      pa = nx; pb = ny;
    }
    return [a, b];
  }
  function match(comp, tour, round, m) {
    return {
      matchId: m.matchId, comp, tour, tourTs: Date.parse(tour), roundId: round.id, phase: round.tournamentPhase, ip: round.idInPhase,
      ts: Date.parse(round.startDate), time: round.startDate, p1: m.playerOneId, p2: m.playerTwoId, w: m.winnerId,
      sets: (m.setsScoreHistory || []).map(s => [s.playerOneGamesScore, s.playerTwoGamesScore]),
      tbPts: (m.setsScoreHistory || []).map(s => (s.isTieBreak ? [s.playerOnePointsScore || 0, s.playerTwoPointsScore || 0] : null))
    };
  }
  // per game: [set, server, winner, p1Points, p2Points, isTB]; plus serve totals and derived stats
  function details(rec, d) {
    const g = (d.gameHistory || []).map(x => { const [a, b] = seqPoints(x.pointSequence); return [x.set, x.servingPlayer, x.winningPlayer, a, b, x.isTieBreak ? 1 : 0]; });
    const serve = [[0, 0], [0, 0]], holds = [[0, 0], [0, 0]], bpF = [[0, 0], [0, 0]];
    for (const x of g) {
      if (x[5]) continue;
      const s = x[1] - 1; serve[s][0] += s === 0 ? x[3] : x[4]; serve[s][1] += x[3] + x[4];
      holds[s][1]++; if (x[2] === x[1]) holds[s][0]++;
    }
    return Object.assign(rec, { g, serve, holds, det: true });
  }
  return { cleanName, seqPoints, match, details };
})();

// ---------------- capture
let TSYNCING = false;
async function tSetStatus(p) { const { tstatus } = await chrome.storage.local.get('tstatus'); const s = Object.assign({}, tstatus || {}, p); await chrome.storage.local.set({ tstatus: s }); return s; }

async function runTennisSync({ detailLimit = 120 } = {}) {
  if (TSYNCING) return { busy: true };
  TSYNCING = true;
  const t0 = Date.now(), log = [], comps = {};
  let added = 0, detailed = 0;
  await tSetStatus({ running: true });
  try {
    const init = await TAPI.init();
    const players = {};
    (init.competitions || []).forEach(c => (c.players || []).forEach(p => { players[p.id] = { id: p.id, name: TParse.cleanName(p.name), comp: c.id }; }));
    await TDB.put('meta', { key: 'init', comps: (init.competitions || []).map(c => ({ id: c.id, name: c.name, liveRound: c.liveRound })), players, phases: init.phases || {}, at: Date.now() });
    const have = new Map((await TDB.getAll('matches')).map(m => [m.matchId, m]));
    for (const c of init.competitions || []) {
      comps[c.id] = { name: c.name, ok: true };
      for (const prev of [true, false]) {
        try {
          const d = await TAPI.results(c.id, prev);
          const R = d.rounds || []; if (!R.length) continue;
          const tour = R[0].startDate; const recs = [];
          R.forEach(r => (r.matches || []).forEach(m => {
            if (m.status !== 2) return;
            const old = have.get(m.matchId);
            if (old && old.sets && old.sets.length) return;
            const rec = Object.assign(old || {}, TParse.match(c.id, tour, r, m)); recs.push(rec); have.set(m.matchId, rec);
          }));
          added += recs.length; await TDB.putMany('matches', recs);
          comps[c.id][prev ? 'prev' : 'cur'] = { tour, rounds: R.length };
        } catch (e) { if (!/temporarily unavailable/i.test(e.message)) { comps[c.id].ok = false; comps[c.id].err = e.message; log.push(`${c.name}: ${e.message}`); } else comps[c.id].paused = true; }
      }
      try { const draw = await TAPI.draw(c.id, false); await TDB.put('meta', { key: 'draw:' + c.id, comp: c.id, draw, at: Date.now() }); } catch (e) { /* between tournaments */ }
    }
    // point-by-point details for matches that don't have them yet (newest first)
    const todo = [...have.values()].filter(m => !m.det).sort((a, b) => b.ts - a.ts).slice(0, detailLimit);
    let i = 0;
    const work = async () => { while (i < todo.length) { const m = todo[i++]; try { TParse.details(m, await TAPI.details(m.matchId)); await TDB.put('matches', m); detailed++; } catch (e) { /* retry next run */ } } };
    await Promise.all([work(), work(), work(), work()]);
  } catch (e) { log.push('Tennis sync failed: ' + e.message); }
  finally { TSYNCING = false; }
  const all = await TDB.getAll('matches');
  return tSetStatus({ running: false, lastSync: Date.now(), took: Date.now() - t0, added, detailed, total: all.length, withDetails: all.filter(m => m.det).length, comps, log });
}

// ---------------- live capture (snapshots from content/tlive-main.js)
const T_LIVE_URL = 'https://tennis.ng.zoomvirtualsports.com/zoom-tennis/live?offset=3600000';
let tLiveLast = 0, tLiveCache = new Map(), tLivePending = new Map(), tLiveTimer = null, tLiveChain = Promise.resolve();
async function onTennisSnap(d) {
  if (!d || !d.comps || d.at <= tLiveLast) return;
  tLiveLast = d.at;
  await chrome.storage.session.set({ tlive: d });
  for (const c of d.comps) for (const m of c.matches) {
    if (m.status !== 1) continue;
    const sig = [m.sa, m.sb, m.ga, m.gb, m.pa, m.pb, m.server].join('|');
    let doc = tLiveCache.get(m.id);
    if (!doc) { doc = (await TDB.get('live', m.id)) || { matchId: m.id, comp: c.comp, p1: m.p1, p2: m.p2, roundStart: c.roundStart, snaps: [] }; tLiveCache.set(m.id, doc); }
    if (doc.sig === sig) continue;
    doc.sig = sig; doc.snaps.push({ at: d.at, done: m.done, ga: m.ga, gb: m.gb, pa: m.pa, pb: m.pb, server: m.server });
    tLivePending.set(m.id, doc);
  }
  if (tLivePending.size && !tLiveTimer) tLiveTimer = setTimeout(() => { const b = [...tLivePending.values()].map(x => Object.assign({}, x)); tLivePending.clear(); tLiveTimer = null; TDB.putMany('live', b).catch(() => {}); }, 3000);
  if (tLiveCache.size > 300) tLiveCache = new Map([...tLiveCache.entries()].slice(-150));
}
function queueTennisSnap(d) { tLiveChain = tLiveChain.then(() => onTennisSnap(d)).catch(() => {}); }
async function ensureTennisTab() {
  const st = await getSettings(); if (!st.tennisLiveTab) return;
  const tabs = await chrome.tabs.query({ url: ['https://tennis.ng.zoomvirtualsports.com/*'] });
  if (tabs.length) { for (const t of tabs) if (t.discarded) chrome.tabs.reload(t.id); chrome.tabs.update(tabs[0].id, { autoDiscardable: false }).catch(() => {}); return; }
  const t = await chrome.tabs.create({ url: T_LIVE_URL, pinned: true, active: false });
  chrome.tabs.update(t.id, { autoDiscardable: false }).catch(() => {});
}
