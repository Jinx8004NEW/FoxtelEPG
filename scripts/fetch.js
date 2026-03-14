// scripts/fetch.js
const https = require('https');
const zlib  = require('zlib');
const fs    = require('fs');
const path  = require('path');

const REGION_ID = process.env.REGION_ID || '8336';
const CHANNELS  = ['FS1', 'FSP'];

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

// Get date string + full IST day range for offset days from today
// offset=0 → today, offset=1 → tomorrow, offset=2 → day after
function getISTDay(offset = 0) {
  const now = new Date();
  // Get today in IST
  const todayIST = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  // Add offset days
  const base = new Date(todayIST + 'T00:00:00+05:30');
  base.setDate(base.getDate() + offset);
  const date = base.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
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

function fetchBinary(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { ...getHeaders(), 'Accept': 'image/png,image/*,*/*' }, timeout: 20000 }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302)
        return fetchBinary(res.headers.location).then(resolve).catch(reject);
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

async function fetchWithRetry(url, max = 3) {
  for (let i = 1; i <= max; i++) {
    try { console.log(`  Attempt ${i}/${max}...`); return await fetchJson(url); }
    catch (e) {
      console.log(`  Attempt ${i} failed: ${e.message}`);
      if (i < max) await sleep(i * 4000); else throw e;
    }
  }
}

function mergeEvents(a, b) {
  const map = new Map();
  [...a, ...b].forEach(ev => map.set(ev.eventId, ev));
  return Array.from(map.values()).sort((x, y) => x.scheduledDate - y.scheduledDate);
}

async function downloadImage(imageUrl, imagesDir) {
  const filename = path.basename(imageUrl.split('?')[0]);
  const filepath = path.join(imagesDir, filename);
  if (fs.existsSync(filepath)) return `data/images/${filename}`;
  try {
    const buf = await fetchBinary(originalUrl(imageUrl));
    fs.writeFileSync(filepath, buf);
    return `data/images/${filename}`;
  } catch (e) {
    console.log(`  Image failed ${filename}: ${e.message}`);
    return null;
  }
}

function updateIndex(tag, date, label) {
  const indexPath = path.join('data', 'index.json');
  let index = {};
  try { index = JSON.parse(fs.readFileSync(indexPath, 'utf8')); } catch {}
  if (!index[tag]) index[tag] = [];
  if (!index[tag].includes(date)) {
    // Insert in date order (newest first)
    index[tag].unshift(date);
    index[tag].sort((a, b) => b.localeCompare(a));
    index[tag] = index[tag].slice(0, 23); // keep today + 2 upcoming + 21 past
  }
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));
  console.log(`[index] ${tag} ${label}: ${index[tag].length} dates total`);
}

async function fetchDayForChannel(tag, offset, imagesDir) {
  const { date, startMs, endMs } = getISTDay(offset);
  const labels = ['today', 'tomorrow', 'day after tomorrow'];
  const label  = labels[offset] || `+${offset}d`;
  const dir    = path.join('data', tag);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  console.log(`\n[${tag}] Fetching ${label} (${date})...`);

  // Fetch with explicit date range
  let events = [];
  try {
    const url  = `https://www.foxtel.com.au/webepg/ws/foxtel/channel/${tag}/events?movieHeight=110&tvShowHeight=90&regionId=${REGION_ID}&startDate=${startMs}&endDate=${endMs}`;
    const json = await fetchWithRetry(url);
    events = json.events || [];
    console.log(`[${tag}] ${label}: ${events.length} events from date-range fetch`);
  } catch(e) {
    console.log(`[${tag}] ${label}: date-range fetch failed — ${e.message}`);
  }

  // For today only: also fetch default endpoint and merge
  if (offset === 0 && events.length > 0) {
    try {
      const defUrl  = `https://www.foxtel.com.au/webepg/ws/foxtel/channel/${tag}/events?movieHeight=110&tvShowHeight=90&regionId=${REGION_ID}`;
      const defJson = await fetchWithRetry(defUrl);
      const defEvs  = defJson.events || [];
      events = mergeEvents(events, defEvs);
      console.log(`[${tag}] today: merged total ${events.length} events`);
    } catch(e) {
      console.log(`[${tag}] today: default fetch failed — ${e.message}`);
    }
  }

  if (!events.length) {
    console.log(`[${tag}] ${label}: no events, skipping`);
    return;
  }

  // Download images
  console.log(`[${tag}] ${label}: downloading ${events.length} images...`);
  const processed = [];
  for (const ev of events) {
    const cleanUrl  = originalUrl(ev.imageUrl);
    const localPath = await downloadImage(cleanUrl, imagesDir);
    processed.push({ ...ev, imageUrl: cleanUrl, localImage: localPath || cleanUrl });
    await sleep(80);
  }

  const payload = {
    channel: tag, date, label,
    fetchedAt: Date.now(),
    fetchedAtIST: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
    events: processed,
  };

  const filePath = path.join(dir, `${date}.json`);
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
  if (offset === 0) fs.writeFileSync(path.join(dir, 'latest.json'), JSON.stringify(payload, null, 2));

  updateIndex(tag, date, label);
  console.log(`[${tag}] ✓ ${label} saved → data/${tag}/${date}.json`);
}

(async () => {
  if (!fs.existsSync('data')) fs.mkdirSync('data');
  const imagesDir = path.join('data', 'images');
  if (!fs.existsSync(imagesDir)) fs.mkdirSync(imagesDir, { recursive: true });

  let failed = false;
  for (const tag of CHANNELS) {
    for (const offset of [0, 1, 2]) {  // today, tomorrow, day after tomorrow
      try {
        await fetchDayForChannel(tag, offset, imagesDir);
        await sleep(1500);
      } catch(e) {
        console.error(`[${tag}] offset=${offset} ✗ ${e.message}`);
        failed = true;
      }
    }
    await sleep(2000);
  }

  if (failed) { console.error('\n❌ Some fetches failed'); process.exit(1); }
  console.log('\n✅ All done — today + 2 upcoming days fetched');
})();
