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

// Load In-Memory Catalog
let catalog = { shows: [] };
const catalogPath = path.join(__dirname, 'catalog.json');
if (fs.existsSync(catalogPath)) {
  try {
    catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
    console.log(`[Catalog] Loaded ${catalog.shows.length} shows from catalog.json`);
  } catch (err) {
    console.error('[Catalog] Error reading catalog.json:', err.message);
  }
}

// Global Middlewares
app.use(cors({
  origin: '*',
  methods: ['GET', 'HEAD', 'OPTIONS'],
  allowedHeaders: ['Range', 'Content-Type', 'Authorization'],
  exposedHeaders: ['Content-Range', 'Accept-Ranges', 'Content-Length', 'Content-Type']
}));

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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
  res.json({ shows: summary });
});

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
  const hasAudioOverride = audio !== undefined && audio !== '' && audio !== '0' && audio !== 'default';
  const useFfmpeg = hasAudioOverride || (isMkv && startSec > 0) || (startSec > 0 && req.query.audio !== undefined);

  // Option A: Dynamic FFmpeg Remux (Instant Multi-Audio Switch / MKV to MP4)
  if (useFfmpeg && fs.existsSync(FFMPEG_BIN)) {
    const audioIdx = parseInt(audio || '0', 10);
    const args = [];

    if (startSec > 0) {
      args.push('-ss', String(startSec));
    }

    args.push(
      '-headers', 'Accept-Encoding: identity\r\n',
      '-i', targetUrl,
      '-map', '0:v:0',
      '-map', `0:a:${isNaN(audioIdx) ? 0 : audioIdx}`,
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

  // Option B: Direct Stratus Byte-Range Proxy (for native MP4 playback)
  const rangeHeader = req.headers.range;
  const requestHeaders = {
    'Accept-Encoding': 'identity'
  };
  if (rangeHeader) {
    requestHeaders['Range'] = rangeHeader;
  }

  https.get(targetUrl, { headers: requestHeaders }, (stratusRes) => {
    res.status(stratusRes.statusCode);

    const forwardHeaders = [
      'content-type',
      'content-length',
      'content-range',
      'accept-ranges',
      'last-modified',
      'etag'
    ];

    forwardHeaders.forEach(h => {
      if (stratusRes.headers[h]) {
        res.setHeader(h, stratusRes.headers[h]);
      }
    });

    if (!res.getHeader('accept-ranges')) {
      res.setHeader('Accept-Ranges', 'bytes');
    }

    stratusRes.pipe(res);
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
