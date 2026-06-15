#!/usr/bin/env node
// Runs a Monte Carlo simulation of the 2026 World Cup using current Elo
// ratings, and writes predictions.json with per-team probabilities of
// reaching each stage.
//
// Usage: node scripts/sim/runSimulation.js [numSimulations]
//
// Ratings come from elo_baseline.json (frozen pre-tournament snapshot) plus
// results.json (applied deterministically via eloBaseline.js) - NOT a live
// fetch. See eloBaseline.js and compareToLive.js for the rationale and the
// manual verification process.

const fs = require('fs');
const path = require('path');
const { GROUPS } = require('./tournament');
const { simulateTournament } = require('./simulateTournament');
const { getKnownResultsByGroup } = require('./resultsSource');
const { computeCurrentRatings, loadBaseline } = require('./eloBaseline');
const { FIFA_RANK } = require('../fifaRankings');

const N_SIMULATIONS = parseInt(process.argv[2], 10) || 20000;
const OUTPUT_PATH = path.join(__dirname, '..', '..', 'predictions.json');

// Simple, fast PRNG (mulberry32) so runs are fast and reproducible per-seed
// if needed. Re-seeded per run from Math.random for non-determinism by default.
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

(async () => {
  const allTeams = Object.values(GROUPS).flat();

  console.log('Computing ratings from baseline + results.json...');
  const { knownByGroup, resultsCount, lastUpdated } = getKnownResultsByGroup();
  const { teamsByName, appliedCount, baselineFetchedAt, deltaMultiplier } = computeCurrentRatings(
    require(path.join(__dirname, '..', '..', 'results.json')).results
  );

  if (appliedCount > 0) {
    console.log(`  Applied ${appliedCount} result(s) on top of the ${baselineFetchedAt} baseline (results.json last updated ${lastUpdated}).`);
  } else {
    console.log('  No completed results found (results.json empty or all placeholders) - using baseline ratings as-is.');
  }

  // Aggregation counters
  const stageCounts = new Map(); // team -> { groupWin, r16, qf, sf, final, champion }
  for (const name of allTeams) {
    stageCounts.set(name, { r32: 0, r16: 0, qf: 0, sf: 0, final: 0, champion: 0, groupWinner: 0, runnerUp: 0 });
  }

  console.log(`Running ${N_SIMULATIONS} simulations...`);
  const startTime = Date.now();

  for (let i = 0; i < N_SIMULATIONS; i++) {
    const rand = mulberry32((Math.random() * 2 ** 31) | 0);
    const result = simulateTournament(teamsByName, rand, knownByGroup);

    // Group-stage outcomes
    for (const standings of Object.values(result.groupStandings)) {
      stageCounts.get(standings[0].name).groupWinner++;
      stageCounts.get(standings[1].name).runnerUp++;
    }

    // R32 participants = group winners + runners-up + 8 best thirds.
    // Derive from r32 matches (home/away of each match = the 32 entrants).
    for (const m of result.r32) {
      stageCounts.get(m.home.name).r32++;
      stageCounts.get(m.away.name).r32++;
    }

    // R16 participants = the 16 winners of the R32 matches (i.e. the home/away
    // teams of each R16 match).
    for (const m of result.r16) {
      stageCounts.get(m.home.name).r16++;
      stageCounts.get(m.away.name).r16++;
    }

    for (const m of result.qf) {
      stageCounts.get(m.home.name).qf++;
      stageCounts.get(m.away.name).qf++;
    }
    for (const m of result.sf) {
      stageCounts.get(m.home.name).sf++;
      stageCounts.get(m.away.name).sf++;
    }
    stageCounts.get(result.final.home.name).final++;
    stageCounts.get(result.final.away.name).final++;
    stageCounts.get(result.champion.name).champion++;
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`Done in ${elapsed}s`);

  const { ELO_TO_NAME } = require('../countryMap');
  const nameToCode = {};
  for (const [code, name] of Object.entries(ELO_TO_NAME)) nameToCode[name] = code;

  const { ratings: baselineRatings } = loadBaseline();

  const teams = allTeams.map((name) => {
    const c = stageCounts.get(name);
    const currentElo = teamsByName.get(name).elo;
    const baselineElo = baselineRatings[name];
    return {
      name,
      code: nameToCode[name] || null,
      group: Object.entries(GROUPS).find(([, members]) => members.includes(name))[0],
      fifaRank: FIFA_RANK[name] != null ? FIFA_RANK[name] : null,
      eloBaseline: baselineElo,
      eloRating: currentElo,
      eloChange: baselineElo != null ? currentElo - baselineElo : null,
      pGroupWinner: c.groupWinner / N_SIMULATIONS,
      pRunnerUp: c.runnerUp / N_SIMULATIONS,
      pRoundOf32: c.r32 / N_SIMULATIONS,
      pRoundOf16: c.r16 / N_SIMULATIONS,
      pQuarterFinal: c.qf / N_SIMULATIONS,
      pSemiFinal: c.sf / N_SIMULATIONS,
      pFinal: c.final / N_SIMULATIONS,
      pChampion: c.champion / N_SIMULATIONS,
    };
  });

  teams.sort((a, b) => b.pChampion - a.pChampion);

  const output = {
    generatedAt: new Date().toISOString(),
    numSimulations: N_SIMULATIONS,
    methodology: {
      ratingSource: `Ratings are computed deterministically from a frozen pre-tournament Elo snapshot (elo_baseline.json, fetched ${baselineFetchedAt}) plus every played result in results.json, applied in date order via the standard World Cup Elo formula (K=60, goal-difference weighted), with each in-tournament result's rating change multiplied by ${deltaMultiplier}x (on the basis that current tournament form is more representative of a team's true strength than their pre-tournament rating alone). No live fetch is used, so there is no possibility of double-counting against eloratings.net's own updates. Run scripts/sim/compareToLive.js periodically to check this against live eloratings.net values (noting ours will diverge somewhat by design, due to the multiplier).`,
      fifaRank: 'fifaRank is the official FIFA/Coca-Cola Men\'s World Ranking position (1-211ish across all FIFA members; only the 48 World Cup teams are listed here), from the 11 June 2026 update - the last one before the tournament (next update: 20 July 2026, after the tournament). This is FIFA\'s own ranking, independent of and not used by this site\'s model - included for comparison only. See scripts/fifaRankings.js.',
      eloRatings: 'eloBaseline is each team\'s rating immediately before the tournament (elo_baseline.json). eloRating is their CURRENT rating, adjusted for tournament performance so far (see ratingSource above). eloChange = eloRating - eloBaseline.',
      homeAdvantage: 100,
      drawModel: 'empirical (base 26% at parity, floor 12% for large gaps)',
      thirdPlaceAndBracket: 'simplified approximation of FIFA Annex C; not the official 495-scenario mapping',
      knockoutTies: 'extra time/penalties treated as draw-probability mass resolved ~50/50 with a small Elo-based tilt',
      liveResults: resultsCount > 0
        ? `${resultsCount} completed group-stage result(s) as of ${lastUpdated} are applied directly (not simulated) in every simulation run, and have updated each involved team's Elo rating (eloRating below) using the standard World Cup Elo formula (K=60, goal-difference weighted).`
        : 'No completed results applied yet - eloRating values are the pre-tournament Elo baseline.',
      climateAdjustment: 'group-stage matches include a small Elo-equivalent adjustment (+/-25 points, see scripts/sim/venues.js) based on each team\'s acclimatisation to that group\'s representative host-city altitude/heat profile. Directional, not a fitted parameter. Not applied to knockout matches.',
    },
    teams,
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
  console.log(`Wrote predictions for ${teams.length} teams to ${OUTPUT_PATH}`);
})();
