const fs = require('fs');
const https = require('https');
const path = require('path');

const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'Pokemon_Google_Drive_Links.json'), 'utf8'));

function getPokemonSeason(item) {
  if (item.relative_path) {
    const match = item.relative_path.match(/Season\s*(\d+)/i);
    if (match) return `Season ${match[1].padStart(2, '0')}`;
  }
  const str = (item.filename || '') + ' ' + (item.title || '');
  const match2 = str.match(/S(\d+)/i);
  if (match2) return `Season ${match2[1].padStart(2, '0')}`;
  return 'Season 01';
}

function computeKey(item) {
  const raw = item.filename || item.title || `${item.file_id}.mp4`;
  let safe = raw.replace(/[^a-zA-Z0-9._-]/g, '_');
  if (item.relative_path && item.relative_path.includes(' CN ') && safe.includes('XD')) {
    safe = safe.replace('XD', 'CN');
  }
  return `Pokemon/${getPokemonSeason(item)}/${safe}`;
}

async function checkUrl(url) {
  return new Promise((resolve) => {
    const req = https.request(url, { method: 'HEAD', timeout: 5000 }, (res) => {
      resolve(res.statusCode === 200 || res.statusCode === 206);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

async function run() {
  console.log(`Checking ${data.length} Pokemon items against live Stratus storage...`);
  const missing = [];
  const found = [];
  let checked = 0;
  const concurrency = 25;

  let idx = 0;
  async function worker() {
    while (idx < data.length) {
      const i = idx++;
      const item = data[i];
      const key = computeKey(item);
      const url = `https://stream-development.zohostratus.in/${encodeURI(key)}`;
      const ok = await checkUrl(url);
      if (ok) {
        found.push(item);
      } else {
        missing.push(item);
      }
      checked++;
      if (checked % 150 === 0 || checked === data.length) {
        process.stdout.write(`\rProgress: ${checked}/${data.length} (Found: ${found.length}, Missing: ${missing.length})`);
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  console.log(`\n\nFinal Report:`);
  console.log(`✅ Verified in Stratus: ${found.length} / ${data.length} (${((found.length/data.length)*100).toFixed(1)}%)`);
  console.log(`⏳ Missing: ${missing.length}`);
  fs.writeFileSync(path.join(__dirname, 'missing_pokemon.json'), JSON.stringify(missing, null, 2), 'utf8');
}

run();
