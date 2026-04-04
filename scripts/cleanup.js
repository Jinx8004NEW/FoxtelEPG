// scripts/cleanup.js
const fs   = require('fs');
const path = require('path');

const CHANNELS = ['FSN','FS1','SP2','FS3','FAF','FSP','SPS','FSS','ESP','ES2','RTV','UFC'];
const MAX_DAYS = 21;

function getISTDay(offset = 0) {
  const base = new Date(new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }) + 'T00:00:00+05:30');
  base.setDate(base.getDate() + offset);
  return base.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

const KEEP = new Set([getISTDay(0), getISTDay(1), getISTDay(2)]);

function daysOld(dateStr) {
  return Math.floor((Date.now() - new Date(dateStr + 'T00:00:00+05:30').getTime()) / 86400000);
}

let removed = 0;
for (const tag of CHANNELS) {
  const dir = path.join('data', tag);
  if (!fs.existsSync(dir)) continue;
  const files = fs.readdirSync(dir).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f));
  for (const file of files) {
    const d = file.replace('.json', '');
    if (KEEP.has(d)) continue;
    if (daysOld(d) > MAX_DAYS) {
      fs.unlinkSync(path.join(dir, file));
      console.log(`[${tag}] Deleted ${file}`);
      removed++;
    }
  }
}

// Sync index.json
const indexPath = path.join('data', 'index.json');
try {
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  for (const tag of CHANNELS) {
    if (!index[tag]) continue;
    index[tag] = index[tag].filter(d => fs.existsSync(path.join('data', tag, `${d}.json`)));
  }
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));
} catch(e) {}

console.log(removed ? `✅ Removed ${removed} old files` : '✅ Nothing to clean');
