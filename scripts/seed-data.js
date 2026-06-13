// One-off script to construct the initial data.json snapshot from the live data
// that was fetched from eloratings.net and Polymarket earlier in this session.
// This gives the page real content immediately on first deploy.
// For subsequent refreshes, use scripts/build-data.js (live fetch) instead.

const fs = require('fs');
const path = require('path');
const { ELO_TO_NAME, NAME_TO_ELO, normalize } = require('./countryMap');

// Full World.tsv rows for the 48 WC2026 teams, captured live from
// https://www.eloratings.net/World.tsv on 2026-06-13.
const ELO_ROWS = [
  ['ES', 2157], ['AR', 2115], ['FR', 2063], ['EN', 2024], ['BR', 1991],
  ['PT', 1989], ['CO', 1982], ['NL', 1948], ['EC', 1938], ['DE', 1932],
  ['NO', 1914], ['HR', 1912], ['TR', 1911], ['JP', 1906], ['BE', 1894],
  ['UY', 1892], ['CH', 1891], ['MX', 1881], ['SN', 1860], ['AT', 1830],
  ['MA', 1827], ['KR', 1786], ['SQ', 1782], ['PY', 1780], ['US', 1780],
  ['AU', 1777], ['DZ', 1772], ['IR', 1772], ['CA', 1767], ['RS', 1734],
  ['PA', 1730], ['UZ', 1714], ['CZ', 1712], ['SE', 1712], ['EG', 1696],
  ['CI', 1695], ['JO', 1680], ['CD', 1652], ['TN', 1628], ['BA', 1616],
  ['IQ', 1607], ['CV', 1578], ['SA', 1576], ['GH', 1510], ['QA', 1421],
  ['ZA', 1511], ['NZ', 1562], ['HT', 1527],
];

// Captured live from https://polymarket.com/event/world-cup-winner on 2026-06-13.
// Values are "Yes" prices (implied probability, 0-1) for each team's
// "Will X win the 2026 FIFA World Cup?" market.
const ODDS_ROWS = [
  ['Spain', 0.170], ['France', 0.167], ['England', 0.112], ['Portugal', 0.103],
  ['Brazil', 0.094], ['Argentina', 0.086], ['Germany', 0.052], ['Netherlands', 0.038],
  ['Norway', 0.029], ['Japan', 0.019], ['Colombia', 0.018], ['Belgium', 0.018],
  ['Morocco', 0.015], ['USA', 0.012], ['Switzerland', 0.011], ['Uruguay', 0.011],
  ['Mexico', 0.011], ['Ecuador', 0.009], ['Croatia', 0.009], ['Turkiye', 0.008],
  ['Senegal', 0.007], ['Austria', 0.006], ['Sweden', 0.006], ['Canada', 0.004],
  ['South Korea', 0.003], ['Ghana', 0.003], ['Bosnia-Herzegovina', 0.003],
  ['Paraguay', 0.003], ['Scotland', 0.003], ['Ivory Coast', 0.003], ['Czechia', 0.003],
  ['Egypt', 0.003], ['Iran', 0.002], ['Algeria', 0.002], ['Tunisia', 0.002],
  ['Australia', 0.002], ['New Zealand', 0.001], ['Haiti', 0.001], ['Jordan', 0.001],
  ['Curacao', 0.001], ['Uzbekistan', 0.001], ['Panama', 0.001], ['Iraq', 0.001],
  ['South Africa', 0.001], ['Congo DR', 0.001], ['Cape Verde', 0.001], ['Qatar', 0.001],
  ['Saudi Arabia', 0.001],
];

const eloRows = ELO_ROWS
  .filter(([code]) => ELO_TO_NAME[code])
  .map(([code, rating]) => ({ code, team: ELO_TO_NAME[code], eloRating: rating }));
eloRows.sort((a, b) => b.eloRating - a.eloRating);
eloRows.forEach((r, i) => (r.eloRank = i + 1));

const oddsRows = ODDS_ROWS
  .filter(([name]) => NAME_TO_ELO[normalize(name)])
  .map(([name, prob]) => ({ code: NAME_TO_ELO[normalize(name)], team: name, impliedProbability: prob }));
oddsRows.sort((a, b) => b.impliedProbability - a.impliedProbability);
oddsRows.forEach((r, i) => (r.oddsRank = i + 1));

const eloByCode = new Map(eloRows.map((r) => [r.code, r]));
const oddsByCode = new Map(oddsRows.map((r) => [r.code, r]));
const allCodes = new Set([...eloByCode.keys(), ...oddsByCode.keys()]);

const teams = [];
for (const code of allCodes) {
  const elo = eloByCode.get(code);
  const odds = oddsByCode.get(code);
  teams.push({
    code,
    team: (elo && elo.team) || (odds && odds.team),
    eloRating: elo ? elo.eloRating : null,
    eloRank: elo ? elo.eloRank : null,
    impliedProbability: odds ? odds.impliedProbability : null,
    oddsRank: odds ? odds.oddsRank : null,
    rankDiff: elo && odds ? elo.eloRank - odds.oddsRank : null,
  });
}

teams.sort((a, b) => {
  if (a.eloRank == null && b.eloRank == null) return 0;
  if (a.eloRank == null) return 1;
  if (b.eloRank == null) return -1;
  return a.eloRank - b.eloRank;
});

const data = {
  generatedAt: '2026-06-13T12:00:00.000Z',
  sources: {
    elo: 'https://www.eloratings.net/World.tsv',
    odds: 'https://polymarket.com/event/world-cup-winner',
  },
  eventVolume: 1265484646,
  eventEndDate: '2026-07-20T00:00:00.000Z',
  teams,
};

fs.writeFileSync(path.join(__dirname, '..', 'data.json'), JSON.stringify(data, null, 2));
console.log(`Wrote ${teams.length} teams to data.json`);
