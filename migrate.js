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
const { spawn, execSync } = require('child_process');
const { GoogleAuth } = require('google-auth-library');
require('dotenv').config();

// Configuration
const BUCKET_NAME = 'stream';
const STRATUS_BASE_URL = `https://${BUCKET_NAME}-development.zohostratus.in`;
const MANIFEST_FILE = process.env.MANIFEST_FILE ? path.resolve(process.env.MANIFEST_FILE) : path.join(__dirname, 'zoho_manifest.json');

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
let zohoTokenPromise = null;

async function getZohoToken() {
  const now = Date.now();
  if (zohoAccessToken && zohoTokenExpires > now + 60000) {
    return zohoAccessToken;
  }
  if (zohoTokenPromise) {
    return zohoTokenPromise;
  }

  zohoTokenPromise = (async () => {
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

    const postData = new URLSearchParams({
      refresh_token: creds.refresh_token,
      client_id: creds.client_id,
      client_secret: creds.client_secret,
      grant_type: 'refresh_token'
    }).toString();

    for (let attempt = 1; attempt <= 6; attempt++) {
      try {
        const token = await new Promise((resolve, reject) => {
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
                  zohoTokenExpires = Date.now() + (json.expires_in ? json.expires_in * 1000 : 3600000);
                  resolve(zohoAccessToken);
                } else if (data.includes('too many requests') || data.includes('Access Denied')) {
                  reject(new Error('RATE_LIMIT'));
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
        zohoTokenPromise = null;
        return token;
      } catch (err) {
        if (err.message === 'RATE_LIMIT' && attempt < 6) {
          const delay = attempt * 2000 + Math.floor(Math.random() * 1500);
          console.warn(`⏳ Zoho OAuth rate limit hit. Backing off for ${(delay / 1000).toFixed(1)}s (attempt ${attempt}/6)...`);
          await new Promise(r => setTimeout(r, delay));
        } else {
          zohoTokenPromise = null;
          throw err;
        }
      }
    }
  })();

  return zohoTokenPromise;
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

function computeOrganizedKey(item, options = {}) {
  const raw = item.filename || item.title || `${item.file_id}.mp4`;
  let safe = raw.replace(/[^a-zA-Z0-9._-]/g, '_');
  const lower = raw.toLowerCase();

  if (options.targetKey) return options.targetKey;
  if (options.prefix === 'movies' || lower.includes('doraemon_movie') || lower.includes('the birth of doraemon') || lower.includes('stand by me')) {
    return `Doraemon/Movies/${safe}`;
  }
  if (lower.includes('pokemon') || (item.relative_path && item.relative_path.toLowerCase().includes('pokemon'))) {
    if (item.relative_path && item.relative_path.includes(' CN ') && safe.includes('XD')) {
      safe = safe.replace('XD', 'CN');
    }
    return `Pokemon/${getPokemonSeason(item)}/${safe}`;
  }
  if (lower.includes('luckyman')) {
    return `Luckyman/Season 01/${safe}`;
  }
  if (lower.includes('shinchan')) {
    return `Shinchan/${item.season || 'Season 01'}/${safe}`;
  }
  if (lower.includes('doraemon') || (item.season && item.season.startsWith('Season'))) {
    return `Doraemon/${item.season || 'Season 01'}/${safe}`;
  }
  if (lower.includes('oggy') || (item.relative_path && item.relative_path.toLowerCase().includes('oggy'))) {
    return `Oggy and the Cockroaches/${getOggySeason(item)}/${safe}`;
  }
  if (lower.includes('bheem') || (item.relative_path && item.relative_path.toLowerCase().includes('bheem'))) {
    return `Chhota Bheem/${getChhotaBheemFolder(item)}/${safe}`;
  }
  return options.prefix ? `${options.prefix}/${safe}` : safe;
}

// ==========================================
// 4. MIGRATION TRANSFER CORE
// ==========================================

async function migrateFile(item, options = {}) {
  const fileId = item.file_id;
  const rawFilename = item.filename || item.title || `${fileId}.mp4`;
  const safeFilename = rawFilename.replace(/[^a-zA-Z0-9._-]/g, '_');
  const targetKey = computeOrganizedKey(item, options);
  const isMovie = options.isMovie || options.prefix === 'movies' || rawFilename.toLowerCase().includes('movie');
  const isSingleAudioMovie = rawFilename.includes('2112 The Birth') ||
                             rawFilename.includes('Stand By Me') ||
                             rawFilename.includes('Sky Utopia') ||
                             rawFilename.includes('Earth Symphony') ||
                             rawFilename.includes('Star Wars 2021');

  // Single-audio movies already have standard Hindi AAC/MP3: stream directly!
  // Dual-audio classic movies (Movie 01-40): Remux Track 0:2 (Hindi Dub) to AAC.
  const shouldConvertAudio = isMovie && !isSingleAudioMovie;

  console.log(`\n======================================================`);
  console.log(`🚀 Starting Cloud Transfer: ${rawFilename}`);
  console.log(`📦 Type: ${isMovie ? (shouldConvertAudio ? '🎬 Dual-Audio Movie (Remuxing Hindi track to AAC in-memory)' : '🎬 Single-Audio Movie (Direct Line Speed)') : '📺 Episode (Direct Line Speed)'}`);
  console.log(`🎯 Target: ${targetKey}`);
  console.log(`======================================================`);

  // Check if already uploaded and verified at new organized key or legacy key
  const existingSize = (await checkStratusObject(targetKey)) || (await checkStratusObject(`episodes/${safeFilename}`));
  if (existingSize && !options.force) {
    console.log(`⚡ Already uploaded and verified on Zoho Stratus (${formatBytes(existingSize)})! Skipping.`);
    const publicUrl = `${STRATUS_BASE_URL}/${encodeURI(targetKey)}`;
    console.log(`🔗 URL: ${publicUrl}`);
    return { url: publicUrl, size: existingSize };
  }

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const zohoToken = await getZohoToken();
      const driveToken = await getGoogleToken();

      return await new Promise((resolve, reject) => {
        const driveReq = https.request({
          hostname: 'www.googleapis.com',
          path: `/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`,
          method: 'GET',
          headers: { 'Authorization': `Bearer ${driveToken}` }
        }, (driveRes) => {
          if (driveRes.statusCode === 302 || driveRes.statusCode === 303) {
            const redirectUrl = new URL(driveRes.headers.location);
            https.get(redirectUrl, (redirectRes) => {
              handleUploadStream(redirectRes, targetKey, zohoToken, shouldConvertAudio, resolve, reject);
            }).on('error', reject);
            return;
          }

          if (driveRes.statusCode !== 200) {
            return reject(new Error(`Google Drive returned status ${driveRes.statusCode}: ${driveRes.statusMessage}`));
          }

          handleUploadStream(driveRes, targetKey, zohoToken, shouldConvertAudio, resolve, reject);
        });

        driveReq.on('error', reject);
        driveReq.end();
      });
    } catch (err) {
      if (attempt === 3) throw err;
      console.warn(`⚠️ Retrying upload (attempt ${attempt}/3): ${err.message}`);
      await new Promise(r => setTimeout(r, 2000 * attempt));
    }
  }

  function handleUploadStream(sourceStream, key, token, convertAudio, resolve, reject) {
    const uploadUrl = `${STRATUS_BASE_URL}/${encodeURI(key)}`;
    const uploadReq = https.request(uploadUrl, {
      method: 'PUT',
      headers: {
        'Authorization': 'Zoho-oauthtoken ' + token,
        'Content-Type': rawFilename.toLowerCase().endsWith('.mkv') ? 'video/x-matroska' : 'video/mp4',
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
      // Dual-Audio Movies: Remux Hindi track 0:2 to AAC, keep original crisp 1080p video untouched (-c:v copy)
      const ffmpegArgs = [
        '-threads', '2',
        '-probesize', '1000000',
        '-analyzeduration', '1000000',
        '-fflags', '+nobuffer+fastseek',
        '-flags', 'low_delay',
        '-i', 'pipe:0',
        '-map', '0:v:0',
        '-map', '0:2',
        '-c:v', 'copy',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-ar', '48000',
        '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
        '-frag_duration', '1000000',
        '-f', 'mp4',
        'pipe:1'
      ];

      console.log(`⚙️ Remuxing audio to universal AAC in-memory...`);
      proc = spawn(ffmpegPath, ffmpegArgs);
      
      proc.stdin.on('error', (err) => {
        if (err.code !== 'EPIPE') console.error('FFmpeg stdin error:', err.message);
      });
      sourceStream.pipe(proc.stdin);
      sourceStream.on('error', () => {
        try { proc.kill(); } catch (e) {}
      });

      // Drain stderr to prevent process pipe buffer deadlocks
      proc.stderr.on('data', () => {});

      streamToUpload = proc.stdout;

      proc.on('error', (err) => {
        console.error('FFmpeg spawn error:', err.message);
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
// 4b. DISK-STAGED MOVIE MIGRATOR (FOR LARGE FILES & ACCURATE FASTSTART REMUX)
// ==========================================

async function downloadGoogleDriveFile(fileId, destPath) {
  const driveToken = await getGoogleToken();
  return new Promise((resolve, reject) => {
    function fetchFromUrl(url, headers = {}) {
      const parsedUrl = new URL(url);
      const req = https.get(parsedUrl, { headers }, (res) => {
        if (res.statusCode === 302 || res.statusCode === 303) {
          return fetchFromUrl(res.headers.location);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`Drive download status ${res.statusCode}: ${res.statusMessage}`));
        }
        const totalSize = parseInt(res.headers['content-length'] || '0', 10);
        let downloaded = 0;
        const startTime = Date.now();
        let lastLog = 0;
        const outStream = fs.createWriteStream(destPath);
        res.on('data', (chunk) => {
          downloaded += chunk.length;
          const canContinue = outStream.write(chunk);
          if (!canContinue) {
            res.pause();
          }
          const now = Date.now();
          if (now - lastLog > 1000) {
            lastLog = now;
            const elapsed = (now - startTime) / 1000;
            const speed = elapsed > 0 ? (downloaded / (1024 * 1024) / elapsed).toFixed(1) : 0;
            const pct = totalSize > 0 ? ` (${((downloaded / totalSize) * 100).toFixed(1)}%)` : '';
            process.stdout.write(`\r📥 Downloading: ${formatBytes(downloaded)}${pct} @ ${speed} MB/s...  `);
          }
        });
        outStream.on('drain', () => {
          res.resume();
        });
        res.on('end', () => {
          outStream.end();
          console.log(`\n✅ Download complete: ${formatBytes(downloaded)}`);
          resolve(destPath);
        });
        res.on('error', (err) => {
          outStream.destroy();
          reject(err);
        });
      });
      req.on('error', reject);
    }

    const driveUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`;
    fetchFromUrl(driveUrl, { 'Authorization': `Bearer ${driveToken}` });
  });
}

async function remuxMovie(inputPath, outputPath, isDualAudio) {
  return new Promise((resolve, reject) => {
    let args;
    if (isDualAudio) {
      let audioMap = '0:2'; // default Hindi track for classic Doraemon movies
      try {
        const ffprobePath = ffmpegPath.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1') || 'ffprobe';
        const probeOut = execSync(`"${ffprobePath}" -v error -select_streams a -show_entries stream=index:stream_tags=language,title -of json "${inputPath}"`, { encoding: 'utf8' });
        const probeData = JSON.parse(probeOut);
        const streams = probeData.streams || [];
        if (streams.length > 0) {
          const hindiStream = streams.find(s => {
            const lang = ((s.tags && s.tags.language) || '').toLowerCase();
            const title = ((s.tags && s.tags.title) || '').toLowerCase();
            return lang.includes('hin') || title.includes('hin');
          });
          if (hindiStream) {
            audioMap = `0:${hindiStream.index}`;
          } else if (streams.length > 1) {
            audioMap = `0:${streams[1].index}`;
          } else {
            audioMap = `0:${streams[0].index}`;
          }
        }
      } catch (e) {
        audioMap = '0:2';
      }

      console.log(`🎵 Selected Audio Track: ${audioMap}`);
      // Remux selected Hindi track to AAC, keep crisp 1080p video untouched (-c:v copy), add +faststart
      args = [
        '-y',
        '-i', inputPath,
        '-map', '0:v:0',
        '-map', audioMap,
        '-c:v', 'copy',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-ar', '48000',
        '-movflags', '+faststart',
        outputPath
      ];
    } else {
      // Single audio: keep existing stream, move moov atom to start for 0-ms browser playback
      args = [
        '-y',
        '-i', inputPath,
        '-c', 'copy',
        '-movflags', '+faststart',
        outputPath
      ];
    }

    console.log(`⚙️ Remuxing with FFmpeg (${isDualAudio ? 'Dual-Audio -> Hindi AAC + faststart' : 'Single-Audio -> copy + faststart'})...`);
    const startTime = Date.now();
    const proc = spawn(ffmpegPath, args);

    let stderr = '';
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });

    proc.on('close', (code) => {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      if (code === 0) {
        console.log(`✅ Remuxing finished in ${elapsed}s!`);
        resolve(outputPath);
      } else {
        console.error('FFmpeg error stderr:', stderr.slice(-1000));
        reject(new Error(`FFmpeg exited with code ${code}`));
      }
    });

    proc.on('error', reject);
  });
}

async function uploadFileToStratus(filePath, targetKey, token) {
  const stat = fs.statSync(filePath);
  const totalSize = stat.size;
  const uploadUrl = `${STRATUS_BASE_URL}/${encodeURI(targetKey)}`;

  return new Promise((resolve, reject) => {
    const uploadReq = https.request(uploadUrl, {
      method: 'PUT',
      headers: {
        'Authorization': 'Zoho-oauthtoken ' + token,
        'Content-Type': 'video/mp4',
        'Content-Length': totalSize,
        'overwrite': 'true'
      }
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(res.statusCode);
        } else {
          reject(new Error(`Stratus upload failed (${res.statusCode}): ${body}`));
        }
      });
    });

    uploadReq.on('error', reject);

    const fileStream = fs.createReadStream(filePath, { highWaterMark: 64 * 1024 });
    let uploaded = 0;
    const startTime = Date.now();
    let lastLog = 0;

    fileStream.on('data', (chunk) => {
      uploaded += chunk.length;
      const canContinue = uploadReq.write(chunk);
      if (!canContinue) {
        fileStream.pause();
      }

      const now = Date.now();
      if (now - lastLog > 1000) {
        lastLog = now;
        const elapsed = (now - startTime) / 1000;
        const speed = elapsed > 0 ? (uploaded / (1024 * 1024) / elapsed).toFixed(1) : 0;
        const pct = ((uploaded / totalSize) * 100).toFixed(1);
        process.stdout.write(`\r🚀 Uploading to Stratus: ${formatBytes(uploaded)} / ${formatBytes(totalSize)} (${pct}%) @ ${speed} MB/s...  `);
      }
    });

    uploadReq.on('drain', () => {
      fileStream.resume();
    });

    fileStream.on('end', () => {
      uploadReq.end();
    });

    fileStream.on('error', (err) => {
      uploadReq.destroy(err);
      reject(err);
    });
  });
}

async function migrateMovie(item, options = {}) {
  const fileId = item.file_id;
  const rawFilename = item.filename || item.title || `${fileId}.mp4`;
  const safeFilename = rawFilename.replace(/[^a-zA-Z0-9._-]/g, '_');
  const targetKey = `Doraemon/Movies/${safeFilename}`;
  const isSingleAudioMovie = rawFilename.includes('2112 The Birth') ||
                             rawFilename.includes('Stand By Me') ||
                             rawFilename.includes('Sky Utopia') ||
                             rawFilename.includes('Earth Symphony') ||
                             rawFilename.includes('Star Wars 2021');
  const isDualAudio = !isSingleAudioMovie;

  console.log(`\n======================================================`);
  console.log(`🎬 Processing Movie: ${rawFilename}`);
  console.log(`📦 Type: ${isDualAudio ? 'Dual-Audio (Remuxing Hindi track to AAC + faststart)' : 'Single-Audio (Copy + faststart)'}`);
  console.log(`🎯 Stratus Target: ${targetKey}`);
  console.log(`======================================================`);

  const existingSize = (await checkStratusObject(targetKey)) || (await checkStratusObject(`movies/${safeFilename}`));
  if (existingSize && !options.force) {
    console.log(`⚡ Already uploaded and verified on Zoho Stratus (${formatBytes(existingSize)})! Skipping.`);
    const publicUrl = `${STRATUS_BASE_URL}/${encodeURI(targetKey)}`;
    return { url: publicUrl, size: existingSize };
  }

  const tmpDir = process.env.RUNNER_TEMP || require('os').tmpdir();
  const inputPath = path.join(tmpDir, `gdrive_${fileId}.mp4`);
  const outputPath = path.join(tmpDir, `remux_${fileId}.mp4`);

  try {
    // 1. Download
    await downloadGoogleDriveFile(fileId, inputPath);

    // 2. Remux
    await remuxMovie(inputPath, outputPath, isDualAudio);

    // Cleanup input immediately
    try { if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath); } catch (e) {}

    // 3. Upload to Stratus
    const zohoToken = await getZohoToken();
    await uploadFileToStratus(outputPath, targetKey, zohoToken);

    // Cleanup output immediately
    try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch (e) {}

    // 4. Verify Range Playback
    const publicUrl = `${STRATUS_BASE_URL}/${encodeURI(targetKey)}`;
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
      key: targetKey,
      url: publicUrl,
      converted_audio: isDualAudio,
      transferred_at: new Date().toISOString()
    };
    saveManifest();

    console.log(`\n🎉 Permanent Zoho Stratus URL:`);
    console.log(`👉 ${publicUrl}\n`);
    return manifest[fileId];
  } finally {
    try { if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath); } catch (e) {}
    try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch (e) {}
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

  if (target === 'oggy-missing') {
    const item = {
      filename: "S2E8-All Out of Shape.mp4",
      file_id: "1mX0MXR8t6raZh2lSvPI5EkZ5YoiIbC2t",
      title: "S2E8-All Out of Shape"
    };
    console.log(`🎯 Migrating Final Oggy Episode: ${item.filename}`);
    await migrateFile(item, { prefix: 'episodes', force: true });
    return;
  }

  if (target === 'sample-episode') {
    const episodes = JSON.parse(fs.readFileSync(path.join(__dirname, 'Doraemon_Google_Drive_Links.json'), 'utf8'));
    await migrateFile(episodes[0], { prefix: 'episodes' });
    return;
  }

  if (target === 'sample-movie') {
    const movies = JSON.parse(fs.readFileSync(path.join(__dirname, 'Doraemon_Movies_Google_Drive_Links.json'), 'utf8'));
    // Default to Nobita's Little Star Wars 2021 (fast ~590MB test) or Birth of Doraemon
    const movie = movies.find(m => m.filename.includes('Star Wars 2021')) || movies[0];
    await migrateMovie(movie);
    return;
  }

  if (target === 'movie-04' || target === 'undersea') {
    const movies = JSON.parse(fs.readFileSync(path.join(__dirname, 'Doraemon_Movies_Google_Drive_Links.json'), 'utf8'));
    const movie = movies.find(m => m.filename.includes('Undersea') || m.filename.includes('Movie_04')) || movies[2];
    console.log(`🎯 Targeting Undersea Movie: ${movie.title} (${movie.size_gb} GB)`);
    await migrateMovie(movie, { force: true });
    return;
  }

  if (target.startsWith('movies-batch-')) {
    const batchNum = parseInt(target.replace('movies-batch-', ''), 10);
    const movies = JSON.parse(fs.readFileSync(path.join(__dirname, 'Doraemon_Movies_Google_Drive_Links.json'), 'utf8'));
    const batchSize = 4; // 10 parallel cloud runners x 4 movies = 40 movies total
    const startIdx = (batchNum - 1) * batchSize;
    const endIdx = Math.min(startIdx + batchSize, movies.length);
    const batchMovies = movies.slice(startIdx, endIdx);

    console.log(`🎬 Processing Movies Batch ${batchNum} (${startIdx + 1} to ${endIdx} of ${movies.length})`);
    for (let i = 0; i < batchMovies.length; i++) {
      console.log(`\n[${i + 1}/${batchMovies.length}] Movie: ${batchMovies[i].title || batchMovies[i].filename}`);
      try {
        await migrateMovie(batchMovies[i]);
      } catch (err) {
        console.error(`❌ Error on movie:`, err.message);
      }
    }
    return;
  }

  if (target === 'all-movies') {
    const movies = JSON.parse(fs.readFileSync(path.join(__dirname, 'Doraemon_Movies_Google_Drive_Links.json'), 'utf8'));
    console.log(`🎬 Found ${movies.length} movies to migrate.`);
    for (let i = 0; i < movies.length; i++) {
      console.log(`\n[${i + 1}/${movies.length}] Processing Movie: ${movies[i].title || movies[i].filename}`);
      try {
        await migrateMovie(movies[i]);
      } catch (err) {
        console.error(`❌ Error on movie ${i + 1}:`, err.message);
      }
    }
    return;
  }

  if (target.startsWith('doraemon-s') || target.startsWith('doraemon-season-')) {
    const rawNum = target.replace(/^doraemon-(s|season-)/, '');
    const items = JSON.parse(fs.readFileSync(path.join(__dirname, 'Doraemon_Google_Drive_Links.json'), 'utf8'));
    let seasonItems;
    if (rawNum === '21-22') {
      seasonItems = items.filter(it => it.season === 'Season 21' || it.season === 'Season 22');
    } else {
      const sStr = `Season ${rawNum.padStart(2, '0')}`;
      seasonItems = items.filter(it => it.season === sStr);
    }
    const concurrency = parseInt(process.env.CONCURRENCY || '8', 10);
    console.log(`📺 Doraemon ${target} (${seasonItems.length} episodes). Concurrency: ${concurrency}`);

    let currentIndex = 0;
    async function worker(workerId) {
      while (currentIndex < seasonItems.length) {
        const i = currentIndex++;
        const item = seasonItems[i];
        console.log(`\n[Worker ${workerId}][${i + 1}/${seasonItems.length}] Processing: ${item.filename || item.title}`);
        try {
          await migrateFile(item, { prefix: 'episodes' });
        } catch (err) {
          console.error(`❌ [Worker ${workerId}] Error on item ${i + 1}:`, err.message);
        }
      }
    }

    const workers = Array.from({ length: concurrency }, (_, id) => worker(id + 1));
    await Promise.all(workers);
    return;
  }

  if (target === 'pokemon-missing' || target === 'pokemon-retry') {
    const missingPath = path.join(__dirname, 'missing_pokemon.json');
    const items = fs.existsSync(missingPath) 
      ? JSON.parse(fs.readFileSync(missingPath, 'utf8'))
      : JSON.parse(fs.readFileSync(path.join(__dirname, 'Pokemon_Google_Drive_Links.json'), 'utf8'));
    const concurrency = parseInt(process.env.CONCURRENCY || '8', 10);
    console.log(`⚡ Processing ${items.length} Pokemon episodes (missing/retry mode). Concurrency: ${concurrency}`);

    let currentIndex = 0;
    async function worker(workerId) {
      while (currentIndex < items.length) {
        const i = currentIndex++;
        const item = items[i];
        console.log(`\n[Worker ${workerId}][${i + 1}/${items.length}] Processing: ${item.filename || item.title}`);
        try {
          await migrateFile(item, { prefix: 'episodes' });
        } catch (err) {
          console.error(`❌ [Worker ${workerId}] Error on item ${i + 1}:`, err.message);
        }
      }
    }

    const workers = Array.from({ length: concurrency }, (_, id) => worker(id + 1));
    await Promise.all(workers);
    return;
  }

  if (target.startsWith('pokemon-batch-')) {
    const batchNum = parseInt(target.replace('pokemon-batch-', ''), 10);
    const items = JSON.parse(fs.readFileSync(path.join(__dirname, 'Pokemon_Google_Drive_Links.json'), 'utf8'));
    const totalBatches = 10;
    const batchSize = Math.ceil(items.length / totalBatches);
    const startIdx = (batchNum - 1) * batchSize;
    const endIdx = Math.min(startIdx + batchSize, items.length);
    const batchItems = items.slice(startIdx, endIdx);
    const concurrency = parseInt(process.env.CONCURRENCY || '8', 10);

    console.log(`⚡ Pokemon Batch ${batchNum}/${totalBatches} (${startIdx + 1} to ${endIdx} of ${items.length} episodes). Concurrency: ${concurrency}`);
    let currentIndex = 0;
    async function worker(workerId) {
      while (currentIndex < batchItems.length) {
        const i = currentIndex++;
        const item = batchItems[i];
        console.log(`\n[Worker ${workerId}][${startIdx + i + 1}/${items.length}] Processing: ${item.filename || item.title}`);
        try {
          await migrateFile(item, { prefix: 'episodes' });
        } catch (err) {
          console.error(`❌ [Worker ${workerId}] Error on item ${startIdx + i + 1}:`, err.message);
        }
      }
    }

    const workers = Array.from({ length: concurrency }, (_, id) => worker(id + 1));
    await Promise.all(workers);
    return;
  }

  if (target.startsWith('pokemon-s') || target.startsWith('pokemon-season-')) {
    const rawNum = target.replace(/^pokemon-(s|season-)/, '');
    const sStr = `Season ${rawNum.padStart(2, '0')}`;
    const items = JSON.parse(fs.readFileSync(path.join(__dirname, 'Pokemon_Google_Drive_Links.json'), 'utf8'));
    const seasonItems = items.filter(it => getPokemonSeason(it) === sStr);
    const concurrency = parseInt(process.env.CONCURRENCY || '8', 10);
    console.log(`📺 Pokemon ${sStr} (${seasonItems.length} episodes). Concurrency: ${concurrency}`);

    let currentIndex = 0;
    async function worker(workerId) {
      while (currentIndex < seasonItems.length) {
        const i = currentIndex++;
        const item = seasonItems[i];
        console.log(`\n[Worker ${workerId}][${i + 1}/${seasonItems.length}] Processing: ${item.filename || item.title}`);
        try {
          await migrateFile(item, { prefix: 'episodes' });
        } catch (err) {
          console.error(`❌ [Worker ${workerId}] Error on item ${i + 1}:`, err.message);
        }
      }
    }

    const workers = Array.from({ length: concurrency }, (_, id) => worker(id + 1));
    await Promise.all(workers);
    return;
  }

  if (target.startsWith('doraemon-batch-')) {
    const batchNum = parseInt(target.replace('doraemon-batch-', ''), 10);
    const items = JSON.parse(fs.readFileSync(path.join(__dirname, 'Doraemon_Google_Drive_Links.json'), 'utf8'));
    const totalBatches = 4;
    const batchSize = Math.ceil(items.length / totalBatches);
    const startIdx = (batchNum - 1) * batchSize;
    const endIdx = Math.min(startIdx + batchSize, items.length);
    const batchItems = items.slice(startIdx, endIdx);
    const concurrency = parseInt(process.env.CONCURRENCY || '4', 10);

    console.log(`📺 Doraemon Batch ${batchNum}/${totalBatches} (${startIdx + 1} to ${endIdx} of ${items.length} episodes). Concurrency: ${concurrency}`);
    let currentIndex = 0;
    async function worker(workerId) {
      while (currentIndex < batchItems.length) {
        const i = currentIndex++;
        const item = batchItems[i];
        console.log(`\n[Worker ${workerId}][${startIdx + i + 1}/${items.length}] Processing: ${item.filename || item.title}`);
        try {
          await migrateFile(item, { prefix: 'episodes' });
        } catch (err) {
          console.error(`❌ [Worker ${workerId}] Error on item ${startIdx + i + 1}:`, err.message);
        }
      }
    }

    const workers = Array.from({ length: concurrency }, (_, id) => worker(id + 1));
    await Promise.all(workers);
    return;
  }

  const catalogMap = {
    'doraemon': 'Doraemon_Google_Drive_Links.json',
    'shinchan': 'Shinchan_Google_Drive_Links.json',
    'oggy': 'Oggy_Google_Drive_Links.json',
    'chhota-bheem': 'Chhota_Bheem_Google_Drive_Links.json',
    'pokemon': 'Pokemon_Google_Drive_Links.json'
  };

  const catalogFile = catalogMap[target.toLowerCase()];
  if (catalogFile && fs.existsSync(path.join(__dirname, catalogFile))) {
    const items = JSON.parse(fs.readFileSync(path.join(__dirname, catalogFile), 'utf8'));
    const concurrency = parseInt(process.env.CONCURRENCY || '4', 10);
    console.log(`📺 Found ${items.length} episodes in ${catalogFile}. Concurrency: ${concurrency}`);

    let currentIndex = 0;
    async function worker(workerId) {
      while (currentIndex < items.length) {
        const i = currentIndex++;
        const item = items[i];
        console.log(`\n[Worker ${workerId}][${i + 1}/${items.length}] Processing: ${item.filename || item.title}`);
        try {
          await migrateFile(item, { prefix: 'episodes' });
        } catch (err) {
          console.error(`❌ [Worker ${workerId}] Error on item ${i + 1}:`, err.message);
        }
      }
    }

    const workers = Array.from({ length: concurrency }, (_, id) => worker(id + 1));
    await Promise.all(workers);
    return;
  }

  console.log(`❌ Unknown target "${target}". Valid targets: sample-episode, sample-movie, movies-batch-1..5, all-movies, doraemon, shinchan, oggy, chhota-bheem.`);
}

module.exports = {
  getZohoToken,
  checkStratusObject,
  STRATUS_BASE_URL,
  BUCKET_NAME,
  migrateMovie,
  migrateFile,
  run
};

if (require.main === module) {
  run().catch(console.error);
}
