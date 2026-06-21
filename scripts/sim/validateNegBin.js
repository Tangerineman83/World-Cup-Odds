// validateNegBin.js
//
// OUT-OF-SAMPLE VALIDATION for the dual-Elo Negative Binomial calibration.
//
// calibrateNegBin.js reports in-sample log-likelihood (fitted vs
// placeholder, both evaluated on the SAME matches used to fit) - that
// number will essentially always favour the fit, almost by construction,
// so it can't answer the harder question: does the fitted r=33.04 (close
// to the Poisson limit, i.e. "not much overdispersion") actually predict
// REAL, NOT-YET-SEEN results better than a lower r (e.g. the original
// r=8 placeholder, or other candidate values)? That's the question this
// script answers, via rolling-origin cross-validation: fit on matches
// before a cutoff matchday, score (log-likelihood) on matches strictly
// after it, repeat across several cutoffs, and look at the aggregate
// picture - not any single split, since with only 36 matches total any
// one split is noisy.
//
// MOTIVATION: a real, pervasive pattern was observed in predictions_negbin.json
// where the NegBin model favours lower-rated teams' championship odds
// fairly uniformly across the bracket (~40 of 48 teams), traced to r=33.04
// compounding underdog survival chances across a 7-round knockout
// bracket (lower r -> fatter goal-count tails -> more single-match upset
// probability for the same Elo gap -> compounds multiplicatively over many
// rounds). That's a real and expected property of NegBin vs Poisson in
// general, but r=33.04 itself was flagged by calibrateNegBin.js's own
// console output as "close to the Poisson limit - doesn't yet show strong
// overdispersion evidence", i.e. underdetermined by 36 matches. This
// script checks whether a genuinely out-of-sample test agrees that r near
// 33 is the best predictor, or whether a different r would have predicted
// held-out results better - which would suggest the current bracket-wide
// favouring-of-underdogs effect is partly an artifact of an
// underdetermined dispersion estimate rather than a fully earned model
// property.
//
// Run with: node validateNegBin.js
//
// --- METHOD: ROLLING-ORIGIN CROSS-VALIDATION ---
//
// Matches are grouped by matchday (distinct date). For each cutoff
// matchday from CUTOFF_START_MATCHDAY onward, everything up to and
// including that matchday is the training set; everything after it
// (through the most recent matchday) is the test set. The full
// chronological sequence is always replayed (see
// calibrateNegBin.js's buildSplitObservations) so test-set matches are
// evaluated against ratings that correctly reflect all training-set
// results, not against the pre-tournament baseline.
//
// At each cutoff: (1) re-fit alpha/gamma/sigma/kappa/r using ONLY the
// training portion's log-likelihood as the optimization objective
// (gridRefineSearchTrainOnly - test observations are computed via the
// same replay but never influence parameter selection), (2) compute that
// fit's log-likelihood on the held-out test portion, (3) separately,
// using the SAME fitted alpha/gamma/sigma/kappa, compute test-set
// log-likelihood at several FIXED reference values of r (NOT re-fitting
// the other params - isolating r's effect specifically), to see directly
// whether a different r would have scored the same held-out matches
// better.
//
// --- WHY MATCHDAY-LEVEL CUTOFFS, NOT ARBITRARY MATCH COUNTS ---
//
// Cutting after a complete matchday mirrors how this calibration is
// actually re-run in practice (after each matchday, per the calibration
// cadence in the project's working notes) - so this validation reflects a
// realistic "what would I have known, and what would I have predicted
// next" scenario rather than an arbitrary split that wouldn't correspond
// to any real decision point.
//
// --- HONEST LIMITATION ---
//
// With only 36 total matches and CUTOFF_START_MATCHDAY chosen to leave a
// meaningful test set at the earliest split, there are only a handful of
// rolling splits, each with a small number of held-out matches (worst
// case: the last split, ~4 matches / 8 observations). Any single split's
// result is noisy. The aggregate across all splits (summed test
// log-likelihood, and "how often did each r value win") is the more
// trustworthy signal, but even that aggregate should be treated as
// suggestive rather than conclusive at this sample size - this script
// reports counts and totals explicitly so that's visible, not papered
// over.

const fs = require('fs');
const path = require('path');
const {
  rederiveBaselineRatings, buildSplitObservations, splitLogLikelihood,
  gridRefineSearchTrainOnly,
} = require('./calibrateNegBin');

const SPLIT_BASELINE_PATH = path.join(__dirname, '..', '..', 'elo_baseline_split.json');
const RESULTS_PATH = path.join(__dirname, '..', '..', 'results.json');
const OUTPUT_PATH = path.join(__dirname, '..', '..', 'negbin_validation.json');

const CUTOFF_START_MATCHDAY = 5; // 0-indexed into the sorted distinct-date list; leaves a non-trivial test set at the earliest split
const REFERENCE_R_VALUES = [3, 5, 8, 12, 20, 33.04, 60, 1000]; // 1000 ~= effectively Poisson

const initialParams = {
  alpha: Math.log(1.3), gamma: 0.15, sigma: 250, kappa: 120, r: 8,
};
const bounds = {
  alpha: [Math.log(0.6), Math.log(2.5)], gamma: [0, 0.8],
  sigma: [100, 900], kappa: [40, 250], r: [1, 60],
};

function round3(n) {
  return Math.round(n * 1000) / 1000;
}

function main() {
  console.log('Loading Phase 1 baseline and results.json...');
  const baseline = JSON.parse(fs.readFileSync(SPLIT_BASELINE_PATH, 'utf-8'));
  const allFixtures = JSON.parse(fs.readFileSync(RESULTS_PATH, 'utf-8')).results || [];
  const played = allFixtures
    .filter((r) => r.homeGoals != null && r.awayGoals != null)
    .map((r, i) => ({ ...r, _origIndex: i }))
    .sort((a, b) => (a.date && b.date ? (a.date.localeCompare(b.date) || a._origIndex - b._origIndex) : a._origIndex - b._origIndex));

  const distinctDates = [...new Set(played.map((m) => m.date))].sort();
  console.log(`  ${played.length} played matches across ${distinctDates.length} matchdays.`);

  if (distinctDates.length <= CUTOFF_START_MATCHDAY + 1) {
    console.error(`ERROR: only ${distinctDates.length} matchdays played - need more than ${CUTOFF_START_MATCHDAY + 1} for a meaningful rolling-origin validation. Re-run after more matchdays.`);
    process.exitCode = 1;
    return;
  }

  const splits = [];
  for (let cutoffMd = CUTOFF_START_MATCHDAY; cutoffMd < distinctDates.length - 1; cutoffMd++) {
    const cutoffDate = distinctDates[cutoffMd];
    const trainCutoffIndex = played.findIndex((m) => m.date > cutoffDate);
    const effectiveCutoffIndex = trainCutoffIndex === -1 ? played.length : trainCutoffIndex;
    const trainCount = effectiveCutoffIndex;
    const testCount = played.length - effectiveCutoffIndex;
    if (testCount === 0) continue;
    splits.push({ cutoffMatchday: cutoffMd + 1, cutoffDate, trainCutoffIndex: effectiveCutoffIndex, trainCount, testCount });
  }

  console.log(`\nRunning ${splits.length} rolling-origin split(s)...`);

  const splitResults = [];
  const referenceWinCounts = {};
  for (const r of REFERENCE_R_VALUES) referenceWinCounts[r] = 0;
  let fittedRWins = 0;

  for (const split of splits) {
    console.log(`\n--- Split: train matchdays 1-${split.cutoffMatchday} (${split.trainCount} matches) -> test matchdays ${split.cutoffMatchday + 1}+ (${split.testCount} matches) ---`);

    const { params: fitted } = gridRefineSearchTrainOnly(
      baseline.ratings, baseline.gfBaseline, baseline.gaBaseline,
      played, split.trainCutoffIndex, initialParams, bounds, 5
    );

    const obsAtFitted = buildSplitObservations(baseline.ratings, baseline.gfBaseline, baseline.gaBaseline, played, split.trainCutoffIndex, fitted);
    const testLLAtFitted = splitLogLikelihood(obsAtFitted, false, fitted);

    console.log(`  Fitted on train: alpha=${round3(fitted.alpha)} gamma=${round3(fitted.gamma)} sigma=${round3(fitted.sigma)} kappa=${round3(fitted.kappa)} r=${round3(fitted.r)}`);
    console.log(`  Test-set log-likelihood at fitted r=${round3(fitted.r)}: ${round3(testLLAtFitted.total)} (${testLLAtFitted.count} observations)`);

    // Now hold alpha/gamma/sigma/kappa fixed at their fitted values, and
    // score the SAME held-out test matches at each reference r - isolating
    // r's specific effect on predictive accuracy, independent of whatever
    // the mean-structure parameters happened to fit to.
    const referenceScores = {};
    let bestR = fitted.r;
    let bestLL = testLLAtFitted.total;
    for (const refR of REFERENCE_R_VALUES) {
      const testParams = { ...fitted, r: refR };
      const obs = buildSplitObservations(baseline.ratings, baseline.gfBaseline, baseline.gaBaseline, played, split.trainCutoffIndex, testParams);
      const ll = splitLogLikelihood(obs, false, testParams);
      referenceScores[refR] = round3(ll.total);
      console.log(`    r=${refR}: test logL = ${round3(ll.total)}`);
      if (ll.total > bestLL) {
        bestLL = ll.total;
        bestR = refR;
      }
    }

    if (bestR === fitted.r) {
      fittedRWins++;
    } else {
      referenceWinCounts[bestR] = (referenceWinCounts[bestR] || 0) + 1;
    }
    console.log(`  Best-scoring r for this split's held-out matches: ${round3(bestR)} (fitted r was ${round3(fitted.r)})`);

    splitResults.push({
      cutoffMatchday: split.cutoffMatchday,
      trainCount: split.trainCount,
      testCount: split.testCount,
      fittedParams: { alpha: round3(fitted.alpha), gamma: round3(fitted.gamma), sigma: round3(fitted.sigma), kappa: round3(fitted.kappa), r: round3(fitted.r) },
      testLogLikelihoodAtFittedR: round3(testLLAtFitted.total),
      referenceRScores: referenceScores,
      bestScoringR: bestR,
    });
  }

  const totalTestLLAtFittedR = splitResults.reduce((s, r) => s + r.testLogLikelihoodAtFittedR, 0);
  const totalTestLLByReference = {};
  for (const refR of REFERENCE_R_VALUES) {
    totalTestLLByReference[refR] = round3(splitResults.reduce((s, r) => s + (r.referenceRScores[refR] || 0), 0));
  }

  console.log('\n=== AGGREGATE ACROSS ALL SPLITS ===');
  console.log(`Total held-out test log-likelihood using each split's own fitted r: ${round3(totalTestLLAtFittedR)}`);
  console.log('Total held-out test log-likelihood by FIXED reference r (summed across all splits, higher = better):');
  for (const refR of REFERENCE_R_VALUES) {
    console.log(`  r=${refR}: ${totalTestLLByReference[refR]}`);
  }
  const bestOverallR = Object.entries(totalTestLLByReference).sort((a, b) => b[1] - a[1])[0];
  console.log(`\nBest-scoring fixed r across ALL held-out matches pooled: r=${bestOverallR[0]} (total logL=${bestOverallR[1]})`);
  console.log(`Per-split "winner" counts: fitted-r won ${fittedRWins}/${splitResults.length} splits; reference-r win counts: ${JSON.stringify(referenceWinCounts)}`);
  console.log(`\nReminder: only ${splitResults.length} split(s), each with a small held-out set (worst case ${Math.min(...splitResults.map(s => s.testCount))} matches) - treat this as suggestive, not conclusive. Re-run as more matchdays are played.`);

  const output = {
    generatedAt: new Date().toISOString(),
    totalPlayedMatches: played.length,
    totalMatchdays: distinctDates.length,
    cutoffStartMatchday: CUTOFF_START_MATCHDAY,
    referenceRValues: REFERENCE_R_VALUES,
    splits: splitResults,
    aggregate: {
      totalTestLogLikelihoodAtEachSplitsFittedR: round3(totalTestLLAtFittedR),
      totalTestLogLikelihoodByFixedReferenceR: totalTestLLByReference,
      bestOverallFixedR: Number(bestOverallR[0]),
      fittedRWinCount: fittedRWins,
      referenceRWinCounts: referenceWinCounts,
      splitCount: splitResults.length,
    },
    limitation: `Only ${splitResults.length} rolling-origin split(s) from ${played.length} total matches - small-sample result, treat as suggestive not conclusive. Re-run as more matchdays are played; more splits with larger held-out sets will give a more reliable answer.`,
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
  console.log(`\nWritten: ${OUTPUT_PATH}`);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error('Fatal error:', err.message, err.stack);
    process.exitCode = 1;
  }
}

module.exports = { main };
