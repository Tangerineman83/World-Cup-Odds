// knockoutNegBin.js
//
// Knockout-match resolution for the dual-Elo Negative Binomial engine,
// companion to groupStageNegBin.js. The existing simulateTournament.js
// resolves knockout matches via matchProbabilities() on the single overall
// Elo (win/draw probabilities, draws going to a coin-flip-ish penalty
// shootout) - see playKnockout() there.
//
// For a genuinely fair model-vs-model comparison, knockout matches here are
// resolved the SAME structural way group matches are in groupStageNegBin.js:
// sample a scoreline directly from each side's ELOa/ELOd via the calibrated
// Negative Binomial constants, and let the winner fall out of the sampled
// score - NOT by computing a separate win probability and ignoring the
// score. A draw after normal/extra time goes to a penalty shootout,
// resolved the same way the existing engine does it (~50/50 with a small
// Elo-based tilt) since penalty outcomes aren't something either model
// claims to predict from goal-scoring form.
//
// KNOCKOUT ALPHA MULTIPLIER:
// Knockout matches historically produce ~8-12% fewer goals than group stage
// matches, reflecting the asymmetric stakes of elimination: teams defend
// deeper, are less willing to commit men forward speculatively, and a 0-0
// after 90 minutes is still a live match (unlike the group stage where a
// late equaliser can end the matter). This is a well-documented finding in
// football literature and is consistent across World Cups and continental
// tournaments. The multiplier is applied as a REDUCTION to the calibrated
// alpha parameter (log expected goals at Elo parity) — lowering expected
// goals uniformly while preserving the Elo-gap effect (sigma) and
// home-advantage effect (gamma) which have no reason to differ by stage.
// A 10% reduction in goals corresponds to multiplying mu by 0.90, which is
// achieved by subtracting ln(1/0.90) ≈ 0.105 from alpha — equivalently,
// multiplying the exponentiated alpha by 0.90. The current calibrated
// alpha=0.25 gives exp(0.25)=1.28 expected goals per team in a neutral
// balanced game; 0.90 × 1.28 = 1.15, consistent with observed KO rates.
//
// STANDALONE and ADDITIVE - does not modify simulateTournament.js or
// anything currently driving the live site.

const { HOST_NATIONS, KNOCKOUT_HOME_ADVANTAGE_MULTIPLIER } = require('./tournament');
const { climateAdjustment } = require('./venues');
const { expectedGoals, sampleNegativeBinomial, loadCalibratedParams } = require('./groupStageNegBin');

// Fraction by which expected goals are reduced in knockout matches relative
// to the calibrated group-stage parameters. 0.90 = 10% fewer goals.
// Grounded in observed WC/continental tournament data; not fitted against
// this tournament's 2 KO results (too small a sample).
const KO_GOALS_MULTIPLIER = 0.90;

// Plays a single knockout match. teamA/teamB: { name, elo, attack, defense }.
// No climate adjustment for knockouts (matches the existing engine's own
// scope - climateAdjustment is documented as group-stage only in venues.js
// and runSimulation.js's methodology text). Returns the winning team object.
function playKnockoutNegBin(teamA, teamB, rand) {
  const { params } = loadCalibratedParams();

  // Apply the knockout alpha reduction. We construct a local adjusted params
  // object rather than mutating the cached params — the cache is shared
  // across the whole simulation run and must not be modified.
  const koParams = {
    ...params,
    alpha: params.alpha + Math.log(KO_GOALS_MULTIPLIER),
  };

  const aIsHost = HOST_NATIONS.has(teamA.name);
  const bIsHost = HOST_NATIONS.has(teamB.name);
  const neutralVenue = !(aIsHost || bIsHost) || (aIsHost && bIsHost);

  let home = teamA, away = teamB, swapped = false;
  if (!neutralVenue && bIsHost) { home = teamB; away = teamA; swapped = true; }

  // 100 = HOME_ADVANTAGE base unit, same convention as groupStageNegBin.js
  // and eloModel.js. KNOCKOUT_HOME_ADVANTAGE_MULTIPLIER (0.25) applies
  // throughout the knockout stage per the existing engine's own home-
  // advantage-decay rationale (tournament.js).
  const homeAdvantageElo = neutralVenue ? 0 : 100 * KNOCKOUT_HOME_ADVANTAGE_MULTIPLIER;

  const muHome = expectedGoals(home.attack, away.defense, homeAdvantageElo, koParams);
  const muAway = expectedGoals(away.attack, home.defense, 0, koParams);

  const gHome = sampleNegativeBinomial(muHome, koParams.r, rand);
  const gAway = sampleNegativeBinomial(muAway, koParams.r, rand);

  let homeWins;
  if (gHome > gAway) {
    homeWins = true;
  } else if (gHome < gAway) {
    homeWins = false;
  } else {
    // Draw - penalties. Same ~coin-flip-with-small-tilt approach as the
    // existing engine's playKnockout(), using OVERALL elo for the tilt
    // (penalties aren't a goals-from-form event either model claims to
    // predict, so there's no principled reason to use attack/defense here
    // specifically - matching the existing engine's own choice of overall
    // Elo for this one piece keeps the comparison fair on the parts that
    // are genuinely shared between both models).
    const eloDiff = home.elo - away.elo;
    const penaltyTilt = 0.5 + Math.max(-0.05, Math.min(0.05, eloDiff / 4000));
    homeWins = rand() < penaltyTilt;
  }

  return swapped ? (homeWins ? away : home) : (homeWins ? home : away);
}

module.exports = { playKnockoutNegBin, KO_GOALS_MULTIPLIER };
