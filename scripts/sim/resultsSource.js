const fs = require('fs');
const path = require('path');
const { applyResultsToElo } = require('./eloUpdate');

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

// Applies all completed results to teamsByName (Map of name -> {name, elo}),
// mutating Elo ratings in place via the standard World Cup Elo update
// (K=60, goal-difference weighted - see eloUpdate.js). Returns the list of
// per-match Elo changes for transparency/logging.
//
// results.json lists ALL 72 group-stage fixtures as placeholders
// (homeGoals/awayGoals: null) so team names/groups never need to be typed by
// hand - only entries where BOTH homeGoals and awayGoals are non-null are
// treated as "played" and applied here; everything else is ignored (and
// still simulated normally).
//
// Also returns a Map from group letter -> array of known-result objects
// ({ home, away, homeGoals, awayGoals }), for passing to simulateGroup so
// completed fixtures are excluded from simulation.
function applyKnownResults(teamsByName) {
  const { results: allFixtures, lastUpdated } = loadResults();
  const results = allFixtures.filter((r) => r.homeGoals != null && r.awayGoals != null);

  const eloChanges = applyResultsToElo(teamsByName, results);

  const knownByGroup = new Map();
  for (const r of results) {
    if (!knownByGroup.has(r.group)) knownByGroup.set(r.group, []);
    knownByGroup.get(r.group).push({
      home: r.home, away: r.away, homeGoals: r.homeGoals, awayGoals: r.awayGoals,
    });
  }

  return { eloChanges, knownByGroup, resultsCount: results.length, lastUpdated };
}

module.exports = { loadResults, applyKnownResults, RESULTS_PATH };
