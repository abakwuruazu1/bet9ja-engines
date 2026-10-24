// IndexedDB wrapper. Stores:
//  matches   (keyPath matchId)  – every finished match, all leagues, all seasons ever captured
//  deep      (keyPath matchId)  – per-match deep stats (possession, shots, saves, site win prob)
//  standings (keyPath key)      – league tables as published by the site
//  meta      (keyPath key)      – init data (leagues/teams), season bookkeeping
//  live      (keyPath matchId)  – in-play timelines: score, corners, site odds & win prob per minute
const ZDB = (() => {
  const NAME = 'zoomStatsDB', VER = 2;
  let dbp = null;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open(NAME, VER);
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains('matches')) {
          const s = db.createObjectStore('matches', { keyPath: 'matchId' });
          s.createIndex('comp', 'comp');
        }
        if (!db.objectStoreNames.contains('deep')) db.createObjectStore('deep', { keyPath: 'matchId' });
        if (!db.objectStoreNames.contains('standings')) db.createObjectStore('standings', { keyPath: 'key' });
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
        if (!db.objectStoreNames.contains('live')) db.createObjectStore('live', { keyPath: 'matchId' }); // in-play timelines
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return dbp;
  }

  const reqP = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

  async function putMany(store, items) {
    if (!items.length) return 0;
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction(store, 'readwrite');
      const s = t.objectStore(store);
      items.forEach(i => s.put(i));
      t.oncomplete = () => res(items.length);
      t.onerror = () => rej(t.error);
    });
  }
  const put = (store, item) => putMany(store, [item]);
  async function get(store, key) { const db = await open(); return reqP(db.transaction(store).objectStore(store).get(key)); }
  async function getAll(store) { const db = await open(); return reqP(db.transaction(store).objectStore(store).getAll()); }
  async function keys(store) { const db = await open(); return reqP(db.transaction(store).objectStore(store).getAllKeys()); }
  async function count(store) { const db = await open(); return reqP(db.transaction(store).objectStore(store).count()); }
  async function byComp(comp) { const db = await open(); return reqP(db.transaction('matches').objectStore('matches').index('comp').getAll(comp)); }
  async function clear(store) {
    const db = await open();
    return new Promise((res, rej) => { const t = db.transaction(store, 'readwrite'); t.objectStore(store).clear(); t.oncomplete = res; t.onerror = () => rej(t.error); });
  }
  return { open, put, putMany, get, getAll, keys, count, byComp, clear };
})();
