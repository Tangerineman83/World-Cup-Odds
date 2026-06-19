#!/usr/bin/env node
// Computes the single "most likely scenario" (modal group standings + chalk
// knockout bracket) and writes scenario.json.
//
// Usage: node scripts/sim/runScenario.js
//
// Ratings come from elo_baseline.json (frozen pre-tournament snapshot) plus
// results.json (applied deterministically via eloBaseline.js) - NOT a live
// fetch. See eloBaseline.js and compareToLive.js for the rationale and the
// manual verification process.

const fs = require('fs');
const path = require('path');
const { ELO_TO_NAME } = require('../countryMap');
const { GROUPS } = require('./tournament');
const { computeGroupResults, buildBracket } = require('./mostLikely');
const { getKnownResultsByGroup } = require('./resultsSource');
const { computeCurrentRatings } = require('./eloBaseline');
const { FIFA_RANK } = require('../fifaRankings');
const { matchProbabilities } = require('./eloModel');
const { HOST_NATIONS, hostGroupMatchMultiplier } = require('./tournament');
const { climateAdjustment, GROUP_VENUE } = require('./venues');

const OUTPUT_PATH = path.join(__dirname, '..', '..', 'scenario.json');

// Inverse of ELO_TO_NAME (code -> name), for displaying each team's code.
const NAME_TO_CODE = {};
for (const [code, name] of Object.entries(ELO_TO_NAME)) NAME_TO_CODE[name] = code;

// Strips a team object down to plain { name, code, elo } for JSON output,
// dropping any internal proxy fields (points/gd/gf used for third-place ranking).
// Optionally preserves `.group` (used for bestThirds, to show which group
// each qualifying third-place team came from).
function cleanTeam(t, codeOf, { includeGroup = false } = {}) {
  if (!t) return null;
  const out = { name: t.name, code: codeOf[t.name] || null, elo: t.elo };
  if (includeGroup && t.group) out.group = t.group;
  return out;
}

function cleanMatch(m, codeOf) {
  return {
    id: m.id,
    home: cleanTeam(m.home, codeOf),
    away: cleanTeam(m.away, codeOf),
    winner: cleanTeam(m.winner, codeOf),
    pWin: m.pWin,
  };
}

// Matches groupStage.js's GOAL_LAMBDA / GOAL_OFFSET - must be kept in sync.
const GOAL_LAMBDA = 2.0;
const GOAL_OFFSET = 0.35;

function predictedScoreForFixture(homeName, awayName, groupLetter, teamsByName, hostMatchNumber) {
  const home = teamsByName.get(homeName);
  const away = teamsByName.get(awayName);
  if (!home || !away) return { predictedHome: 1, predictedAway: 1 };

  const homeIsHost = HOST_NATIONS.has(homeName);
  const awayIsHost = HOST_NATIONS.has(awayName);
  const neutralVenue = !homeIsHost && !awayIsHost;

  // Per results.json convention the host is always listed as home, so the
  // swap path below should never trigger for group stage — included for
  // robustness only.
  let effHome = home, effAway = away, swapped = false;
  if (awayIsHost && !homeIsHost) { effHome = away; effAway = home; swapped = true; }

  const homeAdvMultiplier = (homeIsHost || awayIsHost) ? hostGroupMatchMultiplier(hostMatchNumber) : 1;

  let climateAdj = 0;
  const venueName = groupLetter ? GROUP_VENUE[groupLetter] : null;
  if (venueName) {
    climateAdj = climateAdjustment(effHome.name, venueName) - climateAdjustment(effAway.name, venueName);
  }

  const { pWin, pDraw } = matchProbabilities(effHome.elo, effAway.elo, {
    neutralVenue, climateAdj, homeAdvantageMultiplier: homeAdvMultiplier,
  });
  const pLoss = 1 - pWin - pDraw;

  // Mode of Poisson(λ) = floor(λ) for any non-integer λ; 0 for λ < 1.
  // Uses the same GOAL_LAMBDA / GOAL_OFFSET as groupStage.js so the
  // modal score is consistent with the full simulation's distribution.
  const homeLambda = GOAL_LAMBDA * (GOAL_OFFSET + pWin);
  const awayLambda = GOAL_LAMBDA * (GOAL_OFFSET + pLoss);

  let pHome = Math.floor(homeLambda);
  let pAway = Math.floor(awayLambda);
  if (swapped) { [pHome, pAway] = [pAway, pHome]; }

  return { predictedHome: pHome, predictedAway: pAway };
}

(async () => {
  const allTeams = Object.values(GROUPS).flat();
  const codeOf = NAME_TO_CODE;

  console.log('Computing ratings from baseline + results.json...');
  const { knownByGroup, resultsCount, lastUpdated } = getKnownResultsByGroup();
  const allResultsJson = require(path.join(__dirname, '..', '..', 'results.json'));
  const allResults = allResultsJson.results;
  const { teamsByName, eloChanges, appliedCount, baselineFetchedAt, deltaMultiplier } = computeCurrentRatings(
    allResults
  );

  if (appliedCount > 0) {
    console.log(`  Applied ${appliedCount} result(s) on top of the ${baselineFetchedAt} baseline (results.json last updated ${lastUpdated}):`);
    for (const c of eloChanges) {
      console.log(`    ${c.home} ${c.homeGoals}-${c.awayGoals} ${c.away}: ${c.home} ${c.homeEloChange >= 0 ? '+' : ''}${c.homeEloChange.toFixed(1)}, ${c.away} ${c.awayEloChange >= 0 ? '+' : ''}${c.awayEloChange.toFixed(1)}`);
    }
  } else {
    console.log('  No completed results found (results.json empty or all placeholders) - using baseline ratings as-is.');
  }

  // World ranking shown alongside each team in scenario.json: ranked by
  // chance of winning the tournament (pChampion, from predictions.json) where
  // available, since that's the figure this whole site is built around -
  // falling back to a simple Elo-based rank for any team predictions.json
  // doesn't (yet) cover, e.g. on a first-ever run before predictions.json
  // exists. The GitHub Actions workflow runs runSimulation.js BEFORE
  // runScenario.js so predictions.json is fresh when this runs.
  let pChampionByName = new Map();
  let predictionsByName = new Map();
  try {
    const predictionsRaw = fs.readFileSync(path.join(__dirname, '..', '..', 'predictions.json'), 'utf-8');
    const predictions = JSON.parse(predictionsRaw);
    for (const t of predictions.teams) {
      pChampionByName.set(t.name, t.pChampion);
      predictionsByName.set(t.name, t);
    }
    console.log(`Loaded pChampion for ${pChampionByName.size} teams from predictions.json (for world ranking).`);
  } catch (e) {
    console.log('predictions.json not found/unreadable - world ranking will fall back to Elo for this run.');
  }

  console.log('Computing group results...');
  const groupResults = computeGroupResults(teamsByName, knownByGroup);

  // Third-place ranking: for each group, take the modal-scenario's 3rd-placed
  // team as that group's representative (consistent with the `groups` table
  // below, which shows the modal 1st-4th order), then rank these 12 teams by
  // P(qualify as a top-8 third | finish 3rd in their group) - computed from
  // predictions.json's full 20,000-simulation run, which already determines
  // (for each simulation) the actual top-8-of-12 thirds via the official
  // points -> GD -> goals -> FIFA-ranking tiebreak order (see
  // simulateTournament.js::pickBestThirds/resolveRoundOf32 - "ignoring cards"
  // is a deliberate simplification, noted in methodology below).
  //   P(finish 3rd) = positionProbabilities[2] for that team in their group
  //   P(qualify AND finish 3rd) = pThird = pRoundOf32 - pGroupWinner - pRunnerUp
  //   P(qualify | finish 3rd) = P(qualify AND finish 3rd) / P(finish 3rd)
  // The 8 teams with the highest conditional probability qualify; this
  // ordering then drives bracket slot assignment (buildBracket below), so
  // onward knockout projections are consistent with this ranking.
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

  // Rank all 12 by P(qualify | finish 3rd) descending; ties (e.g. both 0,
  // for teams essentially never finishing 3rd) fall back to pThird then Elo.
  thirdPlaceCandidates.sort((a, b) => {
    if (b.pQualifyGiven3rd !== a.pQualifyGiven3rd) return b.pQualifyGiven3rd - a.pQualifyGiven3rd;
    if (b.pThird !== a.pThird) return b.pThird - a.pThird;
    return b.elo - a.elo;
  });

  const bestThirds = thirdPlaceCandidates.slice(0, 8)
    .map((t) => ({ name: t.name, elo: t.elo, group: t.group }));

  console.log('Building bracket...');
  const scenario = buildBracket(groupResults, bestThirds, teamsByName);

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
          positionProbabilities: g.positionProbabilities[name], // [p1st, p2nd, p3rd, p4th]
          // Modal (points, gd, gf) for THIS team's own modal finishing
          // position in this group - i.e. the "Off the Fence" table's
          // concrete stats line, parallel to the real-results "Actual"
          // table. played is always 3 here since this represents the
          // group stage's completed/projected end state, not a
          // partially-played group like Actual.
          points: stats ? stats.points : null,
          gd: stats ? stats.gd : null,
          gf: stats ? stats.gf : null,
          played: 3,
        };
      }),
      probability: g.probability,
    };
  }

  // ---- "Next Match" predictions -------------------------------------------
  // For each group: which fixtures are coming up, and what's the modal
  // predicted scoreline for each? Used by the "Next Match" toggle in the UI.
  // Complete groups get an empty nextFixtures array; nextRound = null.
  for (const letter of Object.keys(groups)) {
    const groupFixtures = allResults.filter((r) => r.group === letter);
    const unplayed = groupFixtures.filter((r) => r.homeGoals == null);

    if (unplayed.length === 0) {
      groups[letter].nextFixtures = [];
      groups[letter].nextRound = null;
      continue;
    }

    // "Next" = all unplayed fixtures sharing the earliest upcoming date.
    const dates = unplayed.map((r) => r.date).filter(Boolean).sort();
    const nextDate = dates[0] || null;
    const nextBatch = nextDate
      ? unplayed.filter((r) => r.date === nextDate)
      : unplayed.slice(0, 2); // fallback if dates are missing

    // Track how many group-stage matches each host nation has already played,
    // so the correct HOME_ADVANTAGE_SCHEDULE multiplier is used.
    const played = groupFixtures.filter((r) => r.homeGoals != null);
    const hostMatchCounts = new Map();
    for (const r of played) {
      for (const side of [r.home, r.away]) {
        if (HOST_NATIONS.has(side)) hostMatchCounts.set(side, (hostMatchCounts.get(side) || 0) + 1);
      }
    }

    // Round number (1-3): each round = 2 group-stage fixtures.
    const nextRound = Math.floor(played.length / 2) + 1;

    groups[letter].nextFixtures = nextBatch.map((r) => {
      const host = HOST_NATIONS.has(r.home) ? r.home : HOST_NATIONS.has(r.away) ? r.away : null;
      const hostMatchNumber = host ? (hostMatchCounts.get(host) || 0) + 1 : 1;
      const { predictedHome, predictedAway } = predictedScoreForFixture(
        r.home, r.away, letter, teamsByName, hostMatchNumber
      );
      return {
        home: r.home,
        away: r.away,
        predictedHome,
        predictedAway,
        date: r.date || null,
      };
    });
    groups[letter].nextRound = nextRound;
  }
  // ---- end "Next Match" predictions ----------------------------------------

  // allThirds: all 12 third-placed teams (one per group, the modal-scenario
  // 3rd-placed team from each group's `order`), in ONE continuous ranking by
  // P(qualify as a top-8 third | finish 3rd) descending - see
  // thirdPlaceCandidates above. The cutoff (qualifying vs eliminated) falls
  // after the 8th row.
  //
  // The 8 qualifying teams are each annotated with `opponent` (the group
  // winner they're paired against) and `matchId`/`pWin` for that fixture -
  // wherever assignThirdPlaceSlots actually placed them. Because R32 slot
  // eligibility is constrained per-slot (Annex-C-style - not every slot
  // accepts thirds from every group), `matchId`s won't necessarily run
  // M74->M87 in the same order as this ranking.
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

  // qualifying and eliminated both inherit pQualifyGiven3rd-descending order
  // from allThirdsRaw (no re-sort) - allThirds is therefore one continuous
  // ranking from most to least likely to be a top-8 third (given finishing
  // 3rd), with the cutoff line after the 8th row. Each qualifying team's
  // `matchId`/`opponent` reflect wherever assignThirdPlaceSlots actually
  // placed them (constrained by Annex-C-style group eligibility per slot),
  // which won't necessarily run M74->M87 in the same order as this ranking.
  const allThirds = [...qualifying, ...eliminated];

  const output = {
    generatedAt: new Date().toISOString(),
    resultsApplied: resultsCount,
    methodology: {
      ratingSource: `Ratings are computed deterministically from a frozen pre-tournament Elo snapshot (elo_baseline.json, fetched ${baselineFetchedAt}) plus every played result in results.json, applied in date order via the standard World Cup Elo formula (K=60, goal-difference weighted), with each in-tournament result's rating change multiplied by ${deltaMultiplier}x (on the basis that current tournament form is more representative of a team's true strength than their pre-tournament rating alone). No live fetch is used, so there is no possibility of double-counting against eloratings.net's own updates. Run scripts/sim/compareToLive.js periodically to check this against live eloratings.net values (noting ours will diverge somewhat by design, due to the multiplier).`,
      worldRank: pChampionByName.size === allTeams.length
        ? 'Each team\'s worldRank (shown in group tables) is its rank (1-48) by chance of winning the tournament (pChampion in predictions.json) - i.e. the rank matches the same model used for the odds table, not raw rating.'
        : 'predictions.json was unavailable when this was generated, so worldRank falls back to a simple rank by rating - regenerate after running runSimulation.js for a pChampion-based rank.',
      groupOrdering: 'modal (most frequent) full 1st-4th ordering across 20,000 group simulations per group',
      groupModalStats: "each team in groups[letter].order also carries points/gd/gf (and played, always 3) - taken from the single most common JOINT final table (all 4 teams' points/gd/gf together, internally consistent so gd sums to zero) among just the 20,000-simulation runs that produced this group's modal ordering (see groupOrdering). This is what the 'Off the Fence' toggle displays in the same Pts/GD table format as the 'Actual' toggle (which shows the same shape of data sourced from results.json instead). fifaRank (official FIFA World Ranking) is also included per team, used as the final tiebreak - alongside points/gd/gf - when ranking third-placed teams across groups for the Actual/Off-the-Fence thirds table (see thirdPlaceRanking).",
      thirdPlaceRanking: "for the 'Projected' toggle's thirds table specifically: the 12 third-placed teams (one per group, from the modal group scenario) are ranked by P(qualify as a top-8 third | finish 3rd in their group) - computed from the full 20,000-simulation run (predictions.json), where each simulation independently determines its own top-8-of-12 thirds using the official tiebreak order (points -> goal difference -> goals scored -> FIFA World Ranking). 'Ignoring cards' is deliberate: FIFA's real order also includes head-to-head results (above goal difference) and a disciplinary 'team conduct' score (between goals-scored and FIFA ranking) - neither is modelled, since we have no data source for card counts, but both are rare deciders in practice. points/gd/gf/fifaRank are included per team for reference (their modal-scenario stats and FIFA World Ranking) but are NOT the basis for THIS ranking - pQualifyGiven3rd is. The 'Actual' and 'Off the Fence' toggles instead rank their 12 thirds directly by that same points -> gd -> gf -> fifaRank order (no probability involved) - see groupModalStats. Bracket slot assignment (which qualifying third plays which group winner) is an approximation of FIFA's official Annex C lookup table.",
      allThirds: 'allThirds lists all 12 third-placed teams (one per group, modal scenario), in one continuous ranking by pQualifyGiven3rd (P(qualify | finish 3rd)) descending - see thirdPlaceRanking. The first 8 (qualifies: true) are the qualifying thirds per bestThirds/the bracket, each with `opponent`/`matchId`/`pWin` for their assigned Round-of-32 fixture (matchIds may not run M74->M87 in ranking order, since slot eligibility is constrained per Annex C). The remaining 4 (qualifies: false) continue the same ranking - i.e. "how close did they come". Each team also carries thirdPlaceScenarios (the (points,gd) breakdown conditional on finishing 3rd, see predictions.json), plus outcomeScenarios/pooledScenarios/pGroupWinner/pRunnerUp/pRoundOf32 (copied from predictions.json) - the same data used for the team Sankey popup on predictions.html, shown here for these 12 teams via the same popup design.',
      bracketStructure: 'official FIFA Round of 32 structure (Matches 73-88) per the 2026 tournament regulations; the 8 "3rd-placed" slots are filled by greedily assigning the best-ranked qualifying third-place team whose group is eligible for that slot, processed in official match order (74, 77, 79, 80, 81, 82, 85, 87) - an approximation of the 495-scenario Annex C table that always produces a structurally valid matchup',
      knockouts: 'chalk bracket - at each match, the team with the higher combined win+penalty probability advances',
      liveResults: resultsCount > 0
        ? `${resultsCount} completed group-stage result(s) as of ${lastUpdated} are applied directly (not simulated), and have updated each involved team's Elo rating using the standard World Cup Elo formula (K=60, goal-difference weighted, per eloratings.net's methodology).`
        : 'No completed results applied yet - all ratings are the pre-tournament Elo baseline.',
      climateAdjustment: 'group-stage matches include a small Elo-equivalent adjustment (+/-25 points, see scripts/sim/venues.js) based on each team\'s acclimatisation to that group\'s representative host-city altitude/heat profile. This is a clearly-labelled methodological judgement, not a fitted parameter - treat it as directional, not precise. Not applied to knockout matches (venue depends on bracket outcome).',
      note: 'This is a single representative scenario, not a probability distribution. See predictions.html for per-team stage probabilities across 20,000 simulations.',
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
  console.log(`Wrote scenario to ${OUTPUT_PATH}`);
  console.log(`Predicted champion: ${output.champion.name}`);
})();
