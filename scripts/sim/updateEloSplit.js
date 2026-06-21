// updateEloSplit.js
//
// PHASE 2 (in-tournament update methodology) of the dual-Elo project.
//
// Takes the Phase 1 baseline (elo_baseline_split.json - pre-tournament
// ELOa/ELOd) and applies every PLAYED result from results.json, producing
// CURRENT ELOa/ELOd ratings that reflect in-tournament form. This is the
// attack/defense analogue of what eloBaseline.js already does for the
// single overall Elo (frozen baseline + results.json, applied
// deterministically in date order) - same pattern, split in two.
//
// STANDALONE and ADDITIVE, same as buildEloSplit.js:
//   - Does not modify elo_baseline.json, elo_baseline_split.json,
//     eloUpdate.js, groupStage.js, or anything currently driving the live
//     site.
//   - Reads elo_baseline_split.json (Phase 1 output) and results.json.
//   - Writes a NEW file, elo_current_split.json.
//
// Run with: node updateEloSplit.js
//
// --- WHY THIS IS A DIFFERENT UPDATE MECHANISM FROM eloUpdate.js ---
//
// The existing single-Elo update (applyResultToElo in eloUpdate.js) moves a
// team's rating based on MATCH OUTCOME vs expectation: W (1/0.5/0 for
// win/draw/loss) compared to We (expected result from the pre-match Elo
// gap), scaled by a goal-difference weight step function. A 1-0 win and a
// 4-0 win differ only by that step function (1.0 vs ~1.875), not by the
// actual goals themselves - there's no channel in that formula for "this
// was specifically a stingy defensive performance" or "this was a stingy
// attacking one."
//
// Attack and defense need their OWN signals, each tied to what that
// dimension actually claims to measure:
//   attackDelta(team)  = K_GOALS * (actualGoalsFor    - expectedGoalsFor)
//   defenseDelta(team) = K_GOALS * (expectedGoalsAgainst - actualGoalsAgainst)
//
// A team that wins 1-0 against a side it was expected to beat 3-0 gets a
// NEGATIVE attackDelta (scored fewer than expected) but a POSITIVE
// defenseDelta (conceded fewer than expected, in fact zero) - exactly the
// asymmetric movement that a result like Scotland 1-0 Haiti should produce,
// and which the existing single-Elo update has no way to express (it would
// just record a win and move the single rating up by the standard step,
// with no distinction between "professional 1-0" and "barely scraped past
// a side we were expected to thrash").
//
// --- WHY INDEPENDENT, NOT ZERO-SUM ---
//
// Direct instruction for this phase: attack and defense updates are
// INDEPENDENT, not zero-sum. The existing eloUpdate.js is strictly zero-sum
// (home.elo += delta; away.elo -= delta - the exact same number, opposite
// sign). That convention doesn't carry over cleanly to a split rating:
// Scotland's attack-delta from beating Haiti has no principled reason to be
// exactly equal-and-opposite to Haiti's defense-delta from the same match,
// because they're driven by comparison to that TEAM's own expected-goals
// figure (which differs for each side), not a shared single expectation.
// Each of the four deltas in a match (home attack, home defense, away
// attack, away defense) is computed independently from that side's own
// goals vs that side's own expectation.
//
// --- EXPECTED GOALS: PLACEHOLDER FORMULA, NOT YET FITTED ---
//
// Per direct instruction, this phase uses a SIMPLE PLACEHOLDER expected-
// goals formula now (the paper's Section 4.1 log-linear mapping, evaluated
// against CURRENT ELOa/ELOd as the match is processed), rather than
// waiting for Phase 3's full Negative Binomial engine. ALPHA, GAMMA, and
// SIGMA below are placeholder constants - like KAPPA_PLACEHOLDER in
// buildEloSplit.js, they have NOT been fitted by regression against real
// data (see Section 5 of elo-negbin-revised.md for the proper calibration
// procedure). Treat every number this script produces as provisional until
// those constants are fitted.

const fs = require('fs');
const path = require('path');

const SPLIT_BASELINE_PATH = path.join(__dirname, '..', '..', 'elo_baseline_split.json');
const RESULTS_PATH = path.join(__dirname, '..', '..', 'results.json');
const OUTPUT_PATH = path.join(__dirname, '..', '..', 'elo_current_split.json');

// --- Placeholder expected-goals formula constants ---------------------
//
// ln(mu_home) = ALPHA + GAMMA*H + (eloAttack(home) - eloDefense(away)) / SIGMA
// ln(mu_away) = ALPHA +           (eloAttack(away) - eloDefense(home)) / SIGMA
//
// ALPHA: baseline log-goal-rate. exp(ALPHA) ~ 1.3 goals/match for a side
// with no attack/defense edge over its opponent at a neutral venue -
// roughly in line with the GF baseline computed during Phase 1 (visible in
// elo_baseline_split.json's gfBaseline field) but NOT derived from it
// programmatically here - that linkage is exactly the kind of thing
// Section 5's proper joint fit should do. Hand-picked starting point only.
const ALPHA_PLACEHOLDER = Math.log(1.3);

// GAMMA: home-advantage term in log-goal-space, applied only when H=1 (the
// match is at a true home venue for a host nation - see HOST_NATIONS /
// neutralVenue handling below, mirroring the existing eloModel.js
// convention). Small placeholder bump, not fitted.
const GAMMA_PLACEHOLDER = 0.15;

// SIGMA: scale converting an Elo-point gap into log-goal-rate units. Larger
// SIGMA = a given Elo gap moves expected goals less. Placeholder chosen so
// that a ~200-point attack/defense gap (a fairly large gap by this
// project's Elo scale) moves expected goals by a noticeable but not
// extreme amount - NOT fitted against real data.
const SIGMA_PLACEHOLDER = 250;

// K_GOALS: scales how many Elo points a single goal of over/under-
// performance (actual vs expected) moves attack/defense by. Placeholder,
// deliberately modest relative to the existing WORLD_CUP_K=60 single-Elo
// step, since this update fires on EVERY match (no goal-difference
// weighting step function) and should not whipsaw a team's split rating on
// a single fixture. Sized by checking two cases by hand: an evenly-matched
// narrow win (TeamA beats TeamB 2-1 at equal ratings) should move ratings
// by roughly the same scale as the existing eloUpdate.js's typical
// per-match step (~10-30 points); a heavily lopsided mismatch (Scotland
// 1-0 Haiti) should produce a clearly bigger swing than that, but not one
// that consumes most of a team's entire pre-tournament attack/defense
// spread in a single match. NOT fitted against real data (Section 5).
const K_GOALS_PLACEHOLDER = 12;

const HOST_NATIONS = new Set(['USA', 'Canada', 'Mexico']);

function expectedGoals(attackElo, defenseElo, isHomeAdvantage) {
  // The raw (attackElo - defenseElo) / SIGMA term grows unboundedly with
  // the Elo gap, and because it sits inside exp(), an extreme mismatch
  // (e.g. Scotland vs Haiti, a ~400+ point gap) can push expected goals
  // into implausible territory (8-10+ goals) for a single match - no real
  // World Cup match should have an expected-goals figure that high, and
  // K_GOALS_PLACEHOLDER was sized assuming expected goals stays in a sane
  // few-goals range. Capping the gap term at +/-1.5 (an already-large
  // log-goal-rate swing) keeps expected goals bounded at roughly
  // exp(ALPHA + GAMMA + 1.5) =~ 6.5 goals even for the most lopsided
  // realistic matchup, rather than letting it grow without limit. This is
  // a stopgap for Phase 2's placeholder formula, not a substitute for
  // properly fitting ALPHA/GAMMA/SIGMA against real data (Section 5).
  const rawGapTerm = (attackElo - defenseElo) / SIGMA_PLACEHOLDER;
  const cappedGapTerm = Math.max(-1.5, Math.min(1.5, rawGapTerm));
  const logMu = ALPHA_PLACEHOLDER
    + (isHomeAdvantage ? GAMMA_PLACEHOLDER : 0)
    + cappedGapTerm;
  return Math.exp(logMu);
}

// --- Loading inputs ---------------------------------------------------

function loadSplitBaseline() {
  if (!fs.existsSync(SPLIT_BASELINE_PATH)) {
    throw new Error(
      `elo_baseline_split.json not found at ${SPLIT_BASELINE_PATH} - run ` +
      `scripts/sim/buildEloSplit.js (Phase 1) first.`
    );
  }
  return JSON.parse(fs.readFileSync(SPLIT_BASELINE_PATH, 'utf-8'));
}

function loadResults() {
  if (!fs.existsSync(RESULTS_PATH)) {
    throw new Error(`results.json not found at ${RESULTS_PATH}`);
  }
  const parsed = JSON.parse(fs.readFileSync(RESULTS_PATH, 'utf-8'));
  return parsed.results || [];
}

// --- Core update logic ---------------------------------------------------

// Applies a single played result to the running attack/defense ratings
// (mutates ratingsByTeam in place). Returns a per-match log entry for
// transparency/debugging (this is the piece that lets you see exactly why
// Scotland's numbers moved the way they did after Haiti, rather than just
// the before/after snapshot).
function applyResultToSplit(ratingsByTeam, result) {
  const { home, away, homeGoals, awayGoals } = result;
  const homeRating = ratingsByTeam.get(home);
  const awayRating = ratingsByTeam.get(away);
  if (!homeRating || !awayRating) {
    throw new Error(`updateEloSplit: unknown team(s) "${home}" / "${away}"`);
  }

  // Neutral-venue handling mirrors eloModel.js: home advantage only applies
  // if one side is an actual host nation, and only to that side.
  const homeIsHost = HOST_NATIONS.has(home);
  const awayIsHost = HOST_NATIONS.has(away);

  const expectedHomeGoals = expectedGoals(homeRating.attack, awayRating.defense, homeIsHost);
  const expectedAwayGoals = expectedGoals(awayRating.attack, homeRating.defense, awayIsHost);

  // Independent deltas - see header comment for why these are NOT zero-sum.
  const homeAttackDelta = K_GOALS_PLACEHOLDER * (homeGoals - expectedHomeGoals);
  const homeDefenseDelta = K_GOALS_PLACEHOLDER * (expectedAwayGoals - awayGoals);
  const awayAttackDelta = K_GOALS_PLACEHOLDER * (awayGoals - expectedAwayGoals);
  const awayDefenseDelta = K_GOALS_PLACEHOLDER * (expectedHomeGoals - homeGoals);

  homeRating.attack += homeAttackDelta;
  homeRating.defense += homeDefenseDelta;
  awayRating.attack += awayAttackDelta;
  awayRating.defense += awayDefenseDelta;

  return {
    home, away, homeGoals, awayGoals,
    expectedHomeGoals: round2(expectedHomeGoals),
    expectedAwayGoals: round2(expectedAwayGoals),
    homeAttackDelta: round2(homeAttackDelta),
    homeDefenseDelta: round2(homeDefenseDelta),
    awayAttackDelta: round2(awayAttackDelta),
    awayDefenseDelta: round2(awayDefenseDelta),
  };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// --- Main ------------------------------------------------------------------

function main() {
  console.log('Loading Phase 1 baseline (elo_baseline_split.json)...');
  const baseline = loadSplitBaseline();
  const teamNames = Object.keys(baseline.ratings);
  console.log(`  ${teamNames.length} teams loaded`);

  const ratingsByTeam = new Map();
  for (const [name, r] of Object.entries(baseline.ratings)) {
    if (r.attack == null || r.defense == null) {
      console.log(`  Note: ${name} has no attack/defense split (Phase 1 warning: "${r.warning || 'unknown'}") - using overall for both.`);
    }
    ratingsByTeam.set(name, {
      attack: r.attack != null ? r.attack : r.overall,
      defense: r.defense != null ? r.defense : r.overall,
      overall: r.overall,
    });
  }

  console.log('Loading results.json...');
  const allFixtures = loadResults();
  const played = allFixtures
    .filter((r) => r.homeGoals != null && r.awayGoals != null)
    .map((r, i) => ({ ...r, _origIndex: i }))
    .sort((a, b) => {
      if (a.date && b.date) return a.date.localeCompare(b.date) || a._origIndex - b._origIndex;
      if (a.date && !b.date) return -1;
      if (!a.date && b.date) return 1;
      return a._origIndex - b._origIndex;
    });
  console.log(`  ${played.length} played result(s) found, applying in date order`);

  const matchLog = [];
  for (const result of played) {
    const entry = applyResultToSplit(ratingsByTeam, result);
    matchLog.push(entry);
    console.log(
      `  ${entry.home} ${entry.homeGoals}-${entry.awayGoals} ${entry.away}  ` +
      `(expected ${entry.expectedHomeGoals}-${entry.expectedAwayGoals})  ` +
      `${entry.home} attack ${entry.homeAttackDelta >= 0 ? '+' : ''}${entry.homeAttackDelta}, defense ${entry.homeDefenseDelta >= 0 ? '+' : ''}${entry.homeDefenseDelta}  ` +
      `${entry.away} attack ${entry.awayAttackDelta >= 0 ? '+' : ''}${entry.awayAttackDelta}, defense ${entry.awayDefenseDelta >= 0 ? '+' : ''}${entry.awayDefenseDelta}`
    );
  }

  const ratingsOut = {};
  for (const [name, r] of ratingsByTeam.entries()) {
    ratingsOut[name] = {
      overall: r.overall,
      attack: round2(r.attack),
      defense: round2(r.defense),
    };
  }

  const output = {
    generatedAt: new Date().toISOString(),
    baselineSource: baseline.source,
    baselineGeneratedAt: baseline.generatedAt,
    resultsApplied: played.length,
    constants: {
      alpha: ALPHA_PLACEHOLDER,
      gamma: GAMMA_PLACEHOLDER,
      sigma: SIGMA_PLACEHOLDER,
      kGoals: K_GOALS_PLACEHOLDER,
      status: 'PLACEHOLDER - not yet fitted by regression, see Section 5 of elo-negbin-revised.md',
    },
    ratings: ratingsOut,
    matchLog,
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
  console.log(`\nWritten: ${OUTPUT_PATH}`);
  console.log('This file is NEW and ADDITIVE - nothing currently reads it.');
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
  expectedGoals,
  applyResultToSplit,
  ALPHA_PLACEHOLDER,
  GAMMA_PLACEHOLDER,
  SIGMA_PLACEHOLDER,
  K_GOALS_PLACEHOLDER,
};
