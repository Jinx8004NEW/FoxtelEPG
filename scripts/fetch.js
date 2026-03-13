// scripts/fetch.js
// Fetches FOX CRICKET HD (FS1) and FOX SPORTS 505 (FSP) schedules
// and saves them as dated JSON files in data/

const https = require('https');
const fs = require('fs');
const path = require('path');

const REGION_ID = process.env.REGION_ID || '8336';
const CHANNELS = ['FS1', 'FSP'];

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-AU,en;q=0.9',
  'Referer': 'https://www.foxtel.com.au/tv-guide/',
  'Origin': 'https://www.foxtel.com.au',
};

// Get today's date in IST as YYYY-MM-DD
function todayIST() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

// Strip resize params from image URL → original quality
function originalUrl(imageUrl) {
  try { return imageUrl.split('?')[0]; }
  catch { return imageUrl; }
}

// Simple HTTPS GET returning JSON
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: HEADERS }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        }
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse error: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

async function fetchChannel(tag) {
  const url = `https://www.foxtel.com.au/webepg/ws/foxtel/channel/${tag}/events?movieHeight=110&tvShowHeight=90&regionId=${REGION_ID}`;
  console.log(`[${tag}] Fetching from Foxtel...`);
  const json = await fetchJson(url);

  // Process events — strip image resize params
  const events = json.events.map(ev => ({
    ...ev,
    imageUrl: originalUrl(ev.imageUrl),
  }));

  const date = todayIST();
  const dir = path.join('data', tag);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const payload = {
    channel: tag,
    date,
    fetchedAt: Date.now(),
    fetchedAtIST: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
    events,
  };

  const filepath = path.join(dir, `${date}.json`);
  fs.writeFileSync(filepath, JSON.stringify(payload, null, 2));
  console.log(`[${tag}] ✓ Saved ${events.length} events → ${filepath}`);

  // Also write a "latest.json" for easy access
  fs.writeFileSync(path.join(dir, 'latest.json'), JSON.stringify(payload, null, 2));
  console.log(`[${tag}] ✓ Updated latest.json`);
}

(async () => {
  let failed = false;
  for (const tag of CHANNELS) {
    try {
      await fetchChannel(tag);
    } catch (e) {
      console.error(`[${tag}] ✗ Error: ${e.message}`);
      failed = true;
    }
  }
  if (failed) process.exit(1);
  console.log('\n✅ All channels fetched successfully');
})();
