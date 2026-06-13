const https = require('https');
const { NAME_TO_ELO, normalize } = require('./countryMap');

// Public, no-auth Gamma API. The "World Cup Winner" event groups one market per team,
// each a binary "Will X win the 2026 FIFA World Cup?" market.
const GAMMA_EVENT_URL = 'https://gamma-api.polymarket.com/events?slug=world-cup-winner';

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: {
        'User-Agent': 'elo-odds-compare/1.0 (personal project; respectful low-frequency polling)',
        Accept: 'application/json',
      }
    }, (res) => {
      if (res.statusCode && res.statusCode >= 400) {
        reject(new Error(`Request to ${url} failed with status ${res.statusCode}`));
        return;
      }
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Failed to parse JSON from ${url}: ${e.message}`));
        }
      });
    }).on('error', reject);
  });
}

// Normalizes a Polymarket team-market title like "Will Spain win the 2026 FIFA World Cup?"
// down to a bare team name for lookup against NAME_TO_ELO.
function extractTeamName(market) {
  // Prefer groupItemTitle if present (Polymarket uses this for grouped/multi-outcome events)
  const candidates = [market.groupItemTitle, market.question, market.title];
  for (const c of candidates) {
    if (!c) continue;
    let name = c.trim();
    // Strip "Will " prefix and " win the 2026 FIFA World Cup?" / similar suffix
    name = name.replace(/^Will\s+/i, '');
    name = name.replace(/\s+win the (the )?2026 FIFA World Cup\??\s*$/i, '');
    name = name.trim();
    if (name && NAME_TO_ELO[normalize(name)]) {
      return name;
    }
  }
  return null;
}

async function getBettingOdds() {
  const events = await fetchJson(GAMMA_EVENT_URL);
  if (!Array.isArray(events) || events.length === 0) {
    throw new Error('Unexpected response from Polymarket Gamma API: no events found');
  }

  const event = events[0];
  const markets = event.markets || [];

  const rows = [];
  for (const market of markets) {
    const teamName = extractTeamName(market);
    if (!teamName) continue; // not one of our mapped 48 teams (or not a per-team market)

    let prices = market.outcomePrices;
    if (typeof prices === 'string') {
      try { prices = JSON.parse(prices); } catch { prices = null; }
    }
    let outcomes = market.outcomes;
    if (typeof outcomes === 'string') {
      try { outcomes = JSON.parse(outcomes); } catch { outcomes = null; }
    }

    let yesPrice = null;
    if (Array.isArray(prices) && Array.isArray(outcomes)) {
      const yesIdx = outcomes.findIndex((o) => String(o).toLowerCase() === 'yes');
      if (yesIdx >= 0) yesPrice = parseFloat(prices[yesIdx]);
    }
    if (yesPrice === null && market.lastTradePrice != null) {
      yesPrice = parseFloat(market.lastTradePrice);
    }
    if (yesPrice === null || Number.isNaN(yesPrice)) continue;

    rows.push({
      code: NAME_TO_ELO[normalize(teamName)],
      team: teamName,
      impliedProbability: yesPrice, // 0-1
    });
  }

  // Sort by implied probability descending and assign rank
  rows.sort((a, b) => b.impliedProbability - a.impliedProbability);
  rows.forEach((row, i) => (row.oddsRank = i + 1));

  return {
    rows,
    eventVolume: event.volume != null ? parseFloat(event.volume) : null,
    eventEndDate: event.endDate || null,
  };
}

module.exports = { getBettingOdds, GAMMA_EVENT_URL };
