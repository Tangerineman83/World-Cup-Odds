const { getEloRatings } = require('./eloSource');
const { getBettingOdds } = require('./oddsSource');

// Combines Elo ratings and betting-market implied odds into one comparison table.
// Only teams present in BOTH datasets get a meaningful rank diff; teams missing from
// one source are still included but flagged.
async function buildComparison() {
  const [eloRows, oddsResult] = await Promise.all([
    getEloRatings(),
    getBettingOdds(),
  ]);

  const oddsByCode = new Map(oddsResult.rows.map((r) => [r.code, r]));
  const eloByCode = new Map(eloRows.map((r) => [r.code, r]));

  const allCodes = new Set([...eloByCode.keys(), ...oddsByCode.keys()]);

  const combined = [];
  for (const code of allCodes) {
    const elo = eloByCode.get(code);
    const odds = oddsByCode.get(code);

    const row = {
      code,
      team: (elo && elo.team) || (odds && odds.team),
      eloRating: elo ? elo.eloRating : null,
      eloRank: elo ? elo.eloRank : null,
      impliedProbability: odds ? odds.impliedProbability : null,
      oddsRank: odds ? odds.oddsRank : null,
      rankDiff: null, // positive = ranked higher by odds than by Elo (i.e. odds rank number is smaller)
    };

    if (elo && odds) {
      // eloRank and oddsRank are both 1 = best.
      // rankDiff = eloRank - oddsRank.
      //   positive -> betting markets rate the team MORE favourably than Elo (oddsRank < eloRank)
      //   negative -> Elo rates the team MORE favourably than betting markets
      row.rankDiff = elo.eloRank - odds.oddsRank;
    }

    combined.push(row);
  }

  // Default sort: by Elo rank, with unranked (no Elo data) teams pushed to the end
  combined.sort((a, b) => {
    if (a.eloRank == null && b.eloRank == null) return 0;
    if (a.eloRank == null) return 1;
    if (b.eloRank == null) return -1;
    return a.eloRank - b.eloRank;
  });

  return {
    generatedAt: new Date().toISOString(),
    sources: {
      elo: 'https://www.eloratings.net/World.tsv',
      odds: 'https://polymarket.com/event/world-cup-winner',
    },
    eventVolume: oddsResult.eventVolume,
    eventEndDate: oddsResult.eventEndDate,
    teams: combined,
  };
}

module.exports = { buildComparison };
