#!/usr/bin/env node
// Runs a Monte Carlo simulation of the 2026 World Cup using the dual-Elo
// Negative Binomial engine (groupStageNegBin.js + knockoutNegBin.js +
// simulateTournamentNegBin.js), and writes predictions_negbin.json with
// per-team probabilities of reaching each stage - the NegBin-engine
// counterpart to runSimulation.js's predictions.json.
//
// Usage: node scripts/sim/runSimulationNegBin.js [numSimulations]
//
// --- RATINGS SOURCE ---
//
// Reads elo_current_split.json directly (Phase 2's output: current
// in-tournament ELOa/ELOd, already reflecting every played result) rather
// than recomputing from elo_baseline.json + results.json the way
// runSimulation.js's computeCurrentRatings does for the scalar engine -
// elo_current_split.json IS that already-computed equivalent for the
// dual-Elo model, so there's no need to replay anything here. Hard-fails
// with a clear message if elo_current_split.json is missing (run
// updateEloSplit.js / Phase 2 first), same pattern as
// groupStageNegBin.js's own hard dependency on negbin_calibration.json
// existing for a real (non-placeholder) fit.
//
// --- OUTPUT SCOPE: SCOPED DOWN FROM predictions.json, DELIBERATELY ---
//
// predictions.json's full shape (Sankey scenario breakdowns, points-node
// histograms, third-place scenario tables) exists to drive predictions.html's
// rich UI - building the full equivalent here would be substantial work
// mostly aimed at production UI features that don't apply yet, since this
// output is for temp.html model comparison, not a production page. This
// script outputs ONLY the core stage-probability fields needed for a
// like-for-like comparison against predictions.json's same fields
// (pGroupWinner, pRunnerUp, pRoundOf32, pRoundOf16, pQuarterFinal,
// pSemiFinal, pFinal, pChampion) - same field names deliberately, so
// temp.html (once wired up) can diff the two files directly without a
// translation layer. If/when this engine is integrated into the live site
// (Phase 4), the full Sankey/scenario output can be built out then -
// premature to build it now for a comparison-only script.
//
// --- STANDALONE and ADDITIVE ---
//
// Reads elo_current_split.json, negbin_calibration.json (via
// groupStageNegBin.js), and results.json. Writes a NEW file
// (predictions_negbin.json). Does not touch predictions.json or anything
// currently driving the live site.

const fs = require('fs');
const path = require('path');
const { GROUPS } = require('./tournament');
const { simulateTournamentNegBin } = require('./simulateTournamentNegBin');
const { getKnownResultsByGroup } = require('./resultsSource');
const { loadCalibratedParams } = require('./groupStageNegBin');
const { FIFA_RANK } = require('../fifaRankings');

const N_SIMULATIONS = parseInt(process.argv[2], 10) || 20000;
const CURRENT_SPLIT_PATH = path.join(__dirname, '..', '..', 'elo_current_split.json');
const OUTPUT_PATH = path.join(__dirname, '..', '..', 'predictions_negbin.json');

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

(async () => {
  if (!fs.existsSync(CURRENT_SPLIT_PATH)) {
    console.error('ERROR: elo_current_split.json not found. Run scripts/sim/updateEloSplit.js (Phase 2) first.');
    process.exitCode = 1;
    return;
  }

  console.log('Loading current ELOa/ELOd (elo_current_split.json)...');
  const currentSplit = JSON.parse(fs.readFileSync(CURRENT_SPLIT_PATH, 'utf-8'));
  const allTeams = Object.values(GROUPS).flat();

  const teamsByName = new Map();
  const missingTeams = [];
  for (const name of allTeams) {
    const r = currentSplit.ratings[name];
    if (!r) { missingTeams.push(name); continue; }
    teamsByName.set(name, { elo: r.overall, attack: r.attack, defense: r.defense });
  }
  if (missingTeams.length > 0) {
    console.error(`ERROR: ${missingTeams.length} team(s) missing from elo_current_split.json: ${missingTeams.join(', ')}`);
    process.exitCode = 1;
    return;
  }
  console.log(`  Loaded ${teamsByName.size} teams.`);

  const { params, source } = loadCalibratedParams();
  console.log(`Using NegBin constants: ${JSON.stringify(params)}`);
  console.log(`  Source: ${source}`);
  if (source.startsWith('FALLBACK')) {
    console.log('  WARNING: running with placeholder constants, not a real calibration. Run scripts/sim/calibrateNegBin.js (Phase 3a) first for meaningful output.');
  }

  const { knownByGroup, resultsCount, lastUpdated } = getKnownResultsByGroup();
  if (resultsCount > 0) {
    console.log(`  ${resultsCount} completed result(s) applied directly (results.json last updated ${lastUpdated}).`);
  }

  const currentStanding = new Map();
  for (const name of allTeams) {
    currentStanding.set(name, { points: 0, gd: 0, gf: 0, ga: 0, played: 0 });
  }
  for (const fixtures of knownByGroup.values()) {
    for (const r of fixtures) {
      const home = currentStanding.get(r.home);
      const away = currentStanding.get(r.away);
      if (!home || !away) continue;
      home.gf += r.homeGoals; home.ga += r.awayGoals; home.played += 1;
      away.gf += r.awayGoals; away.ga += r.homeGoals; away.played += 1;
      if (r.homeGoals > r.awayGoals) home.points += 3;
      else if (r.homeGoals < r.awayGoals) away.points += 3;
      else { home.points += 1; away.points += 1; }
    }
  }
  for (const s of currentStanding.values()) s.gd = s.gf - s.ga;

  const stageCounts = new Map();
  for (const name of allTeams) {
    stageCounts.set(name, { r32: 0, r16: 0, qf: 0, sf: 0, final: 0, champion: 0, groupWinner: 0, runnerUp: 0 });
  }

  console.log(`Running ${N_SIMULATIONS} simulations...`);
  const startTime = Date.now();

  for (let i = 0; i < N_SIMULATIONS; i++) {
    const rand = mulberry32((Math.random() * 2 ** 31) | 0);
    const result = simulateTournamentNegBin(teamsByName, rand, knownByGroup);

    for (const standings of Object.values(result.groupStandings)) {
      stageCounts.get(standings[0].name).groupWinner++;
      stageCounts.get(standings[1].name).runnerUp++;
    }

    for (const m of result.r32) {
      stageCounts.get(m.home.name).r32++;
      stageCounts.get(m.away.name).r32++;
    }
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

    if ((i + 1) % 5000 === 0) {
      console.log(`  ${i + 1}/${N_SIMULATIONS} (${((Date.now() - startTime) / 1000).toFixed(1)}s elapsed)`);
    }
  }

  const elapsedSec = (Date.now() - startTime) / 1000;
  console.log(`Done in ${elapsedSec.toFixed(1)}s.`);

  const teams = allTeams.map((name) => {
    const c = stageCounts.get(name);
    const r = currentSplit.ratings[name];
    return {
      name,
      group: Object.entries(GROUPS).find(([, members]) => members.includes(name))[0],
      fifaRank: FIFA_RANK[name] != null ? FIFA_RANK[name] : null,
      eloOverall: r.overall,
      eloAttack: r.attack,
      eloDefense: r.defense,
      pGroupWinner: c.groupWinner / N_SIMULATIONS,
      pRunnerUp: c.runnerUp / N_SIMULATIONS,
      pRoundOf32: c.r32 / N_SIMULATIONS,
      pRoundOf16: c.r16 / N_SIMULATIONS,
      pQuarterFinal: c.qf / N_SIMULATIONS,
      pSemiFinal: c.sf / N_SIMULATIONS,
      pFinal: c.final / N_SIMULATIONS,
      pChampion: c.champion / N_SIMULATIONS,
      currentStanding: currentStanding.get(name),
    };
  });

  teams.sort((a, b) => b.pChampion - a.pChampion);

  const output = {
    generatedAt: new Date().toISOString(),
    numSimulations: N_SIMULATIONS,
    model: 'dual-Elo Negative Binomial (Phase 3) - see elo-negbin-revised.md',
    negBinConstants: params,
    negBinConstantsSource: source,
    methodology: {
      ratingSource: 'eloOverall/eloAttack/eloDefense are each team\'s CURRENT in-tournament ratings from elo_current_split.json (Phase 2), already reflecting every played result. Unlike predictions.json\'s scalar engine, goals here are sampled DIRECTLY from a Negative Binomial distribution parameterized by the ELOa/ELOd gap (not decided via win-probability first, then forced-fit goals after) - see groupStageNegBin.js and elo-negbin-revised.md Section 4.',
      scopeNote: 'This output is intentionally scoped down from predictions.json: it has the same core stage-probability fields (for direct comparison) but does NOT include the Sankey/scenario-breakdown fields (pooledScenarios, outcomeScenarios, pointsNodes, thirdPlaceScenarios) that drive predictions.html\'s UI - this file is for model-vs-model comparison (temp.html), not a production page.',
      knockoutModel: 'Knockout matches are also resolved via direct NegBin scoreline sampling (knockoutNegBin.js), not a separate win-probability calculation - draws go to a penalty shootout resolved the same ~50/50-plus-small-Elo-tilt way as the existing engine (penalties aren\'t a goals-from-form event either model claims to predict).',
      liveResults: resultsCount > 0
        ? `${resultsCount} completed group-stage result(s) as of ${lastUpdated} are applied directly (not simulated) in every simulation run.`
        : 'No completed results applied yet.',
    },
    teams,
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
  console.log(`Wrote NegBin-engine predictions for ${teams.length} teams to ${OUTPUT_PATH}`);
})();
