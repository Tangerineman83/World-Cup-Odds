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

  // Third-place qualification scenario tracking: for each team, across sims
  // where they finish 3rd in their group, a histogram of (points,gd) ->
  // count restricted to sims where they ALSO qualified as a top-8 third
  // (i.e. appear in r32). thirdCount tracks the total "finished 3rd"
  // denominator. Used to build a "top 5 scenarios + Others" breakdown per
  // team for the third-place table popup - see buildThirdScenarios below.
  const thirdQualifyHistograms = new Map(); // team -> Map("points,gd" -> count)
  const thirdCounts = new Map(); // team -> count of sims where they finished 3rd
  for (const name of allTeams) {
    thirdQualifyHistograms.set(name, new Map());
    thirdCounts.set(name, 0);
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
    const r32Names = new Set();
    for (const m of result.r32) {
      stageCounts.get(m.home.name).r32++;
      stageCounts.get(m.away.name).r32++;
      r32Names.add(m.home.name);
      r32Names.add(m.away.name);
    }

    // Third-place scenario tracking: for each group's 3rd-placed team,
    // record this sim's (points,gd) and whether they qualified (appear in
    // r32 - the only way a 3rd-placed team reaches r32 is via the
    // third-place route).
    for (const standings of Object.values(result.groupStandings)) {
      const third = standings[2];
      thirdCounts.set(third.name, thirdCounts.get(third.name) + 1);
      if (r32Names.has(third.name)) {
        const hist = thirdQualifyHistograms.get(third.name);
        const key = `${third.points},${third.gd}`;
        hist.set(key, (hist.get(key) || 0) + 1);
      }
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

  // Builds the "top 5 (points,gd) scenarios + Others" breakdown for a team,
  // for the third-place table popup. Each entry's `pct` is expressed as a
  // fraction of ALL sims where this team finished 3rd (thirdCount) - i.e.
  // the top 5 + Others sum to pQualifyGiven3rd (the conditional probability
  // of qualifying given finishing 3rd), NOT to 1. The remaining mass
  // (1 - sum) corresponds to sims where the team finished 3rd but did NOT
  // qualify - not itemised here, but derivable as
  // 1 - pQualifyGiven3rd = 1 - sum(scenario percentages).
  function buildThirdScenarios(name) {
    const thirdCount = thirdCounts.get(name);
    if (!thirdCount) return [];
    const hist = thirdQualifyHistograms.get(name);
    const entries = [...hist.entries()]
      .map(([key, count]) => {
        const [points, gd] = key.split(',').map(Number);
        return { points, gd, pct: count / thirdCount };
      })
      .sort((a, b) => b.pct - a.pct);

    const top5 = entries.slice(0, 5);
    const othersPct = entries.slice(5).reduce((sum, e) => sum + e.pct, 0);
    const scenarios = top5.map((e) => ({ points: e.points, gd: e.gd, pct: e.pct }));
    if (othersPct > 0) scenarios.push({ points: null, gd: null, pct: othersPct });
    return scenarios;
  }

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
      thirdPlaceScenarios: buildThirdScenarios(name),
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
      thirdPlaceScenarios: 'For each team, thirdPlaceScenarios lists the most common (points, gd) combinations from simulations where that team finished 3rd in their group AND qualified as a top-8 third. The pct for each entry is a fraction of ALL simulations where the team finished 3rd (not just qualifying ones) - so the entries sum to pQualifyGiven3rd (in scenario.json allThirds), not to 1. The top 5 distinct (points, gd) combos are listed individually; any remainder is grouped into an "Others" entry (points: null, gd: null). The remaining gap to 1 (i.e. 1 - pQualifyGiven3rd) represents simulations where the team finished 3rd but did NOT qualify - not itemised here. Empty for teams that (almost) never finish 3rd.',
    },
    teams,
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
  console.log(`Wrote predictions for ${teams.length} teams to ${OUTPUT_PATH}`);
})();
