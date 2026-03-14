// scripts/cleanup.js
// Deletes dated JSON files older than 21 days
// Keeps today, tomorrow, day after tomorrow always

const fs   = require('fs');
const path = require('path');

const CHANNELS = ['FS1', 'FSP'];
const MAX_DAYS = 21;

function getISTDay(offset = 0) {
  const base = new Date(new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }) + 'T00:00:00+05:30');
  base.setDate(base.getDate() + offset);
  return base.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

// Dates to always keep: today, tomorrow, day after
const KEEP = new Set([getISTDay(0), getISTDay(1), getISTDay(2)]);

function daysOld(dateStr) {
  const fileDate = new Date(dateStr + 'T00:00:00+05:30');
  return Math.floor((Date.now() - fileDate.getTime()) / (1000 * 60 * 60 * 24));
}

let removed = 0;

for (const tag of CHANNELS) {
  const dir = path.join('data', tag);
  if (!fs.existsSync(dir)) continue;

  const files = fs.readdirSync(dir).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f));
  for (const file of files) {
    const dateStr = file.replace('.json', '');
    if (KEEP.has(dateStr)) continue; // never delete upcoming days
    const age = daysOld(dateStr);
    if (age > MAX_DAYS) {
      fs.unlinkSync(path.join(dir, file));
      console.log(`[${tag}] Deleted ${file} (${age} days old)`);
      removed++;
    }
  }
}

// Also clean up index.json to remove deleted dates
const indexPath = path.join('data', 'index.json');
try {
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  for (const tag of CHANNELS) {
    if (!index[tag]) continue;
    const dir = path.join('data', tag);
    index[tag] = index[tag].filter(d => {
      const exists = fs.existsSync(path.join(dir, `${d}.json`));
      if (!exists) console.log(`[index] Removed stale entry: ${tag}/${d}`);
      return exists;
    });
  }
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));
} catch(e) {}

console.log(removed === 0 ? '✅ Nothing to clean up' : `✅ Removed ${removed} old file(s)`);
