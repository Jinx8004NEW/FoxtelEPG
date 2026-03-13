// scripts/cleanup.js
// Deletes dated JSON files older than 21 days from data/FS1/ and data/FSP/
// Keeps latest.json always

const fs = require('fs');
const path = require('path');

const CHANNELS = ['FS1', 'FSP'];
const MAX_DAYS = 21;

function daysAgo(dateStr) {
  const fileDate = new Date(dateStr + 'T00:00:00+05:30'); // IST
  const now = new Date();
  return Math.floor((now - fileDate) / (1000 * 60 * 60 * 24));
}

let totalRemoved = 0;

for (const tag of CHANNELS) {
  const dir = path.join('data', tag);
  if (!fs.existsSync(dir)) continue;

  const files = fs.readdirSync(dir).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f));

  for (const file of files) {
    const dateStr = file.replace('.json', '');
    const age = daysAgo(dateStr);
    if (age > MAX_DAYS) {
      fs.unlinkSync(path.join(dir, file));
      console.log(`[${tag}] 🗑  Deleted ${file} (${age} days old)`);
      totalRemoved++;
    }
  }
}

if (totalRemoved === 0) {
  console.log('✅ No old files to clean up');
} else {
  console.log(`\n✅ Cleaned up ${totalRemoved} file(s) older than ${MAX_DAYS} days`);
}
