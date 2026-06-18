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
  GROUPS, HOST_NATIONS, KNOCKOUT_HOME_ADVANTAGE_MULTIPLIER, ROUND_OF_32,
  ROUND_OF_16_PAIRS, QUARTER_FINAL_PAIRS, SEMI_FINAL_PAIRS,
  FINAL_PAIR, THIRD_PLACE_PAIR,
} = require('./tournament');
const { simulateGroup } = require('./groupStage');
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
function modalGroupOrdering(teams, N = 20000, options = {}) {
  const orderingCounts = new Map(); // key = "team1|team2|team3|team4" -> count
  const positionCounts = new Map(); // team name -> [count1st, count2nd, count3rd, count4th]
  // For each distinct ordering, tabulate how often each JOINT (points,gd,gf)
  // combination - across all 4 teams together, in standings order - occurs.
  // Then, for whichever ordering turns out to be modal, report the single
  // most common JOINT combination (not just "a" representative run, and
  // crucially not 4 independently-modal per-position stats lines, which
  // could come from 4 different runs and not actually sum to a valid table -
  // e.g. goal differences across the 4 teams wouldn't necessarily sum to
  // zero). Picking one real, internally-consistent simulated table keeps
  // this in the same spirit as the rest of the page: a single coherent
  // scenario, not a probability distribution.
  const jointStatsCountsByKey = new Map(); // orderingKey -> Map("p1,gd1,gf1|p2,gd2,gf2|..." -> count)
  const jointStatsExampleByKey = new Map(); // orderingKey -> Map(jointKey -> [{points,gd,gf} x4, standings order])

  for (const t of teams) positionCounts.set(t.name, [0, 0, 0, 0]);

  for (let i = 0; i < N; i++) {
    const rand = mulberry32((Math.random() * 2 ** 31) | 0);
    const standings = simulateGroup(teams, null, rand, options);
    const key = standings.map((s) => s.name).join('|');
    orderingCounts.set(key, (orderingCounts.get(key) || 0) + 1);

    const jointKey = standings.map((s) => `${s.points},${s.gd},${s.gf}`).join('|');
    if (!jointStatsCountsByKey.has(key)) {
      jointStatsCountsByKey.set(key, new Map());
      jointStatsExampleByKey.set(key, new Map());
    }
    const counts = jointStatsCountsByKey.get(key);
    counts.set(jointKey, (counts.get(jointKey) || 0) + 1);
    if (!jointStatsExampleByKey.get(key).has(jointKey)) {
      jointStatsExampleByKey.get(key).set(jointKey, standings.map((s) => ({ points: s.points, gd: s.gd, gf: s.gf })));
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

  // The single most common JOINT (points,gd,gf) table, among runs that
  // produced bestKey's ordering - keyed by team name so e.g. modalStats[names[0]]
  // is that team's stats line within this one coherent modal table.
  let bestJointKey = null, bestJointCount = -1;
  for (const [jointKey, count] of jointStatsCountsByKey.get(bestKey).entries()) {
    if (count > bestJointCount) { bestJointCount = count; bestJointKey = jointKey; }
  }
  const jointStatsArr = jointStatsExampleByKey.get(bestKey).get(bestJointKey); // [{points,gd,gf} x4], standings order
  const modalStats = {};
  names.forEach((name, pos) => { modalStats[name] = jointStatsArr[pos]; });

  return {
    order: names,
    probability: bestCount / N,
    positionProbabilities, // { teamName: [p1st, p2nd, p3rd, p4th] }
    modalStats, // { teamName: {points, gd, gf} } - this team's line within the single most common JOINT final table for the modal ordering (internally consistent: gd sums to zero across the group)
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

  const { pWin, pDraw, pLoss } = matchProbabilities(home.elo, away.elo, { neutralVenue, homeAdvantageMultiplier: KNOCKOUT_HOME_ADVANTAGE_MULTIPLIER });

  const eloDiff = home.elo - away.elo;
  const tilt = Math.max(-0.05, Math.min(0.05, eloDiff / 4000));
  const homeTotal = pWin + pDraw * (0.5 + tilt);
  const awayTotal = pLoss + pDraw * (0.5 - tilt);

  const homeIsFavourite = homeTotal >= awayTotal;
  const winner = homeIsFavourite ? home : away;
  const pWinOverall = homeIsFavourite ? homeTotal : awayTotal;

  return { winner, pWin: pWinOverall };
}

// Phase 1: computes the modal group-stage results for all 12 groups (no
// bracket yet - that needs the third-place ranking, computed externally in
// runScenario.js using predictions.json's full-simulation probabilities).
// teamsByName: Map of team name -> { name, elo }. knownByGroup: optional Map
// of group letter -> array of completed fixtures (see resultsSource.js).
// Returns { letter -> { order, probability, positionProbabilities,
// thirdPlaceStats, fourth } }.
function computeGroupResults(teamsByName, knownByGroup = new Map()) {
  const groupResults = {};

  for (const [letter, names] of Object.entries(GROUPS)) {
    const teams = names.map((name) => ({ name, elo: teamsByName.get(name).elo }));
    groupResults[letter] = modalGroupOrdering(teams, 50000, {
      knownResults: knownByGroup.get(letter) || [],
      groupLetter: letter,
    });
  }

  for (const [letter, result] of Object.entries(groupResults)) {
    const [, , , fourth] = result.order;
    groupResults[letter].fourth = fourth;
  }

  return groupResults;
}

// Phase 2: builds the chalk bracket (R32 onward) given group results and a
// pre-determined list of the 8 qualifying third-placed teams (bestThirds -
// each { name, elo, group }, ranked best-to-worst - used for Annex-C-style
// slot assignment via assignThirdPlaceSlots). teamsByName: Map of team name
// -> { name, elo }, used to look up winners'/runners-up' elo.
function buildBracket(groupResults, bestThirds, teamsByName) {
  const winners = {};
  const runnersUp = {};

  for (const [letter, result] of Object.entries(groupResults)) {
    const [first, second] = result.order;
    winners[letter] = { name: first, elo: teamsByName.get(first).elo, group: letter };
    runnersUp[letter] = { name: second, elo: teamsByName.get(second).elo, group: letter };
  }

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

module.exports = { computeGroupResults, buildBracket, modalGroupOrdering, chalkWinner };
