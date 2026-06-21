// groupStageNegBin.js
//
// PHASE 3b (simulation engine) of the dual-Elo Negative Binomial project.
//
// A Negative Binomial alternative to groupStage.js's simulateGroup, using
// each team's ELOa/ELOd (attack/defense, current in-tournament values from
// elo_current_split.json) and the calibrated constants from
// negbin_calibration.json, rather than groupStage.js's single-Elo
// win-probability-then-forced-Poisson approach.
//
// DELIBERATELY MIRRORS groupStage.js's simulateGroup() SIGNATURE AND RETURN
// SHAPE EXACTLY (same { name, points, gf, ga, gd, wins, draws, losses }
// standings array, same tiebreak order, same knownResults/groupLetter
// options) so this can be driven by the SAME calling code
// (simulateTournament.js's loop, mostLikely.js's modalGroupOrdering) just
// by swapping which simulateGroup implementation is imported - making a
// like-for-like comparison between the two models straightforward rather
// than requiring two different downstream pipelines.
//
// STANDALONE and ADDITIVE: does not modify groupStage.js, simulateTournament.js,
// or anything currently driving the live site. A separate driver script
// (runNegBinComparison.js) uses this to produce comparison output.
//
// --- WHAT'S DIFFERENT FROM groupStage.js, STRUCTURALLY ---
//
// groupStage.js decides the match OUTCOME first (via matchProbabilities on
// the single overall Elo), then samples Poisson goals scaled to fit that
// already-decided outcome (see groupStage.js's own header comment on this
// being a deliberate simplification for tiebreak purposes). Goals there are
// a downstream correction, not the primary stochastic event.
//
// Here, goals ARE the primary event: each side's goal count is sampled
// directly from a Negative Binomial distribution parameterized by that
// side's expected goals (from the ELOa/ELOd gap, per the calibrated
// alpha/gamma/sigma) and the calibrated dispersion r - the match outcome
// (win/draw/loss) then falls out of the sampled scoreline, not the other
// way around. This is the actual mechanism by which this model can
// produce results the current one structurally cannot (e.g. a result
// where the side with lower implied win probability still produces the
// higher goal tally in a given draw) - see Section 4 of
// elo-negbin-revised.md.
//
// --- CONSTANTS: READ FROM negbin_calibration.json, WITH FALLBACK ---
//
// Reads recommendedParams (not fittedParams) from negbin_calibration.json
// if present - see calibrateNegBin.js's own header on why recommendedParams
// (which falls back to Phase 1's anchored kappa when the raw fit is pinned
// at a search bound) is the one intended for actual use. Falls back to the
// same placeholder constants used by updateEloSplit.js if the calibration
// file isn't present, so this script can still run (with a clear warning)
// even before Phase 3a has been executed.

const fs = require('fs');
const path = require('path');
const { HOST_NATIONS, HOME_ADVANTAGE_SCHEDULE } = require('./tournament');
const { climateAdjustment, GROUP_VENUE } = require('./venues');
const { FIFA_RANK } = require('../fifaRankings');

const CALIBRATION_PATH = path.join(__dirname, '..', '..', 'negbin_calibration.json');

const FALLBACK_PARAMS = {
  alpha: Math.log(1.3),
  gamma: 0.15,
  sigma: 250,
  r: 8,
};

let cachedParams = null;
let cachedParamsSource = null;

function loadCalibratedParams() {
  if (cachedParams) return { params: cachedParams, source: cachedParamsSource };
  if (fs.existsSync(CALIBRATION_PATH)) {
    const data = JSON.parse(fs.readFileSync(CALIBRATION_PATH, 'utf-8'));
    cachedParams = {
      alpha: data.recommendedParams.alpha,
      gamma: data.recommendedParams.gamma,
      sigma: data.recommendedParams.sigma,
      r: data.recommendedParams.r,
    };
    cachedParamsSource = `negbin_calibration.json (fitted against ${data.matchCount} matches, generated ${data.generatedAt})`;
  } else {
    cachedParams = FALLBACK_PARAMS;
    cachedParamsSource = 'FALLBACK PLACEHOLDER constants - negbin_calibration.json not found. Run scripts/sim/calibrateNegBin.js (Phase 3a) first for a real fit.';
  }
  return { params: cachedParams, source: cachedParamsSource };
}

// --- Expected goals (same structural form as updateEloSplit.js / calibrateNegBin.js) ---

function expectedGoals(attackElo, defenseElo, homeAdvantageEloEquivalent, params) {
  const rawGapTerm = (attackElo - defenseElo) / params.sigma;
  const cappedGapTerm = Math.max(-1.5, Math.min(1.5, rawGapTerm));
  // homeAdvantageEloEquivalent folds in BOTH the host-nation boost (already
  // an Elo-point quantity via HOME_ADVANTAGE * multiplier, same convention
  // as eloModel.js) and the climate adjustment (also Elo-point-equivalent,
  // per venues.js). Converted to the same log-goal-rate units as gamma by
  // reusing sigma as the scale - this is a structural simplification
  // (gamma was calibrated only against the binary host/not-host signal in
  // calibrateNegBin.js, not against a continuous Elo-equivalent boost) and
  // is flagged here rather than silently assumed equivalent.
  const homeAdjTerm = homeAdvantageEloEquivalent !== 0
    ? params.gamma * (homeAdvantageEloEquivalent / 100) // 100 = HOME_ADVANTAGE's own base unit, so a full host boost contributes the full gamma term
    : 0;
  const logMu = params.alpha + homeAdjTerm + cappedGapTerm;
  return Math.exp(logMu);
}

// --- Negative Binomial sampling -------------------------------------------
//
// Samples from NegBin(mu, r) via the standard Gamma-Poisson mixture: draw
// lambda ~ Gamma(shape=r, scale=mu/r), then sample Poisson(lambda). This is
// the standard, numerically simple way to sample a NegBin in the
// mean/dispersion parameterization without needing a direct inverse-CDF
// method.
function sampleGamma(shape, scale, rand) {
  // Marsaglia-Tsang method, valid for shape >= 1 (true here since r is
  // always >= 1 per calibrateNegBin.js's search bounds). Standard,
  // well-known algorithm - not derived ad hoc.
  if (shape < 1) {
    // Boost trick for shape < 1 (not expected to be hit given r's bounds,
    // but included so this function doesn't silently misbehave if r is
    // ever fit below 1).
    const u = rand();
    return sampleGamma(shape + 1, scale, rand) * Math.pow(u, 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  while (true) {
    let x, v;
    do {
      // Box-Muller for a standard normal sample
      const u1 = rand() || 1e-12;
      const u2 = rand();
      x = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rand();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v * scale;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v * scale;
  }
}

function poissonSampleFromLambda(lambda, rand) {
  if (lambda <= 0) return 0;
  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= rand();
  } while (p > L);
  return k - 1;
}

function sampleNegativeBinomial(mu, r, rand) {
  const lambda = sampleGamma(r, mu / r, rand);
  return poissonSampleFromLambda(lambda, rand);
}

// --- Group simulation, mirroring groupStage.js's simulateGroup exactly ----
//
// teams: array of { name, elo, attack, defense } - attack/defense should
// come from elo_current_split.json (current in-tournament ELOa/ELOd); elo
// (overall) is kept for the FIFA-rank tiebreak fallback consistency with
// groupStage.js, NOT used in goal sampling itself.
function simulateGroup(teams, hostTeam, rand, options = {}) {
  const { knownResults = [], groupLetter = null } = options;
  const { params, source } = loadCalibratedParams();

  const stats = {};
  for (const t of teams) {
    stats[t.name] = { name: t.name, elo: t.elo, points: 0, gf: 0, ga: 0, gd: 0, wins: 0, draws: 0, losses: 0 };
  }

  const knownByFixture = new Map();
  for (const r of knownResults) {
    knownByFixture.set([r.home, r.away].sort().join('|'), r);
  }

  // Host-advantage tapering logic copied from groupStage.js unchanged (same
  // rationale, same approximation for unplayed-fixture ordering - see that
  // file's own comment for full detail).
  let hostRemainingMultiplier = 1;
  const hostTeamObj = teams.find((t) => HOST_NATIONS.has(t.name));
  if (hostTeamObj) {
    let played = 0;
    for (const t of teams) {
      if (t.name === hostTeamObj.name) continue;
      if (knownByFixture.has([hostTeamObj.name, t.name].sort().join('|'))) played++;
    }
    const remaining = HOME_ADVANTAGE_SCHEDULE.slice(played);
    if (remaining.length > 0) {
      hostRemainingMultiplier = remaining.reduce((a, b) => a + b, 0) / remaining.length;
    }
  }

  const venueName = groupLetter ? GROUP_VENUE[groupLetter] : null;

  for (let i = 0; i < teams.length; i++) {
    for (let j = i + 1; j < teams.length; j++) {
      const home = teams[i];
      const away = teams[j];

      const known = knownByFixture.get([home.name, away.name].sort().join('|'));
      if (known) {
        let scoreA, scoreB;
        if (known.home === home.name) {
          scoreA = known.homeGoals; scoreB = known.awayGoals;
        } else {
          scoreA = known.awayGoals; scoreB = known.homeGoals;
        }
        const resultForA = scoreA > scoreB ? 'home' : scoreA < scoreB ? 'away' : 'draw';
        applyResult(stats[home.name], stats[away.name], scoreA, scoreB, resultForA);
        continue;
      }

      const neutralVenue = !(HOST_NATIONS.has(home.name) || HOST_NATIONS.has(away.name));
      let effHome = home, effAway = away, swapped = false;
      if (!neutralVenue && HOST_NATIONS.has(away.name) && !HOST_NATIONS.has(home.name)) {
        effHome = away; effAway = home; swapped = true;
      }

      let climateAdj = 0;
      if (venueName) {
        climateAdj = climateAdjustment(effHome.name, venueName) - climateAdjustment(effAway.name, venueName);
      }

      const homeAdvantageElo = neutralVenue ? 0 : 100 * hostRemainingMultiplier; // 100 = HOME_ADVANTAGE base unit, same convention as eloModel.js
      const homeAdj = homeAdvantageElo + climateAdj;
      const awayAdj = -climateAdj; // climate is symmetric (home's edge is away's disadvantage); home-advantage itself is one-sided

      const muHome = expectedGoals(effHome.attack, effAway.defense, homeAdj, params);
      const muAway = expectedGoals(effAway.attack, effHome.defense, awayAdj, params);

      const gHomeRaw = sampleNegativeBinomial(muHome, params.r, rand);
      const gAwayRaw = sampleNegativeBinomial(muAway, params.r, rand);

      const [scoreA, scoreB] = swapped ? [gAwayRaw, gHomeRaw] : [gHomeRaw, gAwayRaw];
      const resultForA = scoreA > scoreB ? 'home' : scoreA < scoreB ? 'away' : 'draw';

      applyResult(stats[home.name], stats[away.name], scoreA, scoreB, resultForA);
    }
  }

  for (const s of Object.values(stats)) s.gd = s.gf - s.ga;

  const standings = Object.values(stats);
  standings.sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    if (b.gd !== a.gd) return b.gd - a.gd;
    if (b.gf !== a.gf) return b.gf - a.gf;
    const rankA = FIFA_RANK[a.name] != null ? FIFA_RANK[a.name] : Infinity;
    const rankB = FIFA_RANK[b.name] != null ? FIFA_RANK[b.name] : Infinity;
    return rankA - rankB;
  });

  return standings;
}

function applyResult(homeStats, awayStats, gHome, gAway, resultForHome) {
  homeStats.gf += gHome;
  homeStats.ga += gAway;
  awayStats.gf += gAway;
  awayStats.ga += gHome;

  if (resultForHome === 'home') {
    homeStats.points += 3; homeStats.wins += 1;
    awayStats.losses += 1;
  } else if (resultForHome === 'away') {
    awayStats.points += 3; awayStats.wins += 1;
    homeStats.losses += 1;
  } else {
    homeStats.points += 1; awayStats.points += 1;
    homeStats.draws += 1; awayStats.draws += 1;
  }
}

module.exports = {
  simulateGroup, expectedGoals, sampleNegativeBinomial, sampleGamma,
  poissonSampleFromLambda, loadCalibratedParams,
};
