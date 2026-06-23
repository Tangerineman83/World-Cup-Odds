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
// --- PRODUCTION OUTPUT - DRIVES predictions.html'S MODEL TOGGLE ---
//
// predictions_negbin.json IS the live data source for predictions.html
// when the "New model" toggle is selected (see predictions.js's
// normalizeTeam/setModel) - this is NOT a comparison-only or diagnostic
// script. (Earlier in this project, before the toggle existed, this
// script's output was scoped down for a planned standalone comparison
// page, temp.html, which was never built out and has since been removed -
// any references to that plan elsewhere in this codebase are stale.)
//
// --- STANDALONE and ADDITIVE ---
//
// Reads elo_current_split.json, negbin_calibration.json (via
// groupStageNegBin.js), and results.json. Writes predictions_negbin.json.
// Does not touch predictions.json (the existing engine's own output) or
// anything specific to that engine.

const fs = require('fs');
const path = require('path');
const { GROUPS } = require('./tournament');
const { simulateTournamentNegBin } = require('./simulateTournamentNegBin');
const { getKnownResultsByGroup } = require('./resultsSource');
const { loadCalibratedParams } = require('./groupStageNegBin');
const { FIFA_RANK } = require('../fifaRankings');
const { mulberry32, buildNameToCode,
  OUTCOME_BUCKETS, buildOutcomeHistograms, buildOutcomeScenarios,
  buildPooledScenarios, buildPointsNodes, buildThirdScenarios,
  buildR32OpponentHistograms, buildR32Opponents,
} = require('./shared');

// FOUND WHILE WIRING UP THE FRONTEND TOGGLE: predictions.json (existing
// engine) includes a `code` field per team (flag/abbreviation code, used by
// predictions.js's flagImgHtml) - predictions_negbin.json didn't have this
// at all, since this script was originally written purely for model-vs-
// model comparison (temp.html), not for direct frontend consumption. Added
// here, same derivation as runSimulation.js's own usage, so
// predictions_negbin.json is a genuine drop-in for anything that reads
// predictions.json's team records.
const NAME_TO_CODE = buildNameToCode();

const N_SIMULATIONS = parseInt(process.argv[2], 10) || 100000;
const CURRENT_SPLIT_PATH = path.join(__dirname, '..', '..', 'elo_current_split.json');
const OUTPUT_PATH = path.join(__dirname, '..', '..', 'predictions_negbin.json');

// REFACTORED from a top-level IIFE into an exported main(numSimulations)
// function - needed so an orchestrator (runFullNegBinPipeline.js) can call
// this in-process, in sequence with the other phases, rather than via
// child_process or letting it run uncontrolled on require(). Behavior is
// otherwise UNCHANGED from the original IIFE - same logic, same file I/O,
// same console output - only the invocation mechanism changed. CLI usage
// (node scripts/sim/runSimulationNegBin.js [N]) is preserved via the
// require.main guard at the bottom of this file, which calls
// main(N_SIMULATIONS_FROM_ARGV) exactly as the IIFE used to run
// automatically.
async function main(numSimulations) {
  const N_SIMULATIONS = numSimulations || 100000;

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

  const outcomeHistograms = buildOutcomeHistograms(allTeams);
  const r32OpponentHistograms = buildR32OpponentHistograms(allTeams);

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

    // Outcome scenario tracking: (points, gd, gf) histogram per team per bucket.
    // GF added to support the full FIFA tiebreak order and thirds-table display.
    // r32Names identifies which 3rd-placed teams qualified (the only way a
    // third-placed team reaches r32).
    const r32Names = new Set(result.r32.flatMap((m) => [m.home.name, m.away.name]));
    for (const standings of Object.values(result.groupStandings)) {
      for (let pos = 0; pos < 4; pos++) {
        const team = standings[pos];
        let bucket;
        if (pos === 0) bucket = '1st';
        else if (pos === 1) bucket = '2nd';
        else if (pos === 3) bucket = '4th';
        else bucket = r32Names.has(team.name) ? '3rd_qualified' : '3rd_eliminated';
        const hist = outcomeHistograms.get(team.name).get(bucket);
        const key = `${team.points},${team.gd},${team.gf}`;
        hist.set(key, (hist.get(key) || 0) + 1);
      }
    }

    // R32 opponent tracking: for every team that reaches R32, record their
    // opponent's name. This gives the full distribution of R32 opponents
    // across all simulations - not just the modal scenario.
    for (const m of result.r32) {
      const homeHist = r32OpponentHistograms.get(m.home.name);
      const awayHist = r32OpponentHistograms.get(m.away.name);
      if (homeHist) homeHist.set(m.away.name, (homeHist.get(m.away.name) || 0) + 1);
      if (awayHist) awayHist.set(m.home.name, (awayHist.get(m.home.name) || 0) + 1);
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
      code: NAME_TO_CODE[name] || null,
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
      thirdPlaceScenarios: buildThirdScenarios(name, outcomeHistograms, N_SIMULATIONS),
      outcomeScenarios: {
        first:            buildOutcomeScenarios(name, '1st',            outcomeHistograms, N_SIMULATIONS),
        second:           buildOutcomeScenarios(name, '2nd',            outcomeHistograms, N_SIMULATIONS),
        thirdQualified:   buildOutcomeScenarios(name, '3rd_qualified',  outcomeHistograms, N_SIMULATIONS),
        thirdEliminated:  buildOutcomeScenarios(name, '3rd_eliminated', outcomeHistograms, N_SIMULATIONS),
        fourth:           buildOutcomeScenarios(name, '4th',            outcomeHistograms, N_SIMULATIONS),
      },
      pooledScenarios: buildPooledScenarios(name, outcomeHistograms, N_SIMULATIONS),
      currentStanding: currentStanding.get(name),
      pointsNodes: buildPointsNodes(name, outcomeHistograms, N_SIMULATIONS),
      r32Opponents: buildR32Opponents(name, r32OpponentHistograms, NAME_TO_CODE, N_SIMULATIONS),
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
      knockoutModel: 'Knockout matches are also resolved via direct NegBin scoreline sampling (knockoutNegBin.js), not a separate win-probability calculation - draws go to a penalty shootout resolved the same ~50/50-plus-small-Elo-tilt way as the existing engine (penalties aren\'t a goals-from-form event either model claims to predict).',
      liveResults: resultsCount > 0
        ? `${resultsCount} completed group-stage result(s) as of ${lastUpdated} are applied directly (not simulated) in every simulation run.`
        : 'No completed results applied yet.',
    },
    teams,
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
  console.log(`Wrote NegBin-engine predictions for ${teams.length} teams to ${OUTPUT_PATH}`);
}

if (require.main === module) {
  main(N_SIMULATIONS).catch((e) => {
    console.error('FATAL:', e);
    process.exitCode = 1;
  });
}

module.exports = { main };
