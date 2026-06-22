// mostLikelyNegBin.js
//
// NegBin-engine counterpart to mostLikely.js. Computes a single "most
// likely scenario" for the tournament using the dual-Elo Negative Binomial
// engine (groupStageNegBin.js / knockoutNegBin.js) instead of the existing
// Poisson + single-Elo engine (groupStage.js / simulateTournament.js).
//
// WRITTEN AS A SEPARATE FILE, NOT A PARAMETERIZED VERSION OF mostLikely.js:
// mostLikely.js is used by runScenario.js, which drives the currently-live
// scenario.json / index.html. Modifying it to accept either engine would
// touch code the live site depends on today, requiring careful regression
// testing against existing behavior. A separate file duplicates some
// structure (modalGroupOrdering's shape, buildBracket's bracket-walking
// logic) but carries zero risk of changing anything about the existing
// Poisson engine's output. See the conversation/decision this was built
// from for the explicit tradeoff discussion.
//
// Mirrors mostLikely.js's two-phase structure:
//   computeGroupResultsNegBin: modal group standings (uses
//     groupStageNegBin.js's simulateGroup instead of groupStage.js's).
//   buildBracketNegBin: chalk knockout bracket (uses a new
//     chalkWinnerNegBin, deterministic - NOT playKnockoutNegBin from
//     knockoutNegBin.js, which samples ONE random outcome per call and so
//     is not suitable for a single deterministic "most likely" scenario;
//     chalkWinnerNegBin instead computes the full win-probability via the
//     joint NegBin distribution and picks the favourite, the same
//     "deterministic favourite, not one random sample" approach
//     mostLikely.js's own chalkWinner takes for the existing engine).

const { HOST_NATIONS, KNOCKOUT_HOME_ADVANTAGE_MULTIPLIER, GROUPS,
  ROUND_OF_32, ROUND_OF_16_PAIRS, QUARTER_FINAL_PAIRS, SEMI_FINAL_PAIRS,
  FINAL_PAIR, THIRD_PLACE_PAIR } = require('./tournament');
const { simulateGroup, expectedGoals, negBinJointWinProbability, loadCalibratedParams } = require('./groupStageNegBin');
const { assignThirdPlaceSlots } = require('./thirdPlace');
const { mulberry32 } = require('./shared');

// Runs N group simulations using the NegBin engine and returns the same
// shape mostLikely.js's modalGroupOrdering returns (order, probability,
// positionProbabilities, modalStats) - see that function's own comment for
// the full rationale (modal JOINT table, not 4 independently-modal lines).
// teams: array of { name, elo, attack, defense }.
function modalGroupOrderingNegBin(teams, N = 20000, options = {}) {
  const orderingCounts = new Map();
  const positionCounts = new Map();
  const jointStatsCountsByKey = new Map();
  const jointStatsExampleByKey = new Map();

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

  let bestJointKey = null, bestJointCount = -1;
  for (const [jointKey, count] of jointStatsCountsByKey.get(bestKey).entries()) {
    if (count > bestJointCount) { bestJointCount = count; bestJointKey = jointKey; }
  }
  const jointStatsArr = jointStatsExampleByKey.get(bestKey).get(bestJointKey);
  const modalStats = {};
  names.forEach((name, pos) => { modalStats[name] = jointStatsArr[pos]; });

  return {
    order: names,
    probability: bestCount / N,
    positionProbabilities,
    modalStats,
  };
}

// Deterministic chalk-winner pick for a knockout match under the NegBin
// engine: computes the FULL win probability (P(home scores more) +
// P(draw) split via the same penalty-tilt convention as the existing
// engine's chalkWinner / knockoutNegBin.js's playKnockoutNegBin), then
// picks whichever side has the higher total - NOT a single random sample
// (playKnockoutNegBin samples one outcome per call, which would make a
// "most likely scenario" page non-deterministic between runs - wrong tool
// for this use case, used instead for the Monte Carlo simulation in
// runSimulationNegBin.js where sampling many times is exactly the point).
// teamA/teamB: { name, elo, attack, defense }.
function chalkWinnerNegBin(teamA, teamB) {
  const { params } = loadCalibratedParams();

  const aIsHost = HOST_NATIONS.has(teamA.name);
  const bIsHost = HOST_NATIONS.has(teamB.name);
  const neutralVenue = !(aIsHost || bIsHost) || (aIsHost && bIsHost);

  let home = teamA, away = teamB, swapped = false;
  if (!neutralVenue && bIsHost) { home = teamB; away = teamA; swapped = true; }

  const homeAdvantageElo = neutralVenue ? 0 : 100 * KNOCKOUT_HOME_ADVANTAGE_MULTIPLIER;
  const muHome = expectedGoals(home.attack, away.defense, homeAdvantageElo, params);
  const muAway = expectedGoals(away.attack, home.defense, 0, params);

  // pHomeWin/pDraw/pAwayWin from the joint NegBin distribution (same
  // primitive compareNextMatchScores.js already uses for its win/draw/loss
  // breakdown) - NOT a single sampled scoreline.
  const { pHomeWin, pDraw, pAwayWin } = negBinJointWinProbability(muHome, muAway, params.r);

  const eloDiff = home.elo - away.elo;
  const tilt = Math.max(-0.05, Math.min(0.05, eloDiff / 4000));
  const homeTotal = pHomeWin + pDraw * (0.5 + tilt);
  const awayTotal = pAwayWin + pDraw * (0.5 - tilt);

  const homeIsFavourite = homeTotal >= awayTotal;
  const winner = homeIsFavourite ? home : away;
  const pWinOverall = homeIsFavourite ? homeTotal : awayTotal;

  return { winner, pWin: pWinOverall };
}

// Phase 1: modal group-stage results for all 12 groups, NegBin engine.
// teamsByName: Map of team name -> { name, elo, attack, defense }.
function computeGroupResultsNegBin(teamsByName, knownByGroup = new Map()) {
  const groupResults = {};

  for (const [letter, names] of Object.entries(GROUPS)) {
    const teams = names.map((name) => {
      const t = teamsByName.get(name);
      return { name, elo: t.elo, attack: t.attack, defense: t.defense };
    });
    groupResults[letter] = modalGroupOrderingNegBin(teams, 20000, {
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

// Phase 2: chalk bracket (R32 onward), NegBin engine. Same structure as
// mostLikely.js's buildBracket, swapping in chalkWinnerNegBin and
// attack/defense-aware team objects.
function buildBracketNegBin(groupResults, bestThirds, teamsByName) {
  const winners = {};
  const runnersUp = {};

  const teamObj = (name, group) => {
    const t = teamsByName.get(name);
    return { name, elo: t.elo, attack: t.attack, defense: t.defense, group };
  };

  for (const [letter, result] of Object.entries(groupResults)) {
    const [first, second] = result.order;
    winners[letter] = teamObj(first, letter);
    runnersUp[letter] = teamObj(second, letter);
  }

  const thirdAssignment = assignThirdPlaceSlots(bestThirds); // matchId -> team

  const lookup = (slot, matchId) => {
    if (slot.startsWith('W:')) return winners[slot.slice(2)];
    if (slot.startsWith('R:')) return runnersUp[slot.slice(2)];
    if (slot.startsWith('3RD:')) {
      const t = thirdAssignment.get(matchId);
      // bestThirds entries may already be plain { name, elo, group } (no
      // attack/defense) depending on caller - re-hydrate via teamsByName to
      // guarantee attack/defense are present for chalkWinnerNegBin.
      return t ? teamObj(t.name, t.group) : t;
    }
    throw new Error(`Unknown slot: ${slot}`);
  };

  const matchesById = new Map();

  const r32 = ROUND_OF_32.map((m) => {
    const home = lookup(m.home, m.id);
    const away = lookup(m.away, m.id);
    const { winner, pWin } = chalkWinnerNegBin(home, away);
    const entry = { id: m.id, home, away, winner, pWin };
    matchesById.set(m.id, entry);
    return entry;
  });

  function playRound(pairs) {
    return pairs.map(([matchId, [fromA, fromB]]) => {
      const home = matchesById.get(fromA).winner;
      const away = matchesById.get(fromB).winner;
      const { winner, pWin } = chalkWinnerNegBin(home, away);
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
  const { winner: champion, pWin: finalPWin } = chalkWinnerNegBin(finalHome, finalAway);
  const final = { id: finalId, home: finalHome, away: finalAway, winner: champion, pWin: finalPWin };
  matchesById.set(finalId, final);

  const [tpId, [tpA, tpB]] = THIRD_PLACE_PAIR;
  const semiA = matchesById.get(tpA);
  const semiB = matchesById.get(tpB);
  const loser = (m) => (m.winner.name === m.home.name ? m.away : m.home);
  const tpHome = loser(semiA);
  const tpAway = loser(semiB);
  const { winner: tpWinner, pWin: tpPWin } = chalkWinnerNegBin(tpHome, tpAway);
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

module.exports = { computeGroupResultsNegBin, buildBracketNegBin, modalGroupOrderingNegBin, chalkWinnerNegBin };
