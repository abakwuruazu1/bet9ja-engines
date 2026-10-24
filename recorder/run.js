// 24/7 recorder: runs the extensions' own capture code in Node and publishes the
// databases as JSON files on the `data` branch, where the website reads them.
//   node recorder/run.js [--minutes N] [--once]
require('fake-indexeddb/auto');
const vm = require('vm'), fs = require('fs'), path = require('path'), crypto = require('crypto'), { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DATA = process.env.DATA_DIR || path.join(ROOT, 'data');
const args = process.argv.slice(2);
const RUN_MIN = +(args[args.indexOf('--minutes') + 1] || 0) || 345;  // GitHub job limit is 6 h
const ONCE = args.includes('--once');
const NO_GIT = args.includes('--no-git');
const LP_KEEP_DAYS = 7;
const T0 = Date.now();
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------- chrome API stand-in
const store = { local: {}, session: {} };
const area = k => ({ get: async key => { if (key == null) return { ...store[k] }; const ks = Array.isArray(key) ? key : typeof key === 'string' ? [key] : Object.keys(key); const o = {}; ks.forEach(x => { if (x in store[k]) o[x] = store[k][x]; }); return o; }, set: async o => { Object.assign(store[k], JSON.parse(JSON.stringify(o))); } });
const ev = () => ({ addListener() { }, removeListener() { } });
global.self = global;
if (process.env.MOCK_FETCH) require(path.resolve(process.env.MOCK_FETCH));
global.chrome = {
  storage: { local: area('local'), session: area('session'), onChanged: ev() },
  alarms: { get: async () => null, create() { }, clear: async () => true, onAlarm: ev() },
  runtime: { onInstalled: ev(), onStartup: ev(), onMessage: ev(), getURL: x => x, sendMessage: async () => null },
  tabs: { query: async () => [], create: async () => ({}), update: async () => ({}), reload: async () => { }, sendMessage: async () => { throw new Error('no tabs on the server'); } },
  action: { onClicked: ev() }
};
const load = (...files) => files.forEach(f => vm.runInThisContext(fs.readFileSync(path.join(ROOT, 'docs', f), 'utf8'), { filename: f }));
load('leagueplus/lib/core.js', 'zoom/lib/settings.js', 'zoom/lib/db.js', 'zoom/lib/api.js', 'zoom/lib/parse.js', 'zoom/lib/sync.js', 'zoom/tennis/lib/tcore.js');
const G = n => vm.runInThisContext(n); // reach the scripts' top-level consts
const DBS = {
  leagueplus: { db: G('LPDB'), stores: ['matches', 'meta'], state: ['lpstatus'] },
  zoom: { db: G('ZDB'), stores: ['matches', 'deep', 'standings', 'meta'], state: ['status'] },
  tennis: { db: G('TDB'), stores: ['matches', 'meta'], state: ['tstatus'] }
};

// ---------------------------------------------------------------- chunking
const day = ts => new Date(ts).toISOString().slice(0, 10).replace(/-/g, '');
const hour = ts => new Date(ts).toISOString().slice(0, 13).replace(/[-T]/g, '');
function chunkKey(eng, st, r) {
  if (st === 'matches') return eng === 'leagueplus' ? hour(r.ts) : (r.ts ? day(r.ts) : 'x');
  if (st === 'deep') return 'd' + Math.floor((+r.matchId || 0) / 5000);
  if (eng === 'leagueplus' && st === 'meta' && /^done:/.test(r.key)) return 'done';
  if (st === 'meta' && /^(up|st|draw):/.test(r.key)) return 'live';
  if (st === 'meta' && r.key === 'init') return 'init';
  return 'all';
}
const sha = s => crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);
let manifest = { v: 1, engines: {} };
const mfPath = () => path.join(DATA, 'manifest.json');

async function restore() {
  if (!fs.existsSync(mfPath())) { log('no previous data – starting fresh'); return; }
  manifest = JSON.parse(fs.readFileSync(mfPath(), 'utf8'));
  for (const [eng, E] of Object.entries(manifest.engines || {})) {
    if (!DBS[eng]) continue;
    Object.assign(store.local, E.state || {});
    let n = 0;
    for (const c of E.chunks || []) {
      // League Plus history is not needed to keep capturing – only recent hours (rewritten) and bookkeeping
      if (eng === 'leagueplus' && c.store === 'matches' && c.key < hour(Date.now() - 3 * 3600e3)) continue;
      const f = path.join(DATA, c.file); if (!fs.existsSync(f)) continue;
      const recs = JSON.parse(fs.readFileSync(f, 'utf8')); await DBS[eng].db.putMany(c.store, recs); n += recs.length;
    }
    log('restored', eng, n, 'records');
  }
}

// write every chunk that changed; returns true if anything changed
async function exportAll() {
  let changed = false; const lpCut = hour(Date.now() - LP_KEEP_DAYS * 86400e3);
  for (const [eng, E] of Object.entries(DBS)) {
    const old = manifest.engines[eng] || { chunks: [] };
    const keep = new Map(old.chunks.map(c => [c.file, c]));
    for (const st of E.stores) {
      let recs;
      if (eng === 'leagueplus' && st === 'matches') {
        // only recent hours can change
        const db = await E.db.open();
        recs = await new Promise((res, rej) => { const q = db.transaction('matches').objectStore('matches').index('ts').getAll(IDBKeyRange.lowerBound(Date.now() - 3 * 3600e3)); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
      } else recs = await E.db.getAll(st);
      const groups = {};
      recs.forEach(r => { const k = chunkKey(eng, st, r); (groups[k] = groups[k] || []).push(r); });
      for (const [k, list] of Object.entries(groups)) {
        if (eng === 'leagueplus' && st === 'matches' && k < lpCut) continue;
        const file = `${eng}/${st}-${k}.json`, body = JSON.stringify(list), h = sha(body);
        const prev = keep.get(file);
        if (prev && prev.h === h) continue;
        fs.mkdirSync(path.join(DATA, eng), { recursive: true });
        fs.writeFileSync(path.join(DATA, file), body);
        keep.set(file, { store: st, key: k, file, n: list.length, h, bytes: body.length });
        changed = true;
      }
    }
    // League Plus: drop hours beyond the retention window
    for (const [f, c] of keep) if (eng === 'leagueplus' && c.store === 'matches' && c.key < lpCut) { keep.delete(f); try { fs.unlinkSync(path.join(DATA, f)); } catch (e) { } changed = true; }
    const state = {}; E.state.forEach(k => { if (store.local[k] !== undefined) state[k] = store.local[k]; });
    if (JSON.stringify(state) !== JSON.stringify(old.state)) changed = true;
    manifest.engines[eng] = { chunks: [...keep.values()].sort((a, b) => a.file.localeCompare(b.file)), state };
  }
  if (changed) { manifest.at = Date.now(); fs.writeFileSync(mfPath(), JSON.stringify(manifest)); }
  return changed;
}

// ---------------------------------------------------------------- git
const sh = c => execSync(c, { cwd: DATA, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
let lastSquashDay = null;
function publish() {
  if (NO_GIT) return;
  try {
    sh('git add -A');
    if (!sh('git status --porcelain')) return;
    const today = day(Date.now()), count = +sh('git rev-list --count HEAD 2>/dev/null || echo 0');
    if (count > 400 || (lastSquashDay && lastSquashDay !== today)) {
      // keep the branch small: replace its history with one fresh snapshot
      sh('git checkout -q --orphan snap && git commit -q -m "snapshot ' + new Date().toISOString() + '" && git branch -D data -q 2>/dev/null; git branch -m data');
      sh('git push -q -f origin data');
      log('pushed fresh snapshot');
    } else {
      sh('git commit -q -m "data ' + new Date().toISOString() + '"');
      sh('git push -q origin data');
    }
    lastSquashDay = today;
  } catch (e) { log('publish failed:', (e.stderr || e.message).toString().slice(0, 300)); try { sh('git pull -q --rebase -X theirs origin data'); } catch (e2) { } }
}

// ---------------------------------------------------------------- main loop
(async () => {
  await restore();
  const st = await G('getSettings')();
  log('recorder start; will run', RUN_MIN, 'min');
  let nextZoom = 0, nextPub = 0;
  while (true) {
    const r = await G('lpSync')(); if (r && r.log && r.log.length) log('League Plus:', r.log.join(' | ')); else if (r && r.added) log('League Plus +' + r.added);
    if (Date.now() >= nextZoom) {
      nextZoom = Date.now() + 3 * 60e3;
      try { const z = await G('runSync')({ deepLimit: 40 }); log('Zoom football: total', z.total, '+' + z.added, (z.log || []).join(' | ')); } catch (e) { log('Zoom football failed', e.message); }
      try { const t = await G('runTennisSync')({ detailLimit: st.tDetailLimit }); log('Zoom tennis: total', t.total, '+' + t.added, (t.log || []).join(' | ')); } catch (e) { log('Zoom tennis failed', e.message); }
    }
    if (Date.now() >= nextPub || ONCE) {
      nextPub = Date.now() + 2.5 * 60e3;
      if (await exportAll()) publish();
    }
    if (ONCE || Date.now() - T0 > RUN_MIN * 60e3) break;
    await sleep(30e3);
  }
  log('done');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
