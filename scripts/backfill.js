// scripts/backfill.js
// HD channels: Foxtel API — full historical backfill (DAYS_BACK past days)
// 4K channels: DAZN API  — two calls (6 days back + 6 days forward)
// Only events explicitly flagged is4k:true or is4kUpscaled:true by the API
// Date bucketing: IST (Asia/Kolkata) throughout

const https = require('https');
const zlib  = require('zlib');
const fs    = require('fs');
const path  = require('path');

const REGION_ID = process.env.REGION_ID || '8336';
const DAYS_BACK = parseInt(process.env.DAYS_BACK || '14', 10);

// ── HD Channels ───────────────────────────────────────────────────────────────
const CHANNELS = [
  { tag: 'FSN', name: 'Fox Sports News HD' },
  { tag: 'FS1', name: 'Fox Cricket HD'     },
  { tag: 'SP2', name: 'Fox League HD'      },
  { tag: 'FS3', name: 'Fox Sports 503 HD'  },
  { tag: 'FAF', name: 'Fox Footy HD'       },
  { tag: 'FSP', name: 'Fox Sports 505 HD'  },
  { tag: 'SPS', name: 'Fox Sports 506 HD'  },
  { tag: 'FSS', name: 'Fox Sports 507 HD'  },
  { tag: 'ESP', name: 'ESPN HD'            },
  { tag: 'ES2', name: 'ESPN2 HD'           },
  { tag: 'RTV', name: 'Racing.com HD'      },
  { tag: 'UFC', name: 'Main Event UFC'     },
];

// ── 4K Channels ───────────────────────────────────────────────────────────────
const CHANNELS_4K = [
  { tag: '4KL',  name: 'Fox League 4K'  },
  { tag: '4KF1', name: 'Fox F1 4K'      },
  { tag: '4KF',  name: 'Fox Footy 4K'   },
  { tag: '4KF2', name: 'Fox Footy 2 4K' },
  { tag: '4KN',  name: 'Fox Netball 4K' },
];

// fsa501 included — cricket explicitly flagged 4K by API goes to Fox League 4K
const PROVIDER_TO_4K = {
  'fsa501': '4KL',
  'fsa502': '4KL',
  'fsa506': '4KF1',
  'fsa504': '4KF',
  'fsa503': '4KF2',
  'fsa505': '4KN',
};

const DURATION_FALLBACK = {
  'Australian Rules Football': 130,
  'Netball':                    90,
  'Formula 1':                 180,
  'Rugby League':              100,
  'Cricket':                   480,
};
const DEFAULT_DURATION = 120;

// ── Helpers ───────────────────────────────────────────────────────────────────

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36',
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
    'User-Agent': USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)],
    'Accept':     'application/json',
  };
}

function originalUrl(u) { try { return u.split('?')[0]; } catch { return u; } }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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
      if (i < max) await sleep(i * 4000); else throw e;
    }
  }
}

function updateIndex(tag, date) {
  const indexPath = path.join('data', 'index.json');
  let index = {};
  try { index = JSON.parse(fs.readFileSync(indexPath, 'utf8')); } catch {}
  if (!index[tag]) index[tag] = [];
  if (!index[tag].includes(date)) index[tag].push(date);
  index[tag].sort((a, b) => b.localeCompare(a));
  index[tag] = index[tag].slice(0, 30);
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));
}

// ═════════════════════════════════════════════════════════════════════════════
//  SECTION 1 — HD CHANNELS backfill (Foxtel API)
// ═════════════════════════════════════════════════════════════════════════════

function buildDates() {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const dates = [];
  for (let i = DAYS_BACK; i >= -2; i--) {
    const base = new Date(today + 'T00:00:00+05:30');
    base.setDate(base.getDate() - i);
    dates.push(base.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }));
  }
  return dates;
}

function getRange(date) {
  return {
    startMs: new Date(date + 'T00:00:00+05:30').getTime(),
    endMs:   new Date(date + 'T23:59:59+05:30').getTime(),
  };
}

async function fetchOneHD(tag, date, today) {
  const filePath = path.join('data', tag, `${date}.json`);
  if (fs.existsSync(filePath) && date < today) {
    console.log(`  [${tag}] ${date} — already exists, skip`);
    return 'skipped';
  }
  const { startMs, endMs } = getRange(date);
  const url = `https://www.foxtel.com.au/webepg/ws/foxtel/channel/${tag}/events?movieHeight=110&tvShowHeight=90&regionId=${REGION_ID}&startDate=${startMs}&endDate=${endMs}`;
  try {
    const json   = await fetchWithRetry(url);
    const events = (json.events || []).map(ev => ({ ...ev, imageUrl: originalUrl(ev.imageUrl) }));
    if (!events.length) { console.log(`  [${tag}] ${date} — no events`); return 'empty'; }
    const dir = path.join('data', tag);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({
      channel:      tag,
      date,
      fetchedAt:    Date.now(),
      fetchedAtIST: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
      events,
    }, null, 2));
    updateIndex(tag, date);
    console.log(`  [${tag}] ${date} ✓ ${events.length} events`);
    return 'ok';
  } catch (e) {
    console.log(`  [${tag}] ${date} ✗ ${e.message}`);
    return 'failed';
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  SECTION 2 — 4K CHANNELS backfill (DAZN API)
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

    const dedupKey = `${epgCode}:${eid}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    const sport      = ev.Sport || {};
    const sportTitle = (typeof sport === 'object' ? sport.Title : '') || '';
    const duration   = durById.get(eid) || DURATION_FALLBACK[sportTitle] || DEFAULT_DURATION;

    const imageRaw = ev.ImageUrl || ev.ImageURL || ev.Image || ev.Thumbnail || {};
    const imageUrl = buildImageUrl4K(imageRaw);

    const comp      = ev.Competition || {};
    const compTitle = (typeof comp === 'object' ? comp.Title : '') || '';

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

    // Skip past files that already exist
    const filePath = path.join('data', tag, `${date}.json`);
    if (fs.existsSync(filePath) && date < todayIST) {
      console.log(`  [${tag}] ${date} — already exists, skip`);
      continue;
    }

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

    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
    if (date === todayIST)
      fs.writeFileSync(path.join(dir, 'latest.json'), JSON.stringify(payload, null, 2));

    updateIndex(tag, date);
    console.log(`  [${tag}] ${date} ✓ ${cleanEvents.length} events`);
    written++;
  }

  return written;
}

async function backfill4K(todayIST) {
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
  console.log(`✅ 4K backfill done — ${written} files written.`);
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
  console.log(`[search-index] Rebuilt — ${entries.length} entries (HD + 4K)`);
}

// ═════════════════════════════════════════════════════════════════════════════
//  MAIN
// ═════════════════════════════════════════════════════════════════════════════

(async () => {
  if (!fs.existsSync('data')) fs.mkdirSync('data');

  const todayIST = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const dates    = buildDates();

  console.log(`\n🏏 Foxtel EPG Backfill`);
  console.log(`   Today (IST): ${todayIST}`);
  console.log(`   HD range:    ${dates[0]} → ${dates[dates.length - 1]} (${dates.length} days)`);
  console.log(`   4K range:    ${getISTDay(-6).date} → ${getISTDay(6).date} (DAZN API limit)`);
  console.log(`   HD channels: ${CHANNELS.length} | 4K channels: ${CHANNELS_4K.length}\n`);

  // ── HD backfill ────────────────────────────────────────────────────────────
  console.log('══ HD CHANNELS (Foxtel API) ══════════════════════════════');
  const stats = { ok: 0, failed: 0, skipped: 0, empty: 0 };

  for (const ch of CHANNELS) {
    console.log(`\n── ${ch.name} (${ch.tag}) ──`);
    for (const date of dates) {
      const result = await fetchOneHD(ch.tag, date, todayIST);
      stats[result] = (stats[result] || 0) + 1;
      await sleep(700);
    }
    await sleep(1500);
  }

  console.log(`\n✅ HD backfill complete`);
  console.log(`   ✓ Saved: ${stats.ok} | ✗ Failed: ${stats.failed} | ⟳ Skipped: ${stats.skipped} | ∅ Empty: ${stats.empty}`);

  // ── 4K backfill ────────────────────────────────────────────────────────────
  console.log('\n══ 4K CHANNELS (DAZN API) ════════════════════════════════');
  try {
    await backfill4K(todayIST);
  } catch (e) {
    console.error(`❌ 4K backfill failed: ${e.message}`);
  }

  // ── Search index ───────────────────────────────────────────────────────────
  console.log('\n══ SEARCH INDEX ══════════════════════════════════════════');
  rebuildSearchIndex();
})();
