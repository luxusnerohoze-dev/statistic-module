// LCD Štatistiky – lokálny server, ktorý server-side volá API (Meta, Google Ads,
// GA4, Search Console, YouTube) a vracia jeden JSON pre dashboard.
// Tajné kľúče číta z config.local.json (NEpushuje sa). Verejné ID trhov z markets.json.
//
// v0.3:
//  - História cez store.js (better-sqlite3 ak je, inak JSON) s idempotentným upsertom.
//  - YouTube: reálna denná história odberateľov cez YouTube Analytics API (OAuth),
//    ak sú vyplnené youtube.oauth údaje. Inak fallback na denné snapshoty.
//  - Provizórne dni (dnes/včera) označené pre UI (dáta sa ešte môžu meniť).
//  - Ľahký cache (TTL), aby sa API nezaťažovali pri každom obnovení.

'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { createStore, migrateSnapshots } = require('./store');

const PORT = 4787;
const DIR = __dirname;
const DATA_DIR = path.join(DIR, 'data');
const SNAP_FILE = path.join(DATA_DIR, 'snapshots.json'); // starý formát (migruje sa raz)
const V = 'v21.0';
const YT_REFERER = 'https://luxurycardesign.sk/';

function loadJSON(p, fb) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return fb; } }

const cfg = loadJSON(path.join(DIR, 'config.local.json'), null);
const marketsCfg = loadJSON(path.join(DIR, 'markets.json'), { markets: [] });
const PERIOD = (cfg && cfg.period_days) || 30;
const CACHE_TTL = ((cfg && cfg.cache_minutes != null) ? cfg.cache_minutes : 15) * 60000;

const store = createStore(DATA_DIR);
migrateSnapshots(store, SNAP_FILE); // jednorazovo prenesie staré snapshoty

const num = (x) => (x == null || isNaN(x)) ? 0 : Number(x);
const isoDaysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
const isoToday = () => new Date().toISOString().slice(0, 10);
function metaErr(e) {
  if (!e) return 'neznáma chyba';
  return (e.message || 'chyba') + ' [code ' + e.code +
    (e.error_subcode ? '/' + e.error_subcode : '') + (e.type ? ', ' + e.type : '') + ']';
}

// ── TREND – čisté funkcie (testovateľné) ──
function flow7(series) {
  if (!Array.isArray(series) || series.length < 8) return null;
  const v = series.map((p) => num(p.v));
  const last7 = v.slice(-7).reduce((a, b) => a + b, 0);
  const prev7 = v.slice(-14, -7).reduce((a, b) => a + b, 0);
  if (prev7 === 0) return null;
  return ((last7 - prev7) / prev7) * 100;
}
function stock7(series) {
  if (!Array.isArray(series) || series.length < 2) return null;
  const today = series[series.length - 1];
  const target = new Date(today.d + 'T00:00:00Z');
  target.setUTCDate(target.getUTCDate() - 7);
  let best = null;
  for (const p of series) { if (new Date(p.d + 'T00:00:00Z') <= target) best = p; }
  if (!best) best = series[0];
  if (best.d === today.d || num(best.v) === 0) return null;
  return ((num(today.v) - num(best.v)) / num(best.v)) * 100;
}

// ── OAuth refresh (zdieľané pre Google Ads aj YouTube) ──
function makeTokenCache() { return { token: null, exp: 0 }; }
async function refreshToken(cache, creds, label) {
  if (cache.token && Date.now() < cache.exp) return cache.token;
  if (!creds || !creds.client_id || !creds.refresh_token) throw new Error('chýbajú ' + label + ' OAuth údaje');
  const body = new URLSearchParams({
    client_id: creds.client_id, client_secret: creds.client_secret,
    refresh_token: creds.refresh_token, grant_type: 'refresh_token'
  });
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body
  });
  const j = await r.json();
  if (!j.access_token) throw new Error(label + ' OAuth: ' + (j.error_description || j.error || 'bez tokenu'));
  cache.token = j.access_token; cache.exp = Date.now() + (num(j.expires_in) - 60) * 1000;
  return cache.token;
}
const _gtok = makeTokenCache();
const _ytok = makeTokenCache();
const googleToken = () => refreshToken(_gtok, (cfg && cfg.google_ads) || {}, 'Google');
const youtubeOAuthToken = () => refreshToken(_ytok, (cfg && cfg.youtube && cfg.youtube.oauth) || {}, 'YouTube');

// ── Google Ads (per trh) – denný rozpad ──
async function googleAds(customerId) {
  const g = (cfg && cfg.google_ads) || {};
  if (!g.developer_token) throw new Error('chýba developer_token');
  const at = await googleToken();
  const headers = {
    'Authorization': 'Bearer ' + at, 'developer-token': g.developer_token, 'Content-Type': 'application/json'
  };
  if (g.login_customer_id) headers['login-customer-id'] = String(g.login_customer_id).replace(/-/g, '');
  const query = "SELECT segments.date, metrics.cost_micros, metrics.conversions, metrics.conversions_value, " +
    "metrics.clicks, metrics.impressions FROM customer " +
    "WHERE segments.date BETWEEN '" + isoDaysAgo(PERIOD) + "' AND '" + isoToday() + "' ORDER BY segments.date";
  const r = await fetch('https://googleads.googleapis.com/v23/customers/' + customerId + '/googleAds:search',
    { method: 'POST', headers, body: JSON.stringify({ query }) });
  const text = await r.text();
  let j;
  try { j = JSON.parse(text); } catch (e) { throw new Error('HTTP ' + r.status + ' (nečakaná odpoveď): ' + text.slice(0, 140)); }
  if (j.error) throw new Error((j.error.message || 'Google Ads chyba') + ' [' + (j.error.status || r.status) + ']');
  let spend = 0, conv = 0, val = 0, clicks = 0, impr = 0;
  const byDay = {};
  (j.results || []).forEach((row) => {
    const m = row.metrics || {};
    const d = (row.segments && row.segments.date) || null;
    const daySpend = num(m.costMicros) / 1e6;
    spend += daySpend; conv += num(m.conversions); val += num(m.conversionsValue);
    clicks += num(m.clicks); impr += num(m.impressions);
    if (d) byDay[d] = (byDay[d] || 0) + daySpend;
  });
  const series = Object.keys(byDay).sort().map((d) => ({ d, v: byDay[d] }));
  return { spend, conversions: conv, conversionValue: val, clicks, impressions: impr, roas: spend > 0 ? val / spend : 0, series };
}

// ── GA4 (per trh) – denný rozpad ──
async function ga4(propertyId) {
  const at = await googleToken();
  const body = {
    dateRanges: [{ startDate: PERIOD + 'daysAgo', endDate: 'today' }],
    dimensions: [{ name: 'date' }],
    metrics: [{ name: 'sessions' }, { name: 'totalUsers' }, { name: 'conversions' }, { name: 'screenPageViews' }],
    orderBys: [{ dimension: { dimensionName: 'date' } }]
  };
  const r = await fetch('https://analyticsdata.googleapis.com/v1beta/properties/' + propertyId + ':runReport',
    { method: 'POST', headers: { 'Authorization': 'Bearer ' + at, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || 'GA4 chyba');
  let sessions = 0, users = 0, conv = 0, pv = 0;
  const series = [];
  (j.rows || []).forEach((row) => {
    const dv = (row.dimensionValues && row.dimensionValues[0] && row.dimensionValues[0].value) || '';
    const mv = row.metricValues || [];
    const s = mv[0] ? num(mv[0].value) : 0;
    sessions += s; users += mv[1] ? num(mv[1].value) : 0;
    conv += mv[2] ? num(mv[2].value) : 0; pv += mv[3] ? num(mv[3].value) : 0;
    if (dv.length === 8) series.push({ d: dv.slice(0, 4) + '-' + dv.slice(4, 6) + '-' + dv.slice(6, 8), v: s });
  });
  series.sort((a, b) => a.d < b.d ? -1 : 1);
  return { sessions, users, conversions: conv, pageviews: pv, series };
}

// ── Search Console (per trh) – denný rozpad ──
async function gsc(siteUrl) {
  const at = await googleToken();
  const url = 'https://www.googleapis.com/webmasters/v3/sites/' + encodeURIComponent(siteUrl) + '/searchAnalytics/query';
  const body = { startDate: isoDaysAgo(PERIOD), endDate: isoToday(), dimensions: ['date'] };
  const r = await fetch(url, { method: 'POST', headers: { 'Authorization': 'Bearer ' + at, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || 'GSC chyba');
  let clicks = 0, impr = 0, posWeighted = 0;
  const series = [];
  (j.rows || []).forEach((row) => {
    const d = (row.keys && row.keys[0]) || null;
    const c = num(row.clicks), i = num(row.impressions);
    clicks += c; impr += i; posWeighted += num(row.position) * i;
    if (d) series.push({ d, v: c });
  });
  series.sort((a, b) => a.d < b.d ? -1 : 1);
  return { clicks, impressions: impr, ctr: impr > 0 ? clicks / impr : 0, position: impr > 0 ? posWeighted / impr : 0, series };
}

// ── Meta organika (FB + IG) ──
async function metaOrganic() {
  const m = (cfg && cfg.meta) || {};
  const t = m.access_token;
  if (!t) throw new Error('chýba Meta token');
  const enc = encodeURIComponent(t);
  const out = { facebook: {}, instagram: {} };

  const r = await fetch('https://graph.facebook.com/' + V + '/' + m.facebook_page_id + '?fields=name,fan_count,followers_count&access_token=' + enc);
  const j = await r.json();
  if (j.error) throw new Error('FB: ' + metaErr(j.error));
  out.facebook = { name: j.name, fans: num(j.fan_count), followers: num(j.followers_count) };

  // FB Page insights potrebujú PAGE access token (systémový token vracia chybu #190).
  // Vytiahneme ho zo systémového tokenu. page_impressions je už zrušené – berieme metriky,
  // ktoré reálne vracajú dáta: zobrazenia stránky, interakcie, noví fanúšikovia (28d).
  let pageTok = null;
  try {
    const rp = await fetch('https://graph.facebook.com/' + V + '/' + m.facebook_page_id + '?fields=access_token&access_token=' + enc);
    const jp = await rp.json();
    if (jp.access_token) pageTok = jp.access_token;
  } catch (e) { /* ostane systémový token */ }
  try {
    const ptok = encodeURIComponent(pageTok || t);
    const r2 = await fetch('https://graph.facebook.com/' + V + '/' + m.facebook_page_id + '/insights?metric=page_post_engagements,page_views_total,page_daily_follows_unique&period=days_28&access_token=' + ptok);
    const j2 = await r2.json();
    (j2.data || []).forEach((d) => {
      const vals = d.values || []; const v = vals.length ? vals[vals.length - 1].value : 0;
      if (d.name === 'page_post_engagements') out.facebook.engagement = num(v);
      if (d.name === 'page_views_total') out.facebook.pageViews = num(v);
      if (d.name === 'page_daily_follows_unique') out.facebook.newFollows = num(v);
    });
  } catch (e) { /* insights nepovinné */ }

  let igId = m.instagram_business_id;
  if (!igId) {
    try {
      const r3 = await fetch('https://graph.facebook.com/' + V + '/' + m.facebook_page_id + '?fields=instagram_business_account&access_token=' + enc);
      const j3 = await r3.json();
      if (j3.instagram_business_account) igId = j3.instagram_business_account.id;
    } catch (e) {}
  }
  if (igId) {
    try {
      const r4 = await fetch('https://graph.facebook.com/' + V + '/' + igId + '?fields=username,followers_count,media_count&access_token=' + enc);
      const j4 = await r4.json();
      if (!j4.error) out.instagram = { username: j4.username, followers: num(j4.followers_count), media: num(j4.media_count) };
      // Organické metriky za 28 dní (period=day + total_value + rozsah since/until).
      const since = isoDaysAgo(28), until = isoToday();
      const r5 = await fetch('https://graph.facebook.com/' + V + '/' + igId +
        '/insights?metric=views,reach,total_interactions,profile_views&period=day&metric_type=total_value&since=' + since + '&until=' + until + '&access_token=' + enc);
      const j5 = await r5.json();
      (j5.data || []).forEach((d) => {
        const tv = d.total_value && d.total_value.value;
        if (d.name === 'views') out.instagram.views = num(tv);
        if (d.name === 'reach') out.instagram.reach = num(tv);
        if (d.name === 'total_interactions') out.instagram.interactions = num(tv);
        if (d.name === 'profile_views') out.instagram.profileViews = num(tv);
      });
    } catch (e) {}
  } else {
    out.instagram = { note: 'IG business účet nenájdený' };
  }
  return out;
}

// ── Meta Ads – denný rozpad ──
async function metaAds() {
  const m = (cfg && cfg.meta) || {};
  const t = m.access_token;
  if (!t || !m.ad_account_id) throw new Error('chýba Meta token / ad_account_id');
  const acct = String(m.ad_account_id).startsWith('act_') ? m.ad_account_id : ('act_' + m.ad_account_id);
  const r = await fetch('https://graph.facebook.com/' + V + '/' + acct +
    '/insights?fields=spend,action_values&time_increment=1&date_preset=last_30d&access_token=' + encodeURIComponent(t));
  const j = await r.json();
  if (j.error) throw new Error('Meta Ads: ' + metaErr(j.error));
  let spend = 0, val = 0;
  const series = [];
  // POZOR: Meta vracia hodnotu nákupu pod ~6 rôznymi action_type (purchase, onsite_web_purchase,
  // offsite_conversion.fb_pixel_purchase, omni_purchase…) – sú to DUPLICITY tej istej tržby.
  // Berieme LEN 'omni_purchase' (Meta kanonický súčet), inak by sa ROAS znásobil 6×.
  (j.data || []).forEach((row) => {
    const daySpend = num(row.spend);
    spend += daySpend;
    (row.action_values || []).forEach((a) => { if (a.action_type === 'omni_purchase') val += num(a.value); });
    if (row.date_start) series.push({ d: row.date_start, v: daySpend });
  });
  series.sort((a, b) => a.d < b.d ? -1 : 1);
  return { spend, conversionValue: val, roas: spend > 0 ? val / spend : 0, series };
}

// ── YouTube – aktuálne čísla (Data API, stačí api_key) ──
async function youtube() {
  const y = (cfg && cfg.youtube) || {};
  if (!y.api_key || !y.channel_id) throw new Error('chýba YouTube api_key/channel_id');
  const r = await fetch('https://www.googleapis.com/youtube/v3/channels?part=statistics,snippet&id=' + y.channel_id + '&key=' + y.api_key,
    { headers: { 'Referer': YT_REFERER } });
  const j = await r.json();
  if (j.error) throw new Error('YouTube: ' + (j.error.message || ''));
  const it = (j.items && j.items[0]) || {};
  const s = it.statistics || {};
  return { title: it.snippet && it.snippet.title, subscribers: num(s.subscriberCount), views: num(s.viewCount), videos: num(s.videoCount) };
}

// ── YouTube Analytics – REÁLNA denná história (OAuth) ──
// Vráti absolútny rad odberateľov (rekonštruovaný z denných gained/lost a aktuálneho počtu).
async function youtubeAnalytics(currentSubs) {
  const at = await youtubeOAuthToken();
  const start = isoDaysAgo(Math.max(PERIOD, 90));
  const url = 'https://youtubeanalytics.googleapis.com/v2/reports?ids=channel==MINE' +
    '&startDate=' + start + '&endDate=' + isoToday() +
    '&metrics=views,subscribersGained,subscribersLost&dimensions=day&sort=day';
  const r = await fetch(url, { headers: { 'Authorization': 'Bearer ' + at } });
  const j = await r.json();
  if (j.error) throw new Error('YT Analytics: ' + (j.error.message || JSON.stringify(j.error)));
  const rows = j.rows || []; // [day, views, gained, lost]
  const days = rows.map((row) => ({ d: row[0], views: num(row[1]), net: num(row[2]) - num(row[3]) }));
  // rekonštrukcia absolútneho počtu odberateľov spätne od aktuálneho čísla
  let running = num(currentSubs);
  const subs = new Array(days.length);
  for (let i = days.length - 1; i >= 0; i--) { subs[i] = { d: days[i].d, v: running }; running -= days[i].net; }
  return { subsSeries: subs, viewsDaily: days.map((x) => ({ d: x.d, v: x.views })) };
}

// ── Meta diagnostika tokenu ──
async function metaDebug() {
  const m = (cfg && cfg.meta) || {};
  const t = m.access_token;
  if (!t) return { error: 'v configu chýba meta.access_token' };
  try {
    const r = await fetch('https://graph.facebook.com/' + V + '/debug_token?input_token=' + encodeURIComponent(t) + '&access_token=' + encodeURIComponent(t));
    const j = await r.json();
    if (j.error) return { error: metaErr(j.error) };
    const d = j.data || {};
    const when = (s) => !s ? 'n/a' : (s === 0 ? 'trvalý (nikdy)' : new Date(s * 1000).toLocaleString('sk-SK'));
    return {
      valid: !!d.is_valid, type: d.type, app_id: d.app_id,
      expires_at: when(d.expires_at), data_access_expires_at: when(d.data_access_expires_at),
      scopes: (d.scopes || []).join(', '),
      token_error: d.error ? (d.error.message || String(d.error)) : null
    };
  } catch (e) { return { error: String(e.message || e) }; }
}

// ── Agregátor ──
async function buildStats() {
  const result = {
    period_days: PERIOD, generated: new Date().toISOString(),
    organic: {}, ppc: { google: {}, meta: null }, web: { ga4: {}, gsc: {} },
    tiktok: { active: false, note: 'Bez tokenu / Ads Manager CONTRACT_PENDING – napojíme po aktivácii.' },
    series: {}, deltas: {}, errors: {},
    provisional_from: isoDaysAgo(1), // body s dátumom >= toto sú provizórne (dnes/včera)
    store_engine: store.engine
  };
  const run = async (label, fn) => { try { return await fn(); } catch (e) { result.errors[label] = String(e.message || e); return null; } };

  result.organic.meta = await run('meta', metaOrganic);
  if (!result.organic.meta) result.meta_debug = await metaDebug();
  result.organic.youtube = await run('youtube', youtube);
  result.ppc.meta = await run('meta_ads', metaAds);

  for (const mk of (marketsCfg.markets || [])) {
    result.ppc.google[mk.id] = await run('google_ads_' + mk.id, () => googleAds(mk.google_ads_customer_id));
    result.web.ga4[mk.id] = await run('ga4_' + mk.id, () => ga4(mk.ga4_property_id));
    result.web.gsc[mk.id] = await run('gsc_' + mk.id, () => gsc(mk.gsc_site_url));
  }
  result.markets = (marketsCfg.markets || []).map((m) => ({ id: m.id, label: m.label }));

  // ── História stock metrík (sociálne siete) → store ──
  const today = isoToday();
  const meta = result.organic.meta;
  const yt = result.organic.youtube;
  const rows = [];
  if (meta && meta.facebook) rows.push({ metric: 'fb_followers', date: today, value: num(meta.facebook.followers || meta.facebook.fans) });
  if (meta && meta.instagram && meta.instagram.followers != null) rows.push({ metric: 'ig_followers', date: today, value: num(meta.instagram.followers) });
  if (yt) { rows.push({ metric: 'yt_subscribers', date: today, value: num(yt.subscribers) }); rows.push({ metric: 'yt_views', date: today, value: num(yt.views) }); }
  if (rows.length) store.upsertMany(rows);

  // YouTube reálna história (ak je OAuth) – prepíše snapshoty skutočnými dennými dátami
  const ytOauth = cfg && cfg.youtube && cfg.youtube.oauth && cfg.youtube.oauth.refresh_token;
  if (yt && ytOauth) {
    const yh = await run('youtube_analytics', () => youtubeAnalytics(yt.subscribers));
    if (yh && yh.subsSeries.length) {
      store.upsertMany(yh.subsSeries.map((p) => ({ metric: 'yt_subscribers', date: p.d, value: p.v })));
      result.youtube_history = 'analytics_api';
    }
  }

  // ── Série + delty ──
  const setFlow = (key, obj) => {
    const s = (obj && obj.series) || [];
    result.series[key] = s;
    result.deltas[key] = { pct: flow7(s), basis: 'flow7' };
    if (obj && obj.series) delete obj.series;
  };
  const setStock = (key, metric) => {
    const s = store.series(metric);
    result.series[key] = s;
    result.deltas[key] = { pct: stock7(s), basis: 'stock7' };
  };

  setStock('organic_fb', 'fb_followers');
  setStock('organic_ig', 'ig_followers');
  setStock('organic_yt', 'yt_subscribers');
  setFlow('ppc_meta', result.ppc.meta);
  (marketsCfg.markets || []).forEach((mk) => {
    setFlow('gads_' + mk.id, result.ppc.google[mk.id]);
    setFlow('ga4_' + mk.id, result.web.ga4[mk.id]);
    setFlow('gsc_' + mk.id, result.web.gsc[mk.id]);
  });

  return result;
}

// ── HTTP server (s cache) ──
let _cache = { data: null, at: 0 };
function startServer() {
  const server = http.createServer(async (req, res) => {
    if (req.url && req.url.indexOf('/api/stats') === 0) {
      // CORS zámerne nenastavujeme – dashboard je same-origin (localhost:4787),
      // a '*' by umožnil iným webom v prehliadači čítať biznis čísla.
      if (!cfg) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Chýba config.local.json – vyplň kľúče.' })); return; }
      const force = /[?&]force=1/.test(req.url);
      if (!force && _cache.data && (Date.now() - _cache.at) < CACHE_TTL) {
        const cached = Object.assign({}, _cache.data, { cached: true, cache_age_ms: Date.now() - _cache.at });
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(cached)); return;
      }
      try {
        const data = await buildStats();
        _cache = { data, at: Date.now() };
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data));
      } catch (e) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: String(e.message || e) })); }
      return;
    }
    let rel = (req.url || '/').split('?')[0];
    if (rel === '/' || rel === '') rel = '/index.html';
    const safe = path.normalize(rel).replace(/^(\.\.[/\\])+/, '');
    const file = path.join(DIR, safe);
    if (!file.startsWith(DIR)) { res.writeHead(403); res.end('forbidden'); return; }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      const ext = path.extname(file).toLowerCase();
      const mime = ext === '.js' ? 'application/javascript; charset=utf-8'
        : ext === '.css' ? 'text/css; charset=utf-8'
          : ext === '.json' ? 'application/json; charset=utf-8'
            : ext === '.wasm' ? 'application/wasm'
              : 'text/html; charset=utf-8';
      res.writeHead(200, { 'Content-Type': mime });
      res.end(buf);
    });
  });
  const srv = server.listen(PORT, '127.0.0.1', () => console.log('LCD Štatistiky na http://localhost:' + PORT + ' (store: ' + store.engine + ')'));
  srv.on('error', (e) => { if (e && e.code === 'EADDRINUSE') { console.log('Port ' + PORT + ' obsadeny - pouzijem existujuci'); } else { console.error(e); } });
  return srv;
}

if (require.main === module) startServer();
module.exports = { flow7, stock7, buildStats, startServer, store };
