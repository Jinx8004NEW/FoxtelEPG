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

function originalUrl(imageUrl) {
  try { return imageUrl.split('?')[0]; }
  catch { return imageUrl; }
}

function todayIST() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: getHeaders(), timeout: 30000 }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return fetchJson(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }

      // Decompress based on Content-Encoding
      const encoding = res.headers['content-encoding'];
      let stream = res;

      if (encoding === 'gzip') {
        stream = res.pipe(zlib.createGunzip());
      } else if (encoding === 'deflate') {
        stream = res.pipe(zlib.createInflate());
      } else if (encoding === 'br') {
        stream = res.pipe(zlib.createBrotliDecompress());
      }

      const chunks = [];
      stream.on('data', chunk => chunks.push(chunk));
      stream.on('end', () => {
        try {
          const body = Buffer.concat(chunks).toString('utf8');
          resolve(JSON.parse(body));
        } catch (e) {
          reject(new Error(`JSON parse: ${e.message}`));
        }
      });
      stream.on('error', reject);
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

async function fetchWithRetry(url, maxAttempts = 3) {
  for (let i = 1; i <= maxAttempts; i++) {
    try {
      console.log(`  Attempt ${i}/${maxAttempts}...`);
      return await fetchJson(url);
    } catch (e) {
      console.log(`  Attempt ${i} failed: ${e.message}`);
      if (i < maxAttempts) {
        await sleep(i * 4000);
      } else {
        throw e;
      }
    }
  }
}

async function fetchChannel(tag) {
  const url = `https://www.foxtel.com.au/webepg/ws/foxtel/channel/${tag}/events?movieHeight=110&tvShowHeight=90&regionId=${REGION_ID}`;
  console.log(`\n[${tag}] Fetching...`);

  const json   = await fetchWithRetry(url);
  const events = json.events.map(ev => ({ ...ev, imageUrl: originalUrl(ev.imageUrl) }));
  const date   = todayIST();
  const dir    = path.join('data', tag);

  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const payload = {
    channel: tag, date,
    fetchedAt: Date.now(),
    fetchedAtIST: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
    events,
  };

  fs.writeFileSync(path.join(dir, `${date}.json`), JSON.stringify(payload, null, 2));
  fs.writeFileSync(path.join(dir, 'latest.json'),  JSON.stringify(payload, null, 2));
  console.log(`[${tag}] ✓ ${events.length} events saved → data/${tag}/${date}.json`);
}

(async () => {
  let failed = false;
  for (const tag of CHANNELS) {
    try {
      await fetchChannel(tag);
      await sleep(2000);
    } catch (e) {
      console.error(`[${tag}] ✗ ${e.message}`);
      failed = true;
    }
  }
  if (failed) { console.error('\n❌ Failed'); process.exit(1); }
  console.log('\n✅ Done');
})();
