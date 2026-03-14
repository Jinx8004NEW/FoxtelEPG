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
function todayIST() { return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: getHeaders(), timeout: 30000 }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302)
        return fetchJson(res.headers.location).then(resolve).catch(reject);
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      const enc = res.headers['content-encoding'];
      let stream = res;
      if (enc === 'gzip')    stream = res.pipe(zlib.createGunzip());
      else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
      else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
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

// Download image and save to data/images/ — deduplicated by filename
async function downloadImage(imageUrl, imagesDir) {
  const filename = path.basename(imageUrl.split('?')[0]); // e.g. at1rn.png
  const filepath = path.join(imagesDir, filename);
  if (fs.existsSync(filepath)) return `data/images/${filename}`; // already cached
  try {
    const buf = await fetchBinary(originalUrl(imageUrl));
    fs.writeFileSync(filepath, buf);
    return `data/images/${filename}`;
  } catch (e) {
    console.log(`  Image failed ${filename}: ${e.message}`);
    return null;
  }
}

// Build/update data/index.json
function updateIndex(tag, date) {
  const indexPath = path.join('data', 'index.json');
  let index = {};
  try { index = JSON.parse(fs.readFileSync(indexPath, 'utf8')); } catch {}
  if (!index[tag]) index[tag] = [];
  if (!index[tag].includes(date)) { index[tag].unshift(date); index[tag] = index[tag].slice(0, 21); }
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));
  console.log(`[index] ${tag}: ${index[tag].length} dates`);
}

async function fetchChannel(tag, imagesDir) {
  const url = `https://www.foxtel.com.au/webepg/ws/foxtel/channel/${tag}/events?movieHeight=110&tvShowHeight=90&regionId=${REGION_ID}`;
  console.log(`\n[${tag}] Fetching schedule...`);
  const json   = await fetchWithRetry(url);
  const date   = todayIST();
  const dir    = path.join('data', tag);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  // Download images
  console.log(`[${tag}] Downloading ${json.events.length} images...`);
  const events = [];
  for (const ev of json.events) {
    const cleanUrl = originalUrl(ev.imageUrl);
    const localPath = await downloadImage(cleanUrl, imagesDir);
    events.push({
      ...ev,
      imageUrl: cleanUrl,
      localImage: localPath || cleanUrl,  // local path or fallback to CDN
    });
    await sleep(100); // small delay between image downloads
  }

  const payload = {
    channel: tag, date,
    fetchedAt: Date.now(),
    fetchedAtIST: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
    events,
  };

  fs.writeFileSync(path.join(dir, `${date}.json`), JSON.stringify(payload, null, 2));
  fs.writeFileSync(path.join(dir, 'latest.json'),  JSON.stringify(payload, null, 2));
  updateIndex(tag, date);
  console.log(`[${tag}] ✓ ${events.length} events saved`);
}

(async () => {
  if (!fs.existsSync('data')) fs.mkdirSync('data');
  const imagesDir = path.join('data', 'images');
  if (!fs.existsSync(imagesDir)) fs.mkdirSync(imagesDir, { recursive: true });

  let failed = false;
  for (const tag of CHANNELS) {
    try { await fetchChannel(tag, imagesDir); await sleep(2000); }
    catch (e) { console.error(`[${tag}] ✗ ${e.message}`); failed = true; }
  }
  if (failed) { console.error('\n❌ Failed'); process.exit(1); }
  console.log('\n✅ Done');
})();
