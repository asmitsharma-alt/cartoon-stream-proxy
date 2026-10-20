/**
 * Cloud-to-Cloud Migration Tool: Google Drive -> Zoho Catalyst Stratus
 * 
 * - Streams directly in-memory from Google Drive to Zoho Stratus (Zero disk space used)
 * - Auto-skips already uploaded files (resume support)
 * - Native AAC remuxing for dual-audio movies (fixes browser audio permanently)
 * - Verifies HTTP 206 Range seeking immediately after upload
 * 
 * Usage:
 *   node migrate.js --target sample-episode
 *   node migrate.js --target sample-movie
 *   node migrate.js --target movie-04
 *   node migrate.js --target all-movies
 *   node migrate.js --target <showKey>
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawn } = require('child_process');
const { GoogleAuth } = require('google-auth-library');
require('dotenv').config();

// Configuration
const BUCKET_NAME = 'stream';
const STRATUS_BASE_URL = `https://${BUCKET_NAME}-development.zohostratus.in`;
const MANIFEST_FILE = path.join(__dirname, 'zoho_manifest.json');

// Locate FFmpeg binary
let ffmpegPath = 'ffmpeg';
try {
  const linuxFfmpeg = path.join(__dirname, 'node_modules', '@ffmpeg-installer', 'linux-x64', 'ffmpeg');
  if (fs.existsSync(linuxFfmpeg)) {
    ffmpegPath = linuxFfmpeg;
    try { fs.chmodSync(ffmpegPath, 0o755); } catch (e) {}
  } else {
    const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
    if (ffmpegInstaller.path && fs.existsSync(ffmpegInstaller.path)) {
      ffmpegPath = ffmpegInstaller.path;
    }
  }
} catch (e) {}

// Load or initialize Manifest
let manifest = {};
if (fs.existsSync(MANIFEST_FILE)) {
  try {
    manifest = JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8'));
  } catch (e) {
    manifest = {};
  }
}

function saveManifest() {
  fs.writeFileSync(MANIFEST_FILE, JSON.stringify(manifest, null, 2), 'utf8');
}

// ==========================================
// 1. ZOHO STRATUS AUTHENTICATION
// ==========================================
let zohoAccessToken = null;
let zohoTokenExpires = 0;

async function getZohoToken() {
  const now = Date.now();
  if (zohoAccessToken && zohoTokenExpires > now + 60000) {
    return zohoAccessToken;
  }

  let creds = null;
  // 1. From Environment (CI / Cloud runner)
  if (process.env.ZOHO_CREDENTIALS) {
    try { creds = JSON.parse(process.env.ZOHO_CREDENTIALS); } catch (e) {}
  }
  // 2. From Local CLI Store (Windows/local developer machine)
  if (!creds) {
    try {
      const configStore = require('C:\\Users\\admin\\AppData\\Roaming\\npm\\node_modules\\zcatalyst-cli\\lib\\util_modules\\config-store.js').default;
      const Credential = require('C:\\Users\\admin\\AppData\\Roaming\\npm\\node_modules\\zcatalyst-cli\\lib\\authentication\\credential.js').default;
      const token = configStore.get('in.credential');
      const c = Credential.initToken(token, false);
      creds = {
        client_id: c.client.id,
        client_secret: c.client.secret,
        refresh_token: c.rToken
      };
    } catch (e) {}
  }

  if (!creds || !creds.refresh_token) {
    throw new Error('No Zoho credentials available! Set ZOHO_CREDENTIALS or login with catalyst CLI.');
  }

  return new Promise((resolve, reject) => {
    const postData = new URLSearchParams({
      refresh_token: creds.refresh_token,
      client_id: creds.client_id,
      client_secret: creds.client_secret,
      grant_type: 'refresh_token'
    }).toString();

    const req = https.request('https://accounts.zoho.in/oauth/v2/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData)
      }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.access_token) {
            zohoAccessToken = json.access_token;
            zohoTokenExpires = now + (json.expires_in ? json.expires_in * 1000 : 3600000);
            resolve(zohoAccessToken);
          } else {
            reject(new Error('Zoho token refresh failed: ' + data));
          }
        } catch (e) {
          reject(new Error('Invalid token response: ' + data));
        }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

// ==========================================
// 2. GOOGLE DRIVE AUTHENTICATION
// ==========================================
let driveAuthClient = null;
let driveCachedToken = null;
let driveTokenExpires = 0;

function initGoogleAuth() {
  let credentials = null;
  if (process.env.GOOGLE_CREDENTIALS) {
    try { credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS); } catch (e) {}
  }
  if (!credentials) {
    const credPath = process.env.GOOGLE_CREDENTIALS_PATH || path.join(__dirname, 'scoop-plus-b8ec77cef48d.json');
    if (fs.existsSync(credPath)) {
      try { credentials = JSON.parse(fs.readFileSync(credPath, 'utf8')); } catch (e) {}
    }
  }
  if (!credentials) {
    const files = fs.readdirSync(__dirname);
    for (const f of files) {
      if (f.endsWith('.json') && f.includes('scoop')) {
        try { credentials = JSON.parse(fs.readFileSync(path.join(__dirname, f), 'utf8')); break; } catch (e) {}
      }
    }
  }

  if (credentials) {
    driveAuthClient = new GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/drive.readonly']
    });
  } else {
    throw new Error('Google Drive credentials not found!');
  }
}

async function getGoogleToken() {
  const now = Date.now();
  if (driveCachedToken && driveTokenExpires > now + 60000) {
    return driveCachedToken;
  }
  if (!driveAuthClient) initGoogleAuth();
  const client = await driveAuthClient.getClient();
  const res = await client.getAccessToken();
  driveCachedToken = res.token;
  driveTokenExpires = now + 3500000;
  return driveCachedToken;
}

// ==========================================
// 3. UTILITIES & STRATUS HELPERS
// ==========================================

async function checkStratusObject(key) {
  return new Promise((resolve) => {
    getZohoToken().then(token => {
      const req = https.request(`${STRATUS_BASE_URL}/${encodeURI(key)}`, {
        method: 'HEAD',
        headers: { 'Authorization': 'Zoho-oauthtoken ' + token }
      }, (res) => {
        if (res.statusCode === 200) {
          const size = parseInt(res.headers['content-length'] || '0', 10);
          if (size > 1024) return resolve(size);
        }
        resolve(null);
      });
      req.on('error', () => resolve(null));
      req.end();
    }).catch(() => resolve(null));
  });
}

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return (bytes / Math.pow(k, i)).toFixed(2) + ' ' + sizes[i];
}

async function verifyRangePlayback(objectUrl) {
  return new Promise((resolve) => {
    https.get(objectUrl, {
      headers: { 'Range': 'bytes=0-1024' }
    }, (res) => {
      resolve({
        statusCode: res.statusCode,
        is206: res.statusCode === 206,
        acceptRanges: res.headers['accept-ranges'],
        contentRange: res.headers['content-range']
      });
    }).on('error', (err) => resolve({ statusCode: 500, error: err.message }));
  });
}

// ==========================================
// 4. MIGRATION TRANSFER CORE
// ==========================================

async function migrateFile(item, options = {}) {
  const fileId = item.file_id;
  const rawFilename = item.filename || item.title || `${fileId}.mp4`;
  const safeFilename = rawFilename.replace(/[^a-zA-Z0-9._-]/g, '_');
  const targetKey = options.prefix ? `${options.prefix}/${safeFilename}` : safeFilename;
  const isMovie = options.isMovie || options.prefix === 'movies' || rawFilename.toLowerCase().includes('movie');

  console.log(`\n======================================================`);
  console.log(`🚀 Starting Cloud Transfer: ${rawFilename}`);
  console.log(`📦 Type: ${isMovie ? '🎬 Movie (Converting audio to AAC on-the-fly)' : '📺 Episode (Direct Line Speed)'}`);
  console.log(`🎯 Target: ${targetKey}`);
  console.log(`======================================================`);

  // Check if already in manifest & online
  if (manifest[fileId] && !options.force) {
    const existingSize = await checkStratusObject(targetKey);
    if (existingSize) {
      console.log(`⚡ Already uploaded and verified on Zoho Stratus (${formatBytes(existingSize)})! Skipping.`);
      console.log(`🔗 URL: ${manifest[fileId].url}`);
      return manifest[fileId];
    }
  }

  const zohoToken = await getZohoToken();
  const driveToken = await getGoogleToken();

  return new Promise((resolve, reject) => {
    const driveReq = https.request({
      hostname: 'www.googleapis.com',
      path: `/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`,
      method: 'GET',
      headers: { 'Authorization': `Bearer ${driveToken}` }
    }, (driveRes) => {
      if (driveRes.statusCode === 302 || driveRes.statusCode === 303) {
        const redirectUrl = new URL(driveRes.headers.location);
        https.get(redirectUrl, (redirectRes) => {
          handleUploadStream(redirectRes, targetKey, zohoToken, isMovie, resolve, reject);
        }).on('error', reject);
        return;
      }

      if (driveRes.statusCode !== 200) {
        return reject(new Error(`Google Drive returned status ${driveRes.statusCode}: ${driveRes.statusMessage}`));
      }

      handleUploadStream(driveRes, targetKey, zohoToken, isMovie, resolve, reject);
    });

    driveReq.on('error', reject);
    driveReq.end();
  });

  function handleUploadStream(sourceStream, key, token, convertAudio, resolve, reject) {
    const uploadUrl = `${STRATUS_BASE_URL}/${encodeURI(key)}`;
    const uploadReq = https.request(uploadUrl, {
      method: 'PUT',
      headers: {
        'Authorization': 'Zoho-oauthtoken ' + token,
        'Content-Type': 'video/mp4',
        'overwrite': 'true'
      }
    }, async (uploadRes) => {
      let responseBody = '';
      uploadRes.on('data', c => responseBody += c);
      uploadRes.on('end', async () => {
        if (uploadRes.statusCode >= 200 && uploadRes.statusCode < 300) {
          console.log(`\n✅ Upload Succeeded! Status: ${uploadRes.statusCode}`);
          const publicUrl = `${STRATUS_BASE_URL}/${encodeURI(key)}`;
          
          process.stdout.write(`🔍 Verifying HTTP 206 Range Playback... `);
          const rangeTest = await verifyRangePlayback(publicUrl);
          if (rangeTest.is206) {
            console.log(`[PASS - Native Seeking Ready]`);
          } else {
            console.log(`[Status: ${rangeTest.statusCode}]`);
          }

          manifest[fileId] = {
            title: item.title || rawFilename,
            filename: rawFilename,
            key,
            url: publicUrl,
            converted_audio: convertAudio,
            transferred_at: new Date().toISOString()
          };
          saveManifest();

          console.log(`\n🎉 Permanent Zoho Stratus URL:`);
          console.log(`👉 ${publicUrl}\n`);
          resolve(manifest[fileId]);
        } else {
          reject(new Error(`Zoho upload failed (${uploadRes.statusCode}): ${responseBody}`));
        }
      });
    });

    uploadReq.on('error', reject);

    let streamToUpload = sourceStream;
    let proc = null;

    if (convertAudio) {
      // Audio Conversion: Pass video untouched (-c:v copy), convert audio to AAC (-c:a aac)
      const targetAudio = rawFilename.includes('2112 The Birth') ? '1' : '2';
      const ffmpegArgs = [
        '-i', 'pipe:0',
        '-map', '0:v:0',
        '-map', `0:${targetAudio}`,
        '-c:v', 'copy',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-ar', '48000',
        '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
        '-f', 'mp4',
        'pipe:1'
      ];

      console.log(`⚙️ Remuxing audio track 0:${targetAudio} to AAC in-memory...`);
      proc = spawn(ffmpegPath, ffmpegArgs);
      sourceStream.pipe(proc.stdin);
      streamToUpload = proc.stdout;

      proc.on('error', (err) => {
        console.error('FFmpeg remux error:', err.message);
        uploadReq.destroy(err);
      });
    }

    // Progress Tracker
    let transferred = 0;
    const startTime = Date.now();
    let lastLogTime = 0;

    streamToUpload.on('data', (chunk) => {
      transferred += chunk.length;
      uploadReq.write(chunk);

      const now = Date.now();
      if (now - lastLogTime > 500) {
        lastLogTime = now;
        const elapsedSec = (now - startTime) / 1000;
        const speedMBps = elapsedSec > 0 ? (transferred / (1024 * 1024) / elapsedSec).toFixed(2) : '0';
        process.stdout.write(`\r⏳ Transferred: ${formatBytes(transferred)} @ ${speedMBps} MB/s...   `);
      }
    });

    streamToUpload.on('end', () => {
      uploadReq.end();
    });

    streamToUpload.on('error', (err) => {
      uploadReq.destroy(err);
      reject(err);
    });
  }
}

// ==========================================
// 5. CATALOG MIGRATOR
// ==========================================
async function run() {
  const args = process.argv.slice(2);
  initGoogleAuth();

  const targetIdx = args.indexOf('--target');
  const target = targetIdx > -1 ? args[targetIdx + 1] : (args[0] ? args[0].replace(/^--/, '') : 'sample-episode');

  console.log(`📋 Migration Target Selected: "${target}"`);

  if (target === 'sample-episode') {
    const episodes = JSON.parse(fs.readFileSync(path.join(__dirname, 'Doraemon_Google_Drive_Links.json'), 'utf8'));
    await migrateFile(episodes[0], { prefix: 'episodes' });
    return;
  }

  if (target === 'sample-movie') {
    const movies = JSON.parse(fs.readFileSync(path.join(__dirname, 'Doraemon_Movies_Google_Drive_Links.json'), 'utf8'));
    const movie = movies.find(m => m.filename.includes('Little Star Wars')) || movies[0];
    await migrateFile(movie, { prefix: 'movies', isMovie: true });
    return;
  }

  if (target === 'movie-04') {
    const movies = JSON.parse(fs.readFileSync(path.join(__dirname, 'Doraemon_Movies_Google_Drive_Links.json'), 'utf8'));
    const movie = movies.find(m => m.filename.includes('Movie_04') || m.filename.includes('Undersea')) || movies[2];
    await migrateFile(movie, { prefix: 'movies', isMovie: true });
    return;
  }

  if (target === 'all-movies') {
    const movies = JSON.parse(fs.readFileSync(path.join(__dirname, 'Doraemon_Movies_Google_Drive_Links.json'), 'utf8'));
    console.log(`🎬 Found ${movies.length} movies to migrate.`);
    for (let i = 0; i < movies.length; i++) {
      console.log(`\n[${i + 1}/${movies.length}] Processing Movie: ${movies[i].title || movies[i].filename}`);
      try {
        await migrateFile(movies[i], { prefix: 'movies', isMovie: true });
      } catch (err) {
        console.error(`❌ Error on movie ${i + 1}:`, err.message);
      }
    }
    return;
  }

  const catalogMap = {
    'doraemon': 'Doraemon_Google_Drive_Links.json',
    'shinchan': 'Shinchan_Google_Drive_Links.json',
    'oggy': 'Oggy_Google_Drive_Links.json',
    'chhota-bheem': 'Chhota_Bheem_Google_Drive_Links.json'
  };

  const catalogFile = catalogMap[target.toLowerCase()];
  if (catalogFile && fs.existsSync(path.join(__dirname, catalogFile))) {
    const items = JSON.parse(fs.readFileSync(path.join(__dirname, catalogFile), 'utf8'));
    console.log(`📺 Found ${items.length} episodes in ${catalogFile}.`);
    for (let i = 0; i < items.length; i++) {
      console.log(`\n[${i + 1}/${items.length}] Processing: ${items[i].filename || items[i].title}`);
      try {
        await migrateFile(items[i], { prefix: 'episodes' });
      } catch (err) {
        console.error(`❌ Error on item ${i + 1}:`, err.message);
      }
    }
    return;
  }

  console.log(`❌ Unknown target "${target}". Valid targets: sample-episode, sample-movie, movie-04, all-movies, doraemon, shinchan, oggy, chhota-bheem.`);
}

run().catch(console.error);
