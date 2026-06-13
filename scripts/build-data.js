#!/usr/bin/env node
// Fetches Elo ratings + Polymarket odds, merges them, and writes data.json
// into the site root so the static frontend can load it directly.
//
// Run manually whenever you want to refresh the data:
//   node scripts/build-data.js
//
// Then commit + push data.json (and any other changed files) to update
// the GitHub Pages site.

const fs = require('fs');
const path = require('path');
const { buildComparison } = require('./compare');

const OUTPUT_PATH = path.join(__dirname, '..', 'data.json');

(async () => {
  try {
    console.log('Fetching Elo ratings and betting odds...');
    const data = await buildComparison();
    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(data, null, 2));
    console.log(`Wrote ${data.teams.length} teams to ${OUTPUT_PATH}`);
    console.log(`Generated at: ${data.generatedAt}`);
  } catch (e) {
    console.error('Failed to build data.json:', e.message);
    process.exit(1);
  }
})();
