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

const OUTPUT_PATH = path.join(__dirname, '..', '..', 'scenario.json');

// Strips a team object down to plain { name, code, elo } for JSON output,
// dropping any internal proxy fields (points/gd/gf used for third-place ranking).
function cleanTeam(t, codeOf) {
  if (!t) return null;
  return { name: t.name, code: codeOf[t.name] || null, elo: t.elo };
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
  if (missing.length) {
    console.warn('WARNING: missing Elo ratings for:', missing.join(', '), '- defaulting to 1400');
  }

  const teamsByName = new Map(
    allTeams.map((name) => [name, { name, elo: eloByName.get(name) ?? 1400 }])
  );

  console.log('Computing most-likely scenario...');
  const scenario = computeMostLikelyScenario(teamsByName);

  const groups = {};
  for (const [letter, g] of Object.entries(scenario.groups)) {
    groups[letter] = {
      order: g.order.map((name) => ({
        name,
        code: codeOf[name] || null,
        elo: teamsByName.get(name).elo,
        positionProbabilities: g.positionProbabilities[name], // [p1st, p2nd, p3rd, p4th]
      })),
      probability: g.probability,
    };
  }

  const output = {
    generatedAt: new Date().toISOString(),
    methodology: {
      groupOrdering: 'modal (most frequent) full 1st-4th ordering across 5,000 group simulations per group',
      thirdPlaceRanking: 'approximate - thirds ranked by Elo as a proxy for points/GD/GF (not the official Annex C process)',
      knockouts: 'chalk bracket - at each match, the team with the higher combined win+penalty probability advances',
      note: 'This is a single representative scenario, not a probability distribution. See predictions.html for per-team stage probabilities across 20,000 simulations.',
    },
    groups,
    bestThirds: scenario.bestThirds.map((t) => cleanTeam(t, codeOf)),
    r32: scenario.r32.map((m) => cleanMatch(m, codeOf)),
    r16: scenario.r16.map((m) => cleanMatch(m, codeOf)),
    qf: scenario.qf.map((m) => cleanMatch(m, codeOf)),
    sf: scenario.sf.map((m) => cleanMatch(m, codeOf)),
    final: cleanMatch(scenario.final, codeOf),
    champion: cleanTeam({ name: scenario.champion, elo: teamsByName.get(scenario.champion).elo }, codeOf),
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
  console.log(`Wrote scenario to ${OUTPUT_PATH}`);
  console.log(`Predicted champion: ${output.champion.name}`);
})();
