#!/usr/bin/env node
// runScenarioNegBin.js
//
// NegBin-engine counterpart to runScenario.js. Computes the single "most
// likely scenario" (modal group standings + chalk knockout bracket + Next
// Match predictions) using the dual-Elo Negative Binomial engine
// (mostLikelyNegBin.js / groupStageNegBin.js) instead of the existing
// Poisson + single-Elo engine, and writes scenario_negbin.json in the SAME
// SHAPE as scenario.json (same top-level keys, same per-team/per-match
// fields) so index.html's existing rendering code can read either file via
// a toggle without needing two different rendering paths.
//
// Usage: node scripts/sim/runScenarioNegBin.js
//
// --- RATINGS SOURCE ---
// Reads elo_current_split.json directly (Phase 2's output - current
// in-tournament ELOa/ELOd, already reflecting every played result), same
// as runSimulationNegBin.js. Does NOT call computeCurrentRatings
// (eloBaseline.js) - that's the existing engine's single-overall-Elo
// replay, not used here since this engine needs attack/defense, not one
// number.
//
// --- DEPENDS ON predictions_negbin.json FOR WORLD RANKING + THIRD-PLACE
// RANKING, SAME AS runScenario.js DEPENDS ON predictions.json ---
// Run runSimulationNegBin.js BEFORE this script (the orchestrator,
// runFullNegBinPipeline.js, does this in the correct order automatically).
//
// --- STANDALONE and ADDITIVE ---
// Writes a NEW file (scenario_negbin.json). Does not touch scenario.json
// or anything currently driving the live site by default - see the
// frontend toggle work for how index.html is wired to read this.

const fs = require('fs');
const path = require('path');
const { GROUPS, HOST_NATIONS, KNOCKOUT_HOME_ADVANTAGE_MULTIPLIER, hostGroupMatchMultiplier } = require('./tournament');
const { computeGroupResultsNegBin, buildBracketNegBin } = require('./mostLikelyNegBin');
const { getKnownResultsByGroup } = require('./resultsSource');
const { FIFA_RANK } = require('../fifaRankings');
const { expectedGoals, negBinModalScore, negBinJointWinProbability, loadCalibratedParams } = require('./groupStageNegBin');
const { climateAdjustment, GROUP_VENUE } = require('./venues');
const { buildNameToCode, cleanTeam, cleanMatch } = require('./shared');

const CURRENT_SPLIT_PATH = path.join(__dirname, '..', '..', 'elo_current_split.json');
const PREDICTIONS_NEGBIN_PATH = path.join(__dirname, '..', '..', 'predictions_negbin.json');
const RESULTS_PATH = path.join(__dirname, '..', '..', 'results.json');
const OUTPUT_PATH = path.join(__dirname, '..', '..', 'scenario_negbin.json');

const NAME_TO_CODE = buildNameToCode();

// Predicts a single fixture's score using the NegBin engine DIRECTLY (goals
// sampled from the calibrated NegBin distribution via expectedGoals, then
// the single highest-probability scoreline via negBinModalScore) - NOT
// runScenario.js's two-step "decide outcome first via matchProbabilities,
// then force-fit Poisson goals to match" approach. This is the core
// structural difference the whole dual-Elo NegBin project is about: goals
// are the primary stochastic event here, not a number fitted after the
// fact to an already-decided win/draw/loss - see groupStageNegBin.js's own
// header comment for the full rationale. The "confidence" field (shown in
// the UI) is the modal scoreline's OWN probability mass under the joint
// distribution (not the broader outcome's probability, since there's no
// separate "decide outcome first" step here to report a probability for).
function predictedScoreForFixtureNegBin(homeName, awayName, groupLetter, splitRatings, params, hostMatchNumber) {
  const home = splitRatings[homeName];
  const away = splitRatings[awayName];
  if (!home || !away) return { predictedHome: 1, predictedAway: 1, confidence: 33 };

  const homeIsHost = HOST_NATIONS.has(homeName);
  const awayIsHost = HOST_NATIONS.has(awayName);
  const neutralVenue = !homeIsHost && !awayIsHost;

  // Per results.json convention the host is always listed as home, so the
  // swap path below should never trigger for group stage - included for
  // robustness only, matching runScenario.js's own defensive handling.
  let effHomeName = homeName, effAwayName = awayName, swapped = false;
  if (awayIsHost && !homeIsHost) { effHomeName = awayName; effAwayName = homeName; swapped = true; }
  const effHome = splitRatings[effHomeName];
  const effAway = splitRatings[effAwayName];

  const homeAdvMultiplier = (homeIsHost || awayIsHost) ? hostGroupMatchMultiplier(hostMatchNumber) : 0;

  let climateAdj = 0;
  const venueName = groupLetter ? GROUP_VENUE[groupLetter] : null;
  if (venueName) {
    climateAdj = climateAdjustment(effHomeName, venueName) - climateAdjustment(effAwayName, venueName);
  }
  const homeAdvantageElo = 100 * homeAdvMultiplier;
  const homeAdj = homeAdvantageElo + climateAdj;
  const awayAdj = -climateAdj;

  const muHome = expectedGoals(effHome.attack, effAway.defense, homeAdj, params);
  const muAway = expectedGoals(effAway.attack, effHome.defense, awayAdj, params);

  const modal = negBinModalScore(muHome, muAway, params.r);
  const { pHomeWin, pDraw, pAwayWin } = negBinJointWinProbability(muHome, muAway, params.r);

  // Map goals + confidence back to the original fixture perspective
  // (home/away from results.json), same swap-back convention as
  // runScenario.js's predictedScoreForFixture.
  const pHome = swapped ? modal.a : modal.h;
  const pAway = swapped ? modal.h : modal.a;
  const resultPerspective = pHome > pAway ? 'home' : pHome < pAway ? 'away' : 'draw';
  const homeWinProbReal = swapped ? pAwayWin : pHomeWin;
  const awayWinProbReal = swapped ? pHomeWin : pAwayWin;
  const confidence = Math.round(
    (resultPerspective === 'home' ? homeWinProbReal :
     resultPerspective === 'away' ? awayWinProbReal :
     pDraw) * 100
  );

  return { predictedHome: pHome, predictedAway: pAway, confidence };
}

async function main() {
  const allTeams = Object.values(GROUPS).flat();
  const codeOf = NAME_TO_CODE;

  if (!fs.existsSync(CURRENT_SPLIT_PATH)) {
    console.error('ERROR: elo_current_split.json not found. Run scripts/sim/updateEloSplit.js (Phase 2) first.');
    process.exitCode = 1;
    return;
  }

  console.log('Loading current ELOa/ELOd (elo_current_split.json)...');
  const currentSplit = JSON.parse(fs.readFileSync(CURRENT_SPLIT_PATH, 'utf-8'));
  const splitRatings = currentSplit.ratings;

  const teamsByName = new Map();
  const missingTeams = [];
  for (const name of allTeams) {
    const r = splitRatings[name];
    if (!r) { missingTeams.push(name); continue; }
    teamsByName.set(name, { name, elo: r.overall, attack: r.attack, defense: r.defense });
  }
  if (missingTeams.length > 0) {
    console.error(`ERROR: ${missingTeams.length} team(s) missing from elo_current_split.json: ${missingTeams.join(', ')}`);
    process.exitCode = 1;
    return;
  }

  const { params, source: paramsSource } = loadCalibratedParams();
  console.log(`Using NegBin constants: ${JSON.stringify(params)}`);

  const { knownByGroup, resultsCount, lastUpdated } = getKnownResultsByGroup();
  const allResultsJson = JSON.parse(fs.readFileSync(RESULTS_PATH, 'utf-8'));
  const allResults = allResultsJson.results;

  // World ranking + third-place ranking both depend on predictions_negbin.json
  // (the Monte Carlo run), same dependency runScenario.js has on
  // predictions.json - see that file's own comment. Falls back gracefully
  // (Elo-based rank, pThird=0) if predictions_negbin.json isn't present yet,
  // same as runScenario.js does, rather than hard-failing.
  let pChampionByName = new Map();
  let predictionsByName = new Map();
  try {
    const predictionsRaw = fs.readFileSync(PREDICTIONS_NEGBIN_PATH, 'utf-8');
    const predictions = JSON.parse(predictionsRaw);
    for (const t of predictions.teams) {
      pChampionByName.set(t.name, t.pChampion);
      predictionsByName.set(t.name, t);
    }
    console.log(`Loaded pChampion for ${pChampionByName.size} teams from predictions_negbin.json (for world ranking).`);
  } catch (e) {
    console.log('predictions_negbin.json not found/unreadable - world ranking will fall back to Elo for this run.');
  }

  console.log('Computing group results (NegBin engine)...');
  const groupResults = computeGroupResultsNegBin(teamsByName, knownByGroup);

  // Third-place ranking - same P(qualify | finish 3rd) approach as
  // runScenario.js, sourced from predictions_negbin.json instead of
  // predictions.json. See that file's own extensive comment for the full
  // derivation rationale (not repeated here verbatim to avoid the two
  // copies silently drifting in meaning - if you're changing this logic,
  // check runScenario.js's equivalent block too).
  const thirdPlaceCandidates = Object.entries(groupResults).map(([letter, result]) => {
    const name = result.order[2];
    const pFinish3rd = result.positionProbabilities[name][2];
    const pred = predictionsByName.get(name);
    const pThird = pred ? Math.max(0, pred.pRoundOf32 - pred.pGroupWinner - pred.pRunnerUp) : 0;
    const pQualifyGiven3rd = pFinish3rd > 0 ? pThird / pFinish3rd : 0;
    const stats = result.modalStats && result.modalStats[name];
    return {
      name,
      group: letter,
      elo: teamsByName.get(name).elo,
      pFinish3rd,
      pThird,
      pQualifyGiven3rd,
      points: stats ? stats.points : null,
      gd: stats ? stats.gd : null,
      gf: stats ? stats.gf : null,
    };
  });

  thirdPlaceCandidates.sort((a, b) => {
    if (b.pQualifyGiven3rd !== a.pQualifyGiven3rd) return b.pQualifyGiven3rd - a.pQualifyGiven3rd;
    if (b.pThird !== a.pThird) return b.pThird - a.pThird;
    return b.elo - a.elo;
  });

  const bestThirds = thirdPlaceCandidates.slice(0, 8)
    .map((t) => ({ name: t.name, elo: t.elo, group: t.group }));

  console.log('Building bracket (NegBin engine)...');
  const scenario = buildBracketNegBin(groupResults, bestThirds, teamsByName);

  const eloRank = [...allTeams].sort((a, b) => teamsByName.get(b).elo - teamsByName.get(a).elo);
  const eloRankByName = new Map(eloRank.map((name, i) => [name, i + 1]));

  let worldRankByName;
  if (pChampionByName.size === allTeams.length) {
    const byChampion = [...allTeams].sort((a, b) => pChampionByName.get(b) - pChampionByName.get(a));
    worldRankByName = new Map(byChampion.map((name, i) => [name, i + 1]));
  } else {
    worldRankByName = eloRankByName;
  }

  const groups = {};
  for (const [letter, g] of Object.entries(scenario.groups)) {
    groups[letter] = {
      order: g.order.map((name) => {
        const stats = g.modalStats ? g.modalStats[name] : null;
        return {
          name,
          code: codeOf[name] || null,
          elo: teamsByName.get(name).elo,
          worldRank: worldRankByName.get(name),
          fifaRank: FIFA_RANK[name] != null ? FIFA_RANK[name] : null,
          positionProbabilities: g.positionProbabilities[name],
          points: stats ? stats.points : null,
          gd: stats ? stats.gd : null,
          gf: stats ? stats.gf : null,
          played: 3,
        };
      }),
      probability: g.probability,
    };
  }

  // ---- "Next Match" predictions (NegBin engine) ---------------------------
  for (const letter of Object.keys(groups)) {
    const groupFixtures = allResults.filter((r) => r.group === letter);
    const unplayed = groupFixtures.filter((r) => r.homeGoals == null);

    if (unplayed.length === 0) {
      groups[letter].nextFixtures = [];
      groups[letter].nextRound = null;
      continue;
    }

    const dates = unplayed.map((r) => r.date).filter(Boolean).sort();
    const nextDate = dates[0] || null;
    const nextBatch = nextDate
      ? unplayed.filter((r) => r.date === nextDate)
      : unplayed.slice(0, 2);

    const played = groupFixtures.filter((r) => r.homeGoals != null);
    const hostMatchCounts = new Map();
    for (const r of played) {
      for (const side of [r.home, r.away]) {
        if (HOST_NATIONS.has(side)) hostMatchCounts.set(side, (hostMatchCounts.get(side) || 0) + 1);
      }
    }

    const nextRound = Math.floor(played.length / 2) + 1;

    groups[letter].nextFixtures = nextBatch.map((r) => {
      const host = HOST_NATIONS.has(r.home) ? r.home : HOST_NATIONS.has(r.away) ? r.away : null;
      const hostMatchNumber = host ? (hostMatchCounts.get(host) || 0) + 1 : 1;
      const { predictedHome, predictedAway, confidence } = predictedScoreForFixtureNegBin(
        r.home, r.away, letter, splitRatings, params, hostMatchNumber
      );
      return {
        home: r.home,
        away: r.away,
        predictedHome,
        predictedAway,
        confidence,
        date: r.date || null,
      };
    });
    groups[letter].nextRound = nextRound;
  }
  // ---- end "Next Match" predictions ----------------------------------------

  const bestThirdNames = new Set(scenario.bestThirds.map((t) => t.name));
  const r32OpponentByThird = new Map();
  for (const m of scenario.r32) {
    if (bestThirdNames.has(m.away.name)) {
      r32OpponentByThird.set(m.away.name, { match: m, opponent: m.home });
    }
  }

  const allThirdsRaw = thirdPlaceCandidates.map((t) => ({
    name: t.name,
    code: codeOf[t.name] || null,
    group: t.group,
    elo: t.elo,
    worldRank: worldRankByName.get(t.name),
    fifaRank: FIFA_RANK[t.name] != null ? FIFA_RANK[t.name] : null,
    positionProbabilities: groupResults[t.group].positionProbabilities[t.name],
    pFinish3rd: t.pFinish3rd,
    pThird: t.pThird,
    pQualifyGiven3rd: t.pQualifyGiven3rd,
    points: t.points,
    gd: t.gd,
    gf: t.gf,
    thirdPlaceScenarios: (predictionsByName.get(t.name) || {}).thirdPlaceScenarios || [],
    outcomeScenarios: (predictionsByName.get(t.name) || {}).outcomeScenarios || null,
    pooledScenarios: (predictionsByName.get(t.name) || {}).pooledScenarios || [],
    currentStanding: (predictionsByName.get(t.name) || {}).currentStanding || null,
    pointsNodes: (predictionsByName.get(t.name) || {}).pointsNodes || [],
    pGroupWinner: (predictionsByName.get(t.name) || {}).pGroupWinner,
    pRunnerUp: (predictionsByName.get(t.name) || {}).pRunnerUp,
    pRoundOf32: (predictionsByName.get(t.name) || {}).pRoundOf32,
  }));

  const qualifying = [];
  const eliminated = [];
  for (const t of allThirdsRaw) {
    const r32 = r32OpponentByThird.get(t.name);
    if (r32) {
      qualifying.push({
        ...t,
        qualifies: true,
        matchId: r32.match.id,
        pWin: r32.match.pWin,
        opponent: cleanTeam(r32.opponent, codeOf),
      });
    } else {
      eliminated.push({ ...t, qualifies: false, matchId: null, pWin: null, opponent: null });
    }
  }

  const allThirds = [...qualifying, ...eliminated];

  const output = {
    generatedAt: new Date().toISOString(),
    resultsApplied: resultsCount,
    model: 'dual-Elo Negative Binomial (Phase 3/4) - see elo-negbin-revised.md',
    negBinConstants: params,
    negBinConstantsSource: paramsSource,
    methodology: {
      ratingSource: `Ratings are each team's CURRENT in-tournament ELOa (attack) / ELOd (defense), from elo_current_split.json (Phase 2), already reflecting every played result via a match-count-aware confidence ramp (see updateEloSplit.js). Unlike scenario.json's scalar engine, goals here are sampled DIRECTLY from a Negative Binomial distribution parameterized by the ELOa/ELOd gap (params: ${JSON.stringify(params)}, source: ${paramsSource}) - not decided via win-probability first, then forced-fit Poisson goals after. See groupStageNegBin.js and elo-negbin-revised.md Section 4.`,
      worldRank: pChampionByName.size === allTeams.length
        ? 'Each team\'s worldRank (shown in group tables) is its rank (1-48) by chance of winning the tournament (pChampion in predictions_negbin.json) - i.e. the rank matches the same model used for the odds table, not raw rating.'
        : 'predictions_negbin.json was unavailable when this was generated, so worldRank falls back to a simple rank by rating - regenerate after running runSimulationNegBin.js for a pChampion-based rank.',
      groupOrdering: 'modal (most frequent) full 1st-4th ordering across 20,000 group simulations per group, using the NegBin engine (groupStageNegBin.js)',
      groupModalStats: 'each team in groups[letter].order also carries points/gd/gf (and played, always 3) - taken from the single most common JOINT final table among the 20,000-simulation runs that produced this group\'s modal ordering, same approach as the existing engine\'s scenario.json (see that file\'s methodology.groupModalStats for full detail) - just using NegBin-sampled goals instead of Poisson.',
      thirdPlaceRanking: 'same P(qualify as a top-8 third | finish 3rd) approach as the existing engine\'s scenario.json (see that file\'s methodology.thirdPlaceRanking for full detail on the tiebreak order and its "ignoring cards" limitation), computed from predictions_negbin.json\'s full Monte Carlo run instead of predictions.json\'s.',
      bracketStructure: 'official FIFA Round of 32 structure (Matches 73-88) per the 2026 tournament regulations; the 8 "3rd-placed" slots are filled the same Annex-C-approximation way as the existing engine (assignThirdPlaceSlots, shared code, not duplicated).',
      knockouts: 'chalk bracket - at each match, the team with the higher TOTAL win probability (win + penalty-shootout-weighted draw share) under the NegBin joint scoreline distribution advances - see mostLikelyNegBin.js\'s chalkWinnerNegBin. This computes the full win probability via the joint distribution, NOT a single sampled scoreline (that\'s what runSimulationNegBin.js\'s Monte Carlo does instead, for the aggregate probability table).',
      nextMatchPrediction: 'Predicted scorelines for upcoming group fixtures are the single highest-probability (h,a) pair under the NegBin joint distribution for that fixture (negBinModalScore) - a genuine structural difference from the existing engine\'s scenario.json, which decides the win/draw/loss outcome FIRST (via a separate win-probability calculation) then force-fits a Poisson scoreline consistent with that pre-decided outcome. Here, goals are the primary modelled event throughout - there is no separate "decide outcome, then fit a score" step.',
      liveResults: resultsCount > 0
        ? `${resultsCount} completed group-stage result(s) as of ${lastUpdated} are applied directly (not simulated) - these matches\' actual goals (not simulated ones) are used in the modal group table and the ELOa/ELOd ratings feeding everything else.`
        : 'No completed results applied yet - all ratings are the pre-tournament Elo baseline split.',
      climateAdjustment: 'group-stage matches include a small Elo-equivalent adjustment (+/-25 points, see scripts/sim/venues.js) based on each team\'s acclimatisation to that group\'s representative host-city altitude/heat profile - same adjustment, same values as the existing engine. Not applied to knockout matches (venue depends on bracket outcome).',
      note: 'This is a single representative scenario, not a probability distribution. See predictions.html (toggle to NegBin) for per-team stage probabilities across the full Monte Carlo run.',
      comparisonNote: 'This file (scenario_negbin.json) is the dual-Elo Negative Binomial engine\'s counterpart to scenario.json (the original Poisson + single-Elo engine) - see elo-negbin-revised.md for the full methodology comparison between the two. Both are kept available via a toggle; neither has been retired.',
    },
    groups,
    allThirds,
    bestThirds: scenario.bestThirds.map((t) => cleanTeam(t, codeOf, { includeGroup: true })),
    r32: scenario.r32.map((m) => cleanMatch(m, codeOf)),
    r16: scenario.r16.map((m) => cleanMatch(m, codeOf)),
    qf: scenario.qf.map((m) => cleanMatch(m, codeOf)),
    sf: scenario.sf.map((m) => cleanMatch(m, codeOf)),
    final: cleanMatch(scenario.final, codeOf),
    thirdPlacePlayoff: cleanMatch(scenario.thirdPlacePlayoff, codeOf),
    champion: cleanTeam({ name: scenario.champion, elo: teamsByName.get(scenario.champion).elo }, codeOf),
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
  console.log(`Wrote NegBin scenario to ${OUTPUT_PATH}`);
  console.log(`Predicted champion: ${output.champion.name}`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error('FATAL:', e);
    process.exitCode = 1;
  });
}

module.exports = { main };
