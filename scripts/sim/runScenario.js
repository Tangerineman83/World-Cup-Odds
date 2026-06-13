#!/usr/bin/env node
// Computes the single "most likely scenario" (modal group standings + chalk
// knockout bracket) and writes scenario.json.
//
// Usage: node scripts/sim/runScenario.js

const fs = require('fs');
const path = require('path');
const { getEloRatings } = require('../eloSource');
const { GROUPS } = require('./tournament');
const { computeMostLikelyScenario } = require('./mostLikely');
const { applyKnownResults } = require('./resultsSource');

const OUTPUT_PATH = path.join(__dirname, '..', '..', 'scenario.json');

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

(async () => {
  console.log('Fetching current Elo ratings...');
  const eloRows = await getEloRatings();
  const eloByName = new Map(eloRows.map((r) => [r.team, r.eloRating]));
  const codeOf = {};
  for (const r of eloRows) codeOf[r.team] = r.code;

  const allTeams = Object.values(GROUPS).flat();
  const missing = allTeams.filter((t) => !eloByName.has(t));

  if (eloRows.length === 0) {
    console.error('ERROR: getEloRatings() returned no rows at all - eloratings.net fetch likely failed.');
    console.error('Aborting without writing scenario.json (refusing to overwrite good data with a uniform-rating run).');
    process.exit(1);
  }

  if (missing.length > 0) {
    console.error(`ERROR: missing Elo ratings for ${missing.length}/${allTeams.length} teams: ${missing.join(', ')}`);
    if (missing.length === allTeams.length) {
      console.error('ALL teams are missing - this looks like a total data-source failure, not a few name mismatches.');
    }
    console.error('Aborting without writing scenario.json. Check scripts/eloSource.js and scripts/countryMap.js (team name spelling, World.tsv format).');
    process.exit(1);
  }

  const teamsByName = new Map(
    allTeams.map((name) => [name, { name, elo: eloByName.get(name) }])
  );

  console.log('Applying completed match results...');
  const { eloChanges, knownByGroup, resultsCount, lastUpdated } = applyKnownResults(teamsByName);
  if (resultsCount > 0) {
    console.log(`  Applied ${resultsCount} result(s) (results.json last updated ${lastUpdated}):`);
    for (const c of eloChanges) {
      console.log(`    ${c.home} ${c.homeGoals}-${c.awayGoals} ${c.away}: ${c.home} ${c.homeEloChange >= 0 ? '+' : ''}${c.homeEloChange.toFixed(1)}, ${c.away} ${c.awayEloChange >= 0 ? '+' : ''}${c.awayEloChange.toFixed(1)}`);
    }
  } else {
    console.log('  No completed results found (results.json empty or missing).');
  }

  console.log('Computing most-likely scenario...');
  const scenario = computeMostLikelyScenario(teamsByName, knownByGroup);

  // World ranking shown alongside each team in scenario.json: ranked by
  // chance of winning the tournament (pChampion, from predictions.json) where
  // available, since that's the figure this whole site is built around -
  // falling back to a simple Elo-based rank for any team predictions.json
  // doesn't (yet) cover, e.g. on a first-ever run before predictions.json
  // exists. The GitHub Actions workflow runs runSimulation.js BEFORE
  // runScenario.js so predictions.json is fresh when this runs.
  let pChampionByName = new Map();
  try {
    const predictionsRaw = fs.readFileSync(path.join(__dirname, '..', '..', 'predictions.json'), 'utf-8');
    const predictions = JSON.parse(predictionsRaw);
    for (const t of predictions.teams) pChampionByName.set(t.name, t.pChampion);
    console.log(`Loaded pChampion for ${pChampionByName.size} teams from predictions.json (for world ranking).`);
  } catch (e) {
    console.log('predictions.json not found/unreadable - world ranking will fall back to Elo for this run.');
  }

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
      order: g.order.map((name) => ({
        name,
        code: codeOf[name] || null,
        elo: teamsByName.get(name).elo,
        worldRank: worldRankByName.get(name),
        positionProbabilities: g.positionProbabilities[name], // [p1st, p2nd, p3rd, p4th]
      })),
      probability: g.probability,
    };
  }

  const output = {
    generatedAt: new Date().toISOString(),
    resultsApplied: resultsCount,
    methodology: {
      worldRank: pChampionByName.size === allTeams.length
        ? 'Each team\'s worldRank (shown in group tables) is its rank (1-48) by chance of winning the tournament (pChampion in predictions.json) - i.e. the rank matches the same model used for the odds table, not raw rating.'
        : 'predictions.json was unavailable when this was generated, so worldRank falls back to a simple rank by rating - regenerate after running runSimulation.js for a pChampion-based rank.',
      groupOrdering: 'modal (most frequent) full 1st-4th ordering across 5,000 group simulations per group',
      thirdPlaceRanking: 'approximate - thirds ranked by Elo as a proxy for points/GD/GF (not the official Annex C ranking process)',
      bracketStructure: 'official FIFA Round of 32 structure (Matches 73-88) per the 2026 tournament regulations; the 8 "3rd-placed" slots are filled by greedily assigning the best-ranked qualifying third-place team whose group is eligible for that slot, processed in official match order (74, 77, 79, 80, 81, 82, 85, 87) - an approximation of the 495-scenario Annex C table that always produces a structurally valid matchup',
      knockouts: 'chalk bracket - at each match, the team with the higher combined win+penalty probability advances',
      liveResults: resultsCount > 0
        ? `${resultsCount} completed group-stage result(s) as of ${lastUpdated} are applied directly (not simulated), and have updated each involved team's Elo rating using the standard World Cup Elo formula (K=60, goal-difference weighted, per eloratings.net's methodology).`
        : 'No completed results applied yet - all ratings are the pre-tournament Elo snapshot.',
      climateAdjustment: 'group-stage matches include a small Elo-equivalent adjustment (+/-25 points, see scripts/sim/venues.js) based on each team\'s acclimatisation to that group\'s representative host-city altitude/heat profile. This is a clearly-labelled methodological judgement, not a fitted parameter - treat it as directional, not precise. Not applied to knockout matches (venue depends on bracket outcome).',
      note: 'This is a single representative scenario, not a probability distribution. See predictions.html for per-team stage probabilities across 20,000 simulations.',
    },
    groups,
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
