// calibrateNegBin.js
//
// PHASE 3a (calibration) of the dual-Elo Negative Binomial project.
//
// Fits alpha, gamma, sigma, kappa, and r jointly by maximum likelihood
// against every played result in results.json, replacing the placeholder
// constants used by buildEloSplit.js (kappa) and updateEloSplit.js
// (alpha/gamma/sigma). This is the calibration procedure described in
// Section 5 of elo-negbin-revised.md, now run against real in-tournament
// data rather than deferred.
//
// STANDALONE and ADDITIVE: reads elo_baseline_split.json + results.json,
// writes a NEW file (negbin_calibration.json). Does not modify any existing
// file, including elo_baseline_split.json/elo_current_split.json - those
// keep using their existing placeholder constants until a later phase
// deliberately wires the fitted ones in.
//
// Run with: node calibrateNegBin.js
//
// --- WHY PRE-MATCH RATINGS, NOT elo_current_split.json's FINAL VALUES ---
//
// elo_current_split.json holds each team's CURRENT (post-every-played-
// match) attack/defense rating. Using that single end-state value to
// evaluate the likelihood of an EARLIER match (e.g. a team's 1st group
// match) would be using information from later matches to "predict" an
// earlier one - leakage, not a fair fit. This script instead replays the
// update sequence itself (same chronological-order logic as
// updateEloSplit.js), evaluating each match's likelihood against the
// running attack/defense state as it stood immediately BEFORE that match,
// then applying that match's own update before moving to the next one -
// exactly mirroring how eloBaseline.js/updateEloSplit.js already process
// results in date order for the same reason.
//
// --- WHAT "FITTING" MEANS HERE ---
//
// Negative Binomial log-likelihood for a single observed goal count k
// against mean mu and dispersion r (using the mean/dispersion
// parameterization, NOT the failure-probability one - converted internally
// in negBinLogPmf):
//   logL = lgamma(k+r) - lgamma(r) - lgamma(k+1)
//          + r*log(r/(r+mu)) + k*log(mu/(r+mu))
// Total log-likelihood across all home/away goal observations from all
// played matches is maximized over (alpha, gamma, sigma, kappa, r) jointly.
//
// --- OPTIMIZATION METHOD ---
//
// No external optimization library (project convention is zero npm
// dependencies - see package.json). Implements coordinate-wise grid-refine
// search: for each parameter in turn, holding the others fixed, scan a
// range of candidate values, take the one maximizing total log-likelihood,
// then narrow the range around it and repeat. Cycles through all 5
// parameters for several rounds. This is slower and less precise than a
// proper gradient-based optimizer (e.g. L-BFGS) but is dependency-free,
// deterministic, and transparent - every step is visible in the console
// log, which matters for a first calibration pass that should be
// inspectable, not just trusted.
//
// --- SAMPLE SIZE CAVEAT ---
//
// Only ~36 played matches (72 goal observations) exist at the time this
// script was first written. A 5-parameter joint fit against 72
// observations is a SMALL sample for the number of free parameters -
// treat the fitted values as a genuine first pass, not a settled
// calibration. Re-run as more matches are played; the output records
// matchCount so it's always visible how much data a given calibration run
// was based on. kappa in particular already had a much larger anchor
// (thousands of historical matches via Phase 1's international_results
// pull) - re-fitting it against only 36 in-tournament matches risks
// overriding a well-anchored estimate with a noisy one. See the console
// output's comparison against the Phase 1 kappa for a sanity check on
// this specifically.

const fs = require('fs');
const path = require('path');

const SPLIT_BASELINE_PATH = path.join(__dirname, '..', '..', 'elo_baseline_split.json');
const RESULTS_PATH = path.join(__dirname, '..', '..', 'results.json');
const OUTPUT_PATH = path.join(__dirname, '..', '..', 'negbin_calibration.json');

// Out-of-sample-preferred dispersion value, from rolling-origin
// cross-validation (validateNegBin.js) run against 36 played matches
// across 4 train/test splits. In 3 of 4 splits, the split's own in-sample
// fitted r (which climbed toward 40+ as more training data was added) was
// NOT the best predictor of the held-out matches that actually followed -
// smaller r values (mostly r=8 and r=12) scored better out-of-sample.
// Pooled across all held-out observations, r=12 was the best-scoring fixed
// value overall (see negbin_validation.json's aggregate.bestOverallFixedR).
// Used as a fallback below when the in-sample fit's r lands above
// R_OVERFIT_THRESHOLD - the same "in-sample fit chasing noise toward an
// extreme" pattern already handled for kappa, now extended to r based on
// this specific validation evidence (not just a generic small-sample
// heuristic) - re-run validateNegBin.js as more matchdays are played and
// update this constant if the out-of-sample picture changes.
const R_VALIDATED_FALLBACK = 12;
const R_OVERFIT_THRESHOLD = 25; // matches the threshold already used for the console "r is large" note below

const HOST_NATIONS = new Set(['USA', 'Canada', 'Mexico']);

// --- Negative Binomial log-likelihood (mean/dispersion parameterization) ---

function logGamma(x) {
  // Lanczos approximation - standard, accurate to ~15 significant digits
  // for x > 0, sufficient for log-likelihood evaluation here.
  const g = 7;
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  }
  x -= 1;
  let a = c[0];
  const t = x + g + 0.5;
  for (let i = 1; i < g + 2; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

function negBinLogPmf(k, mu, r) {
  // mu must be > 0, r must be > 0. Returns log P(X=k).
  if (mu <= 0 || r <= 0) return -Infinity;
  return logGamma(k + r) - logGamma(r) - logGamma(k + 1)
    + r * Math.log(r / (r + mu)) - k * Math.log(1 + r / mu);
}

// --- Expected goals formula (same structural form as updateEloSplit.js) ---

function expectedGoals(attackElo, defenseElo, isHomeAdvantage, params) {
  const rawGapTerm = (attackElo - defenseElo) / params.sigma;
  const cappedGapTerm = Math.max(-1.5, Math.min(1.5, rawGapTerm));
  const logMu = params.alpha + (isHomeAdvantage ? params.gamma : 0) + cappedGapTerm;
  return Math.exp(logMu);
}

// --- Re-deriving attack/defense from a candidate kappa ---------------------
//
// elo_baseline_split.json stores attack/defense values already baked in
// using Phase 1's kappa (120, placeholder). To genuinely fit kappa here
// (not just report back whatever value it started at), the baseline split
// must be RE-DERIVED at each candidate kappa from the underlying
// gfPerMatch/gaPerMatch/shrinkFactor/overall fields Phase 1 already stored
// for exactly this purpose - using the pre-baked attack/defense values
// directly would make kappa structurally inert in this fit (changing it
// would have no effect on the likelihood at all, since the values being
// fed into expectedGoals() wouldn't change with it).
//
// gfBaseline/gaBaseline (the 48-team pool averages from Phase 1) are
// needed for this and are read directly from elo_baseline_split.json -
// they don't depend on kappa, so they're computed once, not re-derived
// per candidate.
function rederiveBaselineRatings(rawRatings, gfBaseline, gaBaseline, kappa) {
  const ratings = {};
  for (const [name, r] of Object.entries(rawRatings)) {
    if (r.matchesUsed === 0 || r.gfPerMatch == null || r.gaPerMatch == null) {
      // No GF/GA data for this team (Phase 1 zero-match fallback) -
      // attack/defense collapse to overall regardless of kappa, same as
      // buildEloSplit.js's own zero-match handling.
      ratings[name] = { attack: r.overall, defense: r.overall };
      continue;
    }
    const gfSafe = Math.max(r.gfPerMatch, 0.1);
    const gaSafe = Math.max(r.gaPerMatch, 0.1);
    const shrink = r.shrinkFactor != null ? r.shrinkFactor : 1;
    const attackDelta = shrink * kappa * Math.log(gfSafe / gfBaseline);
    const defenseDelta = shrink * kappa * Math.log(gaSafe / gaBaseline);
    ratings[name] = {
      attack: r.overall + attackDelta,
      defense: r.overall - defenseDelta,
    };
  }
  return ratings;
}

// --- Replay every played match chronologically, building observations ---
//
// Each observation: { mu, k, isHome } for both the home and away goal
// count of every match, evaluated against PRE-MATCH attack/defense state.
// Mutates a running ratings map exactly like updateEloSplit.js, but here
// the ratings update uses a fixed kGoals (kept at the existing Phase 2
// placeholder - NOT re-fit in this pass, see header caveat) so that
// changing alpha/gamma/sigma/kappa during the search doesn't also require
// re-deriving a self-consistent kGoals at every candidate value, which
// would make the search far slower and isn't necessary: kGoals only
// affects how much each match's update moves ratings, not the
// expected-goals formula being fit here.
const K_GOALS_FOR_REPLAY = 12; // matches updateEloSplit.js's current placeholder

function buildObservations(rawBaselineRatings, gfBaseline, gaBaseline, playedMatches, params) {
  const rederived = rederiveBaselineRatings(rawBaselineRatings, gfBaseline, gaBaseline, params.kappa);
  const ratingsByTeam = new Map();
  for (const [name, r] of Object.entries(rederived)) {
    ratingsByTeam.set(name, { attack: r.attack, defense: r.defense });
  }

  const observations = [];
  for (const m of playedMatches) {
    const home = ratingsByTeam.get(m.home);
    const away = ratingsByTeam.get(m.away);
    if (!home || !away) continue; // unknown team name - skip, don't crash the whole fit

    const homeIsHost = HOST_NATIONS.has(m.home);
    const awayIsHost = HOST_NATIONS.has(m.away);

    const muHome = expectedGoals(home.attack, away.defense, homeIsHost, params);
    const muAway = expectedGoals(away.attack, home.defense, awayIsHost, params);

    observations.push({ mu: muHome, k: m.homeGoals });
    observations.push({ mu: muAway, k: m.awayGoals });

    // Apply this match's update before processing the next (chronological,
    // matches updateEloSplit.js's own logic) so later matches are
    // evaluated against ratings that reflect everything played so far.
    const homeAttackDelta = K_GOALS_FOR_REPLAY * (m.homeGoals - muHome);
    const homeDefenseDelta = K_GOALS_FOR_REPLAY * (muAway - m.awayGoals);
    const awayAttackDelta = K_GOALS_FOR_REPLAY * (m.awayGoals - muAway);
    const awayDefenseDelta = K_GOALS_FOR_REPLAY * (muHome - m.homeGoals);
    home.attack += homeAttackDelta;
    home.defense += homeDefenseDelta;
    away.attack += awayAttackDelta;
    away.defense += awayDefenseDelta;
  }
  return observations;
}

function totalLogLikelihood(rawBaselineRatings, gfBaseline, gaBaseline, playedMatches, params) {
  const observations = buildObservations(rawBaselineRatings, gfBaseline, gaBaseline, playedMatches, params);
  let total = 0;
  for (const obs of observations) {
    total += negBinLogPmf(obs.k, obs.mu, params.r);
  }
  return total;
}

// --- Split-aware observation builder, for out-of-sample validation --------
//
// Same replay logic as buildObservations, but takes the FULL chronological
// match list plus a trainCutoffIndex, and tags each observation with
// isTrain. This is essential for a correct out-of-sample evaluation: a
// test-set match still needs its PRE-MATCH rating to reflect everything
// that happened before it chronologically (including training-set
// matches) - simply calling buildObservations on the test slice alone
// would evaluate test matches against baseline (pre-tournament) ratings,
// not against ratings updated through the end of the training period,
// which would understate how much the model actually knows by that point.
// So this always replays the FULL sequence in order, and only the
// observation tagging (not the replay itself) differs between train/test.
function buildSplitObservations(rawBaselineRatings, gfBaseline, gaBaseline, allPlayedMatches, trainCutoffIndex, params) {
  const rederived = rederiveBaselineRatings(rawBaselineRatings, gfBaseline, gaBaseline, params.kappa);
  const ratingsByTeam = new Map();
  for (const [name, r] of Object.entries(rederived)) {
    ratingsByTeam.set(name, { attack: r.attack, defense: r.defense });
  }

  const observations = [];
  for (let i = 0; i < allPlayedMatches.length; i++) {
    const m = allPlayedMatches[i];
    const home = ratingsByTeam.get(m.home);
    const away = ratingsByTeam.get(m.away);
    if (!home || !away) continue;

    const homeIsHost = HOST_NATIONS.has(m.home);
    const awayIsHost = HOST_NATIONS.has(m.away);

    const muHome = expectedGoals(home.attack, away.defense, homeIsHost, params);
    const muAway = expectedGoals(away.attack, home.defense, awayIsHost, params);

    const isTrain = i < trainCutoffIndex;
    observations.push({ mu: muHome, k: m.homeGoals, isTrain });
    observations.push({ mu: muAway, k: m.awayGoals, isTrain });

    const homeAttackDelta = K_GOALS_FOR_REPLAY * (m.homeGoals - muHome);
    const homeDefenseDelta = K_GOALS_FOR_REPLAY * (muAway - m.awayGoals);
    const awayAttackDelta = K_GOALS_FOR_REPLAY * (m.awayGoals - muAway);
    const awayDefenseDelta = K_GOALS_FOR_REPLAY * (muHome - m.homeGoals);
    home.attack += homeAttackDelta;
    home.defense += homeDefenseDelta;
    away.attack += awayAttackDelta;
    away.defense += awayDefenseDelta;
  }
  return observations;
}

// Total log-likelihood restricted to either the train or test portion of a
// split-aware observation set.
function splitLogLikelihood(observations, onlyTrain, params) {
  let total = 0;
  let count = 0;
  for (const obs of observations) {
    if (obs.isTrain !== onlyTrain) continue;
    total += negBinLogPmf(obs.k, obs.mu, params.r);
    count++;
  }
  return { total, count };
}

// Fits the model using ONLY the training portion's log-likelihood as the
// optimization objective (test observations are computed via the same
// replay but never influence which params are chosen) - this is what makes
// the resulting test-set score genuinely out-of-sample.
function gridRefineSearchTrainOnly(rawBaselineRatings, gfBaseline, gaBaseline, allPlayedMatches, trainCutoffIndex, initialParams, bounds, rounds) {
  let params = { ...initialParams };
  const log = [];

  function trainLL(p) {
    const obs = buildSplitObservations(rawBaselineRatings, gfBaseline, gaBaseline, allPlayedMatches, trainCutoffIndex, p);
    return splitLogLikelihood(obs, true, p).total;
  }

  for (let round = 0; round < rounds; round++) {
    for (const key of Object.keys(bounds)) {
      const [lo, hi] = bounds[key];
      const steps = 12;
      let bestVal = params[key];
      let bestLL = trainLL(params);

      const span = (hi - lo) / Math.pow(2, round);
      const center = params[key];
      const rangeLo = Math.max(lo, center - span / 2);
      const rangeHi = Math.min(hi, center + span / 2);

      for (let i = 0; i <= steps; i++) {
        const candidate = rangeLo + (rangeHi - rangeLo) * (i / steps);
        const testParams = { ...params, [key]: candidate };
        const ll = trainLL(testParams);
        if (ll > bestLL) {
          bestLL = ll;
          bestVal = candidate;
        }
      }
      params[key] = bestVal;
      log.push({ round, param: key, value: round2(bestVal), trainLogLikelihood: round2(bestLL) });
    }
  }

  return { params, log };
}

// --- Coordinate-wise grid-refine optimizer ---------------------------------

function gridRefineSearch(rawBaselineRatings, gfBaseline, gaBaseline, playedMatches, initialParams, bounds, rounds) {
  let params = { ...initialParams };
  const log = [];

  for (let round = 0; round < rounds; round++) {
    for (const key of Object.keys(bounds)) {
      const [lo, hi] = bounds[key];
      const steps = 12;
      let bestVal = params[key];
      let bestLL = totalLogLikelihood(rawBaselineRatings, gfBaseline, gaBaseline, playedMatches, params);

      // Narrow the search range each round: full bounds on round 0, then
      // progressively tighter around the current best.
      const span = (hi - lo) / Math.pow(2, round);
      const center = params[key];
      const rangeLo = Math.max(lo, center - span / 2);
      const rangeHi = Math.min(hi, center + span / 2);

      for (let i = 0; i <= steps; i++) {
        const candidate = rangeLo + (rangeHi - rangeLo) * (i / steps);
        const testParams = { ...params, [key]: candidate };
        const ll = totalLogLikelihood(rawBaselineRatings, gfBaseline, gaBaseline, playedMatches, testParams);
        if (ll > bestLL) {
          bestLL = ll;
          bestVal = candidate;
        }
      }
      params[key] = bestVal;
      log.push({ round, param: key, value: round2(bestVal), logLikelihood: round2(bestLL) });
    }
  }

  return { params, log };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// --- Main ------------------------------------------------------------------

function main() {
  console.log('Loading Phase 1 baseline (elo_baseline_split.json)...');
  const baseline = JSON.parse(fs.readFileSync(SPLIT_BASELINE_PATH, 'utf-8'));
  const baselineKappa = baseline.kappa;

  console.log('Loading results.json...');
  const allFixtures = JSON.parse(fs.readFileSync(RESULTS_PATH, 'utf-8')).results || [];
  const played = allFixtures
    .filter((r) => r.homeGoals != null && r.awayGoals != null)
    .map((r, i) => ({ ...r, _origIndex: i }))
    .sort((a, b) => {
      if (a.date && b.date) return a.date.localeCompare(b.date) || a._origIndex - b._origIndex;
      if (a.date && !b.date) return -1;
      if (!a.date && b.date) return 1;
      return a._origIndex - b._origIndex;
    });
  console.log(`  ${played.length} played result(s), ${played.length * 2} goal observations`);

  if (played.length < 20) {
    console.log(`  WARNING: small sample (${played.length} matches) for a 5-parameter joint fit. Treat output as a rough first pass.`);
  }

  // Starting point: existing placeholder constants from Phase 1/2.
  const initialParams = {
    alpha: Math.log(1.3),
    gamma: 0.15,
    sigma: 250,
    kappa: baselineKappa,
    r: 8, // moderate starting dispersion guess; Poisson limit is r -> infinity
  };

  // Search bounds, chosen to bracket plausible football values without
  // being so wide the grid search wastes steps on implausible regions.
  // sigma/gamma widened from an initial pass that pinned both at their
  // original upper bound (500 / 0.4) - that's a signal the bound was too
  // narrow, not that those edge values were the genuine optimum, so the
  // range needed to actually extend past where the first fit landed.
  const bounds = {
    alpha: [Math.log(0.6), Math.log(2.5)],
    gamma: [0, 0.8],
    sigma: [100, 900],
    kappa: [40, 250],
    r: [1, 40],
  };

  console.log('\nRunning coordinate-wise grid-refine search (6 rounds x 5 parameters)...');
  const { params: fitted, log } = gridRefineSearch(
    baseline.ratings, baseline.gfBaseline, baseline.gaBaseline, played, initialParams, bounds, 6
  );
  for (const entry of log) {
    console.log(`  round ${entry.round}  ${entry.param.padEnd(6)} -> ${entry.value}  (logL=${entry.logLikelihood})`);
  }

  const finalLogLikelihood = round2(totalLogLikelihood(baseline.ratings, baseline.gfBaseline, baseline.gaBaseline, played, fitted));
  const placeholderLogLikelihood = round2(totalLogLikelihood(baseline.ratings, baseline.gfBaseline, baseline.gaBaseline, played, initialParams));

  // Flag if any fitted parameter landed exactly on a search bound - a sign
  // the bound is still too narrow and the true optimum may lie beyond it.
  // IMPORTANT DISTINCTION from a genuinely under-bounded search: with only
  // ~36 matches, kappa and r in particular have been observed to keep
  // climbing toward whatever upper bound is set, with only marginal
  // log-likelihood improvement each time the bound is widened (e.g. kappa
  // 120->225->250 and r climbing toward the Poisson limit across rounds in
  // testing) - this is the small-sample overfitting risk flagged in the
  // header, not a sign the bound is simply wrong. Indefinitely widening
  // bounds and re-running chases noise, not signal. Rather than keep
  // expanding the search space, this is reported explicitly so a person
  // can make the actual judgment call (anchor kappa near Phase 1's
  // much-better-supported historical estimate instead of letting 36
  // matches override it; treat r's drift toward the Poisson limit as
  // genuine evidence the in-tournament sample doesn't yet show strong
  // overdispersion, not as "r should be unbounded").
  const pinnedParams = Object.entries(bounds)
    .filter(([key, [lo, hi]]) => Math.abs(fitted[key] - lo) < 1e-6 || Math.abs(fitted[key] - hi) < 1e-6)
    .map(([key]) => key);
  if (pinnedParams.length > 0) {
    console.log(`\n  WARNING: ${pinnedParams.join(', ')} landed exactly on a search bound.`);
    console.log('  With this sample size (' + played.length + ' matches), this is more likely small-sample');
    console.log('  overfitting than a genuinely under-bounded search - widening the bound further and');
    console.log('  re-running will likely just push the same parameter to the new bound again. Recommended:');
    console.log('  treat the OTHER fitted parameters as the useful output of this run, and for any pinned');
    console.log('  parameter, prefer a more conservative/anchored value over chasing the unconstrained MLE');
    console.log('  (e.g. kappa: anchor near Phase 1 historical-data estimate rather than this run value).');
  }

  // recommendedParams applies a conservative judgment call on top of the
  // raw fit - this is the set intended for actual use by a later phase,
  // NOT fittedParams directly.
  // kappa: if pinned at a search bound, fall back to Phase 1's baseline
  // kappa (anchored by a much larger historical sample) rather than the
  // unconstrained in-tournament-only estimate.
  // r: if the in-sample fit lands above R_OVERFIT_THRESHOLD (close to the
  // Poisson limit), fall back to R_VALIDATED_FALLBACK - NOT because it's
  // pinned at a search bound (the search bound is 60, well above this
  // threshold), but because out-of-sample validation specifically showed
  // values in-sample fits converge toward (30-40+) predict held-out
  // matches WORSE than r=12 does - see the R_VALIDATED_FALLBACK comment
  // above for the validation evidence. This is a different trigger
  // condition from kappa's (validation evidence vs bound-pinning) so it's
  // tracked separately, not folded into pinnedParams.
  const recommendedParams = { ...fitted };
  const overriddenParams = [];
  if (pinnedParams.includes('kappa')) {
    recommendedParams.kappa = baselineKappa;
    overriddenParams.push('kappa');
  }
  if (fitted.r > R_OVERFIT_THRESHOLD) {
    recommendedParams.r = R_VALIDATED_FALLBACK;
    overriddenParams.push('r');
  }
  const recommendedNote = overriddenParams.length > 0
    ? `${overriddenParams.join(', ')} replaced with conservative/validated values - see console warnings above for which and why (kappa: pinned-at-bound fallback to Phase 1's historical estimate; r: out-of-sample-validated fallback to R_VALIDATED_FALLBACK=${R_VALIDATED_FALLBACK}, see validateNegBin.js).`
    : 'No parameters were overridden - fittedParams and recommendedParams are identical.';

  console.log('\n--- Fitted constants ---');
  console.log(`  alpha = ${round2(fitted.alpha)}  (exp(alpha) = ${round2(Math.exp(fitted.alpha))} goals/match baseline)`);
  console.log(`  gamma = ${round2(fitted.gamma)}`);
  console.log(`  sigma = ${round2(fitted.sigma)}`);
  console.log(`  kappa = ${round2(fitted.kappa)}  (Phase 1 baseline kappa was ${baselineKappa} - see header caveat on small-sample re-fitting)`);
  console.log(`  r     = ${round2(fitted.r)}  (Poisson limit is r -> infinity; lower r = more overdispersion)`);
  if (fitted.r > R_OVERFIT_THRESHOLD) {
    console.log(`  Note: r is large (closer to the Poisson limit) - out-of-sample validation (validateNegBin.js)`);
    console.log(`  showed this in-sample fit predicts held-out matches WORSE than r=${R_VALIDATED_FALLBACK} does (see`);
    console.log(`  R_VALIDATED_FALLBACK comment). recommendedParams.r is set to ${R_VALIDATED_FALLBACK} accordingly -`);
    console.log(`  re-run validateNegBin.js as more matchdays are played to check this is still the best fallback.`);
  }
  console.log(`\n  Log-likelihood: fitted=${finalLogLikelihood} vs placeholder=${placeholderLogLikelihood} (higher is better fit)`);

  const output = {
    generatedAt: new Date().toISOString(),
    matchCount: played.length,
    observationCount: played.length * 2,
    sampleSizeWarning: played.length < 20
      ? 'Small sample for a 5-parameter joint fit - treat as a rough first pass, re-run as more matches are played.'
      : null,
    pinnedAtBound: pinnedParams.length > 0 ? pinnedParams : null,
    overriddenParams: overriddenParams.length > 0 ? overriddenParams : null,
    initialParams: {
      alpha: round2(initialParams.alpha), gamma: initialParams.gamma,
      sigma: initialParams.sigma, kappa: initialParams.kappa, r: initialParams.r,
    },
    fittedParams: {
      alpha: round2(fitted.alpha), gamma: round2(fitted.gamma),
      sigma: round2(fitted.sigma), kappa: round2(fitted.kappa), r: round2(fitted.r),
    },
    recommendedParams: {
      alpha: round2(recommendedParams.alpha), gamma: round2(recommendedParams.gamma),
      sigma: round2(recommendedParams.sigma), kappa: round2(recommendedParams.kappa), r: round2(recommendedParams.r),
    },
    recommendedNote,
    logLikelihood: { fitted: finalLogLikelihood, placeholder: placeholderLogLikelihood },
    optimizationLog: log,
    note: 'Output is additive - does not modify elo_baseline_split.json, elo_current_split.json, or any constant currently in use by buildEloSplit.js/updateEloSplit.js. A later phase must deliberately wire these fitted values in.',
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
  console.log(`\nWritten: ${OUTPUT_PATH}`);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error('Fatal error:', err.message);
    process.exitCode = 1;
  }
}

module.exports = {
  negBinLogPmf, expectedGoals, rederiveBaselineRatings, buildObservations,
  totalLogLikelihood, gridRefineSearch, logGamma,
  buildSplitObservations, splitLogLikelihood, gridRefineSearchTrainOnly,
};
