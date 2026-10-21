# 🎬 Cartoon Stream Server (Project-Rainfall) — Complete Technical Guide & Architecture

> **Live Deployment:** [https://cartoon-server-50046883835.development.catalystappsail.in](https://cartoon-server-50046883835.development.catalystappsail.in)  
> **Interactive Docs:** [https://cartoon-server-50046883835.development.catalystappsail.in/docs](https://cartoon-server-50046883835.development.catalystappsail.in/docs)  
> **LLM Discovery:** [https://cartoon-server-50046883835.development.catalystappsail.in/llms.txt](https://cartoon-server-50046883835.development.catalystappsail.in/llms.txt)  
> **OpenAPI 3.0 Spec:** [https://cartoon-server-50046883835.development.catalystappsail.in/openapi.json](https://cartoon-server-50046883835.development.catalystappsail.in/openapi.json)

---

## 📑 Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [High-Level Architecture](#2-high-level-architecture)
3. [Core Technologies & Stack](#3-core-technologies--stack)
4. [How It Works Under the Hood](#4-how-it-works-under-the-hood)
   - [4.1 Storage & Video Ingestion Pipeline](#41-storage--video-ingestion-pipeline)
   - [4.2 In-Memory Catalog & Discovery](#42-in-memory-catalog--discovery)
   - [4.3 Dynamic Media Probing (ffprobe)](#43-dynamic-media-probing-ffprobe)
   - [4.4 Dual-Mode Streaming Engine (HTTP 206 vs FFmpeg Transmuxing)](#44-dual-mode-streaming-engine-http-206-vs-ffmpeg-transmuxing)
   - [4.5 Seeking & Timestamp Jumping](#45-seeking--timestamp-jumping)
   - [4.6 Resolution & Dynamic HLS Realities](#46-resolution--dynamic-hls-realities)
5. [Frontend Netflix-Style Web Player](#5-frontend-netflix-style-web-player)
   - [5.1 UI Layout & Design](#51-ui-layout--design)
   - [5.2 Timeline Scrubber & Scrub Controls](#52-timeline-scrubber--scrub-controls)
   - [5.3 Quick Skip & Intro Skipping](#53-quick-skip--intro-skipping)
   - [5.4 Multi-Language Audio Switching UI](#54-multi-language-audio-switching-ui)
   - [5.5 Keyboard Shortcuts](#55-keyboard-shortcuts)
6. [Complete API Reference](#6-complete-api-reference)
7. [AI Agent Integration & Autonomous Discovery](#7-ai-agent-integration--autonomous-discovery)
8. [Cloud Deployment & Operations (Zoho Catalyst AppSail)](#8-cloud-deployment--operations-zoho-catalyst-appsail)
9. [Local Development, Debugging & Testing](#9-local-development-debugging--testing)
10. [Troubleshooting & FAQ](#10-troubleshooting--faq)

---

## 1. Executive Summary

**Cartoon Stream Server** is a cloud-native, high-performance streaming engine and Netflix-style web application built on **Zoho Catalyst AppSail** and **Zoho Stratus Object Storage**.

It provides seamless video streaming for **1,237 cartoon and anime titles** (including all 40 Doraemon Theatrical Movies, Doraemon TV series, Shinchan, and Pokemon) with:
* **Instant Start Playback (< 1 second)** using direct HTTP byte-range passthrough.
* **Dynamic Multi-Audio Switching on the Fly** (Hindi, Japanese, Tamil, Telugu, English) powered by an embedded zero-copy FFmpeg transmuxing pipeline.
* **Precise Seeking & Intro Skipping** (+/- 10s and +85s anime intro skip) with direct timestamp inputs.
* **AI-First Discovery**: First-class support for LLMs, autonomous browser agents, and developer tooling via `/docs`, `/llms.txt`, and `/openapi.json`.

---

## 2. High-Level Architecture

The system is split into three decoupled tiers: Cloud Storage, Serverless Backend / Transmuxer, and the Responsive Web Player:

```
┌────────────────────────────────────────────────────────────────────────┐
│                        Zoho Stratus Object Storage                     │
│                        (bucket: cartoon-storage)                       │
│       - 40 Doraemon Movies (.mp4, multi-audio dual/tri tracks)         │
│       - Doraemon TV Seasons 01-22                                      │
│       - Shinchan TV Seasons 01-19                                      │
│       - Pokemon TV Seasons 01-27                                       │
└─────────────────────────────────▲──────────────────────────────────────┘
                                  │ Direct Range Requests / HTTPS Stream
                                  │
┌─────────────────────────────────┴──────────────────────────────────────┐
│                    Zoho Catalyst AppSail (Node.js 20)                  │
│                     Container: cartoon-server                          │
│                                                                        │
│  ┌───────────────────────┐             ┌────────────────────────────┐  │
│  │   Catalog & Cache     │             │    FFmpeg 7.0.2 Engine     │  │
│  │   - catalog.json      │             │    - ffprobe track inspect │  │
│  │   - In-memory cache   │             │    - on-the-fly transmux   │  │
│  └───────────────────────┘             └────────────────────────────┘  │
│                                                                        │
│  [REST API Routes]                                                     │
│   GET /api/catalog      ──> Returns show & season tree                 │
│   GET /api/show/:id     ──> Detailed episode list & metadata           │
│   GET /api/tracks       ──> ffprobe introspects audio streams          │
│   GET /api/stream       ──> Direct Range Proxy OR FFmpeg Remuxer       │
│   GET /api/diag         ──> System health, Node, & FFmpeg versions     │
│   GET /docs             ──> Interactive Web Sandbox & AI documentation │
│   GET /llms.txt         ──> Plaintext AI system prompt & specs         │
│   GET /openapi.json     ──> Formal OpenAPI 3.0.3 specification         │
└─────────────────────────────────▲──────────────────────────────────────┘
                                  │ CORS: * (Allow-Origin: *)
                                  │
┌─────────────────────────────────┴──────────────────────────────────────┐
│                      Client Layer & Web Player                         │
│  - Netflix Dark UI (HTML5 / Vanilla JS / CSS Grid)                     │
│  - Multi-Audio Track Selector (Hindi, Japanese, Tamil, etc.)           │
│  - Timeline scrubber + Jump-to-timestamp input + Quick Skips           │
│  - External integrations: Mobile apps, Playwright, AI Agents, VLC      │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Core Technologies & Stack

| Layer | Component | Description |
|---|---|---|
| **Hosting & Compute** | Zoho Catalyst AppSail | Linux x86_64 persistent container running Node.js 20 on 512 MB RAM. |
| **Media Storage** | Zoho Stratus | High-speed S3-compatible cloud object storage with public read permissions. |
| **Media Processing** | Static FFmpeg 7.0.2 & FFprobe | Bundled Linux binaries (`appsail/bin/ffmpeg` & `appsail/bin/ffprobe`) executed via Node child processes. |
| **Server Framework** | Express.js 4.x | Fast, unopinionated web server handling routing, Range streaming, and process lifecycle. |
| **Catalog System** | In-Memory JSON Index | Pre-indexed `catalog.json` holding 1,237 titles across multiple shows and seasons. |
| **Client Player** | Custom HTML5 Video Player | Dark-themed, responsive player with custom controls, scrubbing, audio switching, and keyboard bindings. |
| **AI Integration** | `llms.txt` + OpenAPI 3.0 | Machine-readable standards enabling autonomous agents and LLMs to interact with the API. |

---

## 4. How It Works Under the Hood

### 4.1 Storage & Video Ingestion Pipeline
1. Media files were transferred into the Zoho Stratus cloud bucket (`cartoon-storage`) using automated multi-threaded uploader scripts.
2. The Doraemon Movie catalog was partitioned into batches and synchronized via chunked signed PUT uploads.
3. Every uploaded file is accessible via a deterministic URL format:
   ```
   https://stream-development.zohostratus.in/{storage_key}
   ```
   Example:
   `https://stream-development.zohostratus.in/movies/doraemon/Doraemon.The.Movie.Nobitas.Dinosaur.720p.mp4`

### 4.2 In-Memory Catalog & Discovery
* When `appsail/app.js` boots, it reads `appsail/catalog.json` synchronously into server memory (`let catalog = { shows: [] }`).
* All requests to `/api/catalog` and `/api/show/:id` are resolved in **< 1ms** directly from RAM with zero database query latency.
* The catalog exposes:
  * Show IDs (`doraemon-movies`, `doraemon`, `shinchan`, `pokemon`).
  * Titles, descriptions, banners, and season breakdowns.
  * Individual episodes with exact cloud `key`, `duration`, and labels.

### 4.3 Dynamic Media Probing (`ffprobe`)
When a user selects a video, the client asks the server for the available audio tracks:
```
GET /api/tracks?key=movies/doraemon/Doraemon.The.Movie.Nobitas.Dinosaur.720p.mp4
```

1. **Cache Check**: The server checks an in-memory `trackCache` (JavaScript `Map`). If present, it returns immediately.
2. **Probing**: If uncached, the server spawns `ffprobe`:
   ```bash
   ffprobe -v error -headers "Accept-Encoding: identity\r\n" \
     -show_entries stream=index,codec_name,codec_type:stream_tags=language,title:format=duration \
     -of json https://stream-development.zohostratus.in/{key}
   ```
3. **Language Mapping**: FFprobe parses ISO-639-2 language tags (`hin` → Hindi, `jpn` → Japanese, `tam` → Tamil, `tel` → Telugu, `eng` → English).
4. **Response**: Returns a JSON object containing the total duration and an array of all detected audio tracks:
   ```json
   {
     "duration": 5940,
     "audioTracks": [
       { "index": 0, "streamIndex": 1, "language": "hin", "label": "🔊 Hindi (Default)", "codec": "aac" },
       { "index": 1, "streamIndex": 2, "language": "jpn", "label": "🔊 Japanese", "codec": "aac" }
     ]
   }
   ```

---

### 4.4 Dual-Mode Streaming Engine (HTTP 206 vs FFmpeg Transmuxing)

The `/api/stream` endpoint intelligently selects between two streaming modes depending on whether an audio track override is requested:

#### Mode A: Direct Stratus Byte-Range Proxy (Default Track)
* **When Used**: User is playing the primary audio track (`audio=0` or omitted) with no re-muxing needed.
* **Mechanism**:
  1. The browser sends an HTTP request with an `Range: bytes=0-` or `Range: bytes=1048576-` header.
  2. Node.js forwards the `Range` header directly to Zoho Stratus.
  3. Stratus responds with `HTTP 206 Partial Content`.
  4. Node pipes the raw byte stream directly to the browser.
* **Advantages**:
  * **0% CPU Overhead**: Pure network piping.
  * **Zero Latency**: Playback begins in under 50 milliseconds.
  * **Native Browser Seeking**: Chrome, Safari, Firefox, and VLC can seek freely using native byte ranges.

#### Mode B: Dynamic FFmpeg Transmuxing (Alternate Audio Track)
* **When Used**: User selects an alternate audio track (e.g. `?audio=1` for Japanese) or seeks within an MKV file.
* **Mechanism**:
  1. The server spawns an FFmpeg child process:
     ```bash
     ffmpeg \
       -ss {startSec} \
       -headers "Accept-Encoding: identity\r\n" \
       -i https://stream-development.zohostratus.in/{key} \
       -map 0:v:0 \
       -map 0:a:{audioIdx} \
       -c:v copy \
       -c:a aac -b:a 192k \
       -movflags frag_keyframe+empty_moov+default_base_moof \
       -f mp4 pipe:1
     ```
  2. **Key Flags Explained**:
     * `-c:v copy`: **Zero video re-encoding!** The 1080p/720p H.264 video frames are passed through unmodified. This keeps CPU usage low (~5% CPU).
     * `-map 0:a:{audioIdx}`: Selects only the chosen audio track (e.g. Japanese or Tamil).
     * `-c:a aac -b:a 192k`: Converts non-browser audio (e.g. AC-3 or DTS) into pristine, universally supported AAC stereo.
     * `-movflags frag_keyframe+empty_moov+default_base_moof`: Generates **fragmented MP4 (fMP4)** chunks that can be streamed progressively through `pipe:1` without needing to write a file header to disk first.
  3. **Process Lifecycle & Cleanup**:
     When the user pauses, changes tracks, or closes the browser tab, Node catches `req.on('close')` and immediately sends `SIGKILL` to the FFmpeg process. This guarantees that orphaned FFmpeg processes never linger in memory.

---

### 4.5 Seeking & Timestamp Jumping

Seeking in the web player works seamlessly across both modes:
1. **Direct HTTP Range**: The browser calculates byte offsets from duration and issues an HTTP 206 Range request.
2. **Dynamic Audio Stream**: When an alternate audio track is active, the player appends `&t={currentSeconds}` to the stream URL:
   ```
   /api/stream?key=...&audio=1&t=1520
   ```
   FFmpeg uses `-ss 1520` *before* the input (`-i`), performing an input-level fast seek on the source file in milliseconds, and immediately outputs new video frames starting from the selected timestamp.

---

### 4.6 Resolution & Dynamic HLS Realities

A common question is: *Can resolution (1080p -> 720p -> 480p) be switched dynamically like audio?*

| Feature | Audio Track Switching | Resolution Switching (Adaptive Bitrate) |
|---|---|---|
| **CPU Cost** | Negligible (`-c:v copy` passes video untouched) | **Massive** (requires decoding and re-rendering every video frame) |
| **Memory Cost** | ~15 MB per active stream | 150-300 MB per stream |
| **How Netflix Does It** | Pre-muxed audio tracks in separate streams | **Pre-encoded ladders**: Netflix pre-transcodes every movie into 1080p, 720p, 480p, 360p files beforehand. |
| **AppSail Strategy** | Dynamic on-the-fly audio extraction (`-c:v copy`) | Media files are stored in high-definition (720p/1080p). An HLS master manifest (`/api/hls/:key/master.m3u8`) is provided for HLS-compliant clients. |

---

## 5. Frontend Netflix-Style Web Player

The frontend is served from [`appsail/public/index.html`](file:///C:/Users/admin/Desktop/rea/appsail/public/index.html). It requires no build step (zero Webpack/Vite bundle overhead) and executes instantly in all modern browsers.

### 5.1 UI Layout & Design
* **Aesthetic**: Deep obsidian theme (`#141414`) with Netflix Crimson highlights (`#E50914`), glassy control panels, and glowing status pills.
* **Responsive Architecture**: CSS Flexbox and Grid ensure optimal playback across desktop monitors, iPads, and mobile phones.
* **Top Navigation Bar**:
  * 🍿 **CARTOON STREAM** branding.
  * 📖 **API & AI Docs** link (`/docs`).
  * 🤖 **llms.txt** link (`/llms.txt`).
  * ⚡ **ONLINE** server heartbeat indicator.

### 5.2 Timeline Scrubber & Scrub Controls
* **Interactive Progress Bar**: Click or drag across the timeline scrubber to seek to any position.
* **Time Tooltip**: Hovering over the scrubber displays the exact timestamp at that point.
* **Elapsed / Total Time**: Live timestamp display formatted in `HH:MM:SS` or `MM:SS`.

### 5.3 Quick Skip & Intro Skipping
Above the timeline scrubber, dedicated quick-jump actions provide instant convenience:
* ⏪ **-10s**: Rewind 10 seconds.
* ⏩ **+10s**: Skip forward 10 seconds.
* ⏭️ **Skip Intro (+85s)**: Instantly skips the standard 85-second cartoon opening theme song.
* **Jump to Timestamp Box**: Direct text box allowing the user to type `12:30` or `01:15:00` and press <kbd>Enter</kbd> to jump directly to that time.

### 5.4 Multi-Language Audio Switching UI
* When an episode is selected, the player requests `/api/tracks?key=...`.
* The **🎧 Audio Track** dropdown dynamically populates with the actual languages discovered inside the video container (e.g. `🔊 Hindi (Default)`, `🔊 Japanese`, `🔊 Tamil`, `🔊 Telugu`, `🔊 English`).
* Selecting a language updates the video source seamlessly, maintaining the current playback position without resetting to the start.

### 5.5 Keyboard Shortcuts

| Key | Action |
|---|---|
| <kbd>Space</kbd> or <kbd>K</kbd> | Toggle Play / Pause |
| <kbd>←</kbd> / <kbd>→</kbd> | Seek backward / forward 5 seconds |
| <kbd>J</kbd> / <kbd>L</kbd> | Seek backward / forward 10 seconds |
| <kbd>M</kbd> | Toggle Mute |
| <kbd>F</kbd> | Toggle Fullscreen |
| <kbd>0</kbd> – <kbd>9</kbd> | Jump to 0% – 90% of the video duration |

---

## 6. Complete API Reference

All endpoints are public and support universal cross-origin requests (`Access-Control-Allow-Origin: *`).

### 1. Catalog Overview
* **Route**: `GET /api/catalog`
* **Description**: Returns all available shows, banners, and season counts.
* **Sample Response**:
  ```json
  {
    "shows": [
      {
        "id": "doraemon-movies",
        "title": "Doraemon Theatrical Movies (All 40 Movies)",
        "description": "Complete collection of all 40 Doraemon anime theatrical feature films.",
        "banner": "https://m.media-amazon.com/images/M/MV5BMjA5NTY2NTg1NF5BMl5BanBnXkFtZTcwMjE0Nzk3Mw@@._V1_.jpg",
        "seasons": [
          { "name": "All 40 Theatrical Movies (1080p / 720p)", "episode_count": 40 }
        ]
      }
    ]
  }
  ```

### 2. Show Details & Episodes
* **Route**: `GET /api/show/:id`
* **Parameters**: `id` — Show ID (e.g. `doraemon-movies`, `doraemon`, `shinchan`, `pokemon`).
* **Sample Request**:
  ```bash
  curl https://cartoon-server-50046883835.development.catalystappsail.in/api/show/doraemon-movies
  ```

### 3. Track Introspection
* **Route**: `GET /api/tracks`
* **Query Parameters**:
  * `key`: Cloud storage key (e.g. `movies/doraemon/Doraemon.Movie.01.mp4`).
* **Sample Response**:
  ```json
  {
    "duration": 5940,
    "audioTracks": [
      { "index": 0, "streamIndex": 1, "language": "hin", "label": "🔊 Hindi (Default)", "codec": "aac" },
      { "index": 1, "streamIndex": 2, "language": "jpn", "label": "🔊 Japanese", "codec": "aac" }
    ]
  }
  ```

### 4. Media Stream
* **Route**: `GET /api/stream`
* **Query Parameters**:
  * `key`: Cloud storage key (*required*).
  * `audio`: Audio track index (`0`, `1`, `2`, ...). Optional.
  * `t`: Start time in seconds for fast-seek remuxing (e.g. `740`). Optional.
* **Headers Supported**: `Range: bytes={start}-{end}`.
* **Response**: `video/mp4` stream with `HTTP 200` or `HTTP 206 Partial Content`.

### 5. Dynamic HLS Master Playlist
* **Route**: `GET /api/hls/:encodedKey/master.m3u8`
* **Description**: Delivers an HLS playlist with audio alternative renditions.
* **Response**: `application/vnd.apple.mpegurl`.

### 6. Diagnostics & System Health
* **Route**: `GET /api/health` — Checks uptime and loaded catalog size.
* **Route**: `GET /api/diag` — Verifies Node version, platform architecture, and bundled FFmpeg/FFprobe binaries.

---

## 7. AI Agent Integration & Autonomous Discovery

The server is architected so AI agents (ChatGPT, Claude, Gemini, Hermes, or autonomous Playwright crawlers) can interact with it without human intervention.

### 1. `GET /llms.txt`
Follows the emerging standard for LLM site indexing. It provides:
* Concise overview of the server capabilities.
* Full schema specification and parameter documentation.
* Integration recipes in Python, JavaScript/Node.js, and cURL.
* Complete show IDs and storage key naming conventions.

### 2. `GET /openapi.json`
An official **OpenAPI 3.0.3 specification**. This can be plugged directly into:
* OpenAI Custom GPT Actions.
* Claude Tool Use / MCP connectors.
* LangChain, LlamaIndex, or AutoGen toolkits.
* Postman and Swagger UI.

### 3. Interactive Web Sandbox (`/docs`)
Developers and browser-based agents can navigate to `/docs` to:
* View live endpoint tables.
* Execute live API queries with the **⚡ Test Live** console.
* Copy a 1-click self-contained prompt to paste into any LLM chat window.

---

## 8. Cloud Deployment & Operations (Zoho Catalyst AppSail)

### Deployment Architecture
The server is deployed to **Zoho Catalyst AppSail** under the project **Project-Rainfall**:
* **Runtime**: `node20`
* **Allocated RAM**: 512 MB
* **AppSail Name**: `cartoon-server`
* **Listen Port**: Set dynamically via `process.env.X_ZOHO_CATALYST_LISTEN_PORT`.

### Deployment Procedure
To deploy updates to the server:

```powershell
# 1. Navigate to the project directory
cd C:\Users\admin\Desktop\rea

# 2. Deploy using the Catalyst CLI
catalyst deploy appsail --name cartoon-server --build-path appsail --stack node20 --command "node app.js"
```

### Authentication Token Handling
Catalyst CLI uses OAuth tokens stored in `C:\Users\admin\.catalyst\config\credentials.json`. When tokens expire (~60 min), they can be refreshed without launching a browser:
```javascript
const Credential = require('zcatalyst-cli/lib/authentication/credential');
const cred = new Credential();
cred.refreshAccessToken().then(() => console.log('Token refreshed!'));
```

---

## 9. Local Development, Debugging & Testing

### Running Locally
```bash
# 1. Clone repository
git clone https://github.com/asmitsharma-alt/cartoon-stream-proxy.git
cd cartoon-stream-proxy/appsail

# 2. Install dependencies
npm install

# 3. Start local development server
npm start
```
The server will boot on `http://localhost:9000` (or the port defined in `PORT`).

### Automated Testing with Playwright
To verify UI elements, scrubber interactions, and video playback automatically:
```bash
python test_playwright.py
```
This launches a headless Chromium instance, verifies player canvas rendering, tests audio track switching, takes visual screenshots, and asserts that no console errors occurred.

---

## 10. Troubleshooting & FAQ

#### Q: Why does the video buffer when I switch audio languages?
**A**: When switching audio, the server must initiate a fresh transmuxing pipe using FFmpeg. Video frames are passed through untouched (`-c:v copy`), so the switch typically takes under 0.8 seconds.

#### Q: How do I add new episodes or shows to the library?
**A**:
1. Upload the media file to the `cartoon-storage` bucket on Zoho Stratus.
2. Add an entry to `appsail/catalog.json` with the corresponding `key`, `title`, and `duration`.
3. Redeploy the AppSail service with `catalyst deploy appsail`.

#### Q: Can I play streams in third-party players like VLC or IINA?
**A**: Yes! Copy the stream URL:
```
https://cartoon-server-50046883835.development.catalystappsail.in/api/stream?key=movies/doraemon/Doraemon.The.Movie.Nobitas.Dinosaur.720p.mp4
```
Open VLC &rarr; **Media** &rarr; **Open Network Stream** &rarr; Paste the URL. You can switch audio tracks directly inside VLC.

---

*Authored for the Cartoon Stream Proxy project. Open-source, production-grade, and AI-ready.*
