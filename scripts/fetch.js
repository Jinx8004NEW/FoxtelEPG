// scripts/fetch.js — HD channels (Foxtel API) + 4K channels (DAZN API)
// Date bucketing: IST (Asia/Kolkata) throughout — same as existing repo

const https = require('https');
const zlib  = require('zlib');
const fs    = require('fs');
const path  = require('path');

const REGION_ID = process.env.REGION_ID || '8336';

// ── HD Channels — Foxtel webepg API ──────────────────────────────────────────
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

// ── 4K Channels — DAZN EPG API ───────────────────────────────────────────────
const CHANNELS_4K = [
  { tag: '4KL',  name: 'Fox League 4K'  },
  { tag: '4KF1', name: 'Fox F1 4K'      },
  { tag: '4KF',  name: 'Fox Footy 4K'   },
  { tag: '4KF2', name: 'Fox Footy 2 4K' },
  { tag: '4KN',  name: 'Fox Netball 4K' },
];

// linearProvider → 4K EPG code
// fsa501 included — cricket explicitly flagged 4K by API goes to Fox League 4K
const PROVIDER_TO_4K = {
  'fsa501': '4KL',
  'fsa502': '4KL',
  'fsa506': '4KF1',
  'fsa504': '4KF',
  'fsa503': '4KF2',
  'fsa505': '4KN',
};

// Duration fallbacks (minutes) — only used when API provides no end time
const DURATION_FALLBACK = {
  'Australian Rules Football': 130,
  'Netball':                    90,
  'Formula 1':                 180,
  'Rugby League':              100,
  'Cricket':                   480,
};
const DEFAULT_DURATION = 120;

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

// IST date string — same logic as existing repo
function getISTDay(offset = 0) {
  const base = new Date(new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }) + 'T00:00:00+05:30');
  base.setDate(base.getDate() + offset);
  const date    = base.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const startMs = new Date(date + 'T00:00:00+05:30').getTime();
  const endMs   = new Date(date + 'T23:59:59+05:30').getTime();
  return { date, startMs, endMs };
}

// Convert UTC ms timestamp → IST date string (for bucketing 4K events)
function msToISTDate(ms) {
  return new Date(ms).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

function fetchJson(url, customHeaders) {
  return new Promise((resolve, reject) => {
    const headers = customHeaders || getFoxtelHeaders();
    const req = https.get(url, { headers, timeout: 30000 }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302)
        return fetchJson(res.headers.location, customHeaders).then(resolve).catch(reject);
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

async function fetchWithRetry(url, max = 3, customHeaders) {
  for (let i = 1; i <= max; i++) {
    try { return await fetchJson(url, customHeaders); }
    catch (e) {
      console.log(`  Attempt ${i}/${max} failed: ${e.message}`);
      if (i < max) await sleep(i * 4000); else throw e;
    }
  }
}

function mergeEvents(a, b) {
  const map = new Map();
  [...a, ...b].forEach(ev => map.set(ev.eventId, ev));
  return Array.from(map.values()).sort((x, y) => x.scheduledDate - y.scheduledDate);
}

function updateIndex(tag, date) {
  const indexPath = path.join('data', 'index.json');
  let index = {};
  try { index = JSON.parse(fs.readFileSync(indexPath, 'utf8')); } catch {}
  if (!index[tag]) index[tag] = [];
  if (!index[tag].includes(date)) {
    index[tag].push(date);
    index[tag].sort((a, b) => b.localeCompare(a));
    index[tag] = index[tag].slice(0, 24);
  }
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));
}

// Create data/4Kxx/.gitkeep on first run so folders exist in repo
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
//  SECTION 1 — HD CHANNELS (Foxtel API) — unchanged logic
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

  if (offset === 0) {
    try {
      const defJson = await fetchWithRetry(`https://www.foxtel.com.au/webepg/ws/foxtel/channel/${tag}/events?movieHeight=110&tvShowHeight=90&regionId=${REGION_ID}`);
      events = mergeEvents(events, defJson.events || []);
    } catch (e) {}
  }

  if (!events.length) { console.log(`  [${tag}] ${label}: no events`); return; }

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
  if (offset === 0) fs.writeFileSync(path.join(dir, 'latest.json'), JSON.stringify(payload, null, 2));
  updateIndex(tag, date);
  console.log(`  [${tag}] ✓ ${label} (${date}): ${processed.length} events`);
}

// ═════════════════════════════════════════════════════════════════════════════
//  SECTION 2 — 4K CHANNELS (DAZN API)
//  Only events explicitly flagged is4k:true or is4kUpscaled:true by the API
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
  const data = await fetchWithRetry(url, 3, getDaznHeaders());
  const days = Array.isArray(data) ? data : [data];
  const raw  = [];
  for (const day of days) {
    for (const event of (day.Tiles || [])) raw.push(event);
  }
  return raw;
}

function process4KEvents(rawEvents) {
  // Build duration map from events that have both start + end time
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

    // Only include events explicitly flagged as 4K by the API
    const he         = ev.HeEventTypeConfig || {};
    const explicit4k = he.is4k === true || he.is4kUpscaled === true;
    if (!explicit4k) continue;

    const startMs = parseUtcMs(ev.EventStartTime || ev.Start || '');
    if (!startMs) continue;

    const eid = String(ev.EventId || ev.Id || '');
    if (!eid) continue;

    // Deduplicate per (epgCode, eventId)
    const dedupKey = `${epgCode}:${eid}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    // Duration: real end time → sport fallback
    const sport      = ev.Sport || {};
    const sportTitle = (typeof sport === 'object' ? sport.Title : '') || '';
    const duration   = durById.get(eid) || DURATION_FALLBACK[sportTitle] || DEFAULT_DURATION;

    // Image
    const imageRaw = ev.ImageUrl || ev.ImageURL || ev.Image || ev.Thumbnail || {};
    const imageUrl = buildImageUrl4K(imageRaw);

    // Competition / sport info
    const comp       = ev.Competition || {};
    const compTitle  = (typeof comp === 'object' ? comp.Title : '') || '';

    // IST date — same bucketing as HD channels
    const istDate = msToISTDate(startMs);

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

    const label = date === todayIST    ? 'today'
                : date === tomorrowIST ? 'tomorrow'
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
  // Two calls — past 6 days (aired events have real duration) + next 6 days
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
//  SEARCH INDEX — HD + 4K
// ═════════════════════════════════════════════════════════════════════════════

function rebuildSearchIndex() {
  const allChannels = [...CHANNELS, ...CHANNELS_4K];
  const entries = [];

  for (const ch of allChannels) {
    const dir = path.join('data', ch.tag);
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f));
    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
        for (const ev of (data.events || [])) {
          entries.push({
            c:   ch.tag,
            d:   data.date,
            id:  ev.eventId,
            t:   ev.programTitle  || '',
            e:   ev.episodeTitle  || '',
            s:   ev.scheduledDate,
            dur: ev.duration,
            img: ev.imageUrl      || '',
          });
        }
      } catch {}
    }
  }

  entries.sort((a, b) => b.d.localeCompare(a.d) || a.s - b.s);
  fs.writeFileSync(path.join('data', 'search-index.json'), JSON.stringify(entries));
  console.log(`[search-index] Built ${entries.length} entries (HD + 4K)`);
}

// ═════════════════════════════════════════════════════════════════════════════
//  MAIN
// ═════════════════════════════════════════════════════════════════════════════

(async () => {
  if (!fs.existsSync('data')) fs.mkdirSync('data');

  const imagesDir = path.join('data', 'images');
  if (fs.existsSync(imagesDir)) {
    fs.rmSync(imagesDir, { recursive: true, force: true });
    console.log('Removed old data/images folder');
  }

  ensureGitkeep();

  const todayIST = getISTDay(0).date;

  // ── HD channels ────────────────────────────────────────────────────────────
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

  // ── 4K channels ────────────────────────────────────────────────────────────
  console.log('\n══ 4K CHANNELS (DAZN API) ════════════════════════════════');
  let fourKFailed = 0;
  try {
    await fetch4KSection(todayIST);
  } catch (e) {
    console.error(`\n❌ 4K fetch failed: ${e.message}`);
    fourKFailed = 1;
  }

  // ── Search index ───────────────────────────────────────────────────────────
  console.log('\n══ SEARCH INDEX ══════════════════════════════════════════');
  rebuildSearchIndex();

  if (hdFailed > 0 || fourKFailed > 0) process.exit(1);
})();
