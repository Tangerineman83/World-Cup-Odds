#!/usr/bin/env node
// Runs a Monte Carlo simulation of the 2026 World Cup using current Elo
// ratings, and writes predictions.json with per-team probabilities of
// reaching each stage.
//
// Usage: node scripts/sim/runSimulation.js [numSimulations]
//
// Ratings come from elo_baseline.json (frozen pre-tournament snapshot) plus
// results.json (applied deterministically via eloBaseline.js) - NOT a live
// fetch. See eloBaseline.js and compareToLive.js for the rationale and the
// manual verification process.

const fs = require('fs');
const path = require('path');
const { GROUPS } = require('./tournament');
const { simulateTournament } = require('./simulateTournament');
const { getKnownResultsByGroup } = require('./resultsSource');
const { computeCurrentRatings, loadBaseline } = require('./eloBaseline');
const { FIFA_RANK } = require('../fifaRankings');
const { mulberry32, buildNameToCode,
  OUTCOME_BUCKETS, BUCKET_KEY_MAP, SCENARIO_THRESHOLD, LABEL_THRESHOLD,
  buildOutcomeHistograms, buildOutcomeScenarios, buildPooledScenarios,
  buildPointsNodes, buildThirdScenarios,
  buildR32OpponentHistograms, buildR32Opponents,
} = require('./shared');

const N_SIMULATIONS = parseInt(process.argv[2], 10) || 100000;
const OUTPUT_PATH = path.join(__dirname, '..', '..', 'predictions.json');

(async () => {
  const allTeams = Object.values(GROUPS).flat();

  console.log('Computing ratings from baseline + results.json...');
  const { knownByGroup, resultsCount, lastUpdated } = getKnownResultsByGroup();
  const { teamsByName, appliedCount, baselineFetchedAt, deltaMultiplier } = computeCurrentRatings(
    require(path.join(__dirname, '..', '..', 'results.json')).results
  );

  if (appliedCount > 0) {
    console.log(`  Applied ${appliedCount} result(s) on top of the ${baselineFetchedAt} baseline (results.json last updated ${lastUpdated}).`);
  } else {
    console.log('  No completed results found (results.json empty or all placeholders) - using baseline ratings as-is.');
  }

  // Each team's CURRENT group-stage standing from already-played matches
  // only (knownByGroup) - points/gd/gf banked so far, not a simulated
  // distribution. Used as the fixed starting node of the 4-column "road to
  // the Last 32" Sankey (see buildPooledScenarios below): every team starts
  // here, then the simulation fans out from this fixed point. Mirrors the
  // exact points/gf/ga logic in groupStage.js's applyResult so this always
  // agrees with what the engine itself would compute for the same fixtures.
  const currentStanding = new Map(); // team -> { points, gd, gf, ga, played }
  for (const name of allTeams) {
    currentStanding.set(name, { points: 0, gd: 0, gf: 0, ga: 0, played: 0 });
  }
  for (const fixtures of knownByGroup.values()) {
    for (const r of fixtures) {
      const home = currentStanding.get(r.home);
      const away = currentStanding.get(r.away);
      if (!home || !away) continue; // defensive: unknown team name, skip
      home.gf += r.homeGoals; home.ga += r.awayGoals; home.played += 1;
      away.gf += r.awayGoals; away.ga += r.homeGoals; away.played += 1;
      if (r.homeGoals > r.awayGoals) home.points += 3;
      else if (r.homeGoals < r.awayGoals) away.points += 3;
      else { home.points += 1; away.points += 1; }
    }
  }
  for (const s of currentStanding.values()) s.gd = s.gf - s.ga;

  const stageCounts = new Map(); // team -> { groupWin, r16, qf, sf, final, champion }
  for (const name of allTeams) {
    stageCounts.set(name, { r32: 0, r16: 0, qf: 0, sf: 0, final: 0, champion: 0, groupWinner: 0, runnerUp: 0 });
  }

  // Outcome scenario tracking: for each team, a histogram of (points,gd) ->
  // count for each of 5 group-stage outcome buckets: '1st', '2nd',
  // '3rd_qualified' (finished 3rd AND qualified as a top-8 third),
  // '3rd_eliminated' (finished 3rd, did not qualify), '4th'. Counts are out
  // of N_SIMULATIONS (the full run), so each entry's pct = P(this outcome
  // AND this points/GD combo) - summing a bucket's entries gives that
  // bucket's overall probability (matching positionProbabilities for
  // 1st/2nd/4th, and pThird / (pFinish3rd - pThird) for the 3rd-place
  // splits). Used to build "top scenarios" breakdowns per team/outcome - see
  // buildOutcomeScenarios below. (The 3rd_qualified bucket is the same data
  // previously called thirdQualifyHistograms/thirdCounts, generalized.)
  const outcomeHistograms = buildOutcomeHistograms(allTeams);
  const r32OpponentHistograms = buildR32OpponentHistograms(allTeams);

  console.log(`Running ${N_SIMULATIONS} simulations...`);
  const startTime = Date.now();

  for (let i = 0; i < N_SIMULATIONS; i++) {
    const rand = mulberry32((Math.random() * 2 ** 31) | 0);
    const result = simulateTournament(teamsByName, rand, knownByGroup);

    // Group-stage outcomes
    for (const standings of Object.values(result.groupStandings)) {
      stageCounts.get(standings[0].name).groupWinner++;
      stageCounts.get(standings[1].name).runnerUp++;
    }

    // R32 participants = group winners + runners-up + 8 best thirds.
    // Derive from r32 matches (home/away of each match = the 32 entrants).
    const r32Names = new Set();
    for (const m of result.r32) {
      stageCounts.get(m.home.name).r32++;
      stageCounts.get(m.away.name).r32++;
      r32Names.add(m.home.name);
      r32Names.add(m.away.name);
    }

    // Outcome scenario tracking: (points, gd, gf) histogram per team per bucket.
    // GF added to support full FIFA tiebreak and thirds-table display.
    for (const standings of Object.values(result.groupStandings)) {
      for (let pos = 0; pos < 4; pos++) {
        const team = standings[pos];
        let bucket;
        if (pos === 0) bucket = '1st';
        else if (pos === 1) bucket = '2nd';
        else if (pos === 3) bucket = '4th';
        else bucket = r32Names.has(team.name) ? '3rd_qualified' : '3rd_eliminated';

        const hist = outcomeHistograms.get(team.name).get(bucket);
        const key = `${team.points},${team.gd},${team.gf}`;
        hist.set(key, (hist.get(key) || 0) + 1);
      }
    }

    // R32 opponent tracking: for every team that reaches R32, record opponent.
    for (const m of result.r32) {
      const homeHist = r32OpponentHistograms.get(m.home.name);
      const awayHist = r32OpponentHistograms.get(m.away.name);
      if (homeHist) homeHist.set(m.away.name, (homeHist.get(m.away.name) || 0) + 1);
      if (awayHist) awayHist.set(m.home.name, (awayHist.get(m.home.name) || 0) + 1);
    }

    // R16 participants = the 16 winners of the R32 matches (i.e. the home/away
    // teams of each R16 match).
    for (const m of result.r16) {
      stageCounts.get(m.home.name).r16++;
      stageCounts.get(m.away.name).r16++;
    }

    for (const m of result.qf) {
      stageCounts.get(m.home.name).qf++;
      stageCounts.get(m.away.name).qf++;
    }
    for (const m of result.sf) {
      stageCounts.get(m.home.name).sf++;
      stageCounts.get(m.away.name).sf++;
    }
    stageCounts.get(result.final.home.name).final++;
    stageCounts.get(result.final.away.name).final++;
    stageCounts.get(result.champion.name).champion++;
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`Done in ${elapsed}s`);

  const nameToCode = buildNameToCode();

  const { ratings: baselineRatings } = loadBaseline();

  const teams = allTeams.map((name) => {
    const c = stageCounts.get(name);
    const currentElo = teamsByName.get(name).elo;
    const baselineElo = baselineRatings[name];
    return {
      name,
      code: nameToCode[name] || null,
      group: Object.entries(GROUPS).find(([, members]) => members.includes(name))[0],
      fifaRank: FIFA_RANK[name] != null ? FIFA_RANK[name] : null,
      eloBaseline: baselineElo,
      eloRating: currentElo,
      eloChange: baselineElo != null ? currentElo - baselineElo : null,
      pGroupWinner: c.groupWinner / N_SIMULATIONS,
      pRunnerUp: c.runnerUp / N_SIMULATIONS,
      pRoundOf32: c.r32 / N_SIMULATIONS,
      pRoundOf16: c.r16 / N_SIMULATIONS,
      pQuarterFinal: c.qf / N_SIMULATIONS,
      pSemiFinal: c.sf / N_SIMULATIONS,
      pFinal: c.final / N_SIMULATIONS,
      pChampion: c.champion / N_SIMULATIONS,
      thirdPlaceScenarios: buildThirdScenarios(name, outcomeHistograms, N_SIMULATIONS),
      outcomeScenarios: {
        first:           buildOutcomeScenarios(name, '1st',            outcomeHistograms, N_SIMULATIONS),
        second:          buildOutcomeScenarios(name, '2nd',            outcomeHistograms, N_SIMULATIONS),
        thirdQualified:  buildOutcomeScenarios(name, '3rd_qualified',  outcomeHistograms, N_SIMULATIONS),
        thirdEliminated: buildOutcomeScenarios(name, '3rd_eliminated', outcomeHistograms, N_SIMULATIONS),
        fourth:          buildOutcomeScenarios(name, '4th',            outcomeHistograms, N_SIMULATIONS),
      },
      pooledScenarios: buildPooledScenarios(name, outcomeHistograms, N_SIMULATIONS),
      currentStanding: currentStanding.get(name),
      pointsNodes: buildPointsNodes(name, outcomeHistograms, N_SIMULATIONS),
      r32Opponents: buildR32Opponents(name, r32OpponentHistograms, nameToCode, N_SIMULATIONS),
    };
  });

  teams.sort((a, b) => b.pChampion - a.pChampion);

  const output = {
    generatedAt: new Date().toISOString(),
    numSimulations: N_SIMULATIONS,
    methodology: {
      ratingSource: `Ratings are computed deterministically from a frozen pre-tournament Elo snapshot (elo_baseline.json, fetched ${baselineFetchedAt}) plus every played result in results.json, applied in date order via the standard World Cup Elo formula (K=60, goal-difference weighted), with each in-tournament result's rating change multiplied by ${deltaMultiplier}x (on the basis that current tournament form is more representative of a team's true strength than their pre-tournament rating alone). No live fetch is used, so there is no possibility of double-counting against eloratings.net's own updates. Run scripts/sim/compareToLive.js periodically to check this against live eloratings.net values (noting ours will diverge somewhat by design, due to the multiplier).`,
      fifaRank: 'fifaRank is the official FIFA/Coca-Cola Men\'s World Ranking position (1-211ish across all FIFA members; only the 48 World Cup teams are listed here), from the 11 June 2026 update - the last one before the tournament (next update: 20 July 2026, after the tournament). This is FIFA\'s own ranking, independent of and not used by this site\'s model - included for comparison only. See scripts/fifaRankings.js.',
      eloRatings: 'eloBaseline is each team\'s rating immediately before the tournament (elo_baseline.json). eloRating is their CURRENT rating, adjusted for tournament performance so far (see ratingSource above). eloChange = eloRating - eloBaseline.',
      homeAdvantage: 100,
      drawModel: 'empirical (base 26% at parity, floor 12% for large gaps)',
      thirdPlaceAndBracket: 'simplified approximation of FIFA Annex C; not the official 495-scenario mapping',
      knockoutTies: 'extra time/penalties treated as draw-probability mass resolved ~50/50 with a small Elo-based tilt',
      liveResults: resultsCount > 0
        ? `${resultsCount} completed group-stage result(s) as of ${lastUpdated} are applied directly (not simulated) in every simulation run, and have updated each involved team's Elo rating (eloRating below) using the standard World Cup Elo formula (K=60, goal-difference weighted).`
        : 'No completed results applied yet - eloRating values are the pre-tournament Elo baseline.',
      climateAdjustment: 'group-stage matches include a small Elo-equivalent adjustment (+/-25 points, see scripts/sim/venues.js) based on each team\'s acclimatisation to that group\'s representative host-city altitude/heat profile. Directional, not a fitted parameter. Not applied to knockout matches.',
      thirdPlaceScenarios: 'For each team, thirdPlaceScenarios lists the most common (points, gd) combinations from simulations where that team finished 3rd in their group AND qualified as a top-8 third. The pct for each entry is a fraction of ALL simulations where the team finished 3rd (not just qualifying ones) - so the entries sum to pQualifyGiven3rd (in scenario.json allThirds), not to 1. The top 5 distinct (points, gd) combos are listed individually; any remainder is grouped into an "Others" entry (points: null, gd: null). The remaining gap to 1 (i.e. 1 - pQualifyGiven3rd) represents simulations where the team finished 3rd but did NOT qualify - not itemised here. Empty for teams that (almost) never finish 3rd.',
      outcomeScenarios: 'For each team, outcomeScenarios breaks the group stage down into 5 mutually exclusive outcome buckets: first, second, thirdQualified (finished 3rd AND advanced as a top-8 third), thirdEliminated (finished 3rd, did not advance), fourth. Each bucket lists every (points, gd) combination with unconditional probability >1% (a fraction of ALL simulations, not just this bucket), plus an "Others" entry (points/gd: null) for the remainder. Summing the entries for a bucket gives the overall probability of that bucket (matching positionProbabilities[0]/[1]/[3] for first/second/fourth, and pThird / (pFinish3rd - pThird) for the two third-place splits). Summing across all 5 buckets gives 1 (every simulation lands in exactly one bucket).',
      pooledScenarios: 'pooledScenarios is the same underlying data as outcomeScenarios, pooled across all 5 buckets into a single list of (points, gd) outcomes for the whole group stage - used as the third column of the team Sankey diagram. EVERY distinct (points, gd) combo that occurred in at least one simulation gets its own entry here - there is no "Other" catch-all bucket, so the diagram never has a node mixing together unrelated scenarios. Each entry has points, gd, total (unconditional probability, summing to 1 across all entries), byBucket (a map of bucket name to probability, giving the per-bucket contribution to this combo - i.e. the ribbons feeding this node from the outcome buckets in the fourth column), and showLabel (true if total > 0.5%, a hint for the renderer to skip printing a text label on combos too thin to read - the node and its ribbons are still drawn either way, just without a label). Sorted by points descending then gd descending ("best to poorest").',
      currentStanding: 'currentStanding is each team\'s ACTUAL group-stage record from matches already played (results.json), not a simulated figure - the fixed starting point (first column) of the team Sankey diagram. Shape: points, gd, gf, ga, played (how many of their 3 group games are in the books, 0-3). For a team with played: 0, this is always points: 0, gd: 0, gf: 0, ga: 0.',
      pointsNodes: 'pointsNodes is the final-points-total breakdown for one team - the second column of the team Sankey diagram, sitting between currentStanding (fixed) and pooledScenarios (final points+gd). There are at most 9 reachable totals from 3 group games (0,1,2,3,4,5,6,7,9 - 8 points is impossible), so every reachable total gets its own node; no "Other" folding here. Each entry has points, total (unconditional probability of finishing on exactly this many points, summing to 1 across all entries), and byGd (a map of GD value to probability, giving this points total\'s breakdown by final goal difference - i.e. the ribbons feeding into pooledScenarios). Sorted by points descending.',
    },
    teams,
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
  console.log(`Wrote predictions for ${teams.length} teams to ${OUTPUT_PATH}`);
})();
