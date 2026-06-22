// Updates Elo ratings based on actual played World Cup results, following
// eloratings.net's published methodology:
//
//   Elo_new = Elo_old + K * G * (W - We)
//
// where:
//   K = 60 for World Cup matches (eloratings.net's highest K-factor tier -
//       reflects that World Cup results are the most informative).
//   G = goal-difference weight: 1 for a draw or 1-goal margin, 1.5 for a
//       2-goal margin, (11 + N) / 8 for a margin of N >= 3 goals.
//   W = actual result for the team being updated: 1 for a win, 0.5 for a
//       draw, 0 for a loss.
//   We = expected result (win probability + 0.5 * draw probability) from
//        the pre-match Elo difference, INCLUDING home advantage if
//        applicable - i.e. the same `expectedResult` used elsewhere in this
//        codebase, evaluated at dr = (homeElo + homeAdv) - awayElo.
//
// Both teams' ratings move in opposite directions by the same Elo-points
// amount (zero-sum), as in standard Elo.
//
// An optional deltaMultiplier scales the resulting delta (default 1, i.e.
// the standard formula above with no change). eloBaseline.js applies
// IN_TOURNAMENT_DELTA_MULTIPLIER to every World Cup 2026 result, on the
// rationale that a team's current tournament form - against tournament-
// quality opposition, under tournament conditions - is more representative
// of their true current strength than the pre-tournament rating alone, and
// should move the rating proportionally further. This is applied uniformly
// to every in-tournament match as it's played (not decayed or limited to
// "recent" matches), so a team that plays more games gets its rating
// increasingly anchored to its actual tournament performance.

const { expectedResult, HOME_ADVANTAGE } = require('./eloModel');
const { HOST_NATIONS, hostGroupMatchMultiplier, KNOCKOUT_HOME_ADVANTAGE_MULTIPLIER } = require('./tournament');

const WORLD_CUP_K = 60;

// Applied to every in-tournament (World Cup 2026) result's Elo delta, on top
// of the standard K=60 formula above. See rationale in the file header.
const IN_TOURNAMENT_DELTA_MULTIPLIER = 1.5;

function goalDiffWeight(margin) {
  const n = Math.abs(margin);
  if (n <= 1) return 1;
  if (n === 2) return 1.5;
  return (11 + n) / 8;
}

// Applies a single result to a Map of team name -> { name, elo }, mutating
// the Elo values in place. homeTeam/awayTeam are team names; homeGoals/
// awayGoals are the final score. deltaMultiplier (default 1) scales the
// resulting Elo change. homeAdvantageMultiplier (default 1) scales
// HOME_ADVANTAGE for whichever side is the host nation (if either) - see
// HOME_ADVANTAGE_SCHEDULE / hostGroupMatchMultiplier in tournament.js for the
// group-stage decay schedule and KNOCKOUT_HOME_ADVANTAGE_MULTIPLIER for
// knockout matches; callers (applyResultsToElo) compute the right value per
// match. If NEITHER side is a host nation, this has no effect (no advantage
// is applied either way) - the multiplier only matters when one side is a
// host nation in HOST_NATIONS.
// Returns { homeEloChange, awayEloChange } (the final, already-multiplied
// deltas).
function applyResultToElo(teamsByName, homeTeam, awayTeam, homeGoals, awayGoals, deltaMultiplier = 1, homeAdvantageMultiplier = 1) {
  const home = teamsByName.get(homeTeam);
  const away = teamsByName.get(awayTeam);
  if (!home || !away) {
    throw new Error(`applyResultToElo: unknown team(s) "${homeTeam}" / "${awayTeam}"`);
  }

  // Apply the (possibly-scaled) home advantage to whichever side is actually
  // the host nation - not necessarily the "home" team in the fixture
  // listing. If neither side is a host, no advantage applies (neutral
  // venue). If both were hosts this would need a different approach, but no
  // 2026 group has two co-hosts together.
  const homeIsHost = HOST_NATIONS.has(homeTeam);
  const awayIsHost = HOST_NATIONS.has(awayTeam);
  let homeAdvantage = 0;
  if (homeIsHost) homeAdvantage = HOME_ADVANTAGE * homeAdvantageMultiplier;
  else if (awayIsHost) homeAdvantage = -HOME_ADVANTAGE * homeAdvantageMultiplier;

  const dr = (home.elo + homeAdvantage) - away.elo;
  const we = expectedResult(dr);

  let w; // actual result for the home team
  if (homeGoals > awayGoals) w = 1;
  else if (homeGoals < awayGoals) w = 0;
  else w = 0.5;

  const g = goalDiffWeight(homeGoals - awayGoals);
  const delta = WORLD_CUP_K * g * (w - we) * deltaMultiplier;

  home.elo += delta;
  away.elo -= delta;

  return { homeEloChange: delta, awayEloChange: -delta };
}

// Applies a list of results (each { home, away, homeGoals, awayGoals }) to
// teamsByName in order, mutating Elo ratings as it goes (so later results in
// the list reflect Elo changes from earlier ones - matching how eloratings.net
// processes results chronologically). deltaMultiplier (default 1) is passed
// through to applyResultToElo for every result.
//
// For each result involving a host nation (USA/Canada/Mexico), tracks how
// many GROUP-STAGE matches that host has played so far (in the order given -
// results should be pre-sorted chronologically by date, as eloBaseline.js
// does) and applies HOME_ADVANTAGE_SCHEDULE accordingly (1st group match =
// full advantage, 2nd = 75%, 3rd = 50%).
//
// FIXED: previously used a single running match counter with no group/
// knockout distinction (results.json only contained group-stage fixtures
// at the time this was first written, so the gap was deliberately deferred
// - see the prior version of this comment). Once a host nation's 4th
// overall match (their first KNOCKOUT match) is processed, the old code
// called hostGroupMatchMultiplier(4), which doesn't have a 4th array
// entry and falls back to HOME_ADVANTAGE_SCHEDULE's LAST element (0.5,
// the 3rd-group-match tier) - silently applying the wrong tier to every
// knockout match a host nation plays, instead of the intended
// KNOCKOUT_HOME_ADVANTAGE_MULTIPLIER (0.25). Confirmed this had not yet
// affected any real output (no host nation had reached a 4th match at
// time of fix), but needed correcting before group stage concludes.
//
// Now uses the presence of a `group` field on each result to distinguish
// group-stage (apply the tapered per-match-number schedule, tracked via
// its own counter) from knockout (apply the flat
// KNOCKOUT_HOME_ADVANTAGE_MULTIPLIER, regardless of how many matches that
// host has played).
function applyResultsToElo(teamsByName, results, deltaMultiplier = 1) {
  const hostGroupMatchCounts = new Map(); // host name -> number of GROUP-STAGE matches processed so far (knockout matches do not increment this)

  const changes = [];
  for (const r of results) {
    const host = HOST_NATIONS.has(r.home) ? r.home : HOST_NATIONS.has(r.away) ? r.away : null;
    let homeAdvantageMultiplier = 1;
    if (host) {
      const isGroupMatch = r.group != null;
      if (isGroupMatch) {
        const matchNumber = (hostGroupMatchCounts.get(host) || 0) + 1;
        homeAdvantageMultiplier = hostGroupMatchMultiplier(matchNumber);
        hostGroupMatchCounts.set(host, matchNumber);
      } else {
        homeAdvantageMultiplier = KNOCKOUT_HOME_ADVANTAGE_MULTIPLIER;
      }
    }

    const { homeEloChange, awayEloChange } = applyResultToElo(
      teamsByName, r.home, r.away, r.homeGoals, r.awayGoals, deltaMultiplier, homeAdvantageMultiplier
    );
    changes.push({ ...r, homeEloChange, awayEloChange });
  }
  return changes;
}

module.exports = { applyResultToElo, applyResultsToElo, goalDiffWeight, WORLD_CUP_K, IN_TOURNAMENT_DELTA_MULTIPLIER };
