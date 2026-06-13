# Elo vs. Market — World Cup 2026

A self-hosted page comparing [World Football Elo Ratings](https://www.eloratings.net) against
implied rankings from [Polymarket's "World Cup Winner" market](https://polymarket.com/event/world-cup-winner),
for the 48 teams in the 2026 FIFA World Cup. Sortable table with a rank-difference column.

## Quick start

```bash
npm install
npm start
```

Then open `http://localhost:3000`.

The server fetches both data sources on startup and then once per hour, caching the
result to `data/latest.json`. The frontend hits `/api/comparison` and has a manual
"Refresh" button that triggers `/api/refresh`.

## How it works

- **Elo data**: `server/eloSource.js` fetches the plain-text `World.tsv` from
  eloratings.net (column 3 = country code, column 4 = current rating). This is the
  same endpoint widely used in academic/hobbyist Elo analyses — there's no official
  API, so this is a low-frequency (hourly) scrape with a descriptive User-Agent.
- **Betting/market data**: `server/oddsSource.js` calls Polymarket's public Gamma API
  (`gamma-api.polymarket.com/events?slug=world-cup-winner`) — no auth required. Each
  team has its own binary "Will X win the 2026 FIFA World Cup?" market; the "Yes"
  price is the implied probability.
- **Matching**: `server/countryMap.js` maps eloratings.net's two-letter codes to the
  team names Polymarket uses (handles mismatches like `EN`→England, `SQ`→Scotland,
  `CI`→Ivory Coast, and diacritics like Curaçao).
- **Comparison**: `server/compare.js` ranks both datasets independently (1 = best) and
  computes `rankDiff = eloRank − oddsRank`. Positive means the market is more bullish
  on that team than Elo; negative means Elo rates them more highly than the market does.

## Limitations / things to know

- **Not "official."** This is a transparent, reproducible comparison of two public
  data sources — not an authoritative ranking from either organisation.
- **Coverage**: only the 48 WC2026 teams are included. If Polymarket doesn't have a
  market for a team (rare, but possible for debutants), or a team is missing from the
  Elo mapping, that row will show `—` and no rank diff.
- **eloratings.net has no formal scraping ToS.** The hourly interval is deliberately
  conservative. If you need faster updates, consider caching more aggressively rather
  than increasing frequency.
- **Polymarket vs. real-money books**: Polymarket implied probabilities can diverge
  from traditional bookmaker odds (e.g. BetMGM), especially on liquidity-thin outcomes.
  If you'd rather use a different source, swap out `server/oddsSource.js` — the rest
  of the pipeline (`compare.js`, frontend) is source-agnostic as long as it returns
  `{ code, team, impliedProbability, oddsRank }[]`.
- **Team name drift**: if Polymarket renames a market (e.g. "Ivory Coast" → "Côte
  d'Ivoire") the mapping in `countryMap.js` will need a one-line update.

## Deployment

Any Node 18+ host works (Render, Railway, Fly.io, a VPS with PM2, etc.). The app is a
single Express process serving both the API and static frontend — no database needed.
For production, consider:

- Running behind a reverse proxy with HTTPS
- Persisting `data/latest.json` on a volume so a restart doesn't lose the last good
  snapshot while waiting for the next hourly refresh
- Adding basic monitoring on `/api/comparison` for `meta.lastError`
