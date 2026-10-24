// Capture engine: pulls every league, both seasons, standings and deep stats into IndexedDB.
let ZSYNCING = false;

async function setStatus(patch) {
  const { status } = await chrome.storage.local.get('status');
  const s = Object.assign({}, status || {}, patch);
  await chrome.storage.local.set({ status: s });
  return s;
}

async function syncSeason(st, comp, prev, known) {
  const cid = st.clientId;
  const p0 = await ZAPI.results(cid, comp.id, prev, 0);
  const rounds = [...(p0.rounds || [])];
  const total = +p0.total_rounds || rounds.length;
  const r1 = rounds.find(r => r.id === 1) || rounds[0];
  if (!r1) return { added: 0, total: 0 };
  const season = r1.time;
  const metaKey = 'season:' + comp.id + '|' + season;
  if (prev) {
    const m = await ZDB.get('meta', metaKey);
    if (m && m.complete) return { added: 0, total, season, skipped: true };
  }
  for (let off = 20; off < total; off += 20) {
    const p = await ZAPI.results(cid, comp.id, prev, off);
    rounds.push(...(p.rounds || []));
  }
  const recs = [];
  rounds.forEach(r => (r.matches || []).forEach(m => {
    if (m.homeScore == null || m.awayScore == null) return;
    recs.push(ZParse.toRec(comp.id, season, r, m));
  }));
  const added = recs.filter(r => !known.has(r.matchId)).length;
  await ZDB.putMany('matches', recs);
  recs.forEach(r => known.add(r.matchId));
  const perRound = rounds[0] && rounds[0].matches ? rounds[0].matches.length : 0;
  const perSeason = perRound ? 2 * (perRound * 2 - 1) : 38;
  await ZDB.put('meta', { key: metaKey, comp: comp.id, season, rounds: total, perSeason, complete: !!prev && total >= perSeason, at: Date.now() });
  return { added, total, season };
}

async function syncDeep(st, known, limit) {
  const have = new Set(await ZDB.keys('deep'));
  const all = await ZDB.getAll('matches');
  const todo = all.filter(m => !have.has(m.matchId)).sort((a, b) => b.ts - a.ts).slice(0, limit);
  let n = 0;
  for (const m of todo) {
    try {
      const d = await ZAPI.matchStats(st.clientId, m.matchId);
      await ZDB.put('deep', ZParse.deep(m.matchId, d));
      n++;
    } catch (e) {
      await ZDB.put('deep', { matchId: m.matchId, ok: false, err: e.message, at: Date.now() });
    }
    await new Promise(r => setTimeout(r, 250));
  }
  return { fetched: n, pending: all.length - have.size - todo.length };
}

async function runSync({ deepLimit } = {}) {
  if (ZSYNCING) return { busy: true };
  ZSYNCING = true;
  const st = await getSettings();
  const t0 = Date.now();
  const log = [];
  const leagues = {};
  await setStatus({ running: true, startedAt: t0 });
  let added = 0, deepRes = null;
  try {
    const init = await ZAPI.init(st.clientId);
    const comps = (init.competitions || []).map(c => ({ id: c.id, name: c.name, liveRound: c.liveRound, competitors: (c.competitors || []).map(t => t.id) }));
    const teams = {};
    (init.competitions || []).forEach(c => (c.competitors || []).forEach(t => { teams[t.id] = { id: t.id, name: ZParse.clean(t.name), short: t.shortName, comp: c.id }; }));
    await ZDB.put('meta', { key: 'init', comps, teams, shotTypes: init.shotTypes || {}, at: Date.now() });
    const known = new Set(await ZDB.keys('matches'));

    for (const c of comps) {
      if ((st.disabledComps || []).includes(c.id)) continue;
      const L = leagues[c.id] = { name: c.name, ok: true };
      for (const prev of [false, true]) {
        try {
          const r = await syncSeason(st, c, prev, known);
          added += r.added;
          L[prev ? 'prev' : 'cur'] = { rounds: r.total, season: r.season, added: r.added };
        } catch (e) {
          if (/temporarily unavailable/i.test(e.message)) { L.paused = true; L.err = 'Paused by the site (temporarily unavailable)'; continue; }
          L.ok = false; L.err = e.message;
          log.push(`${c.name} ${prev ? 'previous' : 'current'}: ${e.message}`);
        }
      }
      try {
        const rows = await ZAPI.standings(st.clientId, c.id, false);
        await ZDB.put('standings', { key: c.id + ':cur', comp: c.id, rows, at: Date.now() });
      } catch (e) { /* table may be unavailable between seasons */ }
    }
    if (st.deep) deepRes = await syncDeep(st, known, deepLimit || st.deepPerRun);
  } catch (e) {
    log.push('Sync failed: ' + e.message);
  } finally {
    ZSYNCING = false;
  }
  const total = await ZDB.count('matches');
  const deepCount = await ZDB.count('deep');
  const s = await setStatus({ running: false, lastSync: Date.now(), took: Date.now() - t0, added, total, deepCount, deep: deepRes, leagues, log: log.slice(0, 30) });
  return s;
}
