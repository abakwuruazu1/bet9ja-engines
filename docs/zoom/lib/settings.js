// Shared settings (background + dashboard)
const ZDEFAULTS = {
  clientId: '202',
  syncMin: 3,          // minutes between automatic captures
  deep: true,          // fetch per-match deep stats (possession, shots, saves, site win prob)
  deepPerRun: 40,      // max deep-stat requests per sync run
  disabledComps: [],   // competition ids to skip
  halfLifeH: 336,      // model time-decay half-life in hours (tuned on real data: long memory wins)
  prior: 8,            // shrinkage of team strengths toward league average (tuned)
  totShrink: 0.3,      // pull expected TOTAL goals/corners toward league mean (1 = off; tuned)
  maxHist: 1500,       // max past matches per league used to fit the model
  formN: 10,           // form engine: last N home games of home team / away games of away team
  alpha: 4,            // form engine: pseudo-games of league base rate
  blendW: 0.5,         // blend weight for Poisson (rest = Form)
  conf: 0.70,          // "high confidence" threshold
  liveTab: true,       // keep a pinned zoom live-feed tab open so in-play data streams in
  valueEdge: 0.05,     // live value alert: our probability × site odds − 1 must exceed this
  liveMode: 'anchored',// 'anchored' = goal rates pulled to the site's own live win probabilities; 'engine' = our ratings only
  anchorW: 0.8,        // weight on the site-implied rates in anchored mode
  // ---- tennis
  tennisLiveTab: true, // keep the zoom tennis live page open (pinned) for the in-play feed
  tTau: 0.05,          // player-rating spread around the seed prior (tuned by backtest)
  tBeta: 0.05,         // seed-prior strength (tuned)
  tDetailLimit: 120,   // point-by-point match details fetched per capture run
  tConf: 0.70          // tennis "high confidence" threshold
};

async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return Object.assign({}, ZDEFAULTS, settings || {});
}

async function saveSettings(patch) {
  const cur = await getSettings();
  const next = Object.assign(cur, patch);
  await chrome.storage.local.set({ settings: next });
  return next;
}
