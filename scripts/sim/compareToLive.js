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
const { computeCurrentRatings } = require('./eloBaseline');

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

  console.log(`\nBaseline fetched: ${baselineFetchedAt} | Results applied: ${appliedCount}\n`);
  console.log('Team'.padEnd(20), 'Ours'.padStart(8), 'Live'.padStart(8), 'Diff'.padStart(8));
  console.log('-'.repeat(46));

  const flagged = [];
  for (const name of allTeams) {
    const ours = teamsByName.get(name).elo;
    const live = liveByName.get(name);
    if (live == null) {
      console.log(name.padEnd(20), ours.toFixed(1).padStart(8), 'N/A'.padStart(8), '-'.padStart(8));
      continue;
    }
    const diff = ours - live;
    const line = `${name.padEnd(20)} ${ours.toFixed(1).padStart(8)} ${live.toFixed(1).padStart(8)} ${diff >= 0 ? '+' : ''}${diff.toFixed(1).padStart(7)}`;
    if (Math.abs(diff) >= DRIFT_WARN_THRESHOLD) {
      console.log(line, '  <-- drift >', DRIFT_WARN_THRESHOLD);
      flagged.push({ name, ours, live, diff });
    } else {
      console.log(line);
    }
  }

  console.log();
  if (flagged.length === 0) {
    console.log('All teams within', DRIFT_WARN_THRESHOLD, 'points of live eloratings.net. Baseline looks good.');
  } else {
    console.log(`${flagged.length} team(s) drifted more than ${DRIFT_WARN_THRESHOLD} points from live eloratings.net:`);
    for (const f of flagged) {
      console.log(`  ${f.name}: ours=${f.ours.toFixed(1)}, live=${f.live.toFixed(1)}, diff=${f.diff >= 0 ? '+' : ''}${f.diff.toFixed(1)}`);
    }
    console.log();
    console.log('Possible causes:');
    console.log('  - A match this team played isn\'t in results.json yet (add it).');
    console.log('  - eloratings.net has processed a match (e.g. a friendly) we don\'t track.');
    console.log('  - Small formula/rounding differences compounding over several matches.');
    console.log('If drift is widespread and growing, consider re-freezing elo_baseline.json');
    console.log('from a fresh live fetch (only do this BETWEEN matchdays, with results.json');
    console.log('reset to match - otherwise you reintroduce the double-counting this setup avoids).');
  }
})();
