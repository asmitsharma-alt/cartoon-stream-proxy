# ⚡ StreamVault — High-Performance Google Drive Video Streaming Proxy

A lightweight, high-performance streaming proxy and player built in Native Node.js. It streams media directly from Google Drive into custom video players (HTML5 `<video>`, Video.js, Plyr, React Native, or Flutter) with **< 1-second instant start**, **HTTP Range (seeking) support**, and **on-the-fly multi-audio track switching** (Hindi, Japanese, etc.).

Optimized specifically for **Render Free Tier** (runs under 80 MB RAM with zero video re-encoding CPU overhead).

---

## 🌟 Key Features

* **⚡ Instant Playback (< 1 second)**: Caches the initial `512 KB–1 MB` head chunk of media files in server RAM, serving initial video headers and frames in **< 15ms**.
* **🎧 Multi-Audio Switching**: Movies with dual/multi-audio tracks (e.g. Japanese EAC-3 & Hindi MP3) can be toggled on the fly in **~0.5 seconds** while keeping your exact playback position.
* **⏩ HTTP 206 Range Seeking**: Full support for `Range: bytes=...` requests. Fast-forwarding, rewinding, and scrubbing work seamlessly.
* **🌐 Universal CORS**: Access `/stream/:fileId` from any external domain, mobile app, or frontend player.
* **📺 Dynamic Auto-Catalog**: Automatically discovers and indexes all `*_Google_Drive_Links.json` files in the root folder (currently indexing **2,439 titles** across Doraemon, Shinchan, Chhota Bheem, Oggy, and Doraemon Movies).
* **☁️ Render Free Tier Ready**:
  * Native Node.js (no Docker required).
  * `< 80 MB` RAM footprint.
  * `/api/health` endpoint for free 24/7 uptime pingers to eliminate Render's 15-minute sleep.

---

## 🚀 Quick Start (Local Setup)

### 1. Install Dependencies
```bash
npm install
```

### 2. Configure Service Account
Place your Google Cloud Service Account JSON file in the project root:
```
scoop-plus-b8ec77cef48d.json
```
*(The server auto-detects any `*service_account*.json` file in the directory).*

### 3. Start the Server
```bash
npm start
```
Open **[http://localhost:3000](http://localhost:3000)** in your browser to browse and play titles immediately!

---

## ☁️ 1-Click Deployment to Render (Free Tier)

### Step 1: Push Code to GitHub
Ensure you have created a repository on GitHub and pushed your code:
```bash
git add .
git commit -m "Initial commit of streaming proxy"
git push -u origin main
```
*(Note: Your `.gitignore` automatically prevents your credentials JSON from being pushed publicly).*

### Step 2: Create a Web Service on Render
1. Log in to [Render.com](https://render.com) and click **New +** &rarr; **Web Service**.
2. Connect your GitHub repository.
3. Configure the settings:
   * **Runtime**: `Node`
   * **Build Command**: `npm install`
   * **Start Command**: `npm start`
   * **Instance Type**: `Free`

### Step 3: Set Environment Variables on Render
Under the **Environment** tab on Render, add:
* **Key**: `GOOGLE_CREDENTIALS`
* **Value**: *Paste the entire JSON contents of `scoop-plus-b8ec77cef48d.json`*.

Click **Save & Deploy**!

### Step 4: Keep It Awake 24/7 (Prevent 15-min Sleep)
1. Go to [Cron-job.org](https://cron-job.org) or [UptimeRobot](https://uptimerobot.com) (100% free).
2. Create a new monitor that pings your health URL every **10 minutes**:
   ```
   https://your-service-name.onrender.com/api/health
   ```
3. Your server will stay active 24/7 with zero cold starts!

---

## 🔌 API Endpoints

### 1. Video Stream
* **`GET /stream/:fileId`**
  * Direct streaming endpoint with full HTTP Range (206) support.
  * **Query Parameters**:
    * `audio`: *(optional)* Audio track index for multi-audio movies (e.g. `?audio=1` for Japanese, `?audio=2` for Hindi).
    * `startTime`: *(optional)* Seek position in seconds when switching audio (e.g. `?startTime=540`).

### 2. Media Information & Audio Tracks
* **`GET /api/info/:fileId`**
  * Probes video and audio streams via ffprobe:
  ```json
  {
    "file_id": "1vT-ZaTWBFqzpcxxQHsbkHfbHtcC-vMnA",
    "video": { "index": 0, "codec": "h264" },
    "audio_tracks": [
      { "index": 1, "codec": "eac3", "language": "jpn", "label": "Japanese (EAC3)" },
      { "index": 2, "codec": "mp3", "language": "hin", "label": "Hindi (MP3)" }
    ]
  }
  ```

### 3. Catalogs
* **`GET /api/shows`**: List all available shows and item counts.
* **`GET /api/shows/:showKey`**: Paginated titles for a show (`?page=1&limit=50&season=Season%2001&search=bheem`).
* **`GET /api/item/:fileId`**: Get metadata for a specific title.

### 4. Health Check
* **`GET /api/health`**: Uptime, memory usage, and title counts.

---

## 💻 How to Use in External Players & Apps

### HTML5 `<video>`
```html
<video controls playsinline preload="auto" src="https://your-domain.com/stream/FILE_ID"></video>
```

### React / Next.js
```jsx
export function Player({ fileId }) {
  return (
    <video
      controls
      playsInline
      preload="auto"
      src={`https://your-domain.com/stream/${fileId}`}
    />
  );
}
```

### Video.js / Plyr
```javascript
const player = new Plyr('#player');
player.source = {
  type: 'video',
  sources: [{
    src: 'https://your-domain.com/stream/FILE_ID',
    type: 'video/mp4'
  }]
};
```

---

## 📄 License
MIT License
