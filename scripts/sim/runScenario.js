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
const { computeMostLikelyScenario } = require('./mostLikely');
const { getKnownResultsByGroup } = require('./resultsSource');
const { computeCurrentRatings } = require('./eloBaseline');

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

(async () => {
  const allTeams = Object.values(GROUPS).flat();
  const codeOf = NAME_TO_CODE;

  console.log('Computing ratings from baseline + results.json...');
  const { knownByGroup, resultsCount, lastUpdated } = getKnownResultsByGroup();
  const { teamsByName, eloChanges, appliedCount, baselineFetchedAt, deltaMultiplier } = computeCurrentRatings(
    require(path.join(__dirname, '..', '..', 'results.json')).results
  );

  if (appliedCount > 0) {
    console.log(`  Applied ${appliedCount} result(s) on top of the ${baselineFetchedAt} baseline (results.json last updated ${lastUpdated}):`);
    for (const c of eloChanges) {
      console.log(`    ${c.home} ${c.homeGoals}-${c.awayGoals} ${c.away}: ${c.home} ${c.homeEloChange >= 0 ? '+' : ''}${c.homeEloChange.toFixed(1)}, ${c.away} ${c.awayEloChange >= 0 ? '+' : ''}${c.awayEloChange.toFixed(1)}`);
    }
  } else {
    console.log('  No completed results found (results.json empty or all placeholders) - using baseline ratings as-is.');
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

  // allThirds: all 12 third-placed teams (one per group).
  //
  // The 8 that qualify (per bestThirds/the bracket) are listed FIRST, sorted
  // by their Round-of-32 match id (M74 < M77 < M79 < M80 < M81 < M82 < M85 <
  // M87) - i.e. the same order/grouping the knockout bracket below will show
  // them in - each annotated with `opponent` (the group winner they're
  // paired against in that match) and `matchId`/`pWin` for that fixture.
  // This is the bridge between the group-stage section and the knockout
  // section: "8th in this list plays the winner of Group X in match Y".
  //
  // The remaining 4 (eliminated) are listed after, sorted by pThird
  // descending (probability of advancing to the Last 32 via the third-place
  // route specifically: finishing 3rd in their group AND being one of the 8
  // best thirds, derived from predictions.json as
  // pRoundOf32 - pGroupWinner - pRunnerUp) - i.e. "how close did they come".
  const bestThirdNames = new Set(scenario.bestThirds.map((t) => t.name));
  const r32OpponentByThird = new Map();
  for (const m of scenario.r32) {
    if (bestThirdNames.has(m.away.name)) {
      r32OpponentByThird.set(m.away.name, { match: m, opponent: m.home });
    }
  }

  const allThirdsRaw = Object.entries(scenario.groups).map(([letter, g]) => {
    const name = g.order[2];
    const team = teamsByName.get(name);
    const pred = predictionsByName.get(name);
    const pThird = pred ? Math.max(0, pred.pRoundOf32 - pred.pGroupWinner - pred.pRunnerUp) : null;
    return {
      name,
      code: codeOf[name] || null,
      group: letter,
      elo: team.elo,
      worldRank: worldRankByName.get(name),
      positionProbabilities: g.positionProbabilities[name],
      pThird,
    };
  });

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

  // Sort qualifying thirds by their R32 match id (M74, M77, M79, M80, M81,
  // M82, M85, M87 - numeric order happens to match this case, but compare
  // numerically rather than as strings to be safe).
  qualifying.sort((a, b) => parseInt(a.matchId.slice(1), 10) - parseInt(b.matchId.slice(1), 10));
  // Sort eliminated thirds by pThird descending (falling back to Elo if
  // pThird is unavailable).
  eliminated.sort((a, b) => {
    if (a.pThird != null && b.pThird != null) return b.pThird - a.pThird;
    return teamsByName.get(b.name).elo - teamsByName.get(a.name).elo;
  });

  const allThirds = [...qualifying, ...eliminated];

  const output = {
    generatedAt: new Date().toISOString(),
    resultsApplied: resultsCount,
    methodology: {
      ratingSource: `Ratings are computed deterministically from a frozen pre-tournament Elo snapshot (elo_baseline.json, fetched ${baselineFetchedAt}) plus every played result in results.json, applied in date order via the standard World Cup Elo formula (K=60, goal-difference weighted), with each in-tournament result's rating change multiplied by ${deltaMultiplier}x (on the basis that current tournament form is more representative of a team's true strength than their pre-tournament rating alone). No live fetch is used, so there is no possibility of double-counting against eloratings.net's own updates. Run scripts/sim/compareToLive.js periodically to check this against live eloratings.net values (noting ours will diverge somewhat by design, due to the multiplier).`,
      worldRank: pChampionByName.size === allTeams.length
        ? 'Each team\'s worldRank (shown in group tables) is its rank (1-48) by chance of winning the tournament (pChampion in predictions.json) - i.e. the rank matches the same model used for the odds table, not raw rating.'
        : 'predictions.json was unavailable when this was generated, so worldRank falls back to a simple rank by rating - regenerate after running runSimulation.js for a pChampion-based rank.',
      groupOrdering: 'modal (most frequent) full 1st-4th ordering across 5,000 group simulations per group',
      thirdPlaceRanking: "thirds are ranked by points, then goal difference, then goals scored (each team's real simulated stats from their group's modal scenario) - matching the official 2026 tiebreak order. If all three are still tied, we use FIFA World Ranking as a final tiebreak (FIFA's actual order also includes head-to-head results and a disciplinary 'team conduct' record above FIFA ranking, neither of which we model - both are rare deciders in practice). Bracket slot assignment (which qualifying third plays which group winner) is an approximation of FIFA's official Annex C lookup table.",
      allThirds: 'allThirds lists all 12 third-placed teams. The first 8 are the qualifying thirds per bestThirds/the bracket, ordered by their Round-of-32 match id (M74, M77, M79, M80, M81, M82, M85, M87) - matching the order/grouping shown in the knockout bracket below - each with `opponent`/`matchId`/`pWin` for that fixture. The remaining 4 (eliminated in this scenario) are ordered by pThird descending (probability of advancing via the third-place route specifically, derived from predictions.json as pRoundOf32 - pGroupWinner - pRunnerUp).',
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
