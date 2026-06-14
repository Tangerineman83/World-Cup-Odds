const fs = require('fs');
const path = require('path');

const RESULTS_PATH = path.join(__dirname, '..', '..', 'results.json');

// Loads results.json (if present). Returns { results: [...] } or
// { results: [] } if the file doesn't exist or is empty - so callers can
// run unconditionally without checking for the file's existence.
function loadResults() {
  try {
    const raw = fs.readFileSync(RESULTS_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    return { results: parsed.results || [], lastUpdated: parsed.lastUpdated || null };
  } catch (e) {
    return { results: [], lastUpdated: null };
  }
}

// Returns a Map from group letter -> array of known-result objects
// ({ home, away, homeGoals, awayGoals }), for passing to simulateGroup so
// completed fixtures are excluded from simulation (the real scoreline is
// used directly for that group's standings instead).
//
// results.json lists ALL 72 group-stage fixtures as placeholders
// (homeGoals/awayGoals: null) so team names/groups never need to be typed by
// hand - only entries where BOTH homeGoals and awayGoals are non-null are
// treated as "played"; everything else is ignored (and still simulated
// normally).
//
// NOTE: this does NOT update Elo ratings - that's handled separately and
// deterministically by eloBaseline.js (frozen pre-tournament baseline +
// results.json, applied in date order). Keeping the two concerns separate
// avoids ever double-applying an Elo delta.
function getKnownResultsByGroup() {
  const { results: allFixtures, lastUpdated } = loadResults();
  const results = allFixtures.filter((r) => r.homeGoals != null && r.awayGoals != null);

  const knownByGroup = new Map();
  for (const r of results) {
    if (!knownByGroup.has(r.group)) knownByGroup.set(r.group, []);
    knownByGroup.get(r.group).push({
      home: r.home, away: r.away, homeGoals: r.homeGoals, awayGoals: r.awayGoals,
    });
  }

  return { knownByGroup, resultsCount: results.length, lastUpdated };
}

module.exports = { loadResults, getKnownResultsByGroup, RESULTS_PATH };
