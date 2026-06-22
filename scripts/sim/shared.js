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

module.exports = { mulberry32, buildNameToCode, cleanTeam, cleanMatch };
