# Elo vs. Market — World Cup 2026 (static / GitHub Pages)

A sortable comparison of [World Football Elo Ratings](https://www.eloratings.net) against
implied rankings from [Polymarket's "World Cup Winner" market](https://polymarket.com/event/world-cup-winner),
for the teams in the 2026 FIFA World Cup.

This version is a **static site** — designed to be served directly by GitHub Pages.
There's no backend; the page reads a pre-generated `data.json` file.

## Repo structure

```
index.html          <- the page (served by GitHub Pages)
styles.css
app.js              <- reads data.json, renders the sortable table
data.json           <- pre-generated snapshot (commit this after each refresh)
scripts/
  build-data.js     <- run locally to refresh data.json with live data
  seed-data.js      <- one-off script that produced the initial data.json
  eloSource.js      <- fetches eloratings.net/World.tsv
  oddsSource.js     <- fetches Polymarket's public Gamma API
  compare.js        <- merges both, computes rank diffs
  countryMap.js     <- maps Elo codes <-> Polymarket team names
```

## Deploying

1. Push this repo to GitHub.
2. In repo Settings → Pages, set source to the branch/root (or `/docs` if you move
   things there) — whichever contains `index.html`.
3. The page will be live at `https://<username>.github.io/<repo>/`.

## Refreshing the data

Since GitHub Pages can't run a server, you refresh `data.json` manually (or via your
own automation later):

```bash
npm install        # only needed once, installs nothing extra beyond Node core
node scripts/build-data.js
git add data.json
git commit -m "Refresh Elo/odds data"
git push
```

`build-data.js` fetches the latest Elo ratings from eloratings.net and the latest
World Cup Winner odds from Polymarket, recomputes ranks and the Δ rank column, and
overwrites `data.json`. The page picks up the new file on next load (it cache-busts
with a timestamp query string).

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
