// simulateTournamentNegBin.js
//
// Tournament-level driver for the dual-Elo Negative Binomial engine,
// mirroring simulateTournament.js's structure and return shape EXACTLY
// (same groupStandings/r32/r16/qf/sf/final/thirdPlacePlayoff/champion
// keys), but using groupStageNegBin.js for group matches and
// knockoutNegBin.js's playKnockoutNegBin for every knockout match -
// resolving the WHOLE tournament via direct NegBin scoreline sampling, not
// just the group stage, so the model-vs-model comparison is fair
// end-to-end rather than mixing engines partway through.
//
// resolveRoundOf32 and pickBestThirds are reused UNCHANGED from
// simulateTournament.js's own exports - that logic (which 8 thirds qualify,
// how the bracket slots resolve) has nothing to do with which goal model is
// in use, so duplicating it here would just be two copies to keep in sync
// for no reason.
//
// STANDALONE and ADDITIVE - does not modify simulateTournament.js.

const { simulateGroup } = require('./groupStageNegBin');
const { playKnockoutNegBin } = require('./knockoutNegBin');
const { resolveRoundOf32 } = require('./simulateTournament');
const { resolveKnockoutWinner } = require('./knockoutResult');
const {
  GROUPS, ROUND_OF_16_PAIRS, QUARTER_FINAL_PAIRS, SEMI_FINAL_PAIRS,
  FINAL_PAIR, THIRD_PLACE_PAIR,
} = require('./tournament');

// Runs one full tournament simulation under the NegBin engine.
// teamsByName: Map of team name -> { elo, attack, defense } (current
// in-tournament ELOa/ELOd - see runComparison.js for how this is built
// from elo_current_split.json). rand: PRNG returning [0,1). knownByGroup:
// same shape as simulateTournament.js's own parameter (Map of group letter
// -> completed fixtures).
function simulateTournamentNegBin(teamsByName, rand, knownByGroup = new Map(), knownByMatchId = new Map()) {
  const groupStandings = {};

  for (const [letter, names] of Object.entries(GROUPS)) {
    const teams = names.map((name) => {
      const t = teamsByName.get(name);
      return { name, elo: t.elo, attack: t.attack, defense: t.defense };
    });
    groupStandings[letter] = simulateGroup(teams, null, rand, {
      knownResults: knownByGroup.get(letter) || [],
      groupLetter: letter,
    });
  }

  // resolveRoundOf32 only reads .name/.points/.gd/.gf/.group off each
  // standings row (see simulateTournament.js) - groupStageNegBin.js's
  // simulateGroup return shape already matches that exactly (same
  // applyResult/sort logic, deliberately), so this reused function works
  // unchanged on NegBin-engine standings.
  const r32Matches = resolveRoundOf32(groupStandings);
  const matchesById = new Map();

  // r32Matches' home/away team objects only carry { name, elo, gd, gf, ...}
  // from groupStandings (groupStageNegBin's stats shape), NOT attack/
  // defense - playKnockoutNegBin needs attack/defense too, so re-attach
  // them from teamsByName before playing each knockout match.
  function withAttackDefense(team) {
    const full = teamsByName.get(team.name);
    return { ...team, attack: full.attack, defense: full.defense };
  }

  for (const m of r32Matches) {
    const known = knownByMatchId.get(m.id);
    let winner;
    if (known) {
      // Result already played — determine winner via resolveKnockoutWinner
      // (checks 90min -> AET -> penalties in order). Burn rand() calls to
      // keep PRNG state varied across sims (same pattern as
      // groupStageNegBin.js's entropy burn for known results).
      for (let _b = 0; _b < 8; _b++) rand();
      const { winnerName } = resolveKnockoutWinner(known);
      if (winnerName) {
        winner = m.home.name === winnerName ? m.home : m.away;
      } else {
        // Not yet decided (level after 90/AET, no penalty winner recorded
        // yet) — simulate penalties as if this were an unplayed match.
        winner = playKnockoutNegBin(withAttackDefense(m.home), withAttackDefense(m.away), rand);
      }
    } else {
      winner = playKnockoutNegBin(withAttackDefense(m.home), withAttackDefense(m.away), rand);
    }
    matchesById.set(m.id, { ...m, winner });
  }

  function playRound(pairs) {
    const results = [];
    for (const [matchId, [fromA, fromB]] of pairs) {
      const home = matchesById.get(fromA).winner;
      const away = matchesById.get(fromB).winner;
      const known = knownByMatchId.get(matchId);
      let winner;
      if (known) {
        for (let _b = 0; _b < 8; _b++) rand();
        const { winnerName } = resolveKnockoutWinner(known);
        if (winnerName) {
          winner = home.name === winnerName ? home : away;
        } else {
          winner = playKnockoutNegBin(withAttackDefense(home), withAttackDefense(away), rand);
        }
      } else {
        winner = playKnockoutNegBin(withAttackDefense(home), withAttackDefense(away), rand);
      }
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
  const champion = playKnockoutNegBin(withAttackDefense(finalHome), withAttackDefense(finalAway), rand);
  const finalMatch = { id: finalId, home: finalHome, away: finalAway, winner: champion };
  matchesById.set(finalId, finalMatch);

  const [tpId, [tpA, tpB]] = THIRD_PLACE_PAIR;
  const semiA = matchesById.get(tpA);
  const semiB = matchesById.get(tpB);
  const loser = (m) => (m.winner.name === m.home.name ? m.away : m.home);
  const tpHome = loser(semiA);
  const tpAway = loser(semiB);
  const tpWinner = playKnockoutNegBin(withAttackDefense(tpHome), withAttackDefense(tpAway), rand);
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

module.exports = { simulateTournamentNegBin };
