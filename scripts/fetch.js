// scripts/fetch.js
// Scheduled collector - runs every 4 hours from .github/workflows/fetch-schedule.yml
// HD channels: Foxtel API - today + 2 days
// 4K channels: DAZN API  - two calls (6 days back + 6 days forward)
// Date bucketing: IST (Asia/Kolkata) throughout. The frontend re-buckets into the
// viewer's timezone at render time, so a day file can span two local dates.

const https = require('https');
const zlib  = require('zlib');
const fs    = require('fs');
const path  = require('path');
const { HttpsProxyAgent } = require('https-proxy-agent');

const REGION_ID = process.env.REGION_ID || '8336';

// ── Optional proxy for DAZN calls only (Foxtel/HD calls never use it) ───────
// Set these as GitHub Actions secrets: PROXY_HOST, PROXY_PORT, PROXY_USER, PROXY_PASS
function buildDaznProxyAgent() {
  const host = process.env.PROXY_HOST;
  const port = process.env.PROXY_PORT;
  if (!host || !port) return null; // no proxy configured, falls back to direct
  const user = process.env.PROXY_USER;
  const pass = process.env.PROXY_PASS;
  const auth = (user && pass) ? `${encodeURIComponent(user)}:${encodeURIComponent(pass)}@` : '';
  const proxyUrl = `http://${auth}${host}:${port}`;
  return new HttpsProxyAgent(proxyUrl);
}
const DAZN_PROXY_AGENT = buildDaznProxyAgent();

// ── HD Channels - Foxtel webepg API ──────────────────────────────────────────
const CHANNELS = [
  { tag: 'FSN', name: 'Fox Sports News HD', number: '500' },
  { tag: 'FS1', name: 'Fox Cricket HD',     number: '501' },
  { tag: 'SP2', name: 'Fox League HD',      number: '502' },
  { tag: 'FS3', name: 'Fox Sports 503 HD',  number: '503' },
  { tag: 'FAF', name: 'Fox Footy HD',       number: '504' },
  { tag: 'FSP', name: 'Fox Sports 505 HD',  number: '505' },
  { tag: 'SPS', name: 'Fox Sports 506 HD',  number: '506' },
  { tag: 'FSS', name: 'Fox Sports 507 HD',  number: '507' },
  { tag: 'ESP', name: 'ESPN HD',            number: '508' },
  { tag: 'ES2', name: 'ESPN2 HD',           number: '509' },
  { tag: 'RTV', name: 'Racing.com HD',      number: '529' },
  { tag: 'UFC', name: 'Main Event UFC',     number: '523' },
];

// ── 4K Channels - DAZN EPG API ───────────────────────────────────────────────
const CHANNELS_4K = [
  { tag: '4KL',  name: 'Fox League 4K'  },
  { tag: '4KF1', name: 'Fox F1 4K'      },
  { tag: '4KF',  name: 'Fox Footy 4K'   },
  { tag: '4KF2', name: 'Fox Footy 2 4K' },
  { tag: '4KN',  name: 'Fox Netball 4K' },
];

// linearProvider -> 4K EPG code
// fsa501 included - cricket explicitly flagged 4K by API goes to Fox League 4K
const PROVIDER_TO_4K = {
  'fsa501': '4KL',
  'fsa502': '4KL',
  'fsa506': '4KF1',
  'fsa504': '4KF',
  'fsa503': '4KF2',
  'fsa505': '4KN',
};

// Competitions guaranteed to always broadcast in 4K
// Cricket is NOT here - only included when API explicitly flags is4k:true
// Competitions broadcast in 4K without exception, so the API flag can be skipped.
// Cricket is not here: only Australia men's home matches go out in 4K, and fsa501
// routes all cricket to Fox League 4K, so it needs the explicit is4k flag or the
// guide fills with 4K fixtures that were never broadcast that way.
const GUARANTEED_4K_COMPS = new Set(['AFL', 'Formula 1', 'Suncorp Super Netball']);

// Duration fallbacks (minutes) - only used when API provides no end time
const DURATION_FALLBACK = {
  'Australian Rules Football': 130,
  'Netball':                    90,
  'Formula 1':                 180,
  'Rugby League':              100,
  'Cricket':                   480,
};
const DEFAULT_DURATION = 120;

// Retention window in cleanup.js (21 days) plus today and the furthest day fetched
// ahead. HD only reaches +2, but 4K reaches +6, so the cap is sized for 4K: a dense
// 4K channel would otherwise have its oldest dates dropped from the index while the
// files remained on disk. Keep in sync with MAX_DAYS in cleanup.js.
const MAX_INDEX_DATES = 28;

// ── Shared helpers ────────────────────────────────────────────────────────────

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
];

function getFoxtelHeaders() {
  return {
    'User-Agent':      USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)],
    'Accept':          'application/json, text/plain, */*',
    'Accept-Language': 'en-AU,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Referer':         'https://www.foxtel.com.au/tv-guide/',
    'Origin':          'https://www.foxtel.com.au',
    'Connection':      'keep-alive',
    'Cache-Control':   'no-cache',
    'Sec-Fetch-Dest':  'empty',
    'Sec-Fetch-Mode':  'cors',
    'Sec-Fetch-Site':  'same-origin',
  };
}

function getDaznHeaders() {
  return {
    'User-Agent':      USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)],
    'Accept':          'application/json, text/plain, */*',
    'Accept-Language': 'en-AU,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Origin':          'https://kayosports.com.au',
    'Referer':         'https://kayosports.com.au/',
    'Sec-Fetch-Dest':  'empty',
    'Sec-Fetch-Mode':  'cors',
    'Sec-Fetch-Site':  'cross-site',
    'Cache-Control':   'no-cache',
    'Pragma':          'no-cache',
  };
}

function originalUrl(u) { try { return u.split('?')[0]; } catch { return u; } }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Day boundaries in IST. Returns the date string plus the epoch-ms bounds of that
// day - file naming, index entries and cleanup arithmetic all key off this.
function getISTDay(offset = 0) {
  const base = new Date(new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }) + 'T00:00:00+05:30');
  base.setDate(base.getDate() + offset);
  const date    = base.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const startMs = new Date(date + 'T00:00:00+05:30').getTime();
  const endMs   = new Date(date + 'T23:59:59+05:30').getTime();
  return { date, startMs, endMs };
}

function msToISTDate(ms) {
  return new Date(ms).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

function fetchJson(url, customHeaders, agent) {
  return new Promise((resolve, reject) => {
    const headers = customHeaders || getFoxtelHeaders();
    const opts = { headers, timeout: 30000 };
    if (agent) opts.agent = agent;
    const req = https.get(url, opts, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302)
        return fetchJson(res.headers.location, customHeaders, agent).then(resolve).catch(reject);
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      const enc = res.headers['content-encoding'];
      let stream = res;
      if (enc === 'gzip')         stream = res.pipe(zlib.createGunzip());
      else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
      else if (enc === 'br')      stream = res.pipe(zlib.createBrotliDecompress());
      const chunks = [];
      stream.on('data', c => chunks.push(c));
      stream.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (e) { reject(new Error(`JSON parse: ${e.message}`)); }
      });
      stream.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// Linear backoff - 4s, then 8s. Upstream failures are usually transient.
async function fetchWithRetry(url, max = 3, customHeaders, agent) {
  for (let i = 1; i <= max; i++) {
    try { return await fetchJson(url, customHeaders, agent); }
    catch (e) {
      console.log(`  Attempt ${i}/${max} failed: ${e.message}`);
      if (i < max) await sleep(i * 4000); else throw e;
    }
  }
}

// Dedupe on eventId - the bounded and unbounded queries for today overlap.
function mergeEvents(a, b) {
  const map = new Map();
  [...a, ...b].forEach(ev => map.set(ev.eventId, ev));
  return Array.from(map.values()).sort((x, y) => x.scheduledDate - y.scheduledDate);
}

// The frontend can't list a directory over the raw CDN, so available dates are
// published explicitly in data/index.json.
function updateIndex(tag, date) {
  const indexPath = path.join('data', 'index.json');
  let index = {};
  try { index = JSON.parse(fs.readFileSync(indexPath, 'utf8')); } catch {}
  if (!index[tag]) index[tag] = [];
  if (!index[tag].includes(date)) {
    index[tag].push(date);
    index[tag].sort((a, b) => b.localeCompare(a));
    index[tag] = index[tag].slice(0, MAX_INDEX_DATES);
  }
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));
}

// 4K folders can sit empty for weeks between fixtures, and git won't track an
// empty directory.
function ensureGitkeep() {
  for (const ch of CHANNELS_4K) {
    const dir     = path.join('data', ch.tag);
    const gitkeep = path.join(dir, '.gitkeep');
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(gitkeep, '');
      console.log(`  Created data/${ch.tag}/.gitkeep`);
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  SECTION 1 - HD CHANNELS (Foxtel API)
// ═════════════════════════════════════════════════════════════════════════════

async function fetchDayForChannel(tag, offset) {
  const { date, startMs, endMs } = getISTDay(offset);
  const labels = ['today', 'tomorrow', 'day after'];
  const label  = labels[offset] || `+${offset}d`;
  const dir    = path.join('data', tag);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  let events = [];
  try {
    const url  = `https://www.foxtel.com.au/webepg/ws/foxtel/channel/${tag}/events?movieHeight=110&tvShowHeight=90&regionId=${REGION_ID}&startDate=${startMs}&endDate=${endMs}`;
    const json = await fetchWithRetry(url);
    events = json.events || [];
  } catch (e) {
    console.log(`  [${tag}] ${label} failed: ${e.message}`);
    throw e;
  }

  // For today, also hit the default (unbounded) endpoint. It returns whatever
  // Foxtel considers "now", which sometimes catches events the bounded query
  // misses around the day edges.
  if (offset === 0) {
    try {
      const defJson = await fetchWithRetry(`https://www.foxtel.com.au/webepg/ws/foxtel/channel/${tag}/events?movieHeight=110&tvShowHeight=90&regionId=${REGION_ID}`);
      events = mergeEvents(events, defJson.events || []);
    } catch (e) {}
  }

  if (!events.length) { console.log(`  [${tag}] ${label}: no events`); return; }

  // Strip the query string so the original asset is served, not a resized variant
  const processed = events.map(ev => ({ ...ev, imageUrl: originalUrl(ev.imageUrl) }));

  const payload = {
    channel:      tag,
    date,
    label,
    fetchedAt:    Date.now(),
    fetchedAtIST: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
    events:       processed,
  };

  fs.writeFileSync(path.join(dir, `${date}.json`), JSON.stringify(payload, null, 2));
  // latest.json gives the frontend a fixed URL to hit before it knows the server's date
  if (offset === 0) fs.writeFileSync(path.join(dir, 'latest.json'), JSON.stringify(payload, null, 2));
  updateIndex(tag, date);
  console.log(`  [${tag}] ✓ ${label} (${date}): ${processed.length} events`);
}

// ═════════════════════════════════════════════════════════════════════════════
//  SECTION 2 - 4K CHANNELS (DAZN API)
//  4K events = explicitly flagged by API (is4k:true) OR guaranteed competition
//  Guaranteed: AFL, Formula 1, Suncorp Super Netball
//  Cricket: only when API explicitly flags is4k:true
// ═════════════════════════════════════════════════════════════════════════════

function buildImageUrl4K(imageField) {
  const BASE = 'https://image.discovery.indazn.com/jp/v3/jp/none';
  if (imageField && typeof imageField === 'object') {
    const id = imageField.Id || '';
    if (id) return `${BASE}/${id}/fill/none/top/none/80/1920/1080/webp/image?brand=kayo`;
  }
  if (typeof imageField === 'string' && imageField.startsWith('http')) return imageField;
  return '';
}

function parseUtcMs(s) {
  if (!s) return null;
  const d = new Date(s.endsWith('Z') ? s : s + 'Z');
  return isNaN(d.getTime()) ? null : d.getTime();
}

async function fetchDaznRaw(startDate, endDate) {
  const params = new URLSearchParams({
    country:        'au',
    languageCode:   'en',
    openBrowse:     'true',
    timeZoneOffset: '570',
    startDate,
    endDate,
    brand:          'kayo',
  });
  const url  = `https://epg.discovery.indazn.com/eu/v5/epgWithDatesRange?${params}`;
  const data = await fetchWithRetry(url, 3, getDaznHeaders(), DAZN_PROXY_AGENT);
  const days = Array.isArray(data) ? data : [data];
  const raw  = [];
  for (const day of days) {
    for (const event of (day.Tiles || [])) raw.push(event);
  }
  return raw;
}

function process4KEvents(rawEvents) {
  const durById = new Map();
  for (const ev of rawEvents) {
    const eid     = String(ev.EventId || ev.Id || '');
    const startMs = parseUtcMs(ev.EventStartTime || ev.Start || '');
    const endMs   = parseUtcMs(ev.EventEndTime   || ev.End   || '');
    if (eid && startMs && endMs) {
      const dur = Math.round((endMs - startMs) / 60000);
      if (dur > 0) durById.set(eid, dur);
    }
  }

  const processed = [];
  const seen      = new Set();

  for (const ev of rawEvents) {
    const provider = ev.LinearProvider || '';
    const epgCode  = PROVIDER_TO_4K[provider];
    if (!epgCode) continue;

    const he         = ev.HeEventTypeConfig || {};
    const explicit4k = he.is4k === true || he.is4kUpscaled === true;
    const comp       = ev.Competition || {};
    const compTitle  = (typeof comp === 'object' ? comp.Title : '') || '';
    const guaranteed = GUARANTEED_4K_COMPS.has(compTitle);

    // Include if explicitly flagged OR guaranteed competition
    if (!explicit4k && !guaranteed) continue;

    const startMs = parseUtcMs(ev.EventStartTime || ev.Start || '');
    if (!startMs) continue;

    const eid = String(ev.EventId || ev.Id || '');
    if (!eid) continue;

    // The past and future range calls overlap at today, so the same event arrives twice
    const dedupKey = `${epgCode}:${eid}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    const sport      = ev.Sport || {};
    const sportTitle = (typeof sport === 'object' ? sport.Title : '') || '';
    const duration   = durById.get(eid) || DURATION_FALLBACK[sportTitle] || DEFAULT_DURATION;

    const imageRaw = ev.ImageUrl || ev.ImageURL || ev.Image || ev.Thumbnail || {};
    const imageUrl = buildImageUrl4K(imageRaw);
    const istDate  = msToISTDate(startMs);

    processed.push({
      epgCode,
      istDate,
      eventId:          eid,
      programTitle:     ev.Title || '',
      scheduledDate:    startMs,
      duration,
      imageUrl,
      competitionTitle: compTitle,
      sport:            sportTitle,
    });
  }

  return processed;
}

function write4KFiles(processed, todayIST) {
  const groups = new Map();
  for (const ev of processed) {
    const key = `${ev.epgCode}::${ev.istDate}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(ev);
  }

  const tomorrowIST = getISTDay(1).date;
  let written = 0;

  for (const [key, events] of groups) {
    const [tag, date] = key.split('::');
    events.sort((a, b) => a.scheduledDate - b.scheduledDate);

    // Snapshot at write time - goes stale within hours. The frontend ignores it
    // and works from `date` and `scheduledDate`.
    const label = date === todayIST    ? 'today'
                : date === tomorrowIST ? 'tomorrow'
                : date < todayIST      ? 'aired'
                : 'upcoming';

    const cleanEvents = events.map(({ epgCode, istDate, ...rest }) => rest);

    const payload = {
      channel:      tag,
      date,
      label,
      fetchedAt:    Date.now(),
      fetchedAtIST: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
      events:       cleanEvents,
    };

    const dir = path.join('data', tag);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    fs.writeFileSync(path.join(dir, `${date}.json`), JSON.stringify(payload, null, 2));
    if (date === todayIST)
      fs.writeFileSync(path.join(dir, 'latest.json'), JSON.stringify(payload, null, 2));

    updateIndex(tag, date);
    console.log(`  [${tag}] ✓ ${label} (${date}): ${cleanEvents.length} events`);
    written++;
  }

  return written;
}

async function fetch4KSection(todayIST) {
  const pastStr   = getISTDay(-6).date;
  const futureStr = getISTDay(6).date;

  let allRaw = [];

  console.log(`  Call 1 (past):   ${pastStr} → ${todayIST}`);
  try {
    const raw1 = await fetchDaznRaw(pastStr, todayIST);
    console.log(`  Got ${raw1.length} raw events`);
    allRaw = allRaw.concat(raw1);
  } catch (e) {
    console.log(`  ⚠️  Past call failed: ${e.message}`);
  }

  await sleep(2000);

  console.log(`  Call 2 (future): ${todayIST} → ${futureStr}`);
  try {
    const raw2 = await fetchDaznRaw(todayIST, futureStr);
    console.log(`  Got ${raw2.length} raw events`);
    allRaw = allRaw.concat(raw2);
  } catch (e) {
    console.log(`  ⚠️  Future call failed: ${e.message}`);
  }

  console.log(`  Total raw: ${allRaw.length}`);

  const processed = process4KEvents(allRaw);

  const byCh = {};
  for (const ev of processed) byCh[ev.epgCode] = (byCh[ev.epgCode] || 0) + 1;
  for (const ch of CHANNELS_4K)
    console.log(`  ${ch.name} (${ch.tag}): ${byCh[ch.tag] || 0} events`);

  const written = write4KFiles(processed, todayIST);
  console.log(`\n✅ 4K done — ${written} files written.`);
}

// ═════════════════════════════════════════════════════════════════════════════
//  MAIN
// ═════════════════════════════════════════════════════════════════════════════

(async () => {
  if (!fs.existsSync('data')) fs.mkdirSync('data');

  // Left over from an earlier version that cached images locally
  const imagesDir = path.join('data', 'images');
  if (fs.existsSync(imagesDir)) {
    fs.rmSync(imagesDir, { recursive: true, force: true });
    console.log('Removed old data/images folder');
  }

  ensureGitkeep();

  const todayIST = getISTDay(0).date;

  // ── HD channels ──────────────────────────────────────────────────────────
  console.log('\n══ HD CHANNELS (Foxtel API) ══════════════════════════════');
  let hdFailed = 0;
  for (const ch of CHANNELS) {
    console.log(`\n── ${ch.name} (${ch.tag}) ──`);
    for (const offset of [0, 1, 2]) {
      try { await fetchDayForChannel(ch.tag, offset); await sleep(1000); }
      catch (e) { console.error(`  [${ch.tag}] +${offset}d failed: ${e.message}`); hdFailed++; }
    }
    await sleep(1500);
  }
  console.log(`\n✅ HD done — ${CHANNELS.length} channels × 3 days. ${hdFailed} failures.`);

  // ── 4K channels ──────────────────────────────────────────────────────────
  console.log('\n══ 4K CHANNELS (DAZN API) ════════════════════════════════');
  console.log(DAZN_PROXY_AGENT ? `  Using proxy: ${process.env.PROXY_HOST}:${process.env.PROXY_PORT}` : '  No proxy configured (direct connection)');
  let fourKFailed = 0;
  try {
    await fetch4KSection(todayIST);
  } catch (e) {
    console.error(`\n❌ 4K fetch failed: ${e.message}`);
    fourKFailed = 1;
  }

  if (hdFailed > 0 || fourKFailed > 0) process.exit(1);
})();
