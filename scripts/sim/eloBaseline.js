const fs = require('fs');
const path = require('path');
const { applyResultsToElo, IN_TOURNAMENT_DELTA_MULTIPLIER } = require('./eloUpdate');

const BASELINE_PATH = path.join(__dirname, '..', '..', 'elo_baseline.json');

// Loads elo_baseline.json. Returns { ratings: { teamName: elo }, fetchedAt, source }.
function loadBaseline() {
  const raw = fs.readFileSync(BASELINE_PATH, 'utf-8');
  const parsed = JSON.parse(raw);
  return { ratings: parsed.ratings, fetchedAt: parsed.fetchedAt, source: parsed.source };
}

// Computes current Elo ratings: starts from the frozen pre-tournament
// baseline and applies every PLAYED fixture (homeGoals/awayGoals both
// non-null) from results.json's results array, in date order, via the
// standard World Cup Elo update (K=60, goal-difference weighted), with each
// delta scaled by IN_TOURNAMENT_DELTA_MULTIPLIER (currently 1.5x - see
// eloUpdate.js for rationale).
//
// This is fully deterministic - same baseline + same results.json always
// produces the same ratings - and requires no live fetch, so there is no
// possibility of double-counting against eloratings.net's own updates.
//
// allFixtures: the full results.json `results` array (placeholders included;
// only entries with both goals non-null are applied).
//
// Returns:
//   teamsByName: Map of team name -> { name, elo } (current, post-results)
//   eloChanges: per-match Elo deltas, in the order applied (for logging)
//   appliedCount: number of fixtures applied
function computeCurrentRatings(allFixtures) {
  const { ratings, fetchedAt, source } = loadBaseline();

  const teamsByName = new Map(
    Object.entries(ratings).map(([name, elo]) => [name, { name, elo }])
  );

  const played = allFixtures
    .filter((r) => r.homeGoals != null && r.awayGoals != null)
    // Sort by date so Elo updates are applied in chronological order
    // (matters when a team plays multiple matches - each updates the
    // rating the next is based on). Entries without a date sort last and
    // keep their relative order (stable sort).
    .map((r, i) => ({ ...r, _origIndex: i }))
    .sort((a, b) => {
      if (a.date && b.date) return a.date.localeCompare(b.date) || a._origIndex - b._origIndex;
      if (a.date && !b.date) return -1;
      if (!a.date && b.date) return 1;
      return a._origIndex - b._origIndex;
    });

  const eloChanges = applyResultsToElo(teamsByName, played, IN_TOURNAMENT_DELTA_MULTIPLIER);

  return {
    teamsByName,
    eloChanges,
    appliedCount: played.length,
    baselineFetchedAt: fetchedAt,
    baselineSource: source,
    deltaMultiplier: IN_TOURNAMENT_DELTA_MULTIPLIER,
  };
}

module.exports = { loadBaseline, computeCurrentRatings, BASELINE_PATH };
