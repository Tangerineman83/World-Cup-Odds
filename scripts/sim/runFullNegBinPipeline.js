#!/usr/bin/env node
// runFullNegBinPipeline.js
//
// Single entry point for the entire dual-Elo Negative Binomial pipeline,
// run in the correct dependency order, in ONE Node process:
//
//   1. updateEloSplit.js      — applies in-tournament results to baseline
//                               attack/defence ratings
//                               reads:  elo_baseline_split.json + results.json
//                               writes: elo_current_split.json
//
//   2. calibrateNegBin.js     — fits NegBin parameters (alpha, gamma, sigma,
//                               r) by maximum likelihood against all played
//                               results; always runs before simulation so the
//                               Monte Carlo uses the freshest fitted parameters
//                               reads:  elo_baseline_split.json + results.json
//                               writes: negbin_calibration.json
//
//   3. runSimulationNegBin.js — Monte Carlo simulation (100k tournaments)
//                               reads:  elo_current_split.json +
//                                       negbin_calibration.json
//                               writes: predictions_negbin.json
//
//   4. runScenarioNegBin.js   — single modal scenario + bracket
//                               reads:  elo_current_split.json +
//                                       negbin_calibration.json +
//                                       predictions_negbin.json
//                               writes: scenario_negbin.json
//
// Usage: node scripts/sim/runFullNegBinPipeline.js [numSimulations]
//
// WHY CALIBRATION RUNS EVERY TIME: as results accumulate the joint
// likelihood surface shifts — what maximised fit against 36 matches will
// not maximise it against 73. Running calibrateNegBin.js before every
// simulation batch ensures predictions always reflect parameters fitted to
// the most complete available data, not a snapshot from a prior run.
// The compute cost is modest (~30s) relative to the simulation (~3min).
//
// WHY ONE SCRIPT: this dependency order has been a recurring real source of
// errors — separate scripts for each phase meant the correct order relied on
// a human remembering to trigger them in sequence. Calling each phase's
// exported main() directly, in one process, in this fixed order, makes the
// correct sequence structural rather than a manual habit.
//
// DOES NOT run buildEloSplit.js — that script fetches a live third-party
// dataset and is kept manual-only (see build-elo-split.yml). This pipeline
// assumes elo_baseline_split.json already exists and is current.
//
// CACHE NOTE: calibrateNegBin.js writes a fresh negbin_calibration.json in
// step 2, but groupStageNegBin.js caches a parsed copy at module level.
// clearParamsCache() is called between steps 2 and 3 to guarantee step 3
// reads the calibration this run just produced.

const path = require('path');

async function main() {
  const numSimulations = parseInt(process.argv[2], 10) || 100000;
  const startTime = Date.now();

  console.log('='.repeat(70));
  console.log('NegBin full pipeline - single orchestrated run');
  console.log('='.repeat(70));

  // --- Step 1: updateEloSplit.js -------------------------------------------
  console.log('\n--- Step 1/4: updateEloSplit.js (apply in-tournament results to ratings) ---');
  const updateEloSplit = require('./updateEloSplit');
  await updateEloSplit.main();
  if (process.exitCode) {
    console.error('\nPipeline stopped: updateEloSplit.js reported an error (see above). Not proceeding.');
    return;
  }

  // --- Step 2: calibrateNegBin.js (parameter optimisation) ----------------
  console.log('\n--- Step 2/4: calibrateNegBin.js (optimise NegBin parameters against current results) ---');
  const calibrateNegBin = require('./calibrateNegBin');
  await calibrateNegBin.main();
  if (process.exitCode) {
    console.error('\nPipeline stopped: calibrateNegBin.js reported an error (see above). Not proceeding.');
    return;
  }

  // Force the NEXT loadCalibratedParams() call (inside runSimulationNegBin.js
  // / runScenarioNegBin.js, both transitively via groupStageNegBin.js) to
  // re-read the calibration file step 2 JUST wrote, not a stale in-process
  // cached copy - see this file's own header comment and
  // groupStageNegBin.js's clearParamsCache comment for why this matters
  // specifically in a multi-phase-in-one-process orchestrator.
  const { clearParamsCache } = require('./groupStageNegBin');
  clearParamsCache();

  // --- Step 3: runSimulationNegBin.js (Monte Carlo) -----------------------
  console.log(`\n--- Step 3/4: runSimulationNegBin.js (${numSimulations.toLocaleString()} simulations) ---`);
  const runSimulationNegBin = require('./runSimulationNegBin');
  await runSimulationNegBin.main(numSimulations);
  if (process.exitCode) {
    console.error('\nPipeline stopped: runSimulationNegBin.js reported an error (see above). Not proceeding.');
    return;
  }

  // --- Step 4: runScenarioNegBin.js (modal scenario) ----------------------
  console.log('\n--- Step 4/4: runScenarioNegBin.js (modal scenario + bracket) ---');
  const runScenarioNegBin = require('./runScenarioNegBin');
  await runScenarioNegBin.main();
  if (process.exitCode) {
    console.error('\nPipeline stopped: runScenarioNegBin.js reported an error (see above).');
    return;
  }

  const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log('\n' + '='.repeat(70));
  console.log(`Full pipeline complete in ${elapsedSec}s.`);
  console.log('Outputs: elo_current_split.json, negbin_calibration.json, predictions_negbin.json, scenario_negbin.json');
  console.log('='.repeat(70));
}

if (require.main === module) {
  main().catch((e) => {
    console.error('FATAL (orchestrator):', e);
    process.exitCode = 1;
  });
}

module.exports = { main };
