// scripts/backfill.js
// Fetches historical + upcoming days for all 10 channels
// Triggered via GitHub Actions "Backfill Historical Data" workflow

const https = require('https');
const zlib  = require('zlib');
const fs    = require('fs');
const path  = require('path');

const REGION_ID = process.env.REGION_ID || '8336';
const DAYS_BACK = parseInt(process.env.DAYS_BACK || '14', 10);

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
];

// Build date list: DAYS_BACK past days + today + 2 upcoming
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

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36',
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

async function fetchOne(tag, date, today) {
  const filePath = path.join('data', tag, `${date}.json`);

  // Skip past dates already saved — no need to re-fetch
  if (fs.existsSync(filePath) && date < today) {
    console.log(`  [${tag}] ${date} — already exists, skip`);
    return 'skipped';
  }

  const { startMs, endMs } = getRange(date);
  const url = `https://www.foxtel.com.au/webepg/ws/foxtel/channel/${tag}/events?movieHeight=110&tvShowHeight=90&regionId=${REGION_ID}&startDate=${startMs}&endDate=${endMs}`;

  try {
    const json   = await fetchWithRetry(url);
    const events = (json.events || []).map(ev => ({ ...ev, imageUrl: originalUrl(ev.imageUrl) }));

    if (!events.length) {
      console.log(`  [${tag}] ${date} — no events`);
      return 'empty';
    }

    const dir = path.join('data', tag);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    fs.writeFileSync(filePath, JSON.stringify({
      channel: tag, date,
      fetchedAt: Date.now(),
      fetchedAtIST: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
      events,
    }, null, 2));

    updateIndex(tag, date);
    console.log(`  [${tag}] ${date} ✓ ${events.length} events`);
    return 'ok';
  } catch(e) {
    console.log(`  [${tag}] ${date} ✗ ${e.message}`);
    return 'failed';
  }
}

(async () => {
  if (!fs.existsSync('data')) fs.mkdirSync('data');

  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const dates = buildDates();

  console.log(`\n🏏 Foxtel EPG Backfill`);
  console.log(`   Today: ${today}`);
  console.log(`   Range: ${dates[0]} → ${dates[dates.length-1]}`);
  console.log(`   Days: ${dates.length} | Channels: ${CHANNELS.length}`);
  console.log(`   Total API calls: ~${CHANNELS.length * dates.length}\n`);

  const stats = { ok: 0, failed: 0, skipped: 0, empty: 0 };

  for (const ch of CHANNELS) {
    console.log(`\n── ${ch.name} (${ch.tag}) ──`);
    for (const date of dates) {
      const result = await fetchOne(ch.tag, date, today);
      stats[result] = (stats[result] || 0) + 1;
      await sleep(700);
    }
    await sleep(1500);
  }

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`✅ Backfill complete`);
  console.log(`   ✓ Saved: ${stats.ok} | ✗ Failed: ${stats.failed} | ⟳ Skipped: ${stats.skipped} | ∅ Empty: ${stats.empty}`);
})();
