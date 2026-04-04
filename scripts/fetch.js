// scripts/fetch.js — 12 channels, URL-only, today + 2 upcoming days
const https = require('https');
const zlib  = require('zlib');
const fs    = require('fs');
const path  = require('path');

const REGION_ID = process.env.REGION_ID || '8336';

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

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
];

function getHeaders() {
  return {
    'User-Agent': USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)],
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-AU,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Referer': 'https://www.foxtel.com.au/tv-guide/',
    'Origin': 'https://www.foxtel.com.au',
    'Connection': 'keep-alive',
    'Cache-Control': 'no-cache',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
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

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: getHeaders(), timeout: 30000 }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302)
        return fetchJson(res.headers.location).then(resolve).catch(reject);
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

async function fetchWithRetry(url, max = 3) {
  for (let i = 1; i <= max; i++) {
    try { return await fetchJson(url); }
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
  } catch(e) {
    console.log(`  [${tag}] ${label} failed: ${e.message}`);
    throw e;
  }

  // For today: also merge default endpoint
  if (offset === 0) {
    try {
      const defJson = await fetchWithRetry(`https://www.foxtel.com.au/webepg/ws/foxtel/channel/${tag}/events?movieHeight=110&tvShowHeight=90&regionId=${REGION_ID}`);
      events = mergeEvents(events, defJson.events || []);
    } catch(e) {}
  }

  if (!events.length) { console.log(`  [${tag}] ${label}: no events`); return; }

  const processed = events.map(ev => ({ ...ev, imageUrl: originalUrl(ev.imageUrl) }));

  const payload = {
    channel: tag, date, label,
    fetchedAt: Date.now(),
    fetchedAtIST: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
    events: processed,
  };

  fs.writeFileSync(path.join(dir, `${date}.json`), JSON.stringify(payload, null, 2));
  if (offset === 0) fs.writeFileSync(path.join(dir, 'latest.json'), JSON.stringify(payload, null, 2));
  updateIndex(tag, date);
  console.log(`  [${tag}] ✓ ${label} (${date}): ${processed.length} events`);
}

(async () => {
  if (!fs.existsSync('data')) fs.mkdirSync('data');

  // Remove old images folder if exists
  const imagesDir = path.join('data', 'images');
  if (fs.existsSync(imagesDir)) {
    fs.rmSync(imagesDir, { recursive: true, force: true });
    console.log('Removed old data/images folder');
  }

  let failed = 0;
  for (const ch of CHANNELS) {
    console.log(`\n── ${ch.name} (${ch.tag}) ──`);
    for (const offset of [0, 1, 2]) {
      try { await fetchDayForChannel(ch.tag, offset); await sleep(1000); }
      catch(e) { console.error(`  [${ch.tag}] +${offset}d failed: ${e.message}`); failed++; }
    }
    await sleep(1500);
  }

  console.log(`\n✅ Done — ${CHANNELS.length} channels × 3 days. ${failed} failures.`);
  rebuildSearchIndex();
  if (failed > 0) process.exit(1);
})();

function rebuildSearchIndex() {
  const entries = [];
  for (const ch of CHANNELS) {
    const dir = path.join('data', ch.tag);
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f));
    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
        for (const ev of (data.events || [])) {
          entries.push({
            c: ch.tag, d: data.date, id: ev.eventId,
            t: ev.programTitle || '', e: ev.episodeTitle || '',
            s: ev.scheduledDate, dur: ev.duration, img: ev.imageUrl || '',
          });
        }
      } catch {}
    }
  }
  entries.sort((a, b) => b.d.localeCompare(a.d) || a.s - b.s);
  fs.writeFileSync(path.join('data', 'search-index.json'), JSON.stringify(entries));
  console.log(`[search-index] Built ${entries.length} entries`);
}
