const path = require('path');
const fs = require('fs');
const catalyst = require('zcatalyst-sdk-node');
const { CANONICAL_SHOWS_TMDB, enrichTitle } = require('./tmdb');

function cleanTitle(filename) {
  let name = filename.replace(/\.(mp4|mkv|avi|webm)$/i, '');
  name = name.replace(/_/g, ' ');
  name = name.replace(/\[.*?\]|\(.*?\)/g, (match) => {
    if (/\(\d{4}\)/.test(match)) return match;
    return '';
  });
  return name.replace(/\s+/g, ' ').trim();
}

function extractEpNumber(title, filename) {
  const match = (title + ' ' + filename).match(/(?:EP?|Episode|S\d+E)\s*(\d+)/i);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * Scan all objects in Zoho Stratus bucket 'stream' and build the full catalog structure enriched with TMDB
 * @param {object} req - Express request object containing Catalyst headers
 * @returns {Promise<{ shows: Array }>}
 */
async function scanBucketCatalog(req) {
  let catalystApp;
  try {
    catalystApp = req ? catalyst.initialize(req, { scope: 'admin' }) : catalyst.initialize({ scope: 'admin' });
  } catch (e) {
    catalystApp = catalyst.initialize();
  }

  const bucket = catalystApp.stratus().bucket('stream');
  const allObjects = [];
  let continuationToken = null;

  // List all objects across pages
  do {
    const opts = { folderListing: 'false', maxKeys: 1000 };
    if (continuationToken) opts.continuationToken = continuationToken;

    const pageResult = await bucket.listPagedObjects(opts);
    const contents = pageResult.contents || [];
    for (const item of contents) {
      const k = (item.keyDetails && item.keyDetails.key) || item.key;
      const s = (item.keyDetails && item.keyDetails.size) || item.size || 0;
      if (k && /\.(mp4|mkv|avi|webm)$/i.test(k)) {
        allObjects.push({ key: k, size: s });
      }
    }
    continuationToken = pageResult.next_continuation_token || null;
  } while (continuationToken);

  console.log(`[Catalog Scanner] Discovered ${allObjects.length} total video files in Zoho Stratus`);

  // Group into shows
  const showsMap = new Map();

  function getOrCreateShow(id, defaultTitle, defaultDesc, defaultBanner) {
    if (!showsMap.has(id)) {
      const meta = CANONICAL_SHOWS_TMDB[id] || {};
      showsMap.set(id, {
        id: id,
        title: meta.title || defaultTitle || id,
        description: meta.description || defaultDesc || `Watch ${defaultTitle || id} in HD on Cartoon Stream.`,
        banner: meta.banner || defaultBanner || 'https://image.tmdb.org/t/p/w1280/c2oiRa7V3bQzof4wVGzLXtWJ5QU.jpg',
        poster: meta.poster || 'https://image.tmdb.org/t/p/w500/9ZN1P32SHviL3SV51qLivxycvcx.jpg',
        rating: meta.rating || 8.0,
        year: meta.year || 'Classic',
        genres: meta.genres || ['Animation', 'Comedy'],
        seasons: {}
      });
    }
    return showsMap.get(id);
  }

  // Process all files
  for (const item of allObjects) {
    const k = item.key;
    const filename = path.basename(k);
    const clean = cleanTitle(filename);
    const epNum = extractEpNumber(clean, filename);
    const sizeMb = (item.size / (1024 * 1024)).toFixed(1);
    const streamUrl = `https://stream-development.zohostratus.in/${encodeURI(k)}`;
    const epObj = {
      id: `${k.replace(/[^a-zA-Z0-9]/g, '_').slice(-20)}`,
      title: clean,
      filename: filename,
      episode_number: epNum,
      key: k,
      stream_url: streamUrl,
      size_mb: sizeMb
    };

    if (k.startsWith('Doraemon/Movies/')) {
      const show = getOrCreateShow('doraemon-movies', 'Doraemon Theatrical Movies');
      if (!show.seasons['Movies']) show.seasons['Movies'] = [];

      // Enrich movie with TMDB poster, backdrop, synopsis, and rating
      try {
        const tmdbMeta = await enrichTitle(clean, filename, true);
        if (tmdbMeta) {
          epObj.tmdb_title = tmdbMeta.title;
          epObj.poster = tmdbMeta.poster;
          epObj.backdrop = tmdbMeta.backdrop;
          epObj.overview = tmdbMeta.overview;
          epObj.rating = tmdbMeta.rating;
          epObj.year = tmdbMeta.year;
        }
      } catch (tmdbErr) {
        // Fallback gracefully without breaking scan
      }

      show.seasons['Movies'].push(epObj);
    } else if (k.startsWith('Doraemon/')) {
      const show = getOrCreateShow('doraemon', 'Doraemon (TV Series)');
      const parts = k.split('/');
      const season = parts.length > 2 ? parts[1] : 'Season 01';
      if (!show.seasons[season]) show.seasons[season] = [];
      show.seasons[season].push(epObj);
    } else if (k.startsWith('Shinchan/')) {
      const show = getOrCreateShow('shinchan', 'Crayon Shin-chan');
      const parts = k.split('/');
      const season = parts.length > 2 ? parts[1] : 'Season 01';
      if (!show.seasons[season]) show.seasons[season] = [];
      show.seasons[season].push(epObj);
    } else if (k.startsWith('Pokemon/')) {
      const show = getOrCreateShow('pokemon', 'Pokémon (The Complete Series)');
      const parts = k.split('/');
      const season = parts.length > 2 ? parts[1] : 'Season 01';
      if (!show.seasons[season]) show.seasons[season] = [];
      show.seasons[season].push(epObj);
    } else if (k.startsWith('Luckyman/')) {
      const show = getOrCreateShow('luckyman', 'Lucky Man (1994)');
      const parts = k.split('/');
      const season = parts.length > 2 ? parts[1] : 'Season 01';
      if (!show.seasons[season]) show.seasons[season] = [];
      show.seasons[season].push(epObj);
    } else if (k.startsWith('Chhota Bheem/')) {
      const show = getOrCreateShow('chhota-bheem', 'Chhota Bheem');
      const parts = k.split('/');
      const season = parts.length > 2 ? parts[1] : 'Season 01';
      if (!show.seasons[season]) show.seasons[season] = [];
      show.seasons[season].push(epObj);
    } else if (k.startsWith('Oggy and the Cockroaches/')) {
      const show = getOrCreateShow('oggy', 'Oggy and the Cockroaches');
      const parts = k.split('/');
      const season = parts.length > 2 ? parts[1] : 'Season 01';
      if (!show.seasons[season]) show.seasons[season] = [];
      show.seasons[season].push(epObj);
    } else {
      // Auto-discover new show folder
      const parts = k.split('/');
      if (parts.length >= 2) {
        const topFolder = parts[0];
        const showId = topFolder.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        const show = getOrCreateShow(showId, topFolder);
        const season = parts.length > 2 ? parts[1] : 'Season 01';
        if (!show.seasons[season]) show.seasons[season] = [];
        show.seasons[season].push(epObj);
      }
    }
  }

  // Sort episodes in each season
  showsMap.forEach(show => {
    Object.keys(show.seasons).forEach(s => {
      show.seasons[s].sort((a, b) => {
        if (a.episode_number !== null && b.episode_number !== null) {
          return a.episode_number - b.episode_number;
        }
        return a.title.localeCompare(b.title);
      });
    });
  });

  // Preserve desired show order
  const order = ['doraemon-movies', 'doraemon', 'shinchan', 'pokemon', 'luckyman', 'chhota-bheem', 'oggy'];
  const compiledShows = [];
  order.forEach(id => {
    if (showsMap.has(id)) compiledShows.push(showsMap.get(id));
  });
  showsMap.forEach((show, id) => {
    if (!order.includes(id)) compiledShows.push(show);
  });

  return { shows: compiledShows };
}

module.exports = {
  scanBucketCatalog,
  cleanTitle,
  extractEpNumber
};
