// Computes a single "most likely scenario" for the tournament:
//  1. For each group, the modal (most frequently occurring) full 1st-4th
//     ordering across many simulations.
//  2. The 8 best third-placed teams under that modal-groups scenario, and
//     their Round-of-32 placement (using the same simplified bracket mapping
//     as the simulator).
//  3. From R32 onward, a "chalk" bracket: at each match, the team with the
//     higher win probability (per the Elo model, accounting for venue/host
//     advantage) is taken as the winner.
//
// This gives a single coherent, traceable bracket - useful for "follow team X"
// - while the full Monte Carlo distribution (predictions.json) remains the
// source of truth for probabilities.

const { matchProbabilities } = require('./eloModel');
const {
  GROUPS, HOST_NATIONS, ROUND_OF_32, ROUND_OF_16_PAIRS,
  QUARTER_FINAL_PAIRS, SEMI_FINAL_PAIRS,
} = require('./tournament');
const { simulateGroup } = require('./groupStage');
const { pickBestThirds } = require('./simulateTournament');

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Runs N group simulations and returns the modal 1st-4th ordering (by team name)
// for a single group.
function modalGroupOrdering(teams, N = 5000) {
  const counts = new Map(); // key = "team1|team2|team3|team4" -> count

  for (let i = 0; i < N; i++) {
    const rand = mulberry32((Math.random() * 2 ** 31) | 0);
    const standings = simulateGroup(teams, null, rand);
    const key = standings.map((s) => s.name).join('|');
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  let bestKey = null, bestCount = -1;
  for (const [key, count] of counts.entries()) {
    if (count > bestCount) { bestCount = count; bestKey = key; }
  }

  const names = bestKey.split('|');
  return {
    order: names,
    probability: bestCount / N,
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

  // Resolve draw mass via the same penalty-tilt logic as the simulator,
  // but deterministically: split pDraw 50/50 (plus tilt) between home/away.
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
function computeMostLikelyScenario(teamsByName) {
  const groupResults = {}; // letter -> { order: [names 1st-4th], probability }

  for (const [letter, names] of Object.entries(GROUPS)) {
    const teams = names.map((name) => ({ name, elo: teamsByName.get(name).elo }));
    groupResults[letter] = modalGroupOrdering(teams);
  }

  // Build standings-row-like objects for R32 resolution (pickBestThirds needs
  // .points/.gd/.gf - we don't have those for the *modal* ordering directly,
  // so for third-place ranking purposes we approximate using each team's Elo
  // rank within its group as a proxy: better Elo -> assume better record.
  // This is a simplification consistent with the "chalk" framing of this page.
  const winners = {};
  const runnersUp = {};
  const thirdsForRanking = [];

  for (const [letter, result] of Object.entries(groupResults)) {
    const [first, second, third, fourth] = result.order;
    winners[letter] = { name: first, elo: teamsByName.get(first).elo, group: letter };
    runnersUp[letter] = { name: second, elo: teamsByName.get(second).elo, group: letter };

    const thirdTeam = { name: third, elo: teamsByName.get(third).elo, group: letter };
    // Synthetic stats proxy for cross-group third-place ranking: scale Elo
    // into a "points/gd/gf"-like ordering key. Higher Elo -> ranked as a
    // "better" third for bracket-seeding purposes.
    thirdsForRanking.push({
      ...thirdTeam,
      points: thirdTeam.elo, // proxy
      gd: 0,
      gf: 0,
    });

    groupResults[letter].fourth = fourth;
  }

  const bestThirds = pickBestThirds(thirdsForRanking)
    .map((t) => ({ name: t.name, elo: t.elo, group: t.group }));

  const lookup = (slot) => {
    if (slot.startsWith('W:')) return winners[slot.slice(2)];
    if (slot.startsWith('R:')) return runnersUp[slot.slice(2)];
    if (slot.startsWith('3RD:')) {
      const n = parseInt(slot.slice(4), 10);
      return bestThirds[n - 1];
    }
    throw new Error(`Unknown slot: ${slot}`);
  };

  const r32 = ROUND_OF_32.map((m) => {
    const home = lookup(m.home);
    const away = lookup(m.away);
    const { winner, pWin } = chalkWinner(home, away);
    return { id: m.id, home, away, winner, pWin };
  });

  const r16 = ROUND_OF_16_PAIRS.map(([a, b], i) => {
    const home = r32[ROUND_OF_32.findIndex((m) => m.id === a)].winner;
    const away = r32[ROUND_OF_32.findIndex((m) => m.id === b)].winner;
    const { winner, pWin } = chalkWinner(home, away);
    return { id: `R16-${i + 1}`, home, away, winner, pWin };
  });

  const qf = QUARTER_FINAL_PAIRS.map(([a, b], i) => {
    const home = r16[a].winner;
    const away = r16[b].winner;
    const { winner, pWin } = chalkWinner(home, away);
    return { id: `QF-${i + 1}`, home, away, winner, pWin };
  });

  const sf = SEMI_FINAL_PAIRS.map(([a, b], i) => {
    const home = qf[a].winner;
    const away = qf[b].winner;
    const { winner, pWin } = chalkWinner(home, away);
    return { id: `SF-${i + 1}`, home, away, winner, pWin };
  });

  const finalHome = sf[0].winner;
  const finalAway = sf[1].winner;
  const { winner: champion, pWin: finalPWin } = chalkWinner(finalHome, finalAway);
  const final = { id: 'F', home: finalHome, away: finalAway, winner: champion, pWin: finalPWin };

  // Third-place playoff (losers of the semis)
  const thirdPlaceHome = { name: sf[0].home.name === champion.name ? sf[0].away.name : sf[0].home.name, elo: 0 };
  // (Not heavily used; omitted from output for simplicity in v1)

  return {
    groups: groupResults, // { letter: { order: [1st,2nd,3rd,4th], probability } }
    bestThirds,
    r32,
    r16,
    qf,
    sf,
    final,
    champion: champion.name,
  };
}

module.exports = { computeMostLikelyScenario, modalGroupOrdering, chalkWinner };
