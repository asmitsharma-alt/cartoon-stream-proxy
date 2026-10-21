# 🎬 Cartoon Stream Server (Netflix Edition)

> **High-Performance Anime & Cartoon Streaming Engine with Dynamic Multi-Audio Switching on Zoho Catalyst AppSail & Zoho Stratus**

[![Live Server](https://img.shields.io/badge/Live%20Server-Online%20⚡-brightgreen)](https://cartoon-server-50046883835.development.catalystappsail.in)
[![API & AI Docs](https://img.shields.io/badge/Docs-Interactive%20Sandbox-blue)](https://cartoon-server-50046883835.development.catalystappsail.in/docs)
[![LLM Discovery](https://img.shields.io/badge/llms.txt-Standard%20Ready-purple)](https://cartoon-server-50046883835.development.catalystappsail.in/llms.txt)
[![OpenAPI 3.0](https://img.shields.io/badge/OpenAPI-3.0.3%20Spec-orange)](https://cartoon-server-50046883835.development.catalystappsail.in/openapi.json)

---

## 🌟 Quick Links

* 🌐 **Live Web Player**: [https://cartoon-server-50046883835.development.catalystappsail.in](https://cartoon-server-50046883835.development.catalystappsail.in)
* 📖 **Interactive API & AI Docs**: [https://cartoon-server-50046883835.development.catalystappsail.in/docs](https://cartoon-server-50046883835.development.catalystappsail.in/docs)
* 🤖 **Standard LLM System Context**: [https://cartoon-server-50046883835.development.catalystappsail.in/llms.txt](https://cartoon-server-50046883835.development.catalystappsail.in/llms.txt)
* 📑 **Comprehensive Technical Guide**: [SERVER_GUIDE.md](SERVER_GUIDE.md)

---

## 🚀 Key Highlights

* **⚡ Instant Playback (< 1 second)**: Direct HTTP 206 Byte-Range streaming from Zoho Stratus cloud storage.
* **🎧 On-The-Fly Multi-Audio Switching**: Embedded static FFmpeg 7.0.2 extracts and transmuxes alternate audio streams (Hindi, Japanese, Tamil, Telugu, English) on the fly without re-encoding video bitstreams (`-c:v copy -c:a aac`).
* **⏩ Advanced Player Controls**:
  * Interactive timeline scrubber with timestamp hover tooltips.
  * Direct jump-to-timestamp box (accepts `MM:SS` or `HH:MM:SS`).
  * Quick-skip buttons: `⏪ -10s`, `⏩ +10s`, and `⏭️ Skip Intro (+85s)`.
  * Keyboard shortcuts (<kbd>Space</kbd>, <kbd>J</kbd>/<kbd>L</kbd>, <kbd>M</kbd>, <kbd>F</kbd>, <kbd>0-9</kbd>).
* **📚 Massive Media Library**: **1,237 titles** indexed in-memory, including **all 40 Doraemon Theatrical Movies (1080p/720p)**, Doraemon TV seasons, Shinchan, and Pokemon.
* **🤖 Autonomous AI Integration**: Standard `/llms.txt` and `/openapi.json` specifications for ChatGPT, Claude, Gemini, Hermes, and autonomous scrapers.

---

## 🏗️ Architecture Overview

```
Zoho Stratus Object Storage (cartoon-storage)
  │ (Direct Range Requests & Media Blobs)
  ▼
Zoho Catalyst AppSail (Node.js 20 persistent container)
  ├── catalog.json (1,237 indexed titles in RAM)
  ├── bin/ffmpeg & bin/ffprobe v7.0.2 (Static zero-copy transmuxing)
  ├── Express API (/api/catalog, /api/tracks, /api/stream, /api/diag)
  └── Static Web Player (Netflix Dark Obsidian UI)
  │
  ▼
Universal Clients: Web Browser / Mobile Apps / VLC / AI Agents
```

For full architectural deep-dives, see **[SERVER_GUIDE.md](SERVER_GUIDE.md)**.

---

## 🔌 API Endpoints Summary

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/catalog` | `GET` | List all shows, season counts, and banner artwork. |
| `/api/show/:id` | `GET` | Detailed season-by-season episode list with storage keys. |
| `/api/tracks?key=...` | `GET` | Probe container via `ffprobe` for audio languages and duration. |
| `/api/stream?key=...&audio=...&t=...` | `GET` | Dual-mode video stream (HTTP 206 range OR FFmpeg transmux). |
| `/api/diag` | `GET` | Server diagnostics, Node version, and FFmpeg verification. |
| `/api/health` | `GET` | Service uptime and loaded catalog size. |
| `/docs` | `GET` | Interactive testing console & developer documentation. |
| `/llms.txt` | `GET` | AI agent system prompt & API discovery specs. |
| `/openapi.json` | `GET` | Complete OpenAPI 3.0.3 formal schema. |

---

## 🛠️ Local Setup

```bash
# 1. Clone repository
git clone https://github.com/asmitsharma-alt/cartoon-stream-proxy.git
cd cartoon-stream-proxy/appsail

# 2. Install dependencies
npm install

# 3. Start local server
npm start
```
Open [http://localhost:9000](http://localhost:9000) to view the player.

---

## ☁️ Deployment

Deployed to Zoho Catalyst AppSail via the official CLI:
```bash
catalyst deploy appsail --name cartoon-server --build-path appsail --stack node20 --command "node app.js"
```

---

## 📄 License
MIT License
