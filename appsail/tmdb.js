const fs = require('fs');
const path = require('path');
const https = require('https');

const TMDB_API_KEY = process.env.TMDB_API_KEY || 'febd351cb18c057ef65bd6cd832966b6';
const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p';

// In-Memory & File Cache for TMDB responses
const CACHE_FILE = path.join(__dirname, 'tmdb_cache.json');
let tmdbCache = {};

if (fs.existsSync(CACHE_FILE)) {
  try {
    tmdbCache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  } catch (e) {
    tmdbCache = {};
  }
}

function saveCache() {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(tmdbCache, null, 2));
  } catch (e) {
    // Ephemeral filesystem fallback
  }
}

// Canonical TMDB metadata for all 7 primary shows
const CANONICAL_SHOWS_TMDB = {
  'doraemon-movies': {
    title: 'Doraemon Theatrical Movies',
    tmdb_id: 65733,
    type: 'collection',
    poster: `${TMDB_IMAGE_BASE}/w500/u5sFU0Uw3qtFOeWNvnhLAt9JzbA.jpg`,
    banner: `${TMDB_IMAGE_BASE}/w1280/iflKt34Ck2JpY2PY9wW1zwdJgJi.jpg`,
    description: 'All 40 Japanese anime theatrical adventures of Doraemon and Nobita spanning 1980 to 2024 with Hindi dub and multi-language audio.',
    rating: 8.2,
    year: '1980 - 2024',
    genres: ['Animation', 'Adventure', 'Sci-Fi', 'Family']
  },
  'doraemon': {
    title: 'Doraemon (TV Series)',
    tmdb_id: 65733,
    type: 'tv',
    poster: `${TMDB_IMAGE_BASE}/w500/9ZN1P32SHviL3SV51qLivxycvcx.jpg`,
    banner: `${TMDB_IMAGE_BASE}/w1280/c2oiRa7V3bQzof4wVGzLXtWJ5QU.jpg`,
    description: 'Robotic cat Doraemon travels from the 22nd century to protect 10-year-old Nobita Nobi with mind-bending futuristic gadgets.',
    rating: 8.1,
    year: '1979 - Present',
    genres: ['Animation', 'Comedy', 'Sci-Fi', 'Family']
  },
  'shinchan': {
    title: 'Crayon Shin-chan',
    tmdb_id: 30623,
    type: 'tv',
    poster: `${TMDB_IMAGE_BASE}/w500/zg19Paur3lVVSh8J4LJVO1wgBIg.jpg`,
    banner: `${TMDB_IMAGE_BASE}/w1280/2vEu810kBAgeyEvIYsCbNpPl4mf.jpg`,
    description: 'The hilarious daily misadventures of five-year-old Shinnosuke "Shin" Nohara, his eccentric family, and friends in Kasukabe.',
    rating: 7.7,
    year: '1992 - Present',
    genres: ['Animation', 'Comedy', 'Family']
  },
  'pokemon': {
    title: 'Pokémon (The Complete Series)',
    tmdb_id: 60572,
    type: 'tv',
    poster: `${TMDB_IMAGE_BASE}/w500/lP4zwr0F7hWTbAFltfoFTc2AxRG.jpg`,
    banner: `${TMDB_IMAGE_BASE}/w1280/yYpQV25I7XB6S0POJOScPjxYWV5.jpg`,
    description: 'Join Ash Ketchum and his loyal partner Pikachu across 27 seasons as they battle gym leaders and rivals to become Pokémon Masters.',
    rating: 8.0,
    year: '1997 - Present',
    genres: ['Animation', 'Action & Adventure', 'Sci-Fi & Fantasy']
  },
  'luckyman': {
    title: 'Tottemo! Luckyman (1994)',
    tmdb_id: 152487,
    type: 'tv',
    poster: `${TMDB_IMAGE_BASE}/w500/8LEOE1SAzhy3qXlHsi06MpZC3Sv.jpg`,
    banner: `${TMDB_IMAGE_BASE}/w1280/dOIUl4rURV2CIunaHoZgsG5Fszd.jpg`,
    description: 'The cosmic slapstick adventures of an unlucky boy who transforms into Luckyman, defeating interstellar villains purely with dumb luck.',
    rating: 7.5,
    year: '1994',
    genres: ['Animation', 'Action', 'Comedy']
  },
  'chhota-bheem': {
    title: 'Chhota Bheem',
    tmdb_id: 32035,
    type: 'tv',
    poster: `${TMDB_IMAGE_BASE}/w500/q04ngVeKmBGrHisQecrMilLAR1J.jpg`,
    banner: `${TMDB_IMAGE_BASE}/w1280/e4DtlS7Siq906l6oFHreaJjJBFA.jpg`,
    description: 'The heroic adventures of young Bheem, endowed with superhuman strength, protecting the kingdom of Dholakpur with his loyal friends.',
    rating: 6.4,
    year: '2008 - Present',
    genres: ['Animation', 'Action & Adventure', 'Kids']
  },
  'oggy': {
    title: 'Oggy and the Cockroaches',
    tmdb_id: 2777,
    type: 'tv',
    poster: `${TMDB_IMAGE_BASE}/w500/aFAN9aKm0OblOr30ROejJCV8rGf.jpg`,
    banner: `${TMDB_IMAGE_BASE}/w1280/fVO7r9tAnauny8DAqbetlQ1tVtu.jpg`,
    description: 'Oggy, a lazy cat who just wants to lounge and watch TV, is endlessly harassed by three pesky cockroaches: Joey, Dee Dee, and Marky.',
    rating: 7.5,
    year: '1998 - Present',
    genres: ['Animation', 'Comedy', 'Family']
  }
};

/**
 * Perform HTTPS GET request with JSON parsing
 */
function tmdbFetch(url) {
  return new Promise((resolve) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          resolve(null);
        }
      });
    }).on('error', () => resolve(null));
  });
}

/**
 * Search TMDB for a movie or TV show
 */
async function searchTmdb(title, type = 'movie', year = null) {
  const cacheKey = `${type}_${title.toLowerCase().trim()}_${year || ''}`;
  if (tmdbCache[cacheKey]) {
    return tmdbCache[cacheKey];
  }

  // Sanitize title for searching
  const cleanTitle = title
    .replace(/\b(1080p|720p|480p|HEVC|x264|x265|Multi Audio|Hindi Dub|Dual Audio|WEB-DL|BluRay)\b/gi, '')
    .replace(/[-_]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  let queryUrl = `https://api.themoviedb.org/3/search/${type}?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(cleanTitle)}`;
  if (year) {
    queryUrl += type === 'movie' ? `&year=${year}` : `&first_air_date_year=${year}`;
  }

  const json = await tmdbFetch(queryUrl);
  if (!json || !json.results || json.results.length === 0) {
    // Fallback: try search without year if year was provided
    if (year) {
      return searchTmdb(title, type, null);
    }
    tmdbCache[cacheKey] = null;
    return null;
  }

  const best = json.results[0];
  const result = {
    tmdb_id: best.id,
    title: best.title || best.name,
    original_title: best.original_title || best.original_name,
    overview: best.overview || '',
    poster: best.poster_path ? `${TMDB_IMAGE_BASE}/w500${best.poster_path}` : null,
    backdrop: best.backdrop_path ? `${TMDB_IMAGE_BASE}/w1280${best.backdrop_path}` : null,
    rating: best.vote_average ? Math.round(best.vote_average * 10) / 10 : null,
    vote_count: best.vote_count || 0,
    release_date: best.release_date || best.first_air_date || '',
    year: (best.release_date || best.first_air_date || '').slice(0, 4)
  };

  tmdbCache[cacheKey] = result;
  saveCache();
  return result;
}

/**
 * Enriches a title (movie or episode) with TMDB poster, backdrop, and overview
 */
async function enrichTitle(cleanTitle, filename, isMovie = false) {
  // Extract year if present in filename or title
  const yearMatch = (cleanTitle + ' ' + filename).match(/\b(19\d\d|20\d\d)\b/);
  const year = yearMatch ? yearMatch[1] : null;

  // Clean movie query
  let query = cleanTitle;
  if (isMovie) {
    query = cleanTitle.replace(/\b(19\d\d|20\d\d)\b/g, '').trim();
    if (!query.toLowerCase().includes('doraemon')) {
      query = `Doraemon ${query}`;
    }
  }

  const type = isMovie ? 'movie' : 'tv';
  const meta = await searchTmdb(query, type, year);
  return meta;
}

module.exports = {
  TMDB_API_KEY,
  CANONICAL_SHOWS_TMDB,
  searchTmdb,
  enrichTitle
};
