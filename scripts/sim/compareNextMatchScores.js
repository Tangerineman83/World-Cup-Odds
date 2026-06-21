// compareNextMatchScores.js
//
// AD HOC comparison script, NOT part of either production pipeline - built
// to answer a specific question: for genuinely upcoming fixtures, how do
// the existing engine's and the NegBin engine's predicted scorelines
// differ, and why?
//
// --- THE TWO MODELS' MECHANISMS ARE STRUCTURALLY DIFFERENT, NOT JUST
//     DIFFERENT GOAL DISTRIBUTIONS ---
//
// Existing engine (runScenario.js's predictedScoreForFixture): decides the
// match OUTCOME first (win/draw/loss, from matchProbabilities on the
// single overall Elo), then finds the most likely Poisson-distributed
// scoreline CONSTRAINED to be consistent with that outcome (e.g. if the
// favourite is predicted to win, only h>a scorelines are considered, even
// if the unconstrained Poisson mode would be a draw).
//
// NegBin engine: there is no separate outcome-decision step. Goals are the
// primary event - the modal scoreline is simply the (h,a) pair with the
// highest joint Negative Binomial probability, full stop, using ELOa/ELOd
// (not blended overall Elo). The outcome (win/draw/loss) falls out of
// whichever scoreline wins, rather than constraining it.
//
// This script makes BOTH mechanisms explicit in its output (not just the
// final picked score) so the actual point of divergence is visible, not
// just the end result - showing each model's top-5 scorelines by
// probability, not only the single modal pick, since the shape of the
// distribution matters for understanding WHY they differ.
//
// Run with: node compareNextMatchScores.js [homeTeam] [awayTeam]
// With no arguments, runs against every unplayed group-stage fixture in
// results.json.

const fs = require('fs');
const path = require('path');
const { matchProbabilities } = require('./eloModel');
const { HOST_NATIONS, hostGroupMatchMultiplier } = require('./tournament');
const { climateAdjustment, GROUP_VENUE } = require('./venues');
const { expectedGoals, loadCalibratedParams } = require('./groupStageNegBin');
const { negBinLogPmf } = require('./calibrateNegBin');

const RESULTS_PATH = path.join(__dirname, '..', '..', 'results.json');
const ELO_BASELINE_PATH = path.join(__dirname, '..', '..', 'elo_baseline.json');
const CURRENT_SPLIT_PATH = path.join(__dirname, '..', '..', 'elo_current_split.json');

// Computes a team's group-stage match number for an UPCOMING fixture (1st,
// 2nd, or 3rd group match) by counting how many group-stage matches that
// team has already played in results.json, plus one for the fixture being
// evaluated now. This was previously hardcoded to 1 for every fixture (a
// real bug, not a placeholder) - meaning every host-nation match beyond
// their 1st group game was incorrectly given FULL home-advantage strength
// by existingEnginePrediction, instead of the tapered 0.75/0.5 the live
// engine (groupStage.js, via HOME_ADVANTAGE_SCHEDULE) actually uses. Only
// matters for host nations (USA/Canada/Mexico) - HOST_NATIONS-gated
// upstream, but computed generally here since it's cheap to do correctly.
function computeGroupMatchNumber(teamName, allFixtures) {
  const playedCount = allFixtures.filter(
    (f) => (f.home === teamName || f.away === teamName) && f.homeGoals != null && f.group
  ).length;
  return playedCount + 1;
}

// Existing engine's own constants (must match groupStage.js / runScenario.js).
const GOAL_LAMBDA = 2.0;
const GOAL_OFFSET = 0.35;

function poissonPMF(lambda, k) {
  if (k < 0) return 0;
  let p = Math.exp(-lambda);
  for (let i = 1; i <= k; i++) p *= lambda / i;
  return p;
}

// --- Existing engine's prediction, REPLICATING predictedScoreForFixture's
// exact logic but also returning the full top-N scorelines and the
// outcome decision, for visibility (the production function only returns
// the single final pick).
function existingEnginePrediction(homeName, awayName, groupLetter, overallEloByName, hostMatchNumber) {
  const homeElo = overallEloByName[homeName];
  const awayElo = overallEloByName[awayName];

  const homeIsHost = HOST_NATIONS.has(homeName);
  const awayIsHost = HOST_NATIONS.has(awayName);
  const neutralVenue = !homeIsHost && !awayIsHost;

  let effHomeName = homeName, effAwayName = awayName;
  if (awayIsHost && !homeIsHost) { effHomeName = awayName; effAwayName = homeName; }
  const effHomeElo = overallEloByName[effHomeName];
  const effAwayElo = overallEloByName[effAwayName];

  const homeAdvMultiplier = (homeIsHost || awayIsHost) ? hostGroupMatchMultiplier(hostMatchNumber) : 1;

  let climateAdj = 0;
  const venueName = groupLetter ? GROUP_VENUE[groupLetter] : null;
  if (venueName) {
    climateAdj = climateAdjustment(effHomeName, venueName) - climateAdjustment(effAwayName, venueName);
  }

  const { pWin, pDraw } = matchProbabilities(effHomeElo, effAwayElo, {
    neutralVenue, climateAdj, homeAdvantageMultiplier: homeAdvMultiplier,
  });
  const pLoss = 1 - pWin - pDraw;

  const effHomeLambda = GOAL_LAMBDA * (GOAL_OFFSET + pWin);
  const effAwayLambda = GOAL_LAMBDA * (GOAL_OFFSET + pLoss);

  const predictedOutcome = (pWin >= pDraw && pWin >= pLoss) ? 'effHome'
                         : (pLoss >= pDraw) ? 'effAway' : 'draw';

  // Full scored grid (not just the constrained-consistent pick) so we can
  // show the UNCONSTRAINED Poisson mode too, for comparison against what
  // the outcome-consistency constraint actually changed.
  const allScores = [];
  let constrainedBest = null, constrainedBestProb = -1;
  let unconstrainedBest = null, unconstrainedBestProb = -1;
  for (let h = 0; h <= 7; h++) {
    for (let a = 0; a <= 7; a++) {
      const prob = poissonPMF(effHomeLambda, h) * poissonPMF(effAwayLambda, a);
      allScores.push({ h, a, prob });
      if (prob > unconstrainedBestProb) { unconstrainedBestProb = prob; unconstrainedBest = { h, a }; }
      const consistent =
        predictedOutcome === 'effHome' ? h > a :
        predictedOutcome === 'effAway' ? a > h : h === a;
      if (consistent && prob > constrainedBestProb) { constrainedBestProb = prob; constrainedBest = { h, a }; }
    }
  }
  allScores.sort((x, y) => y.prob - x.prob);

  const swapped = effHomeName !== homeName;
  const toRealOrientation = (s) => swapped ? { h: s.a, a: s.h } : { h: s.h, a: s.a };

  return {
    pWin: round3(pWin), pDraw: round3(pDraw), pLoss: round3(pLoss),
    predictedOutcome,
    effHomeLambda: round3(effHomeLambda), effAwayLambda: round3(effAwayLambda),
    constrainedPick: toRealOrientation(constrainedBest),
    unconstrainedPoissonMode: toRealOrientation(unconstrainedBest),
    outcomeConstraintChangedPick: constrainedBest.h !== unconstrainedBest.h || constrainedBest.a !== unconstrainedBest.a,
    top5Scorelines: allScores.slice(0, 5).map((s) => ({ ...toRealOrientation(s), prob: round3(s.prob) })),
  };
}

// --- NegBin engine's prediction: simply the highest-joint-probability
// (h,a) pair, no outcome-decision step at all.
function negBinEnginePrediction(homeName, awayName, groupLetter, currentSplitRatings, params, hostMatchNumber) {
  const home = currentSplitRatings[homeName];
  const away = currentSplitRatings[awayName];

  const homeIsHost = HOST_NATIONS.has(homeName);
  const awayIsHost = HOST_NATIONS.has(awayName);
  const neutralVenue = !homeIsHost && !awayIsHost;

  let effHomeName = homeName, effAwayName = awayName, swapped = false;
  if (awayIsHost && !homeIsHost) { effHomeName = awayName; effAwayName = homeName; swapped = true; }
  const effHome = currentSplitRatings[effHomeName];
  const effAway = currentSplitRatings[effAwayName];

  let climateAdj = 0;
  const venueName = groupLetter ? GROUP_VENUE[groupLetter] : null;
  if (venueName) {
    climateAdj = climateAdjustment(effHomeName, venueName) - climateAdjustment(effAwayName, venueName);
  }
  // FIXED: was a hardcoded flat 100 regardless of match number - now
  // correctly tapers via hostGroupMatchMultiplier, matching
  // existingEnginePrediction's own (also-fixed) use of the same function,
  // so both models are evaluated under the same home-advantage assumption
  // rather than NegBin silently getting a stronger home boost.
  const homeAdvMultiplier = neutralVenue ? 0 : hostGroupMatchMultiplier(hostMatchNumber);
  const homeAdvantageElo = 100 * homeAdvMultiplier;
  const homeAdj = homeAdvantageElo + climateAdj;
  const awayAdj = -climateAdj;

  const muHome = expectedGoals(effHome.attack, effAway.defense, homeAdj, params);
  const muAway = expectedGoals(effAway.attack, effHome.defense, awayAdj, params);

  const allScores = [];
  let best = null, bestProb = -1;
  for (let h = 0; h <= 7; h++) {
    for (let a = 0; a <= 7; a++) {
      const logP = negBinLogPmf(h, muHome, params.r) + negBinLogPmf(a, muAway, params.r);
      const prob = Math.exp(logP);
      allScores.push({ h, a, prob });
      if (prob > bestProb) { bestProb = prob; best = { h, a }; }
    }
  }
  allScores.sort((x, y) => y.prob - x.prob);

  const toRealOrientation = (s) => swapped ? { h: s.a, a: s.h } : { h: s.h, a: s.a };
  const realBest = toRealOrientation(best);
  const outcome = realBest.h > realBest.a ? 'home' : realBest.h < realBest.a ? 'away' : 'draw';

  return {
    muHome: round3(muHome), muAway: round3(muAway),
    modalPick: realBest,
    impliedOutcome: outcome,
    top5Scorelines: allScores.slice(0, 5).map((s) => ({ ...toRealOrientation(s), prob: round3(s.prob) })),
  };
}

function round3(n) {
  return Math.round(n * 1000) / 1000;
}

const OUTPUT_PATH = path.join(__dirname, '..', '..', 'next_match_scores.json');

function main() {
  const results = JSON.parse(fs.readFileSync(RESULTS_PATH, 'utf-8')).results || [];
  const overallEloByName = JSON.parse(fs.readFileSync(ELO_BASELINE_PATH, 'utf-8')).ratings;
  // NOTE: existing engine's overallEloByName should really be CURRENT
  // overall Elo (post-results, via eloBaseline.js's computeCurrentRatings),
  // not the raw pre-tournament baseline - using elo_current_split.json's
  // own .overall field instead, since Phase 2 already carries the current
  // overall rating forward unchanged alongside attack/defense (see
  // updateEloSplit.js - overall itself isn't touched by the attack/defense
  // update, so elo_current_split.json's "overall" field is NOT actually
  // the same thing as the existing engine's own current-Elo computation,
  // which uses a different K=60 goal-difference-weighted formula via
  // eloUpdate.js. This is flagged explicitly in the output disclaimer
  // below rather than silently treated as equivalent.
  const currentSplit = JSON.parse(fs.readFileSync(CURRENT_SPLIT_PATH, 'utf-8'));
  const currentOverallByName = {};
  for (const [name, r] of Object.entries(currentSplit.ratings)) {
    currentOverallByName[name] = r.overall;
  }

  const { params, source } = loadCalibratedParams();
  console.log(`NegBin constants: ${JSON.stringify(params)}`);
  console.log(`Source: ${source}\n`);

  const args = process.argv.slice(2);
  let fixtures;
  if (args.length === 2) {
    const [home, away] = args;
    const match = results.find((r) => r.home === home && r.away === away && r.homeGoals == null);
    if (!match) {
      console.error(`No unplayed fixture found for ${home} vs ${away} in results.json.`);
      process.exitCode = 1;
      return;
    }
    fixtures = [match];
  } else {
    fixtures = results.filter((r) => r.homeGoals == null);
  }

  const output = [];
  for (const m of fixtures) {
    if (!currentOverallByName[m.home] || !currentOverallByName[m.away]) {
      console.log(`Skipping ${m.home} vs ${m.away} - missing rating data.`);
      continue;
    }

    // Host advantage only matters if one side is actually a host nation -
    // compute that side's real upcoming group-match number from
    // results.json rather than assuming every fixture is a host's 1st
    // group match (the previous hardcoded `1`, a real bug - see
    // computeGroupMatchNumber's own comment).
    const hostSide = HOST_NATIONS.has(m.home) ? m.home : HOST_NATIONS.has(m.away) ? m.away : null;
    const hostMatchNumber = hostSide ? computeGroupMatchNumber(hostSide, results) : 1;

    const existing = existingEnginePrediction(m.home, m.away, m.group, currentOverallByName, hostMatchNumber);
    const negbin = negBinEnginePrediction(m.home, m.away, m.group, currentSplit.ratings, params, hostMatchNumber);

    console.log(`=== ${m.home} vs ${m.away} (Group ${m.group}, ${m.date || '?'}) ===`);
    console.log(`  Existing engine: pWin=${existing.pWin} pDraw=${existing.pDraw} pLoss=${existing.pLoss} -> outcome decided first: ${existing.predictedOutcome}`);
    console.log(`    Unconstrained Poisson mode: ${existing.unconstrainedPoissonMode.h}-${existing.unconstrainedPoissonMode.a}`);
    console.log(`    Outcome-constrained pick:   ${existing.constrainedPick.h}-${existing.constrainedPick.a}` + (existing.outcomeConstraintChangedPick ? '  <- constraint changed the pick' : '  (same as unconstrained mode)'));
    console.log(`    Top 5: ${existing.top5Scorelines.map((s) => `${s.h}-${s.a} (${(s.prob*100).toFixed(1)}%)`).join(', ')}`);
    console.log(`  NegBin engine: muHome=${negbin.muHome} muAway=${negbin.muAway} -> goals sampled directly, no outcome pre-decision`);
    console.log(`    Modal pick: ${negbin.modalPick.h}-${negbin.modalPick.a}  (implied outcome: ${negbin.impliedOutcome})`);
    console.log(`    Top 5: ${negbin.top5Scorelines.map((s) => `${s.h}-${s.a} (${(s.prob*100).toFixed(1)}%)`).join(', ')}`);
    console.log();

    output.push({ home: m.home, away: m.away, group: m.group, date: m.date || null, hostSide, hostMatchNumber: hostSide ? hostMatchNumber : null, existing, negbin });
  }

  // Only write the JSON file for the full-batch run (no specific fixture
  // named) - that's the workflow/comparison use case. A single named
  // fixture (ad hoc CLI use, e.g. `node compareNextMatchScores.js Brazil
  // Scotland`) stays console-only, matching how this script has been used
  // so far - writing a single-fixture file would silently overwrite the
  // full comparison output, which isn't what an ad hoc one-off check
  // should do.
  if (args.length !== 2) {
    const fileOutput = {
      generatedAt: new Date().toISOString(),
      negBinConstants: params,
      negBinConstantsSource: source,
      fixtures: output,
    };
    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(fileOutput, null, 2));
    console.log(`Written: ${OUTPUT_PATH} (${output.length} fixture(s))`);
  }

  return output;
}

if (require.main === module) {
  main();
}

module.exports = { existingEnginePrediction, negBinEnginePrediction, main };
