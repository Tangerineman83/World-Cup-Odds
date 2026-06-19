const { matchProbabilities } = require('./eloModel');
const { HOST_NATIONS, HOME_ADVANTAGE_SCHEDULE } = require('./tournament');
const { climateAdjustment, GROUP_VENUE } = require('./venues');
const { FIFA_RANK } = require('../fifaRankings');

// Plays a single match probabilistically given win/draw/loss probabilities
// and a random number in [0,1). Returns 'home' | 'draw' | 'away'.
function playMatch(pWin, pDraw, rand) {
  if (rand < pWin) return 'home';
  if (rand < pWin + pDraw) return 'draw';
  return 'away';
}

// For group-stage goal differences / goals scored (needed for tiebreaks),
// we use a simple stochastic scoreline model: each team's goals ~ Poisson
// with a mean derived from their win probability. This is a simplification
// (real goal distributions depend on both teams' attacking/defensive
// strength independently) but is sufficient for tiebreak purposes in a
// Monte Carlo context, and preserves the W/D/L outcome from matchProbabilities.

function poissonSample(lambda, rand) {
  // Knuth's algorithm
  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= rand();
  } while (p > L);
  return k - 1;
}

// Builds a lookup key for a fixture, order-independent (so a known result
// for "A vs B" matches a simulated pairing generated as either A-v-B or
// B-v-A).
function fixtureKey(nameA, nameB) {
  return [nameA, nameB].sort().join('|');
}

// Simulates a group of 4 teams (round-robin, 6 matches).
// teams: array of { name, elo }
// hostTeam: name of the host nation in this group, or null
// rand: function returning a fresh random number in [0,1) each call
// options:
//   - knownResults: array of { home, away, homeGoals, awayGoals } for
//     fixtures already played. These are applied directly (not simulated);
//     only the remaining fixtures are simulated. Team names must match
//     `teams[].name`.
//   - groupLetter: used to look up this group's representative venue for the
//     climate adjustment (see venues.js). If omitted, no climate adjustment
//     is applied.
//
// Returns array of standings rows sorted 1st-4th:
// { name, elo, points, gf, ga, gd, wins, draws, losses }
function simulateGroup(teams, hostTeam, rand, options = {}) {
  const { knownResults = [], groupLetter = null } = options;

  const stats = {};
  for (const t of teams) {
    stats[t.name] = { name: t.name, elo: t.elo, points: 0, gf: 0, ga: 0, gd: 0, wins: 0, draws: 0, losses: 0 };
  }

  const knownByFixture = new Map();
  for (const r of knownResults) {
    knownByFixture.set(fixtureKey(r.home, r.away), r);
  }

  // If this group has a host nation, work out the home-advantage multiplier
  // to use for their REMAINING (unplayed) group fixtures. HOME_ADVANTAGE_SCHEDULE
  // gives per-match-number values (1st/2nd/3rd), but for unplayed fixtures we
  // don't know whether a given remaining fixture is the host's 2nd or 3rd
  // group match (results.json doesn't assign dates to unplayed fixtures) -
  // so as an approximation, every remaining fixture gets the AVERAGE of the
  // schedule entries not yet "used up" by already-played matches. E.g. if the
  // host has played 1 of 3 (their 1st), both remaining fixtures get
  // avg(75%, 50%) = 62.5%; if they've played 0, all 3 get avg(100%,75%,50%).
  // This at least reflects "later games get less boost than the first" in
  // expectation, without needing fixture ordering.
  let hostRemainingMultiplier = 1;
  const hostTeamObj = teams.find((t) => HOST_NATIONS.has(t.name));
  if (hostTeamObj) {
    let played = 0;
    for (const t of teams) {
      if (t.name === hostTeamObj.name) continue;
      if (knownByFixture.has(fixtureKey(hostTeamObj.name, t.name))) played++;
    }
    const remaining = HOME_ADVANTAGE_SCHEDULE.slice(played);
    if (remaining.length > 0) {
      hostRemainingMultiplier = remaining.reduce((a, b) => a + b, 0) / remaining.length;
    }
  }

  const venueName = groupLetter ? GROUP_VENUE[groupLetter] : null;

  // All 6 round-robin pairings
  for (let i = 0; i < teams.length; i++) {
    for (let j = i + 1; j < teams.length; j++) {
      const home = teams[i];
      const away = teams[j];

      const known = knownByFixture.get(fixtureKey(home.name, away.name));
      if (known) {
        // Apply the actual result directly - no simulation for this fixture.
        // known.home/away may be in either order relative to home/away here;
        // normalise so scoreA/scoreB line up with home/away.
        let scoreA, scoreB;
        if (known.home === home.name) {
          scoreA = known.homeGoals; scoreB = known.awayGoals;
        } else {
          scoreA = known.awayGoals; scoreB = known.homeGoals;
        }
        const resultForA = scoreA > scoreB ? 'home' : scoreA < scoreB ? 'away' : 'draw';
        applyResult(stats[home.name], stats[away.name], scoreA, scoreB, resultForA);
        continue;
      }

      // Neutral venue unless one side is the group's host nation
      const neutralVenue = !(HOST_NATIONS.has(home.name) || HOST_NATIONS.has(away.name));
      // If the away team is actually the host, swap so home-advantage applies correctly
      let effHome = home, effAway = away, swapped = false;
      if (!neutralVenue && HOST_NATIONS.has(away.name) && !HOST_NATIONS.has(home.name)) {
        effHome = away; effAway = home; swapped = true;
      }

      // Climate adjustment (group-stage only): difference between the two
      // teams' acclimatisation profiles at this group's representative venue.
      // See venues.js for methodology and caveats.
      let climateAdj = 0;
      if (venueName) {
        climateAdj = climateAdjustment(effHome.name, venueName) - climateAdjustment(effAway.name, venueName);
      }

      const { pWin, pDraw } = matchProbabilities(effHome.elo, effAway.elo, { neutralVenue, climateAdj, homeAdvantageMultiplier: hostRemainingMultiplier });
      const outcome = playMatch(pWin, pDraw, rand());

      // Goal simulation: base expected goals scaled by win probability.
      //
      // The offset (GOAL_OFFSET) and scale (GOAL_LAMBDA) are chosen so that:
      //   - Equal matches (~50/50) predict ~1-1 and produce ~2.9 goals total
      //   - Moderate favourites (~65% win) predict ~2-1 (not 1-1 as before)
      //   - Clear favourites (~75-85% win) predict ~2-0
      //   - Extreme mismatches (~92%+) predict 2-0 (modal); the tail of the
      //     distribution still produces large-margin results like 5-1 or 7-1
      //     in proportion to their real probability.
      //
      // The previous 1.35 / 0.6 values were too compressed: the offset of 0.6
      // kept the underdog's lambda above 1.0 in almost every match (locking
      // the modal away-goals at 1), and capped the favourite's modal at 1 goal
      // unless they had >88% win probability. The new 2.0 / 0.35 values double
      // the spread while keeping the average goals/game near 2.9-3.1, closer
      // to the real World Cup 2026 figure (~3.1 through matchday 2).
      //
      // W/D/L outcome probabilities are UNAFFECTED - playMatch() determines
      // those independently from matchProbabilities() before this code runs.
      // The lambda change only affects scoreline margins (GD, GF), which flow
      // into group-stage tiebreaks and the Off the Fence stats table.
      const GOAL_LAMBDA = 2.0;
      const GOAL_OFFSET = 0.35;
      let homeLambda = GOAL_LAMBDA * (GOAL_OFFSET + pWin);
      let awayLambda = GOAL_LAMBDA * (GOAL_OFFSET + (1 - pWin - pDraw));

      let gHome = poissonSample(homeLambda, rand);
      let gAway = poissonSample(awayLambda, rand);

      // Force scoreline consistency with the sampled outcome
      if (outcome === 'home' && gHome <= gAway) gHome = gAway + 1;
      if (outcome === 'away' && gAway <= gHome) gAway = gHome + 1;
      if (outcome === 'draw' && gHome !== gAway) gAway = gHome;

      const [scoreA, scoreB] = swapped ? [gAway, gHome] : [gHome, gAway];
      const resultForA = swapped
        ? (outcome === 'home' ? 'away' : outcome === 'away' ? 'home' : 'draw')
        : outcome;

      applyResult(stats[home.name], stats[away.name], scoreA, scoreB, resultForA);
    }
  }

  for (const s of Object.values(stats)) s.gd = s.gf - s.ga;

  const standings = Object.values(stats);
  standings.sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    if (b.gd !== a.gd) return b.gd - a.gd;
    if (b.gf !== a.gf) return b.gf - a.gf;
    // Final tiebreak: FIFA World Ranking (lower rank number = higher
    // standing), per the 2026 regulations - head-to-head and disciplinary
    // record (team conduct) are not modelled, but both sit ABOVE the FIFA
    // ranking in FIFA's actual tiebreak order, so this is an approximation
    // for the rare case all of points/GD/GF tie. Missing ranks (shouldn't
    // happen for the 48 World Cup teams) sort last.
    const rankA = FIFA_RANK[a.name] != null ? FIFA_RANK[a.name] : Infinity;
    const rankB = FIFA_RANK[b.name] != null ? FIFA_RANK[b.name] : Infinity;
    return rankA - rankB;
  });

  return standings;
}

function applyResult(homeStats, awayStats, gHome, gAway, resultForHome) {
  homeStats.gf += gHome;
  homeStats.ga += gAway;
  awayStats.gf += gAway;
  awayStats.ga += gHome;

  if (resultForHome === 'home') {
    homeStats.points += 3; homeStats.wins += 1;
    awayStats.losses += 1;
  } else if (resultForHome === 'away') {
    awayStats.points += 3; awayStats.wins += 1;
    homeStats.losses += 1;
  } else {
    homeStats.points += 1; awayStats.points += 1;
    homeStats.draws += 1; awayStats.draws += 1;
  }
}

module.exports = { simulateGroup, playMatch, poissonSample };
