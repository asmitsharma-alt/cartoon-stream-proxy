const fs = require('fs');
const https = require('https');
const path = require('path');

const cat = JSON.parse(fs.readFileSync(path.join(__dirname, 'appsail', 'catalog.json'), 'utf8'));
const dMovies = cat.shows.find(s => s.id === 'doraemon-movies').seasons.Movies;
const BASE_URL = 'https://cartoon-server-50046883835.development.catalystappsail.in';

async function testMovie(movie, idx) {
  return new Promise((resolve) => {
    const streamUrl = `${BASE_URL}/api/stream?key=${encodeURIComponent(movie.key)}`;
    const startTime = Date.now();
    let ttfb = null;
    let bytes = 0;
    let resolved = false;

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        req.destroy();
        resolve({
          num: idx + 1,
          title: movie.title,
          key: movie.key,
          status: 'TIMEOUT (10s)',
          ttfb_ms: ttfb,
          ready_ms: null,
          bytes: bytes,
          fast: false,
          note: 'Exceeded 10s without buffering 256KB'
        });
      }
    }, 10000);

    const req = https.get(streamUrl, {
      headers: {
        'Range': 'bytes=0-',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    }, (res) => {
      res.on('data', (chunk) => {
        if (ttfb === null) {
          ttfb = Date.now() - startTime;
        }
        bytes += chunk.length;
        // 256 KB is the standard initial buffer threshold for video player playback start
        if (bytes >= 256 * 1024 && !resolved) {
          resolved = true;
          clearTimeout(timer);
          const readyTime = Date.now() - startTime;
          res.destroy();
          resolve({
            num: idx + 1,
            title: movie.title,
            key: movie.key,
            status: res.statusCode,
            ttfb_ms: ttfb,
            ready_ms: readyTime,
            bytes: bytes,
            fast: readyTime < 2000,
            note: readyTime < 1000 ? '⚡ Ultra Fast (<1s)' : (readyTime < 2000 ? '✓ Fast (<2s)' : '⚠️ Moderate')
          });
        }
      });

      res.on('end', () => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          const totalTime = Date.now() - startTime;
          resolve({
            num: idx + 1,
            title: movie.title,
            key: movie.key,
            status: res.statusCode,
            ttfb_ms: ttfb,
            ready_ms: totalTime,
            bytes: bytes,
            fast: false,
            note: `Stream ended early (${(bytes/1024).toFixed(0)} KB)`
          });
        }
      });
    });

    req.on('error', (err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        resolve({
          num: idx + 1,
          title: movie.title,
          key: movie.key,
          status: 'ERROR',
          ttfb_ms: null,
          ready_ms: null,
          bytes: 0,
          fast: false,
          note: err.message
        });
      }
    });
  });
}

(async () => {
  console.log('================================================================');
  console.log(`🎬 Testing Playback Speed for ALL ${dMovies.length} Doraemon Theatrical Movies`);
  console.log('📡 Endpoint: ' + BASE_URL + '/api/stream');
  console.log('================================================================\n');

  const results = [];
  const CONCURRENCY = 4; // Test 4 movies concurrently for realistic fast benchmarking

  for (let i = 0; i < dMovies.length; i += CONCURRENCY) {
    const chunk = dMovies.slice(i, i + CONCURRENCY);
    const promises = chunk.map((m, idx) => testMovie(m, i + idx));
    const batchResults = await Promise.all(promises);
    batchResults.forEach(r => {
      results.push(r);
      const icon = r.status === 206 || r.status === 200 ? (r.fast ? '⚡' : '⏱️') : '❌';
      console.log(`${icon} #${String(r.num).padStart(2, '0')} [${r.status}] ${r.title.slice(0, 45).padEnd(45)} | TTFB: ${r.ttfb_ms ? r.ttfb_ms + 'ms' : 'N/A'} | PlayReady: ${r.ready_ms ? r.ready_ms + 'ms' : 'N/A'} | ${r.note}`);
    });
  }

  console.log('\n================================================================');
  console.log('📊 FINAL SPEED REPORT SUMMARY');
  console.log('================================================================');

  const successful = results.filter(r => r.ready_ms !== null);
  const ultraFast = results.filter(r => r.ready_ms !== null && r.ready_ms < 1000);
  const fast = results.filter(r => r.ready_ms !== null && r.ready_ms >= 1000 && r.ready_ms < 2500);
  const slow = results.filter(r => r.ready_ms !== null && r.ready_ms >= 2500);
  const failed = results.filter(r => r.ready_ms === null);

  const avgReady = successful.length > 0
    ? (successful.reduce((a, b) => a + b.ready_ms, 0) / successful.length).toFixed(0)
    : 0;
  const avgTtfb = successful.length > 0
    ? (successful.reduce((a, b) => a + (b.ttfb_ms || 0), 0) / successful.length).toFixed(0)
    : 0;

  console.log(`Total Movies Tested : ${results.length}`);
  console.log(`Successful Plays    : ${successful.length} / ${results.length} (${((successful.length/results.length)*100).toFixed(0)}%)`);
  console.log(`⚡ Ultra Fast (< 1s) : ${ultraFast.length}`);
  console.log(`✓ Fast (< 2.5s)     : ${fast.length}`);
  console.log(`⚠️ Slower (>= 2.5s) : ${slow.length}`);
  console.log(`❌ Failed / Timeout : ${failed.length}`);
  console.log(`📈 Average TTFB     : ${avgTtfb} ms`);
  console.log(`🚀 Average Start    : ${avgReady} ms`);
  console.log('================================================================');

  // Save report to JSON for artifact
  fs.writeFileSync(path.join(__dirname, 'doraemon_movies_speed_report.json'), JSON.stringify({
    timestamp: new Date().toISOString(),
    total: results.length,
    avgTtfb_ms: avgTtfb,
    avgStart_ms: avgReady,
    results: results
  }, null, 2));
})();
