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

const { expectedResult, HOME_ADVANTAGE } = require('./eloModel');
const { HOST_NATIONS } = require('./tournament');

const WORLD_CUP_K = 60;

function goalDiffWeight(margin) {
  const n = Math.abs(margin);
  if (n <= 1) return 1;
  if (n === 2) return 1.5;
  return (11 + n) / 8;
}

// Applies a single result to a Map of team name -> { name, elo }, mutating
// the Elo values in place. homeTeam/awayTeam are team names; homeGoals/
// awayGoals are the final score. Returns { homeEloChange, awayEloChange }.
function applyResultToElo(teamsByName, homeTeam, awayTeam, homeGoals, awayGoals) {
  const home = teamsByName.get(homeTeam);
  const away = teamsByName.get(awayTeam);
  if (!home || !away) {
    throw new Error(`applyResultToElo: unknown team(s) "${homeTeam}" / "${awayTeam}"`);
  }

  const neutralVenue = !(HOST_NATIONS.has(homeTeam) || HOST_NATIONS.has(awayTeam));
  const dr = (home.elo + (neutralVenue ? 0 : HOME_ADVANTAGE)) - away.elo;
  const we = expectedResult(dr);

  let w; // actual result for the home team
  if (homeGoals > awayGoals) w = 1;
  else if (homeGoals < awayGoals) w = 0;
  else w = 0.5;

  const g = goalDiffWeight(homeGoals - awayGoals);
  const delta = WORLD_CUP_K * g * (w - we);

  home.elo += delta;
  away.elo -= delta;

  return { homeEloChange: delta, awayEloChange: -delta };
}

// Applies a list of results (each { home, away, homeGoals, awayGoals }) to
// teamsByName in order, mutating Elo ratings as it goes (so later results in
// the list reflect Elo changes from earlier ones - matching how eloratings.net
// processes results chronologically).
function applyResultsToElo(teamsByName, results) {
  const changes = [];
  for (const r of results) {
    const { homeEloChange, awayEloChange } = applyResultToElo(
      teamsByName, r.home, r.away, r.homeGoals, r.awayGoals
    );
    changes.push({ ...r, homeEloChange, awayEloChange });
  }
  return changes;
}

module.exports = { applyResultToElo, applyResultsToElo, goalDiffWeight, WORLD_CUP_K };
