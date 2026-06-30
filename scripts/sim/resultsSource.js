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
// Also returns a Map from match id -> { home, away, homeGoals, awayGoals,
// aetHomeGoals, aetAwayGoals, penaltyWinner } for known knockout results,
// used by simulateTournamentNegBin to lock in completed knockout matches
// instead of re-simulating them.
//
// aetHomeGoals / aetAwayGoals: 'after extra time' score. null by default;
// populated only if extra time changed the scoreline (rare — most level
// matches after 90 stay level through ET and go to penalties, but the
// schema supports a stoppage/golden-goal-style ET winner). homeGoals/
// awayGoals ALWAYS represent the 90-minute score regardless of what
// happens afterward — this is what Elo updates are based on (extra time
// goals are a tiny, noisy sample and not used for rating purposes).
//
// penaltyWinner: 'home' | 'away' | undefined. Knockout matches cannot end
// level — a draw after 90 minutes goes to extra time and then penalties if
// still level. We deliberately do NOT model extra time or penalty shootouts
// as goal-scoring events (the existing penalty-shootout logic in
// knockoutNegBin.js's simulated draws is already an explicit ~50/50-plus-
// small-Elo-tilt coin flip, not a goals model — extending that to a few
// extra minutes of football would be modelling noise as signal). Instead,
// when a real knockout match finishes level on goals, results.json records
// the 90-minute scoreline AS PLAYED (so Elo updates still reflect the
// actual goals scored) plus aetHomeGoals/aetAwayGoals (if ET changed the
// score) and/or penaltyWinner recording who actually progressed.
// resolveKnockoutWinner() in knockoutResult.js is the single shared place
// that checks all three in the correct order (90min -> AET -> penalties) —
// downstream consumers should call that rather than re-deriving this logic.
//
// results.json lists ALL fixtures (group + knockout) as placeholders
// (homeGoals/awayGoals: null) so team names never need to be typed by
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
  const knownByMatchId = new Map();

  for (const r of results) {
    const payload = {
      home: r.home, away: r.away, homeGoals: r.homeGoals, awayGoals: r.awayGoals,
      aetHomeGoals: r.aetHomeGoals != null ? r.aetHomeGoals : null,
      aetAwayGoals: r.aetAwayGoals != null ? r.aetAwayGoals : null,
      penaltyWinner: r.penaltyWinner || null,
    };
    if (r.group) {
      // Group stage result — bucket by group letter
      if (!knownByGroup.has(r.group)) knownByGroup.set(r.group, []);
      knownByGroup.get(r.group).push(payload);
    } else if (r.id) {
      // Knockout result — bucket by match id (e.g. 'M73')
      knownByMatchId.set(r.id, payload);
    }
  }

  return { knownByGroup, knownByMatchId, resultsCount: results.length, lastUpdated };
}

module.exports = { loadResults, getKnownResultsByGroup, RESULTS_PATH };
