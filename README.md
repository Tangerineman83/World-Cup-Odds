# Elo vs. Market — World Cup 2026 (static / GitHub Pages)

A sortable comparison of [World Football Elo Ratings](https://www.eloratings.net) against
implied rankings from [Polymarket's "World Cup Winner" market](https://polymarket.com/event/world-cup-winner),
for the teams in the 2026 FIFA World Cup.

This version is a **static site** — designed to be served directly by GitHub Pages.
There's no backend; the page reads a pre-generated `data.json` file.

## Repo structure

```
index.html          <- Elo vs. Market comparison page
predictions.html    <- Tournament simulation / predictions page
styles.css
app.js              <- reads data.json for index.html
predictions.js      <- reads predictions.json for predictions.html
data.json           <- pre-generated Elo vs odds snapshot (commit after each refresh)
predictions.json    <- pre-generated simulation output (commit after each refresh)
scripts/
  build-data.js     <- run locally to refresh data.json with live data
  seed-data.js      <- one-off script that produced the initial data.json
  eloSource.js      <- fetches eloratings.net/World.tsv
  oddsSource.js     <- fetches Polymarket's public Gamma API
  compare.js        <- merges both, computes rank diffs
  countryMap.js     <- maps Elo codes <-> Polymarket/team names
  sim/
    tournament.js       <- groups, host nations, Round-of-32 bracket structure
    eloModel.js         <- Elo -> win/draw/loss probability model
    groupStage.js       <- simulates one group's round-robin
    simulateTournament.js <- full tournament (groups -> R32 -> ... -> final)
    runSimulation.js    <- Monte Carlo runner, writes predictions.json
```

## Deploying

1. Push this repo to GitHub.
2. In repo Settings → Pages, set source to the branch/root (or `/docs` if you move
   things there) — whichever contains `index.html`.
3. The page will be live at `https://<username>.github.io/<repo>/`.

## Refreshing the data

Since GitHub Pages can't run a server, you refresh `data.json` and `predictions.json`
manually (or via your own automation later):

```bash
node scripts/build-data.js          # refreshes data.json (Elo vs market odds)
node scripts/sim/runSimulation.js   # refreshes predictions.json (20,000-run simulation, ~1-2s)
git add data.json predictions.json
git commit -m "Refresh Elo/odds data and tournament predictions"
git push
```

`build-data.js` fetches the latest Elo ratings from eloratings.net and the latest
World Cup Winner odds from Polymarket, recomputes ranks and the Δ rank column.
`runSimulation.js` accepts an optional argument for the number of simulations
(default 20,000), e.g. `node scripts/sim/runSimulation.js 50000` for a higher-precision
run (takes a few seconds longer). Both pages cache-bust their JSON fetch with a
timestamp query string, so refreshed files are picked up on next load.

## Tournament predictions methodology

`predictions.html` runs a Monte Carlo simulation of the full 104-match tournament:

- **Match probabilities**: derived from each team's current Elo rating using
  eloratings.net's expected-result formula (`We = 1 / (10^(-dr/400) + 1)`, where
  `dr` = rating difference, +100 for the home/host side). An empirical draw-probability
  model splits `We` into separate win/draw/loss probabilities (~26% draw at parity,
  floor of ~12% for lopsided matchups).
- **Groups**: the official 12-group draw (A-L) is simulated as a full round-robin;
  standings use points, then goal difference, then goals scored (goal differences are
  sampled from Poisson distributions calibrated to each match's win probability).
- **Round of 32**: the top 2 from each group plus the 8 best third-placed teams advance.
  Bracket placement of the 8 thirds uses a **simplified approximation**, not FIFA's
  official 495-scenario "Annex C" table.
- **Knockouts**: no draws — tied matches go to penalties, modelled as roughly a coin
  flip with a small Elo-based tilt toward the favourite.
- **Host advantage**: USA, Canada, and Mexico receive the +100 Elo home boost in
  *every* match they play, including knockout rounds — a deliberate choice that can
  push host-nation tournament-win probabilities above what prediction markets imply
  (see the Elo vs. Market page for context).
- **v1 limitation**: this is a pre-tournament-style baseline. Results already played
  in the live tournament are not yet incorporated into the simulation.

## How the comparison works

- **Elo rank**: from `eloratings.net/World.tsv`, 1 = highest rated.
- **Market rank**: from Polymarket's "Will X win the 2026 FIFA World Cup?" markets,
  ranked by implied probability (the "Yes" price), 1 = most likely.
- **Δ rank** = Elo rank − market rank. Positive = the market is more bullish on that
  team than Elo is. Negative = Elo rates them more highly than the market currently does.

## Notes / limitations

- This is an independent comparison of two public data sources, not an official
  ranking from either.
- Only teams with a corresponding Polymarket market get a Δ rank; others show `—`.
- `eloratings.net` has no official scraping API — `build-data.js` is meant to be run
  occasionally (e.g. weekly), not continuously.
- If you want automatic hourly/daily refreshes without running the script yourself,
  a GitHub Actions workflow on a schedule (`cron`) that runs `build-data.js` and
  commits the result is the natural next step — not included here per your request,
  but straightforward to add later.
