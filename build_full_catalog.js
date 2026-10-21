const fs = require('fs');
const path = require('path');
const https = require('https');

// Read CLI token credentials
const configStore = require('C:\\Users\\admin\\AppData\\Roaming\\npm\\node_modules\\zcatalyst-cli\\lib\\util_modules\\config-store.js').default;
const Credential = require('C:\\Users\\admin\\AppData\\Roaming\\npm\\node_modules\\zcatalyst-cli\\lib\\authentication\\credential.js').default;
const token = configStore.get('in.credential');
const c = Credential.initToken(token, false);

const BUCKET_NAME = 'stream';
const PROJECT_ID = '86897000000013024';
const ORG_ID = '60091937849';
const ENVIRONMENT = 'Development';

async function getAccessToken() {
  const postData = new URLSearchParams({
    refresh_token: c.rToken,
    client_id: c.client.id,
    client_secret: c.client.secret,
    grant_type: 'refresh_token'
  }).toString();

  return new Promise((resolve, reject) => {
    const req = https.request('https://accounts.zoho.in/oauth/v2/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData)
      }
    }, (res) => {
      let d = '';
      res.on('data', chunk => d += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(d);
          if (json.access_token) resolve(json.access_token);
          else reject(new Error('Failed to get token: ' + d));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

async function listAllObjectsForPrefix(accessToken, prefix) {
  let allContents = [];
  let continuationToken = null;
  let page = 1;

  do {
    let url = `https://api.catalyst.zoho.in/baas/v1/project/${PROJECT_ID}/bucket/objects?bucket_name=${BUCKET_NAME}&prefix=${encodeURIComponent(prefix)}&folder_listing=false&max_keys=1000`;
    if (continuationToken) {
      url += `&continuation_token=${encodeURIComponent(continuationToken)}`;
    }

    const data = await new Promise((resolve, reject) => {
      https.get(url, {
        headers: {
          'Authorization': 'Zoho-oauthtoken ' + accessToken,
          'Catalyst-org': ORG_ID,
          'Environment': ENVIRONMENT
        }
      }, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(body);
            resolve(parsed.data || {});
          } catch (e) {
            reject(new Error(`Failed to parse list response for ${prefix}: ${body.slice(0, 200)}`));
          }
        });
      }).on('error', reject);
    });

    const items = data.contents || [];
    allContents.push(...items);
    process.stdout.write(`  [${prefix}] Page ${page}: +${items.length} (Total: ${allContents.length})\r`);

    continuationToken = data.next_continuation_token || null;
    page++;
  } while (continuationToken);

  console.log(`\n  ✅ ${prefix}: Finished with ${allContents.length} total objects`);
  return allContents;
}

function cleanTitle(filename) {
  let name = filename.replace(/\.(mp4|mkv|avi|webm)$/i, '');
  name = name.replace(/_/g, ' ');
  name = name.replace(/\[.*?\]|\(.*?\)/g, (match) => {
    // Keep release years like (1990)
    if (/\(\d{4}\)/.test(match)) return match;
    return '';
  });
  return name.replace(/\s+/g, ' ').trim();
}

function extractEpNumber(title, filename) {
  const match = (title + ' ' + filename).match(/(?:EP?|Episode|S\d+E)\s*(\d+)/i);
  return match ? parseInt(match[1], 10) : null;
}

(async () => {
  console.log('🚀 Starting Comprehensive Zoho Stratus Object Scanner...');
  const accessToken = await getAccessToken();
  console.log('🔑 Obtained Zoho OAuth Access Token');

  const prefixes = [
    'Doraemon/Movies/',
    'Doraemon/',
    'Shinchan/',
    'Pokemon/',
    'Luckyman/',
    'Chhota Bheem/',
    'Oggy and the Cockroaches/'
  ];

  const prefixResults = {};
  for (const p of prefixes) {
    console.log(`📡 Scanning prefix: ${p}...`);
    prefixResults[p] = await listAllObjectsForPrefix(accessToken, p);
  }

  console.log('\n📦 Compiling Catalog Structure...');

  // 1. Doraemon Movies
  const doraMovies = prefixResults['Doraemon/Movies/']
    .filter(x => x.key && (x.key.endsWith('.mp4') || x.key.endsWith('.mkv')))
    .map((item, idx) => {
      const filename = path.basename(item.key);
      return {
        id: `dora_mov_${idx + 1}`,
        movie_number: idx + 1,
        title: cleanTitle(filename),
        filename: filename,
        key: item.key,
        stream_url: `https://stream-development.zohostratus.in/${encodeURI(item.key)}`,
        size_mb: (item.size / (1024 * 1024)).toFixed(1)
      };
    });

  // 2. Doraemon TV Series
  const doraTvItems = prefixResults['Doraemon/']
    .filter(x => x.key && !x.key.includes('/Movies/') && (x.key.endsWith('.mp4') || x.key.endsWith('.mkv')));
  const doraTvSeasons = {};
  doraTvItems.forEach(item => {
    const parts = item.key.split('/');
    const season = parts.length > 2 ? parts[1] : 'Season 01';
    if (!doraTvSeasons[season]) doraTvSeasons[season] = [];
    const filename = path.basename(item.key);
    doraTvSeasons[season].push({
      id: `dora_${item.key.replace(/[^a-zA-Z0-9]/g, '_').slice(-16)}`,
      title: cleanTitle(filename),
      filename: filename,
      episode_number: extractEpNumber(cleanTitle(filename), filename),
      key: item.key,
      stream_url: `https://stream-development.zohostratus.in/${encodeURI(item.key)}`,
      size_mb: (item.size / (1024 * 1024)).toFixed(1)
    });
  });

  // Sort episodes in each season
  Object.keys(doraTvSeasons).forEach(s => {
    doraTvSeasons[s].sort((a, b) => (a.episode_number || 0) - (b.episode_number || 0));
  });

  // 3. Shinchan
  const shinchanItems = prefixResults['Shinchan/']
    .filter(x => x.key && (x.key.endsWith('.mp4') || x.key.endsWith('.mkv')));
  const shinchanSeasons = {};
  shinchanItems.forEach(item => {
    const parts = item.key.split('/');
    const season = parts.length > 2 ? parts[1] : 'Season 01';
    if (!shinchanSeasons[season]) shinchanSeasons[season] = [];
    const filename = path.basename(item.key);
    shinchanSeasons[season].push({
      id: `shin_${item.key.replace(/[^a-zA-Z0-9]/g, '_').slice(-16)}`,
      title: cleanTitle(filename),
      filename: filename,
      episode_number: extractEpNumber(cleanTitle(filename), filename),
      key: item.key,
      stream_url: `https://stream-development.zohostratus.in/${encodeURI(item.key)}`,
      size_mb: (item.size / (1024 * 1024)).toFixed(1)
    });
  });
  Object.keys(shinchanSeasons).forEach(s => {
    shinchanSeasons[s].sort((a, b) => (a.episode_number || 0) - (b.episode_number || 0));
  });

  // 4. Pokemon
  const pokemonItems = prefixResults['Pokemon/']
    .filter(x => x.key && (x.key.endsWith('.mp4') || x.key.endsWith('.mkv')));
  const pokemonSeasons = {};
  pokemonItems.forEach(item => {
    const parts = item.key.split('/');
    const season = parts.length > 2 ? parts[1] : 'Season 01';
    if (!pokemonSeasons[season]) pokemonSeasons[season] = [];
    const filename = path.basename(item.key);
    pokemonSeasons[season].push({
      id: `poke_${item.key.replace(/[^a-zA-Z0-9]/g, '_').slice(-16)}`,
      title: cleanTitle(filename),
      filename: filename,
      episode_number: extractEpNumber(cleanTitle(filename), filename),
      key: item.key,
      stream_url: `https://stream-development.zohostratus.in/${encodeURI(item.key)}`,
      size_mb: (item.size / (1024 * 1024)).toFixed(1)
    });
  });
  Object.keys(pokemonSeasons).forEach(s => {
    pokemonSeasons[s].sort((a, b) => (a.episode_number || 0) - (b.episode_number || 0));
  });

  // 5. Lucky Man
  const luckymanItems = prefixResults['Luckyman/']
    .filter(x => x.key && (x.key.endsWith('.mp4') || x.key.endsWith('.mkv')));
  const luckymanEpisodes = luckymanItems.map(item => {
    const filename = path.basename(item.key);
    return {
      id: `lucky_${item.key.replace(/[^a-zA-Z0-9]/g, '_').slice(-16)}`,
      title: cleanTitle(filename),
      filename: filename,
      episode_number: extractEpNumber(cleanTitle(filename), filename),
      key: item.key,
      stream_url: `https://stream-development.zohostratus.in/${encodeURI(item.key)}`,
      size_mb: (item.size / (1024 * 1024)).toFixed(1)
    };
  }).sort((a, b) => (a.episode_number || 0) - (b.episode_number || 0));

  // 6. Chhota Bheem
  const bheemItems = prefixResults['Chhota Bheem/']
    .filter(x => x.key && (x.key.endsWith('.mp4') || x.key.endsWith('.mkv')));
  const bheemSeasons = {};
  bheemItems.forEach(item => {
    const parts = item.key.split('/');
    const folder = parts.length > 2 ? parts[1] : 'Episodes';
    if (!bheemSeasons[folder]) bheemSeasons[folder] = [];
    const filename = path.basename(item.key);
    bheemSeasons[folder].push({
      id: `bheem_${item.key.replace(/[^a-zA-Z0-9]/g, '_').slice(-16)}`,
      title: cleanTitle(filename),
      filename: filename,
      episode_number: extractEpNumber(cleanTitle(filename), filename),
      key: item.key,
      stream_url: `https://stream-development.zohostratus.in/${encodeURI(item.key)}`,
      size_mb: (item.size / (1024 * 1024)).toFixed(1)
    });
  });

  // 7. Oggy and the Cockroaches
  const oggyItems = prefixResults['Oggy and the Cockroaches/']
    .filter(x => x.key && (x.key.endsWith('.mp4') || x.key.endsWith('.mkv')));
  const oggySeasons = {};
  oggyItems.forEach(item => {
    const parts = item.key.split('/');
    const season = parts.length > 2 ? parts[1] : 'Season 01';
    if (!oggySeasons[season]) oggySeasons[season] = [];
    const filename = path.basename(item.key);
    oggySeasons[season].push({
      id: `oggy_${item.key.replace(/[^a-zA-Z0-9]/g, '_').slice(-16)}`,
      title: cleanTitle(filename),
      filename: filename,
      episode_number: extractEpNumber(cleanTitle(filename), filename),
      key: item.key,
      stream_url: `https://stream-development.zohostratus.in/${encodeURI(item.key)}`,
      size_mb: (item.size / (1024 * 1024)).toFixed(1)
    });
  });

  const fullCatalog = {
    updated_at: new Date().toISOString(),
    shows: [
      {
        id: 'doraemon-movies',
        title: 'Doraemon Theatrical Movies',
        description: 'Complete collection of 40 Doraemon anime theatrical feature films with Multi-Audio (Hindi Dub & Japanese Original).',
        banner: 'https://m.media-amazon.com/images/M/MV5BMjA5NTY2NTg1NF5BMl5BanBnXkFtZTcwMjE0Nzk3Mw@@._V1_.jpg',
        seasons: { 'Movies': doraMovies }
      },
      {
        id: 'doraemon',
        title: 'Doraemon (TV Series)',
        description: 'Classic & modern TV adventures of the robotic cat Doraemon and Nobita Nobi.',
        banner: 'https://m.media-amazon.com/images/M/MV5BMmMwNTAyOTktOGU3ZS00NmVkLTk1MjMtNWZhZDQ1NDk0OTI0XkEyXkFqcGc@._V1_.jpg',
        seasons: doraTvSeasons
      },
      {
        id: 'shinchan',
        title: 'Crayon Shin-chan',
        description: 'Mischievous 5-year-old Shinnosuke Nohara and his hilarious daily adventures in Kasukabe.',
        banner: 'https://m.media-amazon.com/images/M/MV5BNDc4NzQ5OTMtYTZmNC00ZGUwLWIwMzctNDhjMzAxODc1ZGY5XkEyXkFqcGc@._V1_.jpg',
        seasons: shinchanSeasons
      },
      {
        id: 'pokemon',
        title: 'Pokémon (The Complete Series)',
        description: 'Ash Ketchum from Pallet Town sets out on an epic journey with Pikachu across all regions to become a Pokémon Master.',
        banner: 'https://m.media-amazon.com/images/M/MV5BNWRmY2FiMDktNmE5YS00Mzc5LWE1NmItOGYxNmI5ODcxZDI1XkEyXkFqcGc@._V1_.jpg',
        seasons: pokemonSeasons
      },
      {
        id: 'luckyman',
        title: 'Lucky Man (1994)',
        description: 'Youichi Tsuiteru transforms into the universe luckiest hero Tottemo! Luckyman.',
        banner: 'https://m.media-amazon.com/images/M/MV5BZmEwMTRiMmEtYTFjNy00MDdmLTgzMDItYzcyOTk1YjYyMDNjXkEyXkFqcGc@._V1_.jpg',
        seasons: { 'Season 01': luckymanEpisodes }
      },
      {
        id: 'chhota-bheem',
        title: 'Chhota Bheem',
        description: 'Bheem and his friends protect the kingdom of Dholakpur from evil threats.',
        banner: 'https://m.media-amazon.com/images/M/MV5BMTEzODc3MjgtZGRlMi00Y2Y0LWI5MmMtM2MwMzEzYWRlZTNmXkEyXkFqcGc@._V1_.jpg',
        seasons: bheemSeasons
      },
      {
        id: 'oggy',
        title: 'Oggy and the Cockroaches',
        description: 'Oggy the lazy blue cat constantly battles three mischievous cockroaches: Dee Dee, Marky, and Joey.',
        banner: 'https://m.media-amazon.com/images/M/MV5BYzA0M2Y0MDAtYmE2OC00MDc0LTg1Y2UtOWIwMGMzY2M4ZmY3XkEyXkFqcGc@._V1_.jpg',
        seasons: oggySeasons
      }
    ]
  };

  // Write catalog.json to both places
  const outPath1 = path.join(__dirname, 'appsail', 'catalog.json');
  fs.writeFileSync(outPath1, JSON.stringify(fullCatalog, null, 2), 'utf8');
  console.log(`\n🎉 Full Catalog written to ${outPath1}!`);

  let totalTitles = 0;
  fullCatalog.shows.forEach(s => {
    let sCount = 0;
    Object.keys(s.seasons).forEach(k => { sCount += s.seasons[k].length; });
    console.log(`  ⭐ ${s.title}: ${sCount} episodes across ${Object.keys(s.seasons).length} seasons`);
    totalTitles += sCount;
  });
  console.log(`\n🏆 Grand Total Indexed Titles: ${totalTitles} titles in Zoho Stratus!`);
})();
