/**
 * Instant Server-Side Organizer for Zoho Catalyst Stratus
 * 
 * Reorganizes all files in the "stream" bucket into a pristine hierarchy:
 *   [Cartoon Name] / [Season XX] / [Safe Filename]
 * 
 * - Pure metadata operation (0 KB video downloaded, 0 KB uploaded)
 * - Uses Zoho Catalyst Stratus atomic rename
 * - Multi-threaded concurrent worker pool
 * - Safe & idempotent: auto-skips already organized objects
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const { checkStratusObject } = require('./migrate.js');

const BUCKET_NAME = 'stream';
const PROJECT_ID = '86897000000013024';
const ORG_ID = 60091937849;
const ENVIRONMENT = 'Development';
const MCP_URL = 'https://da-60092049956.zohomcp.in/mcp/6de48728652362d289a46ebc8d881f87/message';

function getMcpToken() {
  try {
    const tokenPath = path.join(os.homedir(), '.mcp-auth', 'mcp-remote-v1', '047faa944ca1cbbd81dea9f2a857dd3f_tokens.json');
    const tokens = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
    return tokens.access_token;
  } catch (e) {
    throw new Error('Unable to read MCP access token: ' + e.message);
  }
}

function getSafeFilename(raw) {
  return raw.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function getOggySeason(item) {
  const str = (item.relative_path || '') + ' ' + (item.filename || '') + ' ' + (item.title || '');
  if (/S0?1/i.test(str)) return 'Season 01';
  if (/S0?2/i.test(str)) return 'Season 02';
  if (/S0?3/i.test(str)) return 'Season 03';
  if (/S0?5/i.test(str)) return 'Season 05';
  return 'Season 01';
}

function getChhotaBheemFolder(item) {
  if ((item.relative_path || '').includes('Movies')) return 'Movies & Specials';
  return 'Classic Episodes';
}

async function renameStratusObject(currentKey, newKey, mcpToken) {
  return new Promise((resolve) => {
    const postData = JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now() + Math.floor(Math.random() * 10000),
      method: 'tools/call',
      params: {
        name: 'CatalystbyZoho_Rename_Object',
        arguments: {
          headers: { 'Catalyst-org': ORG_ID, 'Environment': ENVIRONMENT },
          path_variables: { 'projectId': PROJECT_ID },
          query_params: {
            bucket_name: BUCKET_NAME,
            current_key: currentKey,
            rename_to: newKey
          },
          body: {}
        }
      }
    });

    const req = https.request(MCP_URL, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + mcpToken,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(d);
          const text = json.result?.content?.[0]?.text;
          const inner = text ? JSON.parse(text) : json;
          resolve({ status: res.statusCode, inner });
        } catch (e) {
          resolve({ status: res.statusCode, raw: d });
        }
      });
    });
    req.on('error', err => resolve({ error: err.message }));
    req.write(postData);
    req.end();
  });
}

function buildOrganizationPlan(filterShow = 'all') {
  const plan = [];

  // 1. Doraemon Episodes
  if (filterShow === 'all' || filterShow === 'doraemon') {
    const doraemon = JSON.parse(fs.readFileSync(path.join(__dirname, 'Doraemon_Google_Drive_Links.json'), 'utf8'));
    for (const item of doraemon) {
      const safe = getSafeFilename(item.filename || item.title);
      plan.push({
        show: 'Doraemon',
        currentKey: `episodes/${safe}`,
        newKey: `Doraemon/${item.season || 'Season 01'}/${safe}`
      });
    }
  }

  // 2. Doraemon Movies
  if (filterShow === 'all' || filterShow === 'movies') {
    const movies = JSON.parse(fs.readFileSync(path.join(__dirname, 'Doraemon_Movies_Google_Drive_Links.json'), 'utf8'));
    for (const item of movies) {
      const safe = getSafeFilename(item.filename || item.title);
      plan.push({
        show: 'Doraemon Movies',
        currentKey: `movies/${safe}`,
        newKey: `Doraemon/Movies/${safe}`
      });
    }
  }

  // 3. Shinchan Episodes
  if (filterShow === 'all' || filterShow === 'shinchan') {
    const shinchan = JSON.parse(fs.readFileSync(path.join(__dirname, 'Shinchan_Google_Drive_Links.json'), 'utf8'));
    for (const item of shinchan) {
      const safe = getSafeFilename(item.filename || item.title);
      plan.push({
        show: 'Shinchan',
        currentKey: `episodes/${safe}`,
        newKey: `Shinchan/${item.season || 'Season 01'}/${safe}`
      });
    }
  }

  // 4. Oggy and the Cockroaches
  if (filterShow === 'all' || filterShow === 'oggy') {
    const oggy = JSON.parse(fs.readFileSync(path.join(__dirname, 'Oggy_Google_Drive_Links.json'), 'utf8'));
    for (const item of oggy) {
      const safe = getSafeFilename(item.filename || item.title);
      const season = getOggySeason(item);
      plan.push({
        show: 'Oggy and the Cockroaches',
        currentKey: `episodes/${safe}`,
        newKey: `Oggy and the Cockroaches/${season}/${safe}`
      });
    }
  }

  // 5. Chhota Bheem
  if (filterShow === 'all' || filterShow === 'chhota-bheem') {
    const cb = JSON.parse(fs.readFileSync(path.join(__dirname, 'Chhota_Bheem_Google_Drive_Links.json'), 'utf8'));
    for (const item of cb) {
      const safe = getSafeFilename(item.filename || item.title);
      const folder = getChhotaBheemFolder(item);
      plan.push({
        show: 'Chhota Bheem',
        currentKey: `episodes/${safe}`,
        newKey: `Chhota Bheem/${folder}/${safe}`
      });
    }
  }

  return plan;
}

async function run() {
  const args = process.argv.slice(2);
  const showArg = args.find((a, i) => args[i - 1] === '--show') || 'all';
  const concurrency = parseInt(args.find((a, i) => args[i - 1] === '--concurrency') || '6', 10);

  const mcpToken = getMcpToken();
  const plan = buildOrganizationPlan(showArg);

  console.log(`\n======================================================`);
  console.log(`📁 Zoho Stratus File Organizer`);
  console.log(`🎯 Scope: ${showArg} (${plan.length} files to check)`);
  console.log(`⚙️ Concurrency: ${concurrency} parallel workers`);
  console.log(`======================================================\n`);

  let alreadyDone = 0;
  let newlyOrganized = 0;
  let missing = 0;
  let failed = 0;
  let currentIndex = 0;

  async function worker(id) {
    while (currentIndex < plan.length) {
      const i = currentIndex++;
      const item = plan[i];
      const progress = `[${i + 1}/${plan.length}]`;

      // 1. Check if already organized at newKey
      const newSize = await checkStratusObject(item.newKey);
      if (newSize) {
        alreadyDone++;
        process.stdout.write(`⚡ ${progress} Already in place: ${item.newKey}\n`);
        continue;
      }

      // 2. Check if currentKey exists to be renamed
      const currentSize = await checkStratusObject(item.currentKey);
      if (!currentSize) {
        missing++;
        continue;
      }

      // 3. Perform server-side atomic rename
      const res = await renameStratusObject(item.currentKey, item.newKey, mcpToken);
      if (res.inner?.status === 'success') {
        newlyOrganized++;
        console.log(`✅ ${progress} Renamed: ${item.currentKey} ➔ ${item.newKey}`);
      } else {
        failed++;
        console.warn(`⚠️ ${progress} Failed to rename ${item.currentKey}:`, res.inner?.data?.message || res.inner || res);
      }
    }
  }

  const workers = Array.from({ length: concurrency }, (_, id) => worker(id + 1));
  await Promise.all(workers);

  console.log(`\n======================================================`);
  console.log(`🏁 Organization Run Complete!`);
  console.log(`⚡ Already in Place: ${alreadyDone}`);
  console.log(`✅ Newly Organized:  ${newlyOrganized}`);
  console.log(`🔍 Not in Storage:   ${missing}`);
  console.log(`⚠️ Errors:           ${failed}`);
  console.log(`======================================================\n`);
}

if (require.main === module) {
  run().catch(console.error);
}
