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
const { HOME_ADVANTAGE_SCHEDULE, KNOCKOUT_HOME_ADVANTAGE_MULTIPLIER } = require('./tournament');

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
// performance (actual vs expected) moves attack/defense by.
//
// CALIBRATION RATIONALE:
// The baseline is built from 20 historical matches per team. Each
// tournament match should carry meaningful weight relative to that
// history. At K=16 with a ramp to full weight by match 3, a fully-
// weighted match moves ratings by at most 16*(actual-expected) points.
// With expected goals capped at 3.0, the maximum swing per match is
// ~16*3 = 48 points — but in practice expected goals are 1-2 and actual
// deltas are smaller, giving typical moves of 5-20 points per match.
// This means 3 tournament matches can shift a rating by at most ~60
// points, while the baseline represents 20 matches of evidence. That's
// a 3:20 ratio — too conservative for an event where in-tournament
// performance is the primary signal we want to track.
//
// Raised to 40: a fully-weighted match now moves ratings by up to ~120
// points (3*40), with typical moves of 10-40 points. Three matches can
// shift a rating by ~80-120 points, enough to reflect a team's genuine
// tournament performance and bring results like Ecuador's mixed group
// stage (W1 D1 L1) into meaningful contrast with Mexico's perfect
// group stage (W3 D0 L0). This preserves the baseline as a prior while
// giving the in-tournament sample real explanatory weight.
const K_GOALS_PLACEHOLDER = 40;

// --- Match-count-aware confidence ramp ----------------------------------
//
// PROBLEM THIS SOLVES: a flat K_GOALS applies the same per-goal weight to
// a team's 1st tournament match as its 5th. Testing found that any flat
// K_GOALS strong enough to meaningfully shift a team's rating after 2
// consistent results ALSO produces implausibly large single-match swings
// for teams with only 1 match played.
//
// FIX: each match's K_GOALS contribution is scaled by how many TOURNAMENT
// matches that specific team has played so far (including the current
// one), via min(1, x) confidence-shrinkage. Weight sequence:
//   - 1st match: 1/3 of K_GOALS_PLACEHOLDER
//   - 2nd match: 2/3
//   - 3rd match onward: full weight (1.0)
//
// NOTE: ramp starts at 1/3, NOT 0. A team's first tournament match
// carries real (if cautious) weight - setting it to zero meant e.g.
// Mexico's 2-0 win vs South Africa contributed nothing to their ratings,
// which is indefensible: a played result is always evidence.
const MATCH_COUNT_RAMP_FULL = 3;

function matchCountWeight(matchNumberForTeam) {
  // matchNumberForTeam is 1-indexed (1 = first match).
  // Returns 1/RAMP_FULL for match 1, rising linearly to 1.0 at RAMP_FULL.
  return Math.min(1, matchNumberForTeam / MATCH_COUNT_RAMP_FULL);
}

// --- Result-alignment taper on goal deltas ------------------------------
//
// PROBLEM: when a team performs exactly as expected (e.g. Mexico expected
// 2.54 vs Czechia, scores 3), the raw delta (3 - 2.54 = +0.46) gives a
// small attack boost. But when a strong team beats a very weak one by
// less than predicted (expected 5, actual 2), the raw delta (-3) gives a
// *penalty* — even though the team still won. This punishes strong teams
// for not running up huge scores against weak opponents.
//
// More broadly, goals that are "aligned" with the prediction (actual on
// the same side of zero as expected) carry less new information than
// surprise goals (actual opposite side). A team scoring 2 when expected
// 0.5 is much more informative than a team scoring 3 when expected 2.5.
//
// FIX: apply a taper to the raw goal delta. The taper works as follows:
//   delta_raw = actual - expected
//   aligned   = actual and expected are on the same side (both > 0 always,
//               so "aligned" means actual >= expected and expected > 1, or
//               actual <= expected and expected < 1) — effectively whether
//               the OVER/UNDER direction is the expected one.
//
// Simpler practical formulation: use Elo-implied goals as the reference
// and taper the delta proportionally — goals "within" the expectation
// get full credit; goals BEYOND the expectation in an already-predicted
// direction get a taper so the surplus counts at half weight.
//
// Concretely:
//   If actual > expected (scored more than expected):
//     delta = (expected - 0) * 1.0 + (actual - expected) * SURPLUS_WEIGHT
//   If actual < expected (scored less than expected):
//     delta = actual - expected  (full penalty, no taper — failing to score
//             when expected to is genuinely informative)
//   The net result: beating expectations upward is tapered; falling short
//   is not. This is intentionally asymmetric — a clean sheet when you
//   were expected to concede 2 is a clear signal; scoring 1 when expected
//   2 is also a clear signal; scoring 4 when expected 3 is only a weak
//   incremental signal.
//
// SURPLUS_WEIGHT: 0.5 means the surplus above expectation counts at half
// the per-goal rate. This preserves direction but prevents cascading
// boosts from large margins against weak opposition.
const SURPLUS_WEIGHT = 0.5;

function taperedGoalDelta(actual, expected, didWinThisDimension) {
  // actual:              goals the team scored (for attack) or opponent scored (for defence)
  // expected:            goals the model expected
  // didWinThisDimension: true when the actual result is "good" in this dimension
  //                      (attack: team actually scored more than opponent;
  //                       defence: opponent actually scored fewer than expected)
  //
  // RULE 1 — Taper upside surplus:
  //   When actual > expected, the excess above expectation counts at SURPLUS_WEIGHT.
  //   This prevents large margins against weak opponents generating implausibly
  //   large rating boosts.
  //
  // RULE 2 — Win protection:
  //   When a team WON in this dimension (didWinThisDimension=true) but the model's
  //   expected value was so extreme it implies a PENALTY despite winning, clamp the
  //   delta at 0. A team should never LOSE attack/defence rating for a positive
  //   real-world outcome. E.g. Mexico score 2 when expected 5 vs South Africa:
  //   they won the match; they should not lose attack rating.
  //
  // RULE 3 — Full penalty when underperforming:
  //   When actual < expected and we don't have win protection, full penalty applies.
  //   Failing to score when expected to is genuinely informative.
  const rawDelta = actual - expected;
  const taperedDelta = rawDelta > 0
    ? rawDelta * SURPLUS_WEIGHT          // Rule 1: taper surplus
    : rawDelta;                           // Rule 3: full penalty

  // Rule 2: clamp at 0 when the team actually performed well in this dimension
  if (didWinThisDimension && taperedDelta < 0) return 0;

  return taperedDelta;
}

const HOST_NATIONS = new Set(['USA', 'Canada', 'Mexico']);

function expectedGoals(attackElo, defenseElo, homeAdvantageMultiplier) {
  // The raw (attackElo - defenseElo) / SIGMA term grows with the Elo gap.
  // Capping the gap term at +/-1.5 keeps expected goals bounded but still
  // allows exp(ALPHA + GAMMA + 1.5) ≈ 6.5 goals for extreme mismatches.
  // At these levels a real underperformance (Ecuador 0-0 vs Curacao when
  // expected 5.83) generates implausibly large penalties (62 Elo points
  // from a single match). The underlying issue is that the SIGMA/ALPHA
  // constants are not yet fitted against real data (Section 5).
  //
  // Additional cap: expected goals are clamped at MAX_EXPECTED_GOALS (3.0).
  // No real World Cup team is ever genuinely "expected" to score more than
  // 3 goals in a competitive match - beyond that point the expectation is
  // an artefact of the unfitted model, not a real prediction. This makes
  // the Elo update robust to extreme mismatches until proper calibration.
  const MAX_EXPECTED_GOALS = 3.0;
  const rawGapTerm = (attackElo - defenseElo) / SIGMA_PLACEHOLDER;
  const cappedGapTerm = Math.max(-1.5, Math.min(1.5, rawGapTerm));
  const logMu = ALPHA_PLACEHOLDER
    + (GAMMA_PLACEHOLDER * homeAdvantageMultiplier)
    + cappedGapTerm;
  return Math.min(MAX_EXPECTED_GOALS, Math.exp(logMu));
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
// (mutates ratingsByTeam in place, including each team's matchesPlayed
// counter). Returns a per-match log entry for transparency/debugging (this
// is the piece that lets you see exactly why Scotland's numbers moved the
// way they did after Haiti, rather than just the before/after snapshot).
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

  // FIXED (two issues, both now corrected):
  // (1) previously passed the flat boolean homeIsHost/awayIsHost straight
  // into expectedGoals, applying FULL host advantage to every played
  // host-nation match regardless of match number - ignoring the same
  // HOME_ADVANTAGE_SCHEDULE taper (1, 0.75, 0.5) already applied correctly
  // for UNPLAYED group fixtures elsewhere (groupStageNegBin.js/
  // groupStage.js). E.g. Canada's 6-0 win over Qatar (their 2nd group
  // match) was scored against expectedHomeGoals=6.4, assuming FULL
  // strength rather than the correct 0.75.
  // (2) the first fix (above) used matchesPlayed directly as a proxy for
  // "which group match number is this", clamped via
  // Math.min(matchesPlayed, HOME_ADVANTAGE_SCHEDULE.length - 1) - this
  // silently broke once a host nation's matchesPlayed reached 3+ via a
  // KNOCKOUT match (not just a 3rd+ group match), since the clamp has no
  // way to distinguish the two - it would keep applying the 3rd-group-
  // match tier (0.5) to every knockout match indefinitely, instead of the
  // correct flat KNOCKOUT_HOME_ADVANTAGE_MULTIPLIER (0.25). This mirrors a
  // near-identical bug found and fixed the same way in eloUpdate.js's
  // applyResultsToElo - see that function's own comment for the full
  // explanation. Fixed by using result.group's presence (the same
  // convention used elsewhere, e.g. compareNextMatchScores.js) to decide
  // which constant applies, and tracking GROUP-STAGE match number
  // separately (hostGroupMatchesPlayed, scoped to this function only) from
  // the general matchesPlayed counter - the latter legitimately keeps
  // counting through knockout matches for confidence-ramp purposes
  // (matchCountWeight), which is a different concern from home-advantage
  // tapering and should not share one counter.
  const isGroupMatch = result.group != null;
  let homeAdvMultiplier;
  if (isGroupMatch) {
    // matchesPlayed has NOT yet been incremented for THIS match at this
    // point (that happens below) - but matchesPlayed only counts ALL
    // matches (group + knockout) for a team, which isn't the right number
    // for a group-match-number lookup once knockouts are mixed in. Use
    // hostGroupMatchesPlayed instead, a count scoped to group matches only.
    homeAdvMultiplier = HOME_ADVANTAGE_SCHEDULE[
      Math.min(
        (homeIsHost ? homeRating.hostGroupMatchesPlayed : awayRating.hostGroupMatchesPlayed) || 0,
        HOME_ADVANTAGE_SCHEDULE.length - 1
      )
    ];
  } else {
    homeAdvMultiplier = KNOCKOUT_HOME_ADVANTAGE_MULTIPLIER;
  }
  // homeIsHost and awayIsHost should never both be true (HOST_NATIONS
  // teams don't play each other at a "home" venue for either side in the
  // group stage under this tournament's structure) - if they were, only
  // the home side's own taper would currently be used; not handled as a
  // distinct case since it doesn't occur in practice for this tournament.

  const expectedHomeGoals = expectedGoals(homeRating.attack, awayRating.defense, homeIsHost ? homeAdvMultiplier : 0);
  const expectedAwayGoals = expectedGoals(awayRating.attack, homeRating.defense, awayIsHost ? homeAdvMultiplier : 0);
  if (isGroupMatch) {
    if (homeIsHost) homeRating.hostGroupMatchesPlayed = (homeRating.hostGroupMatchesPlayed || 0) + 1;
    if (awayIsHost) awayRating.hostGroupMatchesPlayed = (awayRating.hostGroupMatchesPlayed || 0) + 1;
  }

  // This is each team's Nth tournament match (1-indexed, including this
  // one) - drives the confidence ramp below. Incremented BEFORE computing
  // the weight, so a team's literal first tournament match is N=1, not 0.
  homeRating.matchesPlayed += 1;
  awayRating.matchesPlayed += 1;
  const homeWeight = matchCountWeight(homeRating.matchesPlayed);
  const awayWeight = matchCountWeight(awayRating.matchesPlayed);

  // Independent deltas. Goal deltas are tapered via taperedGoalDelta():
  //   - surplus above expectation counts at half rate (SURPLUS_WEIGHT)
  //   - no penalty when a team performed well in that dimension vs the match outcome
  // "Win this dimension" flags:
  //   home attack wins if home scored more goals than away (home won match)
  //   home defence wins if away scored fewer goals than model expected
  //   (symmetric for away)
  const homeWonMatch = homeGoals > awayGoals;
  const awayWonMatch = awayGoals > homeGoals;
  const homeAttackDelta  = K_GOALS_PLACEHOLDER * homeWeight
    * taperedGoalDelta(homeGoals, expectedHomeGoals, homeWonMatch);
  const homeDefenseDelta = K_GOALS_PLACEHOLDER * homeWeight
    * taperedGoalDelta(expectedAwayGoals, awayGoals, awayGoals < expectedAwayGoals);
  const awayAttackDelta  = K_GOALS_PLACEHOLDER * awayWeight
    * taperedGoalDelta(awayGoals, expectedAwayGoals, awayWonMatch);
  const awayDefenseDelta = K_GOALS_PLACEHOLDER * awayWeight
    * taperedGoalDelta(expectedHomeGoals, homeGoals, homeGoals < expectedHomeGoals);

  homeRating.attack += homeAttackDelta;
  homeRating.defense += homeDefenseDelta;
  awayRating.attack += awayAttackDelta;
  awayRating.defense += awayDefenseDelta;

  return {
    home, away, homeGoals, awayGoals,
    isGroupMatch,
    homeAdvMultiplier: (homeIsHost || awayIsHost) ? round2(homeAdvMultiplier) : null,
    expectedHomeGoals: round2(expectedHomeGoals),
    expectedAwayGoals: round2(expectedAwayGoals),
    homeMatchNumber: homeRating.matchesPlayed,
    awayMatchNumber: awayRating.matchesPlayed,
    homeWeight: round2(homeWeight),
    awayWeight: round2(awayWeight),
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
      matchesPlayed: 0,
      hostGroupMatchesPlayed: 0,
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
      `${entry.home}[match ${entry.homeMatchNumber}, w=${entry.homeWeight}] attack ${entry.homeAttackDelta >= 0 ? '+' : ''}${entry.homeAttackDelta}, defense ${entry.homeDefenseDelta >= 0 ? '+' : ''}${entry.homeDefenseDelta}  ` +
      `${entry.away}[match ${entry.awayMatchNumber}, w=${entry.awayWeight}] attack ${entry.awayAttackDelta >= 0 ? '+' : ''}${entry.awayAttackDelta}, defense ${entry.awayDefenseDelta >= 0 ? '+' : ''}${entry.awayDefenseDelta}`
    );
  }

  const ratingsOut = {};
  for (const [name, r] of ratingsByTeam.entries()) {
    ratingsOut[name] = {
      overall: r.overall,
      attack: round2(r.attack),
      defense: round2(r.defense),
      matchesPlayed: r.matchesPlayed,
      hostGroupMatchesPlayed: r.hostGroupMatchesPlayed,
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
      matchCountRampFull: MATCH_COUNT_RAMP_FULL,
      status: 'PLACEHOLDER - not yet fitted by regression, see Section 5 of elo-negbin-revised.md. kGoals is now match-count-ramped (see matchCountWeight) rather than flat - see header comment for rationale.',
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
  main,
  expectedGoals,
  applyResultToSplit,
  matchCountWeight,
  taperedGoalDelta,
  ALPHA_PLACEHOLDER,
  GAMMA_PLACEHOLDER,
  SIGMA_PLACEHOLDER,
  K_GOALS_PLACEHOLDER,
  SURPLUS_WEIGHT,
  MATCH_COUNT_RAMP_FULL,
};
