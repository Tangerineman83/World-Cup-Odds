#!/usr/bin/env node
// Manual diagnostic script - NOT part of the automated pipeline.
//
// Fetches LIVE current ratings from eloratings.net and compares them to our
// own baseline+results.json-derived ratings, team by team. Run this
// periodically (e.g. after each round of group matches) to confirm our
// deterministic model is tracking reality - if a team has drifted a lot more
// than its results.json-implied delta would suggest, it likely means
// eloratings.net is reflecting a match we don't have in results.json yet
// (or vice versa).
//
// Usage: node scripts/sim/compareToLive.js

const path = require('path');
const { getEloRatings } = require('../eloSource');
const { GROUPS } = require('./tournament');
const { computeCurrentRatings, loadBaseline } = require('./eloBaseline');
const { IN_TOURNAMENT_DELTA_MULTIPLIER } = require('./eloUpdate');

const DRIFT_WARN_THRESHOLD = 15; // Elo points - flag teams beyond this

(async () => {
  const allTeams = Object.values(GROUPS).flat();

  console.log('Fetching LIVE ratings from eloratings.net...');
  let liveRows;
  try {
    liveRows = await getEloRatings();
  } catch (e) {
    console.error('Live fetch failed:', e.message);
    console.error('(This script requires network access - it is for manual/local use, not CI.)');
    process.exit(1);
  }

  if (liveRows.length === 0) {
    console.error('Live fetch returned no rows - aborting comparison.');
    process.exit(1);
  }

  const liveByName = new Map(liveRows.map((r) => [r.team, r.eloRating]));

  console.log('Computing our baseline+results.json ratings...');
  const { teamsByName, appliedCount, baselineFetchedAt } = computeCurrentRatings(
    require(path.join(__dirname, '..', '..', 'results.json')).results
  );
  const { ratings: baselineRatings } = loadBaseline();

  console.log(`\nBaseline fetched: ${baselineFetchedAt} | Results applied: ${appliedCount} | In-tournament multiplier: ${IN_TOURNAMENT_DELTA_MULTIPLIER}x\n`);
  console.log('NOTE: "ours" is EXPECTED to differ from "live" for teams that have played');
  console.log(`matches, by roughly (${IN_TOURNAMENT_DELTA_MULTIPLIER}x - 1) = ${((IN_TOURNAMENT_DELTA_MULTIPLIER - 1) * 100).toFixed(0)}% of their live movement so far - that's the`);
  console.log('point of the multiplier. The check below accounts for this and flags only');
  console.log('UNEXPLAINED drift beyond what the multiplier predicts.\n');

  console.log('Team'.padEnd(20), 'Ours'.padStart(8), 'Live'.padStart(8), 'Baseline'.padStart(9), 'Unexplained'.padStart(12));
  console.log('-'.repeat(60));

  const flagged = [];
  for (const name of allTeams) {
    const ours = teamsByName.get(name).elo;
    const live = liveByName.get(name);
    const baseline = baselineRatings[name];
    if (live == null || baseline == null) {
      console.log(name.padEnd(20), ours.toFixed(1).padStart(8), 'N/A'.padStart(8), '-'.padStart(9), '-'.padStart(12));
      continue;
    }

    // liveMovement = how much eloratings.net has moved this team since our
    // baseline (could include World Cup matches AND anything else, e.g.
    // friendlies). expectedOurs = baseline + multiplier * liveMovement is
    // our best guess at what "ours" should be if results.json + the
    // multiplier fully explains the difference. "unexplained" is the
    // residual - large values suggest a missing/extra result rather than
    // the multiplier itself.
    const liveMovement = live - baseline;
    const expectedOurs = baseline + IN_TOURNAMENT_DELTA_MULTIPLIER * liveMovement;
    const unexplained = ours - expectedOurs;

    const line = `${name.padEnd(20)} ${ours.toFixed(1).padStart(8)} ${live.toFixed(1).padStart(8)} ${baseline.toFixed(1).padStart(9)} ${unexplained >= 0 ? '+' : ''}${unexplained.toFixed(1).padStart(11)}`;
    if (Math.abs(unexplained) >= DRIFT_WARN_THRESHOLD) {
      console.log(line, '  <-- unexplained drift >', DRIFT_WARN_THRESHOLD);
      flagged.push({ name, ours, live, baseline, unexplained });
    } else {
      console.log(line);
    }
  }

  console.log();
  if (flagged.length === 0) {
    console.log('All teams within', DRIFT_WARN_THRESHOLD, 'points of "baseline + multiplier x live movement". Looks good.');
  } else {
    console.log(`${flagged.length} team(s) have unexplained drift beyond ${DRIFT_WARN_THRESHOLD} points:`);
    for (const f of flagged) {
      console.log(`  ${f.name}: ours=${f.ours.toFixed(1)}, live=${f.live.toFixed(1)}, baseline=${f.baseline.toFixed(1)}, unexplained=${f.unexplained >= 0 ? '+' : ''}${f.unexplained.toFixed(1)}`);
    }
    console.log();
    console.log('Possible causes:');
    console.log('  - A match this team played isn\'t in results.json yet (add it).');
    console.log('  - eloratings.net has processed a match (e.g. a friendly) we don\'t track,');
    console.log('    so liveMovement includes something results.json doesn\'t.');
    console.log('  - Small formula/rounding differences compounding over several matches.');
    console.log('If drift is widespread and growing, consider re-freezing elo_baseline.json');
    console.log('from a fresh live fetch (only do this BETWEEN matchdays, with results.json');
    console.log('reset to match - otherwise you reintroduce the double-counting this setup avoids).');
  }
})();
