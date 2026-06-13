const { simulateGroup } = require('./groupStage');
const { matchProbabilities } = require('./eloModel');
const {
  GROUPS, HOST_NATIONS, ROUND_OF_32, ROUND_OF_16_PAIRS,
  QUARTER_FINAL_PAIRS, SEMI_FINAL_PAIRS,
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
// (ranked best to worst), each tagged with their group letter.
function pickBestThirds(thirdPlaceRows) {
  const ranked = [...thirdPlaceRows].sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    if (b.gd !== a.gd) return b.gd - a.gd;
    if (b.gf !== a.gf) return b.gf - a.gf;
    return Math.random() - 0.5;
  });
  return ranked.slice(0, 8);
}

// Resolves the "3RD:n" placeholders in ROUND_OF_32 to actual teams, using the
// simplified fixed ordering described in tournament.js.
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

  const lookup = (slot) => {
    if (slot.startsWith('W:')) return winners[slot.slice(2)];
    if (slot.startsWith('R:')) return runnersUp[slot.slice(2)];
    if (slot.startsWith('3RD:')) {
      const n = parseInt(slot.slice(4), 10);
      return bestThirds[n - 1];
    }
    throw new Error(`Unknown slot: ${slot}`);
  };

  return ROUND_OF_32.map((m) => ({
    id: m.id,
    home: lookup(m.home),
    away: lookup(m.away),
  }));
}

// Runs one full tournament simulation. teamsByName: Map of team name -> { elo }.
// rand: PRNG returning [0,1).
function simulateTournament(teamsByName, rand) {
  const groupStandings = {};

  for (const [letter, names] of Object.entries(GROUPS)) {
    const teams = names.map((name) => ({ name, elo: teamsByName.get(name).elo }));
    groupStandings[letter] = simulateGroup(teams, null, rand);
  }

  const r32Matches = resolveRoundOf32(groupStandings);
  const r32Winners = r32Matches.map((m) => playKnockout(m.home, m.away, rand));

  const r16Matches = ROUND_OF_16_PAIRS.map(([a, b], i) => ({
    id: `R16-${i + 1}`,
    home: r32Winners[ROUND_OF_32.findIndex((m) => m.id === a)],
    away: r32Winners[ROUND_OF_32.findIndex((m) => m.id === b)],
  }));
  const r16Winners = r16Matches.map((m) => playKnockout(m.home, m.away, rand));

  const qfMatches = QUARTER_FINAL_PAIRS.map(([a, b], i) => ({
    id: `QF-${i + 1}`,
    home: r16Winners[a],
    away: r16Winners[b],
  }));
  const qfWinners = qfMatches.map((m) => playKnockout(m.home, m.away, rand));

  const sfMatches = SEMI_FINAL_PAIRS.map(([a, b], i) => ({
    id: `SF-${i + 1}`,
    home: qfWinners[a],
    away: qfWinners[b],
  }));
  const sfWinners = sfMatches.map((m) => playKnockout(m.home, m.away, rand));

  const finalMatch = { id: 'F', home: sfWinners[0], away: sfWinners[1] };
  const champion = playKnockout(finalMatch.home, finalMatch.away, rand);

  return {
    groupStandings,
    r32: r32Matches.map((m, i) => ({ ...m, winner: r32Winners[i] })),
    r16: r16Matches.map((m, i) => ({ ...m, winner: r16Winners[i] })),
    qf: qfMatches.map((m, i) => ({ ...m, winner: qfWinners[i] })),
    sf: sfMatches.map((m, i) => ({ ...m, winner: sfWinners[i] })),
    final: { ...finalMatch, winner: champion },
    champion,
  };
}

module.exports = { simulateTournament, resolveRoundOf32, pickBestThirds, playKnockout };
