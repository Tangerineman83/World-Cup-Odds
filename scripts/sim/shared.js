// shared.js
//
// Shared utilities for scripts/sim/, consolidating logic that was
// previously duplicated identically across multiple files (found during a
// full-project code review). Each function here was verified
// byte-for-byte identical across its previous copies before being moved
// here - this file doesn't change any behavior, only removes duplication.
//
// Used by both the existing engine (runSimulation.js, runScenario.js,
// mostLikely.js) and the NegBin engine (runSimulationNegBin.js,
// runScenarioNegBin.js, mostLikelyNegBin.js) - genuinely engine-agnostic,
// model-agnostic logic only. Do not add anything here that depends on
// which goal model is in use.

const { ELO_TO_NAME } = require('../countryMap');

// Simple, fast, deterministic-per-seed PRNG. Previously duplicated
// identically in mostLikely.js, mostLikelyNegBin.js, runSimulation.js, and
// runSimulationNegBin.js.
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Builds a team-name -> flag/abbreviation-code lookup table from
// countryMap.js's ELO_TO_NAME (code -> name). Previously rebuilt
// independently and identically in runScenario.js, runScenarioNegBin.js,
// runSimulation.js, and runSimulationNegBin.js.
function buildNameToCode() {
  const nameToCode = {};
  for (const [code, name] of Object.entries(ELO_TO_NAME)) nameToCode[name] = code;
  return nameToCode;
}

// Strips a team object down to plain { name, code, elo } for JSON output,
// dropping any internal proxy fields (points/gd/gf used for third-place
// ranking). Optionally preserves `.group` (used for bestThirds, to show
// which group each qualifying third-place team came from). Engine-agnostic:
// only reads .name/.elo/.group, present on team objects from either engine.
// Previously duplicated identically in runScenario.js and
// runScenarioNegBin.js.
function cleanTeam(t, codeOf, { includeGroup = false } = {}) {
  if (!t) return null;
  const out = { name: t.name, code: codeOf[t.name] || null, elo: t.elo };
  if (includeGroup && t.group) out.group = t.group;
  return out;
}

// Strips a knockout match object down to plain JSON output shape. Engine-
// agnostic for the same reason as cleanTeam. Previously duplicated
// identically in runScenario.js and runScenarioNegBin.js.
function cleanMatch(m, codeOf) {
  return {
    id: m.id,
    home: cleanTeam(m.home, codeOf),
    away: cleanTeam(m.away, codeOf),
    winner: cleanTeam(m.winner, codeOf),
    pWin: m.pWin,
  };
}

// ---- Sankey builder functions -------------------------------------------
//
// These four functions build the data structures that drive the team
// detail popup's flow diagram (Sankey) on index.html/predictions.html.
// They operate purely on the outcomeHistograms Map (team -> bucket ->
// Map('points,gd' -> count)) built during the Monte Carlo simulation loop
// and are completely engine-agnostic - identical logic needed by both
// runSimulation.js (existing engine) and runSimulationNegBin.js (NegBin
// engine). Previously only existed in runSimulation.js; moved here so
// runSimulationNegBin.js can use them without duplication.
//
// All probabilities are unconditional (count / N_SIMULATIONS), i.e. a
// fraction of ALL simulations, not conditional on a given bucket. See
// runSimulation.js's own comments for the full rationale on each function.

const OUTCOME_BUCKETS = ['1st', '2nd', '3rd_qualified', '3rd_eliminated', '4th'];

// Maps simulation histogram bucket keys to the JS-friendly keys used in
// outcomeScenarios and in scenarioFlow.js's OUTCOME_BUCKETS[].key.
const BUCKET_KEY_MAP = {
  '1st': 'first',
  '2nd': 'second',
  '3rd_qualified': 'thirdQualified',
  '3rd_eliminated': 'thirdEliminated',
  '4th': 'fourth',
};

const SCENARIO_THRESHOLD = 0.01; // combos below 1% unconditional go into "Other"
const LABEL_THRESHOLD = 0.005;   // combos below 0.5% get no text label in the Sankey

function buildOutcomeScenarios(name, bucket, outcomeHistograms, N) {
  const hist = outcomeHistograms.get(name).get(bucket);
  const entries = [...hist.entries()]
    .map(([key, count]) => {
      const [points, gd] = key.split(',').map(Number);
      return { points, gd, pct: count / N };
    })
    .sort((a, b) => b.pct - a.pct);

  const shown = entries.filter((e) => e.pct > SCENARIO_THRESHOLD);
  const othersPct = entries.filter((e) => e.pct <= SCENARIO_THRESHOLD).reduce((sum, e) => sum + e.pct, 0);
  const scenarios = shown.map((e) => ({ points: e.points, gd: e.gd, pct: e.pct }));
  if (othersPct > 0) scenarios.push({ points: null, gd: null, pct: othersPct });
  return scenarios;
}

function buildPooledScenarios(name, outcomeHistograms, N) {
  const pooled = new Map();
  for (const bucket of OUTCOME_BUCKETS) {
    const mappedKey = BUCKET_KEY_MAP[bucket];
    const hist = outcomeHistograms.get(name).get(bucket);
    for (const [key, count] of hist.entries()) {
      if (!pooled.has(key)) {
        const [points, gd] = key.split(',').map(Number);
        pooled.set(key, { points, gd, byBucket: {} });
      }
      pooled.get(key).byBucket[mappedKey] = count / N;
    }
  }

  return [...pooled.values()]
    .map((e) => {
      const total = Object.values(e.byBucket).reduce((sum, p) => sum + p, 0);
      return { points: e.points, gd: e.gd, total, byBucket: e.byBucket, showLabel: total > LABEL_THRESHOLD };
    })
    .sort((a, b) => (b.points - a.points) || (b.gd - a.gd));
}

function buildPointsNodes(name, outcomeHistograms, N) {
  const byPoints = new Map();
  for (const bucket of OUTCOME_BUCKETS) {
    const hist = outcomeHistograms.get(name).get(bucket);
    for (const [key, count] of hist.entries()) {
      const [points, gd] = key.split(',').map(Number);
      if (!byPoints.has(points)) byPoints.set(points, { points, total: 0, byGd: new Map() });
      const node = byPoints.get(points);
      node.total += count;
      node.byGd.set(gd, (node.byGd.get(gd) || 0) + count);
    }
  }

  return [...byPoints.values()]
    .map((node) => ({
      points: node.points,
      total: node.total / N,
      byGd: Object.fromEntries(
        [...node.byGd.entries()].map(([gd, count]) => [String(gd), count / N])
      ),
    }))
    .sort((a, b) => b.points - a.points);
}

function buildThirdScenarios(name, outcomeHistograms, N) {
  const qualified = buildOutcomeScenarios(name, '3rd_qualified', outcomeHistograms, N);
  const eliminatedHist = outcomeHistograms.get(name).get('3rd_eliminated');
  const eliminatedTotal = [...eliminatedHist.values()].reduce((sum, c) => sum + c, 0) / N;
  const qualifiedTotal = qualified.reduce((sum, e) => sum + e.pct, 0);
  const pFinish3rd = qualifiedTotal + eliminatedTotal;
  if (pFinish3rd === 0) return [];
  return qualified.map((e) => ({ points: e.points, gd: e.gd, pct: e.pct / pFinish3rd }));
}

function buildOutcomeHistograms(allTeams) {
  const outcomeHistograms = new Map();
  for (const name of allTeams) {
    const byBucket = new Map();
    for (const bucket of OUTCOME_BUCKETS) byBucket.set(bucket, new Map());
    outcomeHistograms.set(name, byBucket);
  }
  return outcomeHistograms;
}

module.exports = {
  mulberry32, buildNameToCode, cleanTeam, cleanMatch,
  OUTCOME_BUCKETS, BUCKET_KEY_MAP, SCENARIO_THRESHOLD, LABEL_THRESHOLD,
  buildOutcomeHistograms, buildOutcomeScenarios, buildPooledScenarios,
  buildPointsNodes, buildThirdScenarios,
};
