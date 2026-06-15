// Computes a single "most likely scenario" for the tournament:
//  1. For each group, the modal (most frequently occurring) full 1st-4th
//     ordering across many simulations, plus each team's individual
//     probability of finishing in each position.
//  2. The 8 best third-placed teams under that modal-groups scenario, placed
//     into the official Round-of-32 bracket (Matches 73-88) using a
//     constraint-respecting approximation of FIFA's Annex C assignment.
//  3. From R32 onward, a "chalk" bracket: at each match, the team with the
//     higher combined win+penalty probability advances.
//
// This gives a single coherent, traceable bracket - useful for "follow team X"
// - while the full Monte Carlo distribution (predictions.json) remains the
// source of truth for probabilities.

const { matchProbabilities } = require('./eloModel');
const {
  GROUPS, HOST_NATIONS, ROUND_OF_32,
  ROUND_OF_16_PAIRS, QUARTER_FINAL_PAIRS, SEMI_FINAL_PAIRS,
  FINAL_PAIR, THIRD_PLACE_PAIR,
} = require('./tournament');
const { simulateGroup } = require('./groupStage');
const { pickBestThirds } = require('./simulateTournament');
const { assignThirdPlaceSlots } = require('./thirdPlace');

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Runs N group simulations and returns:
//  - the modal 1st-4th ordering (by team name) and its probability
//  - for each team, the probability of finishing in each position (1st-4th)
//
// options:
//   - knownResults: array of completed fixtures for this group (see
//     groupStage.js::simulateGroup), applied directly rather than simulated.
//   - groupLetter: this group's letter, used for the climate adjustment
//     (see venues.js). Optional - omit to skip climate adjustment.
function modalGroupOrdering(teams, N = 5000, options = {}) {
  const orderingCounts = new Map(); // key = "team1|team2|team3|team4" -> count
  const positionCounts = new Map(); // team name -> [count1st, count2nd, count3rd, count4th]
  // For each distinct ordering, tabulate how often each (points, gd, gf)
  // combination occurs for the team finishing 3rd - then, for whichever
  // ordering turns out to be modal, report the MODAL stats combination (not
  // just "a" representative run). A single representative run can be
  // unrepresentative even when its ordering is correct - e.g. a 3rd-place
  // finish on 6 points (2W 1L) is possible but rare (~2%) compared to the
  // typical 3-4 points, even though many different points totals can produce
  // the same final ORDERING. Reporting the modal stats combo for the modal
  // ordering avoids surfacing such an outlier as if it were typical.
  const statsCountsByKey = new Map(); // orderingKey -> Map("points|gd|gf" -> count)
  const statsExampleByKey = new Map(); // orderingKey -> Map("points|gd|gf" -> {points,gd,gf})

  for (const t of teams) positionCounts.set(t.name, [0, 0, 0, 0]);

  for (let i = 0; i < N; i++) {
    const rand = mulberry32((Math.random() * 2 ** 31) | 0);
    const standings = simulateGroup(teams, null, rand, options);
    const key = standings.map((s) => s.name).join('|');
    orderingCounts.set(key, (orderingCounts.get(key) || 0) + 1);

    const third = standings[2];
    const statsKey = `${third.points}|${third.gd}|${third.gf}`;
    if (!statsCountsByKey.has(key)) {
      statsCountsByKey.set(key, new Map());
      statsExampleByKey.set(key, new Map());
    }
    const counts = statsCountsByKey.get(key);
    counts.set(statsKey, (counts.get(statsKey) || 0) + 1);
    if (!statsExampleByKey.get(key).has(statsKey)) {
      statsExampleByKey.get(key).set(statsKey, { points: third.points, gd: third.gd, gf: third.gf });
    }

    standings.forEach((s, pos) => {
      positionCounts.get(s.name)[pos] += 1;
    });
  }

  let bestKey = null, bestCount = -1;
  for (const [key, count] of orderingCounts.entries()) {
    if (count > bestCount) { bestCount = count; bestKey = key; }
  }

  const names = bestKey.split('|');
  const positionProbabilities = {};
  for (const [name, counts] of positionCounts.entries()) {
    positionProbabilities[name] = counts.map((c) => c / N);
  }

  // Modal (points, gd, gf) for the 3rd-placed team, among runs that produced
  // bestKey's ordering.
  const thirdName = names[2];
  let bestStatsKey = null, bestStatsCount = -1;
  for (const [statsKey, count] of statsCountsByKey.get(bestKey).entries()) {
    if (count > bestStatsCount) { bestStatsCount = count; bestStatsKey = statsKey; }
  }
  const thirdStats = statsExampleByKey.get(bestKey).get(bestStatsKey);

  return {
    order: names,
    probability: bestCount / N,
    positionProbabilities, // { teamName: [p1st, p2nd, p3rd, p4th] }
    thirdPlaceStats: { [thirdName]: thirdStats }, // { teamName: {points, gd, gf} } - modal stats for the 3rd-placed team under the modal ordering
  };
}

// Picks a chalk (favourite) winner for a knockout match. Returns
// { winner, pWin } where pWin is the favourite's win probability
// (including the drawn-then-penalties mass, split 50/50 with a small tilt).
function chalkWinner(teamA, teamB) {
  const aIsHost = HOST_NATIONS.has(teamA.name);
  const bIsHost = HOST_NATIONS.has(teamB.name);
  const neutralVenue = !(aIsHost || bIsHost) || (aIsHost && bIsHost);

  let home = teamA, away = teamB, swapped = false;
  if (!neutralVenue && bIsHost) { home = teamB; away = teamA; swapped = true; }

  const { pWin, pDraw, pLoss } = matchProbabilities(home.elo, away.elo, { neutralVenue });

  const eloDiff = home.elo - away.elo;
  const tilt = Math.max(-0.05, Math.min(0.05, eloDiff / 4000));
  const homeTotal = pWin + pDraw * (0.5 + tilt);
  const awayTotal = pLoss + pDraw * (0.5 - tilt);

  const homeIsFavourite = homeTotal >= awayTotal;
  const winner = homeIsFavourite ? home : away;
  const pWinOverall = homeIsFavourite ? homeTotal : awayTotal;

  return { winner, pWin: pWinOverall };
}

// Main entry point. teamsByName: Map of team name -> { name, elo }.
// knownByGroup: optional Map of group letter -> array of completed fixtures
// (see resultsSource.js), passed through to modalGroupOrdering/simulateGroup
// so completed group-stage results are used directly rather than simulated.
function computeMostLikelyScenario(teamsByName, knownByGroup = new Map()) {
  const groupResults = {}; // letter -> { order, probability, positionProbabilities, fourth }

  for (const [letter, names] of Object.entries(GROUPS)) {
    const teams = names.map((name) => ({ name, elo: teamsByName.get(name).elo }));
    groupResults[letter] = modalGroupOrdering(teams, 5000, {
      knownResults: knownByGroup.get(letter) || [],
      groupLetter: letter,
    });
  }

  const winners = {};
  const runnersUp = {};
  const thirdsForRanking = [];

  for (const [letter, result] of Object.entries(groupResults)) {
    const [first, second, third, fourth] = result.order;
    winners[letter] = { name: first, elo: teamsByName.get(first).elo, group: letter };
    runnersUp[letter] = { name: second, elo: teamsByName.get(second).elo, group: letter };

    const thirdTeam = { name: third, elo: teamsByName.get(third).elo, group: letter };
    // Cross-group third-place ranking uses the real points/GD/GF from this
    // group's modal scenario (the same stats simulateTournament.js uses for
    // the actual probability calculations), via the official FIFA tiebreak
    // order (points -> GD -> GF) in pickBestThirds. Falls back to an
    // Elo-based proxy only if stats are unexpectedly unavailable (e.g. a
    // group with fewer than 5000 distinct simulation outcomes - shouldn't
    // happen in practice).
    const thirdStats = result.stats && result.stats[third];
    if (thirdStats) {
      thirdsForRanking.push({ ...thirdTeam, points: thirdStats.points, gd: thirdStats.gd, gf: thirdStats.gf });
    } else {
      thirdsForRanking.push({ ...thirdTeam, points: thirdTeam.elo, gd: 0, gf: 0 });
    }

    groupResults[letter].fourth = fourth;
  }

  const bestThirds = pickBestThirds(thirdsForRanking)
    .map((t) => ({ name: t.name, elo: t.elo, group: t.group }));

  const thirdAssignment = assignThirdPlaceSlots(bestThirds); // matchId -> team

  const lookup = (slot, matchId) => {
    if (slot.startsWith('W:')) return winners[slot.slice(2)];
    if (slot.startsWith('R:')) return runnersUp[slot.slice(2)];
    if (slot.startsWith('3RD:')) return thirdAssignment.get(matchId);
    throw new Error(`Unknown slot: ${slot}`);
  };

  const matchesById = new Map();

  const r32 = ROUND_OF_32.map((m) => {
    const home = lookup(m.home, m.id);
    const away = lookup(m.away, m.id);
    const { winner, pWin } = chalkWinner(home, away);
    const entry = { id: m.id, home, away, winner, pWin };
    matchesById.set(m.id, entry);
    return entry;
  });

  function playRound(pairs) {
    return pairs.map(([matchId, [fromA, fromB]]) => {
      const home = matchesById.get(fromA).winner;
      const away = matchesById.get(fromB).winner;
      const { winner, pWin } = chalkWinner(home, away);
      const entry = { id: matchId, home, away, winner, pWin };
      matchesById.set(matchId, entry);
      return entry;
    });
  }

  const r16 = playRound(ROUND_OF_16_PAIRS);
  const qf = playRound(QUARTER_FINAL_PAIRS);
  const sf = playRound(SEMI_FINAL_PAIRS);

  const [finalId, [finalA, finalB]] = FINAL_PAIR;
  const finalHome = matchesById.get(finalA).winner;
  const finalAway = matchesById.get(finalB).winner;
  const { winner: champion, pWin: finalPWin } = chalkWinner(finalHome, finalAway);
  const final = { id: finalId, home: finalHome, away: finalAway, winner: champion, pWin: finalPWin };
  matchesById.set(finalId, final);

  // Third-place playoff (losers of the semis)
  const [tpId, [tpA, tpB]] = THIRD_PLACE_PAIR;
  const semiA = matchesById.get(tpA);
  const semiB = matchesById.get(tpB);
  const loser = (m) => (m.winner.name === m.home.name ? m.away : m.home);
  const tpHome = loser(semiA);
  const tpAway = loser(semiB);
  const { winner: tpWinner, pWin: tpPWin } = chalkWinner(tpHome, tpAway);
  const thirdPlacePlayoff = { id: tpId, home: tpHome, away: tpAway, winner: tpWinner, pWin: tpPWin };

  return {
    groups: groupResults,
    bestThirds,
    r32,
    r16,
    qf,
    sf,
    final,
    thirdPlacePlayoff,
    champion: champion.name,
  };
}

module.exports = { computeMostLikelyScenario, modalGroupOrdering, chalkWinner };
