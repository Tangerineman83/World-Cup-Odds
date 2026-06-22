#!/usr/bin/env node
// runFullNegBinPipeline.js
//
// Single entry point for the entire dual-Elo Negative Binomial pipeline,
// run in the correct dependency order, in ONE Node process:
//
//   1. updateEloSplit.js   (Phase 2: elo_baseline_split.json + results.json
//                            -> elo_current_split.json)
//   2. calibrateNegBin.js  (Phase 3a: elo_baseline_split.json + results.json
//                            -> negbin_calibration.json)
//   3. runSimulationNegBin.js (Phase 3b/4: elo_current_split.json +
//                            negbin_calibration.json -> predictions_negbin.json,
//                            full Monte Carlo)
//   4. runScenarioNegBin.js   (Phase 4: elo_current_split.json +
//                            negbin_calibration.json + predictions_negbin.json
//                            -> scenario_negbin.json, single modal scenario)
//
// Usage: node scripts/sim/runFullNegBinPipeline.js [numSimulations]
//   numSimulations defaults to 20000, same as runSimulationNegBin.js's own
//   default, and is passed through to step 3 only (the others don't take a
//   simulation count).
//
// WHY ONE SCRIPT: this dependency order has been a recurring real source of
// errors across this project - separate scripts/workflows for each phase
// meant the correct order ("ratings before calibration before simulation
// before scenario") relied on a human remembering to trigger them in
// sequence, which was missed more than once (see project history). Calling
// each phase's exported main() directly, in one process, in this fixed
// order, makes the correct sequence structural rather than a manual habit -
// the same reasoning previously motivated combining several separate
// per-phase workflows into one (see refresh-negbin-predictions.yml, which
// now runs this entire script as its single step), now extended one level
// deeper to cover the full chain through to the scenario output too.
//
// DOES NOT run buildEloSplit.js (Phase 1) - that script fetches a live
// third-party dataset over the network and is deliberately kept
// manual-only/separately-scheduled (see build-elo-split.yml's own header).
// This pipeline assumes elo_baseline_split.json already exists and is
// current; Phase 1 remains a separate, occasional, manually-triggered step.
//
// EACH PHASE'S OWN SANITY CHECKS STILL APPLY: this orchestrator does not
// duplicate or replace e.g. calibrateNegBin.js's log-likelihood regression
// check or runSimulationNegBin.js's missing-team check - if a phase's own
// main() throws or sets a non-zero exit code, this script stops immediately
// (does not proceed to the next phase with known-bad input) and exits
// non-zero itself, so a CI workflow correctly fails rather than committing
// partial/bad output.
//
// CACHE NOTE: see groupStageNegBin.js's clearParamsCache - calibrateNegBin.js
// writes a FRESH negbin_calibration.json in step 2, but groupStageNegBin.js
// caches a parsed copy at module level once first read. clearParamsCache()
// is called explicitly between steps 2 and 3 below to guarantee step 3
// reads the calibration this SAME run just produced, not a stale cached
// value from earlier in the process (this only matters because multiple
// phases now run in one process - a fresh `node script.js` CLI invocation
// per phase never had this risk, since cachedParams always starts null).

const path = require('path');

async function main() {
  const numSimulations = parseInt(process.argv[2], 10) || 20000;
  const startTime = Date.now();

  console.log('='.repeat(70));
  console.log('NegBin full pipeline - single orchestrated run');
  console.log('='.repeat(70));

  // --- Step 1: updateEloSplit.js (Phase 2) ---------------------------------
  console.log('\n--- Step 1/4: updateEloSplit.js (current ELOa/ELOd) ---');
  const updateEloSplit = require('./updateEloSplit');
  await updateEloSplit.main();
  if (process.exitCode) {
    console.error('\nPipeline stopped: updateEloSplit.js reported an error (see above). Not proceeding.');
    return;
  }

  // --- Step 2: calibrateNegBin.js (Phase 3a) -------------------------------
  console.log('\n--- Step 2/4: calibrateNegBin.js (fit NegBin constants) ---');
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

  // --- Step 3: runSimulationNegBin.js (Phase 3b/4, Monte Carlo) -----------
  console.log(`\n--- Step 3/4: runSimulationNegBin.js (${numSimulations} simulations) ---`);
  const runSimulationNegBin = require('./runSimulationNegBin');
  await runSimulationNegBin.main(numSimulations);
  if (process.exitCode) {
    console.error('\nPipeline stopped: runSimulationNegBin.js reported an error (see above). Not proceeding.');
    return;
  }

  // --- Step 4: runScenarioNegBin.js (Phase 4, single modal scenario) ------
  console.log('\n--- Step 4/4: runScenarioNegBin.js (modal scenario + bracket) ---');
  const runScenarioNegBin = require('./runScenarioNegBin');
  await runScenarioNegBin.main();
  if (process.exitCode) {
    console.error('\nPipeline stopped: runScenarioNegBin.js reported an error (see above).');
    return;
  }

  const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log('\n' + '='.repeat(70));
  console.log(`Full NegBin pipeline complete in ${elapsedSec}s.`);
  console.log('Wrote: elo_current_split.json, negbin_calibration.json, predictions_negbin.json, scenario_negbin.json');
  console.log('='.repeat(70));
}

if (require.main === module) {
  main().catch((e) => {
    console.error('FATAL (orchestrator):', e);
    process.exitCode = 1;
  });
}

module.exports = { main };
