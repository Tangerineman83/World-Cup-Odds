#!/usr/bin/env node
// Runs a Monte Carlo simulation of the 2026 World Cup using current Elo ratings,
// and writes predictions.json with per-team probabilities of reaching each stage.
//
// Usage: node scripts/sim/runSimulation.js [numSimulations]

const fs = require('fs');
const path = require('path');
const { getEloRatings } = require('../eloSource');
const { GROUPS } = require('./tournament');
const { simulateTournament } = require('./simulateTournament');
const { applyKnownResults } = require('./resultsSource');

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
  console.log('Fetching current Elo ratings...');
  const eloRows = await getEloRatings(); // [{ code, team, eloRating, eloRank }]
  const eloByName = new Map(eloRows.map((r) => [r.team, r.eloRating]));

  // Verify every team in the official groups has an Elo rating
  const allTeams = Object.values(GROUPS).flat();
  const missing = allTeams.filter((t) => !eloByName.has(t));
  if (missing.length) {
    console.warn('WARNING: missing Elo ratings for:', missing.join(', '));
    console.warn('These teams will be assigned a default rating of 1400.');
  }

  const teamsByName = new Map(
    allTeams.map((name) => [name, { name, elo: eloByName.get(name) ?? 1400 }])
  );

  console.log('Applying completed match results...');
  const { eloChanges, knownByGroup, resultsCount, lastUpdated } = applyKnownResults(teamsByName);
  if (resultsCount > 0) {
    console.log(`  Applied ${resultsCount} result(s), updating Elo ratings (results.json last updated ${lastUpdated}).`);
  } else {
    console.log('  No completed results found (results.json empty or missing).');
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

  const teams = allTeams.map((name) => {
    const c = stageCounts.get(name);
    return {
      name,
      code: nameToCode[name] || null,
      group: Object.entries(GROUPS).find(([, members]) => members.includes(name))[0],
      eloRating: teamsByName.get(name).elo,
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
      eloSource: 'https://www.eloratings.net/World.tsv',
      homeAdvantage: 100,
      drawModel: 'empirical (base 26% at parity, floor 12% for large gaps)',
      thirdPlaceAndBracket: 'simplified approximation of FIFA Annex C; not the official 495-scenario mapping',
      knockoutTies: 'extra time/penalties treated as draw-probability mass resolved ~50/50 with a small Elo-based tilt',
      liveResults: resultsCount > 0
        ? `${resultsCount} completed group-stage result(s) as of ${lastUpdated} are applied directly (not simulated) in every simulation run, and have updated each involved team's Elo rating (eloRating below) using the standard World Cup Elo formula (K=60, goal-difference weighted).`
        : 'No completed results applied yet - eloRating values are the pre-tournament Elo snapshot.',
      climateAdjustment: 'group-stage matches include a small Elo-equivalent adjustment (+/-25 points, see scripts/sim/venues.js) based on each team\'s acclimatisation to that group\'s representative host-city altitude/heat profile. Directional, not a fitted parameter. Not applied to knockout matches.',
    },
    teams,
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
  console.log(`Wrote predictions for ${teams.length} teams to ${OUTPUT_PATH}`);
})();
