const { matchProbabilities } = require('./eloModel');
const { HOST_NATIONS } = require('./tournament');

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

// Simulates a group of 4 teams (round-robin, 6 matches).
// teams: array of { name, elo }
// hostTeam: name of the host nation in this group, or null
// rand: function returning a fresh random number in [0,1) each call
//
// Returns array of standings rows sorted 1st-4th:
// { name, elo, points, gf, ga, gd, wins, draws, losses }
function simulateGroup(teams, hostTeam, rand) {
  const stats = {};
  for (const t of teams) {
    stats[t.name] = { name: t.name, elo: t.elo, points: 0, gf: 0, ga: 0, gd: 0, wins: 0, draws: 0, losses: 0 };
  }

  // All 6 round-robin pairings
  for (let i = 0; i < teams.length; i++) {
    for (let j = i + 1; j < teams.length; j++) {
      const home = teams[i];
      const away = teams[j];

      // Neutral venue unless one side is the group's host nation
      const neutralVenue = !(HOST_NATIONS.has(home.name) || HOST_NATIONS.has(away.name));
      // If the away team is actually the host, swap so home-advantage applies correctly
      let effHome = home, effAway = away, swapped = false;
      if (!neutralVenue && HOST_NATIONS.has(away.name) && !HOST_NATIONS.has(home.name)) {
        effHome = away; effAway = home; swapped = true;
      }

      const { pWin, pDraw } = matchProbabilities(effHome.elo, effAway.elo, { neutralVenue });
      const outcome = playMatch(pWin, pDraw, rand());

      // Goal simulation: base expected goals scaled by win probability
      const baseLambda = 1.35;
      let homeLambda = baseLambda * (0.6 + pWin);
      let awayLambda = baseLambda * (0.6 + (1 - pWin - pDraw));

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
    // Final tiebreak: random (head-to-head/fair-play not modelled)
    return Math.random() - 0.5;
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
