/* Online mode: lets the extension dashboards run as a normal website.
   - stands in for the chrome.* extension API
   - downloads what the 24/7 recorder captured (data branch of this repo) into the browser's database
   - keeps it fresh every ~90 s */
(() => {
  const me = document.currentScript;
  const ENG = me.dataset.engine;                       // leagueplus | zoom | tennis
  const DBNAME = { leagueplus: 'LPDB', zoom: 'ZDB', tennis: 'TDB' }[ENG];
  const APPS = (me.dataset.app || '').split(',');      // scripts that start the dashboard
  const host = location.hostname.endsWith('.github.io') ? location.hostname.split('.')[0] : 'abakwuruazu1';
  const repo = location.hostname.endsWith('.github.io') ? (location.pathname.split('/')[1] || 'bet9ja-engines') : 'bet9ja-engines';
  const OWNER = window.B9E_OWNER || host, REPO = window.B9E_REPO || repo;
  const LS = { get: (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } }, set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { } } };

  // ---------------- chrome.* stand-in
  const listeners = [];
  const localKey = 'b9e:local:' + ENG;
  let remote = LS.get('b9e:remote:' + ENG, {});          // recorder status (read-only here)
  const session = {};
  const pick = (src, key) => { if (key == null) return { ...src }; const ks = Array.isArray(key) ? key : typeof key === 'string' ? [key] : Object.keys(key); const o = {}; ks.forEach(k => { if (src[k] !== undefined) o[k] = src[k]; else if (key && typeof key === 'object' && !Array.isArray(key)) o[k] = key[k]; }); return o; };
  const fire = ch => listeners.forEach(f => { try { f(ch, 'local'); } catch (e) { console.error(e); } });
  const local = {
    get: async key => pick(Object.assign({}, LS.get(localKey, {}), remote), key),
    set: async o => { const cur = LS.get(localKey, {}), ch = {}; for (const k in o) { ch[k] = { oldValue: cur[k], newValue: o[k] }; cur[k] = o[k]; } LS.set(localKey, cur); fire(ch); },
    remove: async k => { const cur = LS.get(localKey, {}); [].concat(k).forEach(x => delete cur[x]); LS.set(localKey, cur); }
  };
  const ev = arr => ({ addListener: f => arr && arr.push(f), removeListener() { } });
  window.chrome = {
    storage: { local, session: { get: async k => pick(session, k), set: async o => Object.assign(session, o) }, onChanged: ev(listeners) },
    runtime: {
      getURL: x => x, onMessage: ev(),
      sendMessage: async msg => {
        const t = msg && msg.type;
        if (['lpSyncNow', 'syncNow', 'tennisSyncNow'].includes(t)) { await refresh(true); return remote; }
        if (t === 'deepOne') return { ok: false, err: 'Online version: deep stats are fetched automatically by the recorder (a few minutes after each match).' };
        if (t === 'openLiveTab' || t === 'openTennisTab') { alert('Live in-play needs the Chrome extension on a computer – it is not available on the online version.'); return false; }
        return true;
      }
    },
    tabs: { create: async o => { window.open(o.url, '_blank'); return {}; }, query: async () => [] }
  };

  // ---------------- loading banner
  const bar = document.createElement('div');
  bar.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:9999;background:#111a24;color:#cfe;border-top:1px solid #234;padding:8px 14px;font:13px system-ui;display:flex;gap:12px;align-items:center;flex-wrap:wrap';
  bar.innerHTML = '<a href="../index.html" style="color:#3ddc97;font-weight:700;text-decoration:none">⌂ Home</a><span id="b9eMsg">Loading recorded data…</span>';
  const msg = t => { const e = document.getElementById('b9eMsg'); if (e) e.textContent = t; };
  document.addEventListener('DOMContentLoaded', () => document.body.appendChild(bar));

  // ---------------- data download
  let sha = null, shaAt = 0, busy = null;
  async function latestSha(force) {
    if (sha && !force && Date.now() - shaAt < 60e3) return sha;
    try {
      const r = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/commits/data`, { headers: { Accept: 'application/vnd.github.sha' }, cache: 'no-store' });
      if (r.ok) { sha = (await r.text()).trim(); shaAt = Date.now(); return sha; }
    } catch (e) { }
    shaAt = Date.now(); return sha || 'data';   // rate-limited: fall back to the branch (may be up to 5 min old)
  }
  const lpDays = () => +LS.get('b9e:lpDays', 2) || 2;
  async function refresh(force) {
    if (busy) return busy;
    busy = (async () => {
      const DB = window[DBNAME] || eval(DBNAME);
      const s = await latestSha(force), base = `https://raw.githubusercontent.com/${OWNER}/${REPO}/${s}/`;
      let mf;
      try { mf = await (await fetch(base + 'manifest.json', { cache: s === 'data' ? 'no-store' : 'default' })).json(); }
      catch (e) { msg('No recorded data yet – the recorder publishes its first data a few minutes after it starts.'); return; }
      const E = mf.engines && mf.engines[ENG]; if (!E) { msg('No data for this engine yet.'); return; }
      const loadedKey = 'b9e:loaded:' + ENG; let loaded = LS.get(loadedKey, {});
      if (Object.keys(loaded).length && !(await DB.count('matches'))) loaded = {};   // database was cleared
      const cutoff = new Date(Date.now() - lpDays() * 86400e3).toISOString().slice(0, 13).replace(/[-T]/g, '');
      const todo = E.chunks.filter(c => loaded[c.file] !== c.h && !(ENG === 'leagueplus' && c.store === 'matches' && c.key < cutoff));
      let i = 0;
      for (const c of todo) {
        msg(`Downloading recorded data… ${++i}/${todo.length}`);
        try { const recs = await (await fetch(base + c.file)).json(); await DB.putMany(c.store, recs); loaded[c.file] = c.h; LS.set(loadedKey, loaded); }
        catch (e) { console.warn('chunk failed', c.file, e); }
      }
      const ch = {};
      for (const k in E.state || {}) if (JSON.stringify(E.state[k]) !== JSON.stringify(remote[k])) ch[k] = { oldValue: remote[k], newValue: E.state[k] };
      remote = E.state || {}; LS.set('b9e:remote:' + ENG, remote);
      const st = Object.values(remote)[0] || {};
      msg(`Online · recorder last checked Bet9ja ${st.lastSync ? Math.round((Date.now() - st.lastSync) / 60000) + ' min ago' : '–'} · updates every ~2 min`);
      if (Object.keys(ch).length || todo.length) { if (!Object.keys(ch).length) { const k = Object.keys(remote)[0]; if (k) ch[k] = { oldValue: null, newValue: remote[k] }; } fire(ch); }
    })().finally(() => { busy = null; });
    return busy;
  }

  // ---------------- start: libraries -> data -> dashboard
  const loadScript = src => new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = rej; document.body.appendChild(s); });
  document.addEventListener('DOMContentLoaded', async () => {
    const list = [...document.querySelectorAll('script[type="lazy"]')].map(s => s.dataset.src);
    let started = false;
    for (const src of list) {
      if (!started && APPS.includes(src)) { started = true; try { await refresh(true); } catch (e) { console.error(e); msg('Could not download data: ' + e.message); } }
      await loadScript(src);
    }
    setInterval(() => refresh(false), 90e3);
  });
})();
