const { simulateGroup } = require('./groupStage');
const { matchProbabilities } = require('./eloModel');
const { assignThirdPlaceSlots } = require('./thirdPlace');
const {
  GROUPS, HOST_NATIONS, ROUND_OF_32,
  ROUND_OF_16_PAIRS, QUARTER_FINAL_PAIRS, SEMI_FINAL_PAIRS,
  FINAL_PAIR, THIRD_PLACE_PAIR,
} = require('./tournament');

// Plays a single knockout match (no draws - extra time/penalties resolve it).
// Returns the winning team object.
function playKnockout(teamA, teamB, rand) {
  const aIsHost = HOST_NATIONS.has(teamA.name);
  const bIsHost = HOST_NATIONS.has(teamB.name);
  const neutralVenue = !(aIsHost || bIsHost) || (aIsHost && bIsHost);

  let home = teamA, away = teamB, swapped = false;
  if (!neutralVenue && bIsHost) { home = teamB; away = teamA; swapped = true; }

  const { pWin, pDraw } = matchProbabilities(home.elo, away.elo, { neutralVenue });

  // Penalties: modelled as ~coin-flip with a very slight Elo-based tilt
  // (favourite marginally more likely to win a shootout).
  const eloDiff = home.elo - away.elo;
  const penaltyTilt = 0.5 + Math.max(-0.05, Math.min(0.05, eloDiff / 4000));

  const r = rand();
  let homeWins;
  if (r < pWin) {
    homeWins = true;
  } else if (r < pWin + pDraw) {
    homeWins = rand() < penaltyTilt;
  } else {
    homeWins = false;
  }

  return swapped ? (homeWins ? away : home) : (homeWins ? home : away);
}

// Picks the 8 best third-place teams from the 12 group thirds, ranked by
// points -> gd -> gf -> random. Returns array of 8 team-stat objects
// (ranked best to worst), each tagged with their group letter (.group).
function pickBestThirds(thirdPlaceRows) {
  const ranked = [...thirdPlaceRows].sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    if (b.gd !== a.gd) return b.gd - a.gd;
    if (b.gf !== a.gf) return b.gf - a.gf;
    return Math.random() - 0.5;
  });
  return ranked.slice(0, 8);
}

// Resolves all 16 Round of 32 matches to actual teams, given group standings.
// Returns an array of { id, home, away } in ROUND_OF_32 order.
function resolveRoundOf32(groupStandings) {
  const winners = {};
  const runnersUp = {};
  const thirds = [];

  for (const [letter, standings] of Object.entries(groupStandings)) {
    winners[letter] = standings[0];
    runnersUp[letter] = standings[1];
    thirds.push({ ...standings[2], group: letter });
  }

  const bestThirds = pickBestThirds(thirds);
  const thirdAssignment = assignThirdPlaceSlots(bestThirds); // matchId -> team

  const lookup = (slot, matchId) => {
    if (slot.startsWith('W:')) return winners[slot.slice(2)];
    if (slot.startsWith('R:')) return runnersUp[slot.slice(2)];
    if (slot.startsWith('3RD:')) return thirdAssignment.get(matchId);
    throw new Error(`Unknown slot: ${slot}`);
  };

  return ROUND_OF_32.map((m) => ({
    id: m.id,
    home: lookup(m.home, m.id),
    away: lookup(m.away, m.id),
  }));
}

// Runs one full tournament simulation. teamsByName: Map of team name -> { elo }.
// rand: PRNG returning [0,1).
//
// Returns a structure keyed by official FIFA match ids (M73-M104), plus
// convenience round arrays (r32, r16, qf, sf) and `final`/`thirdPlacePlayoff`.
function simulateTournament(teamsByName, rand) {
  const groupStandings = {};

  for (const [letter, names] of Object.entries(GROUPS)) {
    const teams = names.map((name) => ({ name, elo: teamsByName.get(name).elo }));
    groupStandings[letter] = simulateGroup(teams, null, rand);
  }

  const r32Matches = resolveRoundOf32(groupStandings);
  const matchesById = new Map(); // matchId -> { id, home, away, winner }

  for (const m of r32Matches) {
    const winner = playKnockout(m.home, m.away, rand);
    matchesById.set(m.id, { ...m, winner });
  }

  function playRound(pairs) {
    const results = [];
    for (const [matchId, [fromA, fromB]] of pairs) {
      const home = matchesById.get(fromA).winner;
      const away = matchesById.get(fromB).winner;
      const winner = playKnockout(home, away, rand);
      const entry = { id: matchId, home, away, winner };
      matchesById.set(matchId, entry);
      results.push(entry);
    }
    return results;
  }

  const r16Matches = playRound(ROUND_OF_16_PAIRS);
  const qfMatches = playRound(QUARTER_FINAL_PAIRS);
  const sfMatches = playRound(SEMI_FINAL_PAIRS);

  const [finalId, [finalA, finalB]] = FINAL_PAIR;
  const finalHome = matchesById.get(finalA).winner;
  const finalAway = matchesById.get(finalB).winner;
  const champion = playKnockout(finalHome, finalAway, rand);
  const finalMatch = { id: finalId, home: finalHome, away: finalAway, winner: champion };
  matchesById.set(finalId, finalMatch);

  // Third-place playoff: losers of the two semi-finals
  const [tpId, [tpA, tpB]] = THIRD_PLACE_PAIR;
  const semiA = matchesById.get(tpA);
  const semiB = matchesById.get(tpB);
  const loser = (m) => (m.winner.name === m.home.name ? m.away : m.home);
  const tpHome = loser(semiA);
  const tpAway = loser(semiB);
  const tpWinner = playKnockout(tpHome, tpAway, rand);
  const thirdPlacePlayoff = { id: tpId, home: tpHome, away: tpAway, winner: tpWinner };

  return {
    groupStandings,
    r32: r32Matches.map((m) => matchesById.get(m.id)),
    r16: r16Matches,
    qf: qfMatches,
    sf: sfMatches,
    final: finalMatch,
    thirdPlacePlayoff,
    champion,
  };
}

module.exports = { simulateTournament, resolveRoundOf32, pickBestThirds, playKnockout };
