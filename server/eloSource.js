const https = require('https');
const { ELO_TO_NAME } = require('./countryMap');

const ELO_URL = 'https://www.eloratings.net/World.tsv';

function fetchText(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: {
        // A descriptive UA is good practice for a low-frequency, transparent scraper.
        'User-Agent': 'elo-odds-compare/1.0 (personal project; respectful low-frequency polling)'
      }
    }, (res) => {
      if (res.statusCode && res.statusCode >= 400) {
        reject(new Error(`Request to ${url} failed with status ${res.statusCode}`));
        return;
      }
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

// Parses World.tsv. Relevant columns (0-indexed):
//   2 -> two-letter eloratings.net country code
//   3 -> current Elo rating
async function getEloRatings() {
  const raw = await fetchText(ELO_URL);
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);

  const all = lines.map((line) => {
    const cols = line.split('\t');
    const code = cols[2];
    const rating = parseInt(cols[3], 10);
    return { code, rating };
  }).filter((row) => row.code && !Number.isNaN(row.rating));

  // Filter down to the 48 World Cup 2026 teams we have a mapping for,
  // and attach the friendly name used for matching against betting markets.
  const wc2026 = all
    .filter((row) => ELO_TO_NAME[row.code])
    .map((row) => ({
      code: row.code,
      team: ELO_TO_NAME[row.code],
      eloRating: row.rating,
    }));

  // Sort by rating descending and assign rank
  wc2026.sort((a, b) => b.eloRating - a.eloRating);
  wc2026.forEach((row, i) => (row.eloRank = i + 1));

  return wc2026;
}

module.exports = { getEloRatings, ELO_URL };
