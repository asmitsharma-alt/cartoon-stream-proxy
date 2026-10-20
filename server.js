const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawn } = require('child_process');
const { GoogleAuth } = require('google-auth-library');
require('dotenv').config();

// Locate static ffmpeg and ffprobe binaries
let ffmpegPath = 'ffmpeg';
let ffprobePath = 'ffprobe';
try {
  ffmpegPath = require('ffmpeg-static') || 'ffmpeg';
} catch (e) {
  // Use system ffmpeg
}
try {
  const ffprobeInstaller = require('@ffprobe-installer/ffprobe');
  ffprobePath = ffprobeInstaller.path || 'ffprobe';
} catch (e) {
  // Use system ffprobe
}

const app = express();
const PORT = process.env.PORT || 3000;

// Enable Cross-Origin Resource Sharing for all frontends/apps
app.use(cors({
  origin: '*',
  methods: ['GET', 'HEAD', 'OPTIONS'],
  allowedHeaders: ['Range', 'Content-Type', 'Authorization'],
  exposedHeaders: ['Content-Range', 'Accept-Ranges', 'Content-Length', 'Content-Type']
}));

// Serve static frontend files from 'public'
app.use(express.static(path.join(__dirname, 'public')));

// Persistent HTTPS Agent for connection pooling to Google Drive
const gdriveAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 50,
  timeout: 60000
});

// ==========================================
// 1. GOOGLE SERVICE ACCOUNT AUTHENTICATION
// ==========================================
let authClient = null;
let cachedToken = null;
let tokenExpiresAt = 0;

function initGoogleAuth() {
  let credentials = null;

  // 1. Check environment variable for raw JSON
  if (process.env.GOOGLE_CREDENTIALS) {
    try {
      credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
      console.log(' Loaded credentials from GOOGLE_CREDENTIALS env variable');
    } catch (e) {
      console.error('❌ Failed to parse GOOGLE_CREDENTIALS env:', e.message);
    }
  }

  // 2. Check specified path or auto-detect scoop-plus credentials file
  if (!credentials) {
    const credPath = process.env.GOOGLE_CREDENTIALS_PATH || path.join(__dirname, 'scoop-plus-b8ec77cef48d.json');
    if (fs.existsSync(credPath)) {
      try {
        credentials = JSON.parse(fs.readFileSync(credPath, 'utf8'));
        console.log(` Loaded credentials from file: ${path.basename(credPath)}`);
      } catch (e) {
        console.error(`❌ Failed reading credentials file ${credPath}:`, e.message);
      }
    } else {
      // Auto-search any service_account JSON in root
      const files = fs.readdirSync(__dirname);
      for (const f of files) {
        if (f.endsWith('.json') && !f.includes('Links') && !f.includes('package')) {
          try {
            const data = JSON.parse(fs.readFileSync(path.join(__dirname, f), 'utf8'));
            if (data.type === 'service_account') {
              credentials = data;
              console.log(` Auto-detected service account credentials from: ${f}`);
              break;
            }
          } catch (e) {}
        }
      }
    }
  }

  if (credentials) {
    authClient = new GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/drive.readonly']
    });
  } else {
    console.warn('⚠️ No Google credentials found! Drive API requests will be unauthorized.');
  }
}

async function getAccessToken() {
  const now = Date.now();
  if (cachedToken && tokenExpiresAt > now + 300000) { // 5 min safety buffer
    return cachedToken;
  }
  if (!authClient) return null;

  try {
    const client = await authClient.getClient();
    const tokenResponse = await client.getAccessToken();
    cachedToken = tokenResponse.token;
    // Standard Google token lasts 3600 seconds (1 hour)
    tokenExpiresAt = now + 3500 * 1000;
    return cachedToken;
  } catch (err) {
    console.error('❌ Error refreshing Google access token:', err.message);
    return null;
  }
}

// Background token refresher every 50 minutes
setInterval(async () => {
  try {
    await getAccessToken();
    console.log('🔄 Access token refreshed in background');
  } catch (e) {}
}, 50 * 60 * 1000);

// ==========================================
// 2. AUTOMATIC CATALOG INGESTION
// ==========================================
const catalogs = {};
const fileIndexMap = new Map();

function formatShowName(filename) {
  let name = filename.replace('_Google_Drive_Links.json', '').replace('.json', '');
  return name.replace(/_/g, ' ');
}

function loadCatalogs() {
  const files = fs.readdirSync(__dirname);
  let totalTitles = 0;

  files.forEach(file => {
    if (file.endsWith('_Google_Drive_Links.json')) {
      const showKey = file.replace('_Google_Drive_Links.json', '').toLowerCase();
      const showTitle = formatShowName(file);
      const filePath = path.join(__dirname, file);

      try {
        const rawData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (Array.isArray(rawData)) {
          const items = rawData.map((item, idx) => {
            const fileId = item.file_id;
            const title = item.title || item.filename || `Episode ${idx + 1}`;
            const season = item.season || (item.relative_path ? item.relative_path.split('/')[0] : 'General');
            
            // Normalize size in MB
            let sizeMb = item.size_mb;
            if (!sizeMb && item.size_gb) sizeMb = Math.round(item.size_gb * 1024 * 10) / 10;
            if (!sizeMb && item.size_bytes) sizeMb = Math.round((item.size_bytes / (1024 * 1024)) * 10) / 10;

            const normalizedItem = {
              id: `${showKey}_${idx + 1}`,
              index: item.index || (idx + 1),
              title,
              filename: item.filename || title,
              season,
              size_mb: sizeMb || 0,
              file_id: fileId,
              stream_url: `/stream/${fileId}`,
              show_key: showKey,
              show_title: showTitle
            };

            // Map by file_id for quick O(1) lookup
            fileIndexMap.set(fileId, normalizedItem);
            return normalizedItem;
          });

          // Group items by seasons
          const seasons = {};
          items.forEach(it => {
            if (!seasons[it.season]) seasons[it.season] = [];
            seasons[it.season].push(it);
          });

          catalogs[showKey] = {
            key: showKey,
            title: showTitle,
            total: items.length,
            seasons: Object.keys(seasons),
            items
          };

          totalTitles += items.length;
          console.log(` Indexed ${items.length} titles for "${showTitle}"`);
        }
      } catch (err) {
        console.error(`❌ Failed parsing catalog ${file}:`, err.message);
      }
    }
  });

  console.log(` Total Library: ${totalTitles} playable titles ready.`);
}

// ==========================================
// 3. ZERO-WAIT HEAD CHUNK CACHE (RAM)
// ==========================================
// Caches the first 512KB - 1MB chunk of actively accessed files in RAM
// This allows the initial browser request to respond in < 15ms!
const HEAD_CHUNK_SIZE = 1024 * 1024; // 1 MB
const headChunkCache = new Map();
const MAX_HEAD_CACHE_ITEMS = 60; // ~60 MB RAM max, safe for Render 512MB limit

function cacheHeadChunk(fileId, buffer, totalSize) {
  if (headChunkCache.size >= MAX_HEAD_CACHE_ITEMS) {
    const oldestKey = headChunkCache.keys().next().value;
    headChunkCache.delete(oldestKey);
  }
  headChunkCache.set(fileId, {
    buffer,
    totalSize,
    cachedAt: Date.now()
  });
}

// ==========================================
// 4. STREAMING ENGINE WITH HTTP RANGE
// ==========================================
app.get('/stream/:fileId', async (req, res) => {
  const { fileId } = req.params;
  const { audio, startTime } = req.query;

  const token = await getAccessToken();
  if (!token) {
    return res.status(500).send('Google authentication service unavailable');
  }

  const driveUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;

  const item = fileIndexMap.get(fileId);
  const isMovie = item && item.show_key === 'doraemon_movies';

  // If audio track is requested OR if it's a Doraemon movie (which has EAC3/AC3 audio),
  // stream with AAC audio transcoding so sound is 100% audible in every browser!
  let targetAudio = audio;
  if ((targetAudio === undefined || targetAudio === '') && isMovie) {
    targetAudio = (item.filename && item.filename.includes('2112 The Birth of Doraemon')) ? '1' : '2'; // Default to Hindi
  }

  // ----------------------------------------------------
  // Scenario A: Multi-Audio Stream Remuxing (e.g. Movies)
  // ----------------------------------------------------
  if (targetAudio !== undefined && targetAudio !== '') {
    const audioIdx = parseInt(targetAudio, 10);
    const startSec = parseFloat(startTime) || 0;

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Accept-Ranges', 'none'); // fragmented dynamic stream

    const ffmpegArgs = [];
    if (startSec > 0) {
      ffmpegArgs.push('-ss', startSec.toString());
    }

    ffmpegArgs.push(
      '-headers', `Authorization: Bearer ${token}\r\n`,
      '-i', driveUrl,
      '-map', '0:v:0',
      '-map', `0:${audioIdx}`,
      '-c:v', 'copy',
      '-c:a', 'aac', // Transcode selected audio to AAC (universally playable in Chrome/Firefox/Safari)
      '-b:a', '192k',
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
      '-f', 'mp4',
      'pipe:1'
    );

    const proc = spawn(ffmpegPath, ffmpegArgs);

    proc.stdout.pipe(res);

    proc.stderr.on('data', () => {
      // debug logs omitted to prevent terminal spam
    });

    req.on('close', () => {
      proc.kill('SIGKILL');
    });

    proc.on('error', (err) => {
      console.error('FFmpeg remux error:', err.message);
      if (!res.headersSent) res.status(500).send('Streaming error');
    });

    return;
  }

  // ----------------------------------------------------
  // Scenario B: Direct Line-Speed HTTP Range Streaming
  // ----------------------------------------------------
  const rangeHeader = req.headers.range;

  // Check if request is for the start of the file and we have it in RAM cache
  if (rangeHeader && headChunkCache.has(fileId)) {
    const parts = rangeHeader.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : undefined;
    const cached = headChunkCache.get(fileId);

    // If request start is within cached range
    if (start === 0 && (!end || end < cached.buffer.length)) {
      const sliceEnd = (end !== undefined && end < cached.buffer.length) ? end + 1 : cached.buffer.length;
      const chunk = cached.buffer.slice(start, sliceEnd);

      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${start + chunk.length - 1}/${cached.totalSize}`);
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Content-Length', chunk.length);
      res.setHeader('Content-Type', 'video/mp4');
      return res.end(chunk);
    }
  }

  // Forward range request to Google Drive API
  const options = {
    method: 'GET',
    agent: gdriveAgent,
    headers: {
      'Authorization': `Bearer ${token}`
    }
  };

  if (rangeHeader) {
    options.headers['Range'] = rangeHeader;
  }

  const driveReq = https.request(driveUrl, options, (driveRes) => {
    // If Google Drive returns 302/307 redirect to CDN, follow it
    if (driveRes.statusCode === 302 || driveRes.statusCode === 307) {
      const redirectUrl = driveRes.headers.location;
      const redirectReq = https.request(redirectUrl, {
        method: 'GET',
        headers: rangeHeader ? { 'Range': rangeHeader } : {}
      }, (redirRes) => {
        pipeDriveResponse(redirRes, res, fileId, rangeHeader);
      });
      redirectReq.on('error', (e) => res.status(502).send(e.message));
      redirectReq.end();
      return;
    }

    pipeDriveResponse(driveRes, res, fileId, rangeHeader);
  });

  driveReq.on('error', (err) => {
    console.error('Drive request error:', err.message);
    if (!res.headersSent) res.status(502).send('Error connecting to storage');
  });

  req.on('close', () => {
    driveReq.destroy();
  });

  driveReq.end();
});

function pipeDriveResponse(driveRes, clientRes, fileId, rangeHeader) {
  clientRes.status(driveRes.statusCode);

  const headersToForward = [
    'content-range',
    'content-length',
    'content-type',
    'accept-ranges',
    'last-modified',
    'etag'
  ];

  headersToForward.forEach(header => {
    if (driveRes.headers[header]) {
      clientRes.setHeader(header, driveRes.headers[header]);
    }
  });

  // Ensure Accept-Ranges is always present for video players
  if (!clientRes.getHeader('accept-ranges')) {
    clientRes.setHeader('Accept-Ranges', 'bytes');
  }

  // If this was the first chunk (bytes=0-...), cache up to 1MB in RAM for instant subsequent starts
  const isStart = !rangeHeader || rangeHeader.startsWith('bytes=0-');
  if (isStart && !headChunkCache.has(fileId)) {
    const totalSizeMatch = (driveRes.headers['content-range'] || '').match(/\/(\d+)$/);
    const totalSize = totalSizeMatch ? parseInt(totalSizeMatch[1], 10) : parseInt(driveRes.headers['content-length'] || '0', 10);
    
    const chunks = [];
    let received = 0;

    driveRes.on('data', (chunk) => {
      clientRes.write(chunk);
      if (received < HEAD_CHUNK_SIZE) {
        chunks.push(chunk);
        received += chunk.length;
        if (received >= HEAD_CHUNK_SIZE) {
          const fullBuf = Buffer.concat(chunks).slice(0, HEAD_CHUNK_SIZE);
          cacheHeadChunk(fileId, fullBuf, totalSize);
        }
      }
    });

    driveRes.on('end', () => {
      if (received < HEAD_CHUNK_SIZE && chunks.length > 0) {
        cacheHeadChunk(fileId, Buffer.concat(chunks), totalSize);
      }
      clientRes.end();
    });

    return;
  }

  driveRes.pipe(clientRes);
}

// ==========================================
// 5. MEDIA METADATA & AUDIO PROBE
// ==========================================
const mediaInfoCache = new Map();

// Pre-computed audio tracks for Doraemon Movies so there is 0ms delay and 100% reliability
function getPrecomputedTracks(fileId) {
  const item = fileIndexMap.get(fileId);
  if (!item || item.show_key !== 'doraemon_movies') return null;

  // Movie 00 is Hindi single audio
  if (item.filename && item.filename.includes('2112 The Birth of Doraemon')) {
    return [
      { index: 1, codec: 'mp3', language: 'hin', label: 'Hindi (Original)' }
    ];
  }

  // All other Doraemon Movies are Dual Audio: Japanese (Track 1) + Hindi (Track 2)
  return [
    { index: 2, codec: 'ac3', language: 'hin', label: 'Hindi (Dub)' },
    { index: 1, codec: 'eac3', language: 'jpn', label: 'Japanese (Original)' }
  ];
}

app.get('/api/info/:fileId', async (req, res) => {
  const { fileId } = req.params;

  // 1. Check pre-computed movie audio tracks first (0ms instant response)
  const precomputed = getPrecomputedTracks(fileId);
  if (precomputed) {
    return res.json({
      file_id: fileId,
      video: { index: 0, codec: 'h264' },
      audio_tracks: precomputed
    });
  }

  // 2. Check memory cache
  if (mediaInfoCache.has(fileId)) {
    return res.json(mediaInfoCache.get(fileId));
  }

  // Single-track episodes don't need probe
  res.json({
    file_id: fileId,
    video: { index: 0, codec: 'h264' },
    audio_tracks: [
      { index: 1, codec: 'aac', language: 'hin', label: 'Hindi / Default' }
    ]
  });
});

function formatAudioLabel(lang, codec) {
  const l = lang.toLowerCase();
  let name = lang;
  if (l.includes('hin')) name = 'Hindi';
  else if (l.includes('jpn') || l.includes('jap')) name = 'Japanese';
  else if (l.includes('eng')) name = 'English';
  else if (l.includes('tam')) name = 'Tamil';
  else if (l.includes('tel')) name = 'Telugu';
  return `${name} (${codec.toUpperCase()})`;
}

// ==========================================
// 6. REST API CATALOG ENDPOINTS
// ==========================================
// List all shows
app.get('/api/shows', (req, res) => {
  const result = Object.values(catalogs).map(cat => ({
    key: cat.key,
    title: cat.title,
    total: cat.total,
    seasons: cat.seasons
  }));
  res.json(result);
});

// List items for a show (with optional season, search, and pagination)
app.get('/api/shows/:showKey', (req, res) => {
  const { showKey } = req.params;
  const { season, search, page = 1, limit = 50 } = req.query;

  const catalog = catalogs[showKey.toLowerCase()];
  if (!catalog) {
    return res.status(404).json({ error: 'Show not found' });
  }

  let filtered = catalog.items;

  if (season) {
    filtered = filtered.filter(i => i.season.toLowerCase() === season.toLowerCase());
  }

  if (search) {
    const q = search.toLowerCase();
    filtered = filtered.filter(i => i.title.toLowerCase().includes(q) || i.filename.toLowerCase().includes(q));
  }

  const p = Math.max(1, parseInt(page, 10));
  const l = Math.max(1, Math.min(200, parseInt(limit, 10)));
  const startIndex = (p - 1) * l;
  const paginated = filtered.slice(startIndex, startIndex + l);

  res.json({
    show: catalog.title,
    key: catalog.key,
    total_items: filtered.length,
    page: p,
    total_pages: Math.ceil(filtered.length / l),
    items: paginated
  });
});

// Lookup individual item by file_id
app.get('/api/item/:fileId', (req, res) => {
  const item = fileIndexMap.get(req.params.fileId);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  res.json(item);
});

// ==========================================
// 7. KEEP-ALIVE HEALTH PING (FOR RENDER 24/7)
// ==========================================
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime_seconds: Math.floor(process.uptime()),
    total_titles: fileIndexMap.size,
    cached_head_chunks: headChunkCache.size,
    memory_mb: Math.round(process.memoryUsage().rss / (1024 * 1024)),
    timestamp: new Date().toISOString()
  });
});

// Start Server
initGoogleAuth();
loadCatalogs();

app.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(` Cartoon Streaming Proxy running at http://localhost:${PORT}`);
  console.log(` Test Player UI: http://localhost:${PORT}`);
  console.log(` Health Ping:    http://localhost:${PORT}/api/health`);
  console.log(`======================================================\n`);
});
