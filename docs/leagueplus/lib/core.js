// League Plus (Bet9ja virtual football, leagueplus-tv.bet9ja.com) – shared core:
// API client, database, selection catalogue, settlement and capture.
// Data source: https://stadium-tv-api.bet9ja.com  (/game/init, /game/{gameId}/round, /game/standings/{gameId})
// The API only returns the UPCOMING round (with all odds) and the LAST finished round (scores, goal minutes,
// odds) – no history – so the extension records every round as it happens (a round every ~6 minutes).
const LP_API = 'https://stadium-tv-api.bet9ja.com';

const LPDB = (() => {
  const NAME = 'leaguePlusDB', VER = 1; let dbp = null;
  function open() {
    if (dbp) return dbp;
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open(NAME, VER);
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains('matches')) { const s = db.createObjectStore('matches', { keyPath: 'key' }); s.createIndex('comp', 'comp'); s.createIndex('ts', 'ts'); }
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
      };
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    return dbp;
  }
  const reqP = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  async function putMany(store, items) { if (!items.length) return 0; const db = await open(); return new Promise((res, rej) => { const t = db.transaction(store, 'readwrite'); const s = t.objectStore(store); items.forEach(i => s.put(i)); t.oncomplete = () => res(items.length); t.onerror = () => rej(t.error); }); }
  return {
    open, putMany, put: (s, i) => putMany(s, [i]),
    get: async (s, k) => reqP((await open()).transaction(s).objectStore(s).get(k)),
    getAll: async s => reqP((await open()).transaction(s).objectStore(s).getAll()),
    count: async s => reqP((await open()).transaction(s).objectStore(s).count()),
    clear: async s => { const db = await open(); return new Promise((res, rej) => { const t = db.transaction(s, 'readwrite'); t.objectStore(s).clear(); t.oncomplete = res; t.onerror = () => rej(t.error); }); }
  };
})();

// ---------------- selection catalogue (built from /game/init markets)
const LPCat = (() => {
  let CAT = null;
  // groups used to remove the bookmaker margin: exclusive groups sum to 1, "pair" groups sum to 2
  const GROUP = { 1: 'ex', 3: 'ex', 4: 'ex', 5: 'ex', 6: 'ex', 7: 'ex', 8: 'ex', 13: 'ex', 2: 'pair', 10: 'pair', 14: 'pair' };
  function build(init) {
    const cat = {};
    (init.markets || []).forEach(m => {
      const add = (sels, sub) => Object.entries(sels || {}).forEach(([id, s]) => {
        cat[id] = { id: +id, mId: m.id, market: m.name.trim(), sub, name: s.name, full: s.fullName || s.name, type: s.type, aw: !!s.alwaysWin, ws: new Set(String(s.winningScores || '').split('|').filter(Boolean)), cond: s.winningConditions || null, group: GROUP[m.id] || 'other' };
      });
      add(m.selections, null); (m.submarkets || []).forEach(sm => add(sm.selections, sm.name));
    });
    CAT = cat; return cat;
  }
  const get = () => CAT;
  // market key used for grouping/calibration (market + line)
  const mkey = c => c.mId + (c.sub ? '@' + c.sub : '');
  const mlabel = c => c.market + (c.sub ? ' ' + c.sub : '');
  const UNIVERSE = new Set(); for (let h = 0; h <= 6; h++) for (let a = 0; a + h <= 6; a++) UNIVERSE.add(h + ':' + a);
  // semantic fallback for scores outside the listed universe (more than 6 goals)
  function semantic(c, h, a) {
    const n = c.name.replace(/\s+/g, ''), t = h + a, R = h > a ? '1' : h < a ? '2' : 'X', gg = h > 0 && a > 0;
    let m;
    if (c.mId === 1) return n === R;
    if (c.mId === 2) return n.includes(R) || (n === 'X2' && R === 'X');
    if (c.mId === 3) return (n === 'GG') === gg;
    if (c.mId === 4) return n === h + '-' + a;
    if ((m = n.match(/^([OU])(\d+\.5)$/))) return m[1] === 'O' ? t > +m[2] : t < +m[2];
    if ((m = n.match(/^([HA])([OU])(\d+\.5)$/))) { const g = m[1] === 'H' ? h : a; return m[2] === 'O' ? g > +m[3] : g < +m[3]; }
    if ((m = n.match(/^([12X])([OU])(\d+\.5)$/))) return R === m[1] && (m[2] === 'O' ? t > +m[3] : t < +m[3]);
    if ((m = n.match(/^(1X|12|X2|2X)([OU])(\d+\.5)$/))) return m[1].includes(R) && (m[2] === 'O' ? t > +m[3] : t < +m[3]);
    if ((m = n.match(/^MultiHome(\d)-(\d)$/))) return h >= +m[1] && h <= +m[2];
    if ((m = n.match(/^MultiAway(\d)-(\d)$/))) return a >= +m[1] && a <= +m[2];
    if ((m = n.match(/^Multi(\d)-(\d)$/))) return t >= +m[1] && t <= +m[2];
    if ((m = n.match(/^([12X])\+(GG|NG)$/))) return R === m[1] && ((m[2] === 'GG') === gg);
    if ((m = n.match(/^(1X|12|2X)\+(GG|NG)$/))) return m[1].includes(R) && ((m[2] === 'GG') === gg);
    return c.aw;
  }
  // goals: [[minute,'h'|'a'],...] needed only for "Goal Up" selections
  function settle(c, h, a, goals) {
    if (c.type === 2 || c.cond) {
      const side = c.name.trim().startsWith('1') ? 'h' : 'a';
      if (side === 'h' ? h > a : a > h) return true;
      if (!goals) return null;
      let x = 0, y = 0; for (const [, s] of goals) { s === 'h' ? x++ : y++; if ((side === 'h' ? x - y : y - x) === 1) return true; }
      return false;
    }
    const k = h + ':' + a;
    if (UNIVERSE.has(k)) return c.ws.has(k);
    return semantic(c, h, a);
  }
  return { build, get, mkey, mlabel, settle, semantic };
})();

// ---------------- parsing
const LPParse = (() => {
  function hashSel(s) { let x = 0; for (let i = 0; i < s.length; i++) x = (x * 31 + s.charCodeAt(i)) | 0; return 'sel:' + s.length + ':' + (x >>> 0).toString(36); }
  // returns { matches: [...], selsets: {key: string} }
  function results(game, rr) {
    const out = [], selsets = {};
    (rr.competitions || []).forEach((comp, ci) => {
      const names = String(rr.matches[ci] || '').split('|').filter(Boolean);
      const scores = String(rr.results[ci] || '').split('|');
      const odds = String(rr.odds[ci] || '').split('|');
      const sel = String(rr.selections[ci] || ''); const sk = hashSel(sel); selsets[sk] = sel;
      const goals = names.map(() => []);
      String((rr.timeline || [])[ci] || '').split('|').filter(Boolean).forEach(ev => {
        const [min, codes] = ev.split(':'); String(codes || '').split('-').forEach(cs => { const c = +cs; if (!c) return; const idx = Math.floor((c - 1) / 2); if (goals[idx]) goals[idx].push([+min, c % 2 === 1 ? 'h' : 'a']); });
      });
      names.forEach((nm, i) => {
        const [home, away] = nm.split('-'); const [hg, ag] = String(scores[i] || '').split(':').map(Number);
        if (!(hg >= 0) || !(ag >= 0)) return;
        const g = goals[i].sort((x, y) => x[0] - y[0]);
        out.push({ key: rr.roundId + ':' + comp + ':' + i, game, comp, roundId: +rr.roundId, season: +rr.seasons[ci], week: +rr.weeks[ci], ts: Date.parse(rr.liveStartDate), idx: i, home, away, hg, ag, goals: g, tlOk: g.length === hg + ag, odds: odds[i] || '', sk });
      });
    });
    return { matches: out, selsets };
  }
  // upcoming round -> fixtures with odds
  function upcoming(game, r) {
    const out = [], selsets = {};
    (r.competitions || []).forEach((comp, ci) => {
      const names = String(r.matches[ci] || '').split('|').filter(Boolean), odds = String(r.odds[ci] || '').split('|');
      const sel = String(r.selections[ci] || ''); const sk = hashSel(sel); selsets[sk] = sel;
      names.forEach((nm, i) => { const [home, away] = nm.split('-'); out.push({ key: r.roundId + ':' + comp + ':' + i, game, comp, roundId: +r.roundId, season: +r.seasons[ci], week: +r.weeks[ci], ts: Date.parse(r.startDate), close: Date.parse(r.noBetDate || r.endDate), end: Date.parse(r.endDate), idx: i, home, away, odds: odds[i] || '', sk }); });
    });
    return { fixtures: out, selsets };
  }
  // odds string + selection string -> Map selId -> odds
  function oddsMap(oddsStr, selStr) { const ids = String(selStr).split('-'), o = String(oddsStr).split('-').map(Number), m = new Map(); ids.forEach((id, i) => { if (o[i] > 1) m.set(+id, o[i]); }); return m; }
  return { results, upcoming, oddsMap, hashSel };
})();

// ---------------- capture (background)
let LP_SYNCING = false;
async function lpStatus(p) { const { lpstatus } = await chrome.storage.local.get('lpstatus'); const s = Object.assign({}, lpstatus || {}, p); await chrome.storage.local.set({ lpstatus: s }); return s; }
async function lpFetch(path) { const r = await fetch(LP_API + path, { cache: 'no-store', credentials: 'omit' }); if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + path); const j = await r.json(); if (!j || j.status !== 1) throw new Error((j && j.error && j.error.message) || 'API error'); return j.data; }
async function lpSync() {
  if (LP_SYNCING) return { busy: true };
  LP_SYNCING = true; const t0 = Date.now(), log = []; let added = 0;
  try {
    let init = await LPDB.get('meta', 'init');
    if (!init || Date.now() - init.at > 6 * 3600e3) { const d = await lpFetch('/game/init'); init = { key: 'init', at: Date.now(), games: d.games, markets: d.markets, roundSpecialMarkets: d.roundSpecialMarkets }; await LPDB.put('meta', init); }
    const metas = [];
    for (const g of init.games) {
      try {
        const d = await lpFetch('/game/' + g.id + '/round');
        if (d.roundResults && d.roundResults.roundId) {
          const doneKey = 'done:' + g.id + ':' + d.roundResults.roundId;
          if (!(await LPDB.get('meta', doneKey))) {
            const p = LPParse.results(g.id, d.roundResults);
            for (const k in p.selsets) metas.push({ key: k, value: p.selsets[k] });
            added += await LPDB.putMany('matches', p.matches);
            metas.push({ key: doneKey, at: Date.now() });
          }
        }
        if (d.round && d.round.roundId) { const u = LPParse.upcoming(g.id, d.round); for (const k in u.selsets) metas.push({ key: k, value: u.selsets[k] }); metas.push({ key: 'up:' + g.id, at: Date.now(), fixtures: u.fixtures }); }
        const ids = g.leagues.filter(l => l.enabled).map(l => l.id).join(',');
        try { const st = await lpFetch('/game/standings/' + g.id + '?competitionIds=' + ids); metas.push({ key: 'st:' + g.id, at: Date.now(), standings: st.standings }); } catch (e) { /* optional */ }
      } catch (e) { log.push(g.name + ': ' + e.message); }
    }
    await LPDB.putMany('meta', metas);
  } catch (e) { log.push('Sync failed: ' + e.message); }
  finally { LP_SYNCING = false; }
  const total = await LPDB.count('matches');
  const prev = (await chrome.storage.local.get('lpstatus')).lpstatus || {};
  return lpStatus({ lastSync: Date.now(), took: Date.now() - t0, added, total, log, firstSync: prev.firstSync || Date.now(), lastAdded: added ? Date.now() : prev.lastAdded });
}
if (typeof module !== 'undefined') module.exports = { LPCat, LPParse };
