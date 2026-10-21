const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { spawn, execSync } = require('child_process');

// Ensure bundled Linux ffmpeg and ffprobe binaries are executable
const FFMPEG_BIN = path.join(__dirname, 'bin', 'ffmpeg');
const FFPROBE_BIN = path.join(__dirname, 'bin', 'ffprobe');

[FFMPEG_BIN, FFPROBE_BIN].forEach(bin => {
  if (fs.existsSync(bin)) {
    try {
      fs.chmodSync(bin, 0o755);
      console.log(`[Binary] Executable permission set on ${path.basename(bin)}`);
    } catch (err) {
      console.warn(`[Binary] Could not chmod ${path.basename(bin)}:`, err.message);
    }
  }
});

const app = express();
// AppSail PORT rule: Always use process.env.X_ZOHO_CATALYST_LISTEN_PORT
const PORT = process.env.X_ZOHO_CATALYST_LISTEN_PORT || process.env.PORT || 9000;
const BUCKET_BASE_URL = 'https://stream-development.zohostratus.in';
const { scanBucketCatalog } = require('./scanner');

// In-Memory Dynamic Catalog Management
let catalog = { shows: [] };
let catalogVersion = Date.now().toString();
let lastScanTime = Date.now();
let isScanning = false;
let lastCatalystReq = null;
const SCAN_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes TTL for auto-scanning

const catalogPath = path.join(__dirname, 'catalog.json');
if (fs.existsSync(catalogPath)) {
  try {
    catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
    console.log(`[Catalog] Loaded ${catalog.shows.length} shows from catalog.json (Version: ${catalogVersion})`);
  } catch (err) {
    console.error('[Catalog] Error reading catalog.json:', err.message);
  }
}

// Background Scan Trigger Function
async function triggerCatalogScan(req) {
  if (isScanning) return { status: 'already_running', version: catalogVersion };
  isScanning = true;
  const startTime = Date.now();
  console.log('[Catalog] 🚀 Starting Stratus catalog scan...');

  try {
    const freshCatalog = await scanBucketCatalog(req || lastCatalystReq);
    if (freshCatalog && freshCatalog.shows && freshCatalog.shows.length > 0) {
      catalog = freshCatalog;
      catalogVersion = Date.now().toString();
      lastScanTime = Date.now();
      const totalTitles = catalog.shows.reduce((acc, s) => {
        return acc + Object.keys(s.seasons).reduce((sAcc, sName) => sAcc + s.seasons[sName].length, 0);
      }, 0);
      console.log(`[Catalog] ✅ Scan complete in ${Date.now() - startTime}ms. Total: ${catalog.shows.length} shows, ${totalTitles} titles. Version: ${catalogVersion}`);

      // Persist to disk
      try {
        fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2));
      } catch (fsErr) {
        console.warn('[Catalog] Could not write catalog.json (ephemeral storage):', fsErr.message);
      }

      return {
        status: 'success',
        version: catalogVersion,
        shows_count: catalog.shows.length,
        total_titles: totalTitles,
        scan_time_ms: Date.now() - startTime
      };
    }
  } catch (err) {
    console.error('[Catalog] ❌ Stratus scan error:', err.message);
    return { status: 'error', message: err.message, version: catalogVersion };
  } finally {
    isScanning = false;
  }
}

// Global Middlewares
app.use((req, res, next) => {
  if (req.headers && (req.headers['x-zc-project-id'] || req.headers['catalyst-org'])) {
    lastCatalystReq = req;
  }
  next();
});

// Periodic background auto-check (every 60s checks if 5m TTL expired)
setInterval(() => {
  if (!isScanning && (Date.now() - lastScanTime > SCAN_INTERVAL_MS)) {
    triggerCatalogScan(lastCatalystReq).catch(() => {});
  }
}, 60000);

// Kick off auto-scan 5 seconds after startup to ensure fresh catalog
setTimeout(() => {
  if (!isScanning) {
    triggerCatalogScan(lastCatalystReq).catch(() => {});
  }
}, 5000);

// Global Middlewares
app.use(cors({
  origin: '*',
  methods: ['GET', 'HEAD', 'OPTIONS'],
  allowedHeaders: ['Range', 'Content-Type', 'Authorization'],
  exposedHeaders: ['Content-Range', 'Accept-Ranges', 'Content-Length', 'Content-Type']
}));

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Documentation & AI Agent Discovery Routes
app.get('/docs', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'docs.html'));
});

app.get('/llms.txt', (req, res) => {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.sendFile(path.join(__dirname, 'public', 'llms.txt'));
});

app.get('/openapi.json', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.sendFile(path.join(__dirname, 'public', 'openapi.json'));
});

// ==========================================
// 1. HEALTH & METRICS
// ==========================================
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    shows_count: catalog.shows.length
  });
});

app.get('/api/diag', (req, res) => {
  let ffmpegVersion = 'not found';
  let ffprobeVersion = 'not found';
  const bin = fs.existsSync(FFMPEG_BIN) ? FFMPEG_BIN : 'ffmpeg';
  const pbin = fs.existsSync(FFPROBE_BIN) ? FFPROBE_BIN : 'ffprobe';

  try {
    ffmpegVersion = execSync(`"${bin}" -version`, { timeout: 3000 }).toString().split('\n')[0];
  } catch (e) {
    ffmpegVersion = 'ERR: ' + e.message;
  }

  try {
    ffprobeVersion = execSync(`"${pbin}" -version`, { timeout: 3000 }).toString().split('\n')[0];
  } catch (e) {
    ffprobeVersion = 'ERR: ' + e.message;
  }

  res.json({
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    ffmpegBinExists: fs.existsSync(FFMPEG_BIN),
    ffprobeBinExists: fs.existsSync(FFPROBE_BIN),
    ffmpeg: ffmpegVersion,
    ffprobe: ffprobeVersion
  });
});

// ==========================================
// 2. CATALOG & TRACK INTROSPECTION API
// ==========================================
app.get('/api/catalog', (req, res) => {
  // Stale-While-Revalidate: Trigger background refresh if TTL expired
  if (lastCatalystReq && !isScanning && (Date.now() - lastScanTime > SCAN_INTERVAL_MS)) {
    triggerCatalogScan(lastCatalystReq).catch(() => {});
  }

  const etag = `W/"cat-${catalogVersion}"`;
  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
  res.setHeader('X-Catalog-Version', catalogVersion);
  res.setHeader('X-Catalog-Updated', new Date(lastScanTime).toISOString());

  if (req.headers['if-none-match'] === etag) {
    return res.status(304).end();
  }

  const summary = catalog.shows.map(show => ({
    id: show.id,
    title: show.title,
    description: show.description,
    banner: show.banner,
    seasons: Object.keys(show.seasons).map(sName => ({
      name: sName,
      episode_count: show.seasons[sName].length
    }))
  }));

  res.json({
    version: catalogVersion,
    last_updated: new Date(lastScanTime).toISOString(),
    shows: summary
  });
});

app.get('/api/catalog/version', (req, res) => {
  const totalTitles = catalog.shows.reduce((acc, s) => {
    return acc + Object.keys(s.seasons).reduce((sAcc, sName) => sAcc + s.seasons[sName].length, 0);
  }, 0);

  res.setHeader('Cache-Control', 'no-cache');
  res.json({
    version: catalogVersion,
    last_updated: new Date(lastScanTime).toISOString(),
    shows_count: catalog.shows.length,
    total_titles: totalTitles,
    is_scanning: isScanning
  });
});

const handleRefreshCatalog = async (req, res) => {
  if (isScanning) {
    return res.json({
      status: 'in_progress',
      message: 'Catalog scan already in progress',
      version: catalogVersion
    });
  }
  const result = await triggerCatalogScan(req);
  res.json(result);
};

app.get('/api/catalog/refresh', handleRefreshCatalog);
app.post('/api/catalog/refresh', handleRefreshCatalog);

app.get('/api/show/:id', (req, res) => {
  const show = catalog.shows.find(s => s.id === req.params.id);
  if (!show) {
    return res.status(404).json({ error: 'Show not found' });
  }
  res.json(show);
});

// In-Memory Track Cache
const trackCache = new Map();

app.get('/api/tracks', (req, res) => {
  const key = req.query.key;
  if (!key) return res.status(400).json({ error: 'Missing "key" parameter' });

  if (trackCache.has(key)) {
    return res.json(trackCache.get(key));
  }

  const targetUrl = `${BUCKET_BASE_URL}/${encodeURI(key)}`;
  const pbin = fs.existsSync(FFPROBE_BIN) ? FFPROBE_BIN : 'ffprobe';

  const args = [
    '-v', 'error',
    '-headers', 'Accept-Encoding: identity\r\n',
    '-show_entries', 'stream=index,codec_name,codec_type:stream_tags=language,title:format=duration',
    '-of', 'json',
    targetUrl
  ];

  let output = '';
  let errorOutput = '';
  const proc = spawn(pbin, args);

  proc.stdout.on('data', (d) => { output += d.toString(); });
  proc.stderr.on('data', (d) => { errorOutput += d.toString(); });

  proc.on('close', (code) => {
    if (code !== 0) {
      console.warn(`[FFprobe] exit code ${code} for ${key}`);
      const fallback = { duration: 0, audioTracks: [{ index: 0, streamIndex: 1, language: 'hin', label: '🔊 Hindi / Default' }] };
      return res.json(fallback);
    }

    try {
      const data = JSON.parse(output);
      const audioStreams = (data.streams || []).filter(s => s.codec_type === 'audio');
      const durationSec = Math.floor(parseFloat((data.format && data.format.duration) || '0'));

      const langMap = {
        'hin': 'Hindi',
        'tam': 'Tamil',
        'tel': 'Telugu',
        'eng': 'English',
        'en': 'English',
        'jpn': 'Japanese',
        'ja': 'Japanese'
      };

      const tracks = audioStreams.map((s, idx) => {
        const langCode = (s.tags && s.tags.language) || '';
        const langName = langMap[langCode.toLowerCase()] || (langCode ? langCode.toUpperCase() : `Audio ${idx + 1}`);
        return {
          index: idx,
          streamIndex: s.index,
          language: langCode || 'und',
          label: idx === 0 ? `🔊 ${langName} (Default)` : `🔊 ${langName}`,
          codec: s.codec_name
        };
      });

      const result = {
        duration: durationSec,
        audioTracks: tracks.length > 0 ? tracks : [{ index: 0, streamIndex: 1, language: 'und', label: '🔊 Default Audio' }]
      };
      trackCache.set(key, result);
      res.json(result);
    } catch (e) {
      console.error('[FFprobe Parse Error]:', e.message);
      res.json({ duration: 0, audioTracks: [{ index: 0, streamIndex: 1, language: 'und', label: '🔊 Default Audio' }] });
    }
  });

  proc.on('error', (err) => {
    console.error('[FFprobe Spawn Error]:', err.message);
    res.json({ duration: 0, audioTracks: [{ index: 0, streamIndex: 1, language: 'und', label: '🔊 Default Audio' }] });
  });
});

// ==========================================
// 3. STREAMING ENGINE (HTTP 206 + FFmpeg Multi-Audio)
// ==========================================
app.get('/api/stream', (req, res) => {
  const key = req.query.key;
  if (!key) {
    return res.status(400).json({ error: 'Missing "key" query parameter' });
  }

  const targetUrl = `${BUCKET_BASE_URL}/${encodeURI(key)}`;
  const audio = req.query.audio;
  const startSec = parseFloat(req.query.t || '0');
  const isMkv = key.toLowerCase().endsWith('.mkv');
  const isTs = key.toLowerCase().includes('stand_by_me') || key.toLowerCase().includes('sky_utopia') || key.toLowerCase().includes('earth_symphony');
  const hasAudioOverride = audio !== undefined && audio !== '' && audio !== 'default';
  const forceFfmpeg = req.query.remux === 'true' || isMkv || isTs;
  const useFfmpeg = forceFfmpeg || hasAudioOverride || startSec > 0;

  // Option A: Dynamic FFmpeg Remux (Instant Multi-Audio Switch / MKV to MP4)
  if (useFfmpeg && fs.existsSync(FFMPEG_BIN)) {
    const audioIdx = parseInt(audio || '0', 10);
    const args = [
      '-probesize', '32M',
      '-analyzeduration', '32M'
    ];

    if (startSec > 0) {
      args.push('-ss', String(startSec));
    }

    args.push(
      '-headers', 'Accept-Encoding: identity\r\n',
      '-i', targetUrl,
      '-map', '0:v:0',
      '-map', `0:a:${isNaN(audioIdx) ? 0 : audioIdx}?`,
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
      '-f', 'mp4',
      'pipe:1'
    );

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Access-Control-Allow-Origin', '*');

    const ffmpegProc = spawn(FFMPEG_BIN, args);

    ffmpegProc.stdout.pipe(res);

    ffmpegProc.stderr.on('data', () => {});

    ffmpegProc.on('error', (err) => {
      console.error('[FFmpeg Process Error]:', err.message);
      if (!res.headersSent) res.status(500).json({ error: 'FFmpeg streaming failed', details: err.message });
    });

    req.on('close', () => {
      try { ffmpegProc.kill('SIGKILL'); } catch (e) {}
    });

    return;
  }

  // Option B: Direct Stratus Byte-Range Proxy with Safe Chunk Slicing
  const rangeHeader = req.headers.range;

  https.get(targetUrl, { headers: { 'Accept-Encoding': 'identity' } }, (stratusRes) => {
    if (stratusRes.statusCode !== 200 && stratusRes.statusCode !== 206) {
      res.status(stratusRes.statusCode);
      return stratusRes.pipe(res);
    }

    const totalLength = parseInt(stratusRes.headers['content-length'] || '0', 10);
    const contentType = stratusRes.headers['content-type'] || 'video/mp4';

    res.setHeader('Content-Type', contentType);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length, Content-Type');
    if (stratusRes.headers['etag']) res.setHeader('ETag', stratusRes.headers['etag']);
    if (stratusRes.headers['last-modified']) res.setHeader('Last-Modified', stratusRes.headers['last-modified']);

    // Instant HEAD resolution without buffering data
    if (req.method === 'HEAD') {
      if (totalLength > 0 && totalLength <= 2147483647) {
        res.setHeader('Content-Length', totalLength);
      }
      stratusRes.destroy();
      return res.status(200).end();
    }

    if (!rangeHeader) {
      // Direct GET without range
      // If totalLength <= 2GB, we can safely set Content-Length.
      // If totalLength > 2GB, NEVER set Content-Length to prevent ZGS 32-bit signed integer overflow!
      if (totalLength > 0 && totalLength <= 2147483647) {
        res.setHeader('Content-Length', totalLength);
      }
      res.status(200);
      return stratusRes.pipe(res);
    }

    // Parse Range header: "bytes=start-end"
    let start = 0;
    let end = totalLength > 0 ? totalLength - 1 : 0;
    const parts = rangeHeader.replace(/bytes=/, '').split('-');
    if (parts[0]) start = parseInt(parts[0], 10);
    if (parts[1]) end = parseInt(parts[1], 10);

    // If open-ended range (e.g. bytes=0-), cap chunk size to 25MB to prevent ZGS 32-bit integer overflow
    // and deliver ultra-responsive, instant 206 streaming for video players
    const MAX_CHUNK_SIZE = 25 * 1024 * 1024; // 25 MB
    if (!parts[1] || (end - start + 1) > MAX_CHUNK_SIZE) {
      end = Math.min(start + MAX_CHUNK_SIZE - 1, totalLength > 0 ? totalLength - 1 : start + MAX_CHUNK_SIZE - 1);
    }

    const chunkSize = end - start + 1;
    res.status(206);
    if (totalLength > 0) {
      res.setHeader('Content-Range', `bytes ${start}-${end}/${totalLength}`);
    }
    res.setHeader('Content-Length', chunkSize);

    let bytesStreamed = 0;
    let bytesSkipped = 0;

    stratusRes.on('data', (chunk) => {
      // 1. Skip bytes before start
      if (bytesSkipped < start) {
        const remainingToSkip = start - bytesSkipped;
        if (chunk.length <= remainingToSkip) {
          bytesSkipped += chunk.length;
          return;
        } else {
          chunk = chunk.slice(remainingToSkip);
          bytesSkipped = start;
        }
      }

      // 2. Stream up to chunkSize
      const remainingToSend = chunkSize - bytesStreamed;
      if (remainingToSend <= 0) {
        stratusRes.destroy();
        return;
      }

      if (chunk.length > remainingToSend) {
        const slice = chunk.slice(0, remainingToSend);
        res.write(slice);
        bytesStreamed += slice.length;
        res.end();
        stratusRes.destroy();
      } else {
        res.write(chunk);
        bytesStreamed += chunk.length;
        if (bytesStreamed >= chunkSize) {
          res.end();
          stratusRes.destroy();
        }
      }
    });

    stratusRes.on('end', () => {
      if (!res.writableEnded) res.end();
    });

    stratusRes.on('error', (err) => {
      console.error(`[Stratus Stream Error] for key ${key}:`, err.message);
      if (!res.headersSent) res.status(502).end();
    });

    req.on('close', () => {
      stratusRes.destroy();
    });
  }).on('error', (err) => {
    console.error(`[Stream Error] for key ${key}:`, err.message);
    if (!res.headersSent) {
      res.status(502).json({ error: 'Failed to stream from storage backend', details: err.message });
    }
  });
});

// ==========================================
// 4. DYNAMIC HLS MASTER PLAYLIST
// ==========================================
app.get('/api/hls/:encodedKey/master.m3u8', (req, res) => {
  const key = decodeURIComponent(req.params.encodedKey);
  const streamBase = `/api/stream?key=${encodeURIComponent(key)}`;

  // Generate HLS playlist referencing multiple audio tracks and resolutions
  const masterM3u8 = `#EXTM3U
#EXT-X-VERSION:4

# Audio Tracks
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Hindi (Default)",DEFAULT=YES,AUTOSELECT=YES,LANGUAGE="hin",URI="${streamBase}"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Japanese / Original",DEFAULT=NO,AUTOSELECT=NO,LANGUAGE="jpn",URI="${streamBase}"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Tamil",DEFAULT=NO,AUTOSELECT=NO,LANGUAGE="tam",URI="${streamBase}"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Telugu",DEFAULT=NO,AUTOSELECT=NO,LANGUAGE="tel",URI="${streamBase}"

# Video Qualities
#EXT-X-STREAM-INF:BANDWIDTH=3500000,RESOLUTION=1920x1080,AUDIO="audio",NAME="1080p (Full HD)"
${streamBase}
#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720,AUDIO="audio",NAME="720p (HD)"
${streamBase}
#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=854x480,AUDIO="audio",NAME="480p (Data Saver)"
${streamBase}
`;

  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
  res.setHeader('Cache-Control', 'no-cache');
  res.send(masterM3u8);
});

// Serve frontend for all client routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start Server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`====================================================`);
  console.log(`🎬 Cartoon Streaming Server Running on Port: ${PORT}`);
  console.log(`📡 Storage Backend: ${BUCKET_BASE_URL}`);
  console.log(`🌐 Web Player: http://localhost:${PORT}`);
  console.log(`====================================================`);
});
