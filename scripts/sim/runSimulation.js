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
const { mulberry32, buildNameToCode } = require('./shared');

const N_SIMULATIONS = parseInt(process.argv[2], 10) || 20000;
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
  const OUTCOME_BUCKETS = ['1st', '2nd', '3rd_qualified', '3rd_eliminated', '4th'];
  const outcomeHistograms = new Map(); // team -> bucket -> Map("points,gd" -> count)
  for (const name of allTeams) {
    const byBucket = new Map();
    for (const bucket of OUTCOME_BUCKETS) byBucket.set(bucket, new Map());
    outcomeHistograms.set(name, byBucket);
  }

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

    // Outcome scenario tracking: for every team in every group, record this
    // sim's (points,gd) under the appropriate bucket. 1st/2nd/4th come
    // straight from standings position; 3rd is split into qualified/
    // eliminated based on r32 membership (the only way a 3rd-placed team
    // reaches r32 is via the third-place route).
    for (const standings of Object.values(result.groupStandings)) {
      for (let pos = 0; pos < 4; pos++) {
        const team = standings[pos];
        let bucket;
        if (pos === 0) bucket = '1st';
        else if (pos === 1) bucket = '2nd';
        else if (pos === 3) bucket = '4th';
        else bucket = r32Names.has(team.name) ? '3rd_qualified' : '3rd_eliminated';

        const hist = outcomeHistograms.get(team.name).get(bucket);
        const key = `${team.points},${team.gd}`;
        hist.set(key, (hist.get(key) || 0) + 1);
      }
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

  // Builds the (points,gd) scenario breakdown for one team/bucket. Every
  // combo with pct (= count/N_SIMULATIONS, i.e. P(this outcome bucket AND
  // this points/GD combo), unconditional) greater than 1% gets its own
  // entry; everything else is folded into a single "Others" entry
  // (points: null, gd: null). Summing all entries for a bucket gives that
  // bucket's overall probability (e.g. matching positionProbabilities[0] for
  // '1st'). The SCENARIO_THRESHOLD is unconditional - i.e. a combo needs to
  // represent >1% of ALL simulations to get its own row, not >1% of this
  // bucket's sims.
  const SCENARIO_THRESHOLD = 0.01; // combos below 1% unconditional go into "Other"
  function buildOutcomeScenarios(name, bucket) {
    const hist = outcomeHistograms.get(name).get(bucket);
    const entries = [...hist.entries()]
      .map(([key, count]) => {
        const [points, gd] = key.split(',').map(Number);
        return { points, gd, pct: count / N_SIMULATIONS };
      })
      .sort((a, b) => b.pct - a.pct);

    const shown = entries.filter((e) => e.pct > SCENARIO_THRESHOLD);
    const othersPct = entries.filter((e) => e.pct <= SCENARIO_THRESHOLD).reduce((sum, e) => sum + e.pct, 0);
    const scenarios = shown.map((e) => ({ points: e.points, gd: e.gd, pct: e.pct }));
    if (othersPct > 0) scenarios.push({ points: null, gd: null, pct: othersPct });
    return scenarios;
  }

  // Builds the pooled (points,gd) breakdown across ALL 5 outcome buckets for
  // one team, for the new Sankey-style diagram: left nodes = the 5 buckets,
  // right nodes = (points,gd) combos pooled across buckets (so e.g. "6pts
  // GD+1" reached via both '2nd' and 'thirdQualified' is ONE right-side
  // node, fed by ribbons from both buckets). The >1% SCENARIO_THRESHOLD is
  // applied to each combo's POOLED total (summed across buckets) - combos
  // at or below stay folded into a single "Other" node (points/gd: null),
  // which itself aggregates each bucket's leftover mass for that combo.
  // Sorted by points desc, then gd desc ("best to poorest"); "Other" last.
  // Each entry's byBucket gives the per-bucket contribution (for ribbons),
  // omitting buckets with a zero contribution. total = sum of byBucket
  // values = this node's overall probability (unconditional, fraction of
  // N_SIMULATIONS). Summing all entries' totals gives 1.
  // Maps raw histogram bucket keys (matching OUTCOME_BUCKETS array at the
  // top of the sim loop) to the JS-friendly keys used in outcomeScenarios
  // and in scenarioFlow.js's OUTCOME_BUCKETS[].key - so pooledScenarios
  // byBucket keys match what the Sankey renderer expects.
  const BUCKET_KEY_MAP = {
    '1st': 'first',
    '2nd': 'second',
    '3rd_qualified': 'thirdQualified',
    '3rd_eliminated': 'thirdEliminated',
    '4th': 'fourth',
  };

  // Below this, a (points, gd) combo is still drawn as its own node/ribbon
  // (every real combo gets a node - no "Other" catch-all), but its label is
  // hidden to avoid overcrowding the column with illegible text for combos
  // that are too thin to read anyway. The node and its ribbons are always
  // there and hoverable/clickable; only the always-on text label is culled.
  const LABEL_THRESHOLD = 0.005; // 0.5%

  function buildPooledScenarios(name) {
    const pooled = new Map(); // "points,gd" -> { points, gd, byBucket: {bucket: count} }
    for (const bucket of OUTCOME_BUCKETS) {
      const mappedKey = BUCKET_KEY_MAP[bucket];
      const hist = outcomeHistograms.get(name).get(bucket);
      for (const [key, count] of hist.entries()) {
        if (!pooled.has(key)) {
          const [points, gd] = key.split(',').map(Number);
          pooled.set(key, { points, gd, byBucket: {} });
        }
        pooled.get(key).byBucket[mappedKey] = count / N_SIMULATIONS;
      }
    }

    // Every distinct (points, gd) combo that occurred in at least one
    // simulation gets its own entry - no threshold-based folding into
    // "Other". showLabel marks whether this combo is common enough
    // (>LABEL_THRESHOLD) for the Sankey to print its text label; thin
    // combos still get a node and ribbons, just without a label
    // cluttering the column.
    return [...pooled.values()]
      .map((e) => {
        const total = Object.values(e.byBucket).reduce((sum, p) => sum + p, 0);
        return { points: e.points, gd: e.gd, total, byBucket: e.byBucket, showLabel: total > LABEL_THRESHOLD };
      })
      .sort((a, b) => (b.points - a.points) || (b.gd - a.gd));
  }

  // Builds the "final points total" breakdown for one team - the second
  // column of the 4-column Sankey (current points -> final points -> final
  // points+GD -> group finish). Every final points total a team could
  // realistically reach has its own node (there are at most 9 possible
  // values - 0,1,2,3,4,5,6,7,9 - from 3 group games, so no "Other" folding
  // is needed here, unlike the points+GD breakdown). Each node's byGd gives
  // the GD breakdown FOR THAT POINTS TOTAL (i.e. which third-column nodes it
  // feeds into, and with what probability) - this is what makes the
  // points -> points+GD ribbons possible. total = unconditional probability
  // (fraction of N_SIMULATIONS) of finishing on exactly this many points;
  // summing all nodes' totals gives 1.
  function buildPointsNodes(name) {
    const byPoints = new Map(); // points -> { total: count, byGd: Map(gd -> count) }
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
        total: node.total / N_SIMULATIONS,
        byGd: Object.fromEntries(
          [...node.byGd.entries()].map(([gd, count]) => [String(gd), count / N_SIMULATIONS])
        ),
      }))
      .sort((a, b) => b.points - a.points);
  }

  // which expects pct relative to P(finish 3rd) (= pFinish3rd), i.e. "given
  // finish 3rd, what's the points/GD AND qualified breakdown" - entries sum
  // to pQualifyGiven3rd. Derived from the new '3rd_qualified' bucket
  // (unconditional pct, see buildOutcomeScenarios) divided by
  // pFinish3rd = P('3rd_qualified') + P('3rd_eliminated').
  function buildThirdScenarios(name) {
    const qualified = buildOutcomeScenarios(name, '3rd_qualified');
    const eliminatedHist = outcomeHistograms.get(name).get('3rd_eliminated');
    const eliminatedTotal = [...eliminatedHist.values()].reduce((sum, c) => sum + c, 0) / N_SIMULATIONS;
    const qualifiedTotal = qualified.reduce((sum, e) => sum + e.pct, 0);
    const pFinish3rd = qualifiedTotal + eliminatedTotal;
    if (pFinish3rd === 0) return [];
    return qualified.map((e) => ({ points: e.points, gd: e.gd, pct: e.pct / pFinish3rd }));
  }

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
      thirdPlaceScenarios: buildThirdScenarios(name),
      outcomeScenarios: {
        first: buildOutcomeScenarios(name, '1st'),
        second: buildOutcomeScenarios(name, '2nd'),
        thirdQualified: buildOutcomeScenarios(name, '3rd_qualified'),
        thirdEliminated: buildOutcomeScenarios(name, '3rd_eliminated'),
        fourth: buildOutcomeScenarios(name, '4th'),
      },
      pooledScenarios: buildPooledScenarios(name),
      currentStanding: currentStanding.get(name),
      pointsNodes: buildPointsNodes(name),
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
