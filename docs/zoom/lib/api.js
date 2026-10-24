// Bet9ja Zoom API client (the data feed behind zoomscores.ng).
// Direct fetch from the extension first; if that fails, proxy the request through an
// open zoomscores.ng / zoomapi.bet9ja.com tab (content/proxy.js).
const ZAPI = (() => {
  const BASE = 'https://zoomapi.bet9ja.com/zoomexternalapi';
  let proxyUntil = 0;

  async function direct(url, init) {
    const r = await fetch(url, init);
    if (!r.ok) throw Object.assign(new Error('HTTP ' + r.status), { transport: true });
    return r.json();
  }

  async function viaTab(url, init) {
    const tabs = await chrome.tabs.query({ url: ['https://zoomapi.bet9ja.com/*', 'https://www.zoomscores.ng/*', 'https://zoomscores.ng/*'] });
    for (const t of tabs) {
      try {
        const resp = await chrome.tabs.sendMessage(t.id, { type: 'zoomProxy', url, method: init.method, headers: init.headers, body: init.body });
        if (resp && resp.ok) return resp.j;
      } catch (e) { /* tab without proxy frame – try next */ }
    }
    throw new Error('Direct access failed and no zoomscores.ng tab is open to relay through. Open https://www.zoomscores.ng in a tab.');
  }

  async function call(path, cid, { method = 'GET', body } = {}) {
    const url = BASE + path;
    const init = { method, headers: { 'Content-Type': 'application/json', clientId: String(cid) }, body: body ? JSON.stringify(body) : undefined, credentials: 'omit', cache: 'no-store' };
    let j;
    if (Date.now() < proxyUntil) {
      j = await viaTab(url, init);
    } else {
      try {
        j = await direct(url, init);
        if (j && j.status !== 1 && j.error && j.error.code === -24499) throw Object.assign(new Error(j.error.message), { transport: true });
      } catch (e) {
        if (!(e instanceof TypeError) && !e.transport) throw e;
        j = await viaTab(url, init);
        proxyUntil = Date.now() + 30 * 60e3;
      }
    }
    if (!j || j.status !== 1) throw new Error((j && j.error && j.error.message) || 'API error');
    return j.data;
  }

  return {
    init: cid => call('/Competition/Init', cid, { method: 'POST', body: { clientId: String(cid), isShop: 0 } }),
    results: (cid, comp, prev, offset) => call(`/SeasonResult/Results?clientId=${cid}&competitionId=${comp}&previous=${prev ? 1 : 0}&offset=${offset}&limit=20`, cid),
    standings: (cid, comp, prev) => call(`/SeasonResult/Statistics?clientId=${cid}&competitionId=${comp}&previous=${prev ? 1 : 0}`, cid),
    matchStats: (cid, matchId) => call(`/MatchStatistics/MatchStatistics?clientId=${cid}&matchId=${matchId}`, cid),
    nextRound: (cid, roundId) => call(`/Competition/RoundTimeOffset?clientId=${cid}&roundId=${roundId}`, cid)
  };
})();
