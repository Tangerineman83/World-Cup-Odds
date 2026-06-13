# World Cup 2026 — Elo Predictions

A static site with two views of an Elo-based prediction model for the 2026 FIFA
World Cup:

- **`index.html`** — the "most likely scenario": predicted group standings (1st-4th
  for all 12 groups, with relative-strength Elo bars) and a full knockout bracket
  tree (Round of 32 → Final → Champion) with drawn connector lines, built by taking
  the modal group outcome and then a "chalk" (favourite-wins) bracket. **Click any
  team name** to trace its predicted route: the team's group row, every bracket match
  it plays, and the connector lines along its path all highlight together, and the
  bracket scrolls to its first knockout match.
- **`predictions.html`** — the full probability table: for all 48 teams, the
  probability of finishing 1st/2nd in their group and of reaching the R32, R16, QF,
  SF, Final, and winning the tournament, from a 20,000-run Monte Carlo simulation.

No backend — both pages read pre-generated JSON files (`scenario.json` and
`predictions.json`).

## Repo structure

```
index.html           <- group tables + knockout bracket (home page)
predictions.html     <- full per-team probability table
styles.css
app.js                <- reads scenario.json, renders groups + bracket, handles highlighting
predictions.js        <- reads predictions.json, renders the sortable table
scenario.json         <- pre-generated "most likely scenario" (commit after refresh)
predictions.json      <- pre-generated Monte Carlo probabilities (commit after refresh)
scripts/
  eloSource.js        <- fetches eloratings.net/World.tsv
  countryMap.js        <- maps Elo codes <-> team names
  sim/
    tournament.js        <- groups, host nations, Round-of-32 bracket structure
    eloModel.js          <- Elo -> win/draw/loss probability model
    groupStage.js         <- simulates one group's round-robin (with goal sim for tiebreaks)
    simulateTournament.js <- full Monte Carlo tournament (groups -> R32 -> ... -> final)
    mostLikely.js          <- modal group order + chalk bracket ("most likely scenario")
    runSimulation.js       <- runs N simulations, writes predictions.json
    runScenario.js          <- computes the most-likely scenario, writes scenario.json
```

## Deploying

1. Push this repo to GitHub.
2. In repo Settings → Pages, set source to the branch/root containing `index.html`.
3. Live at `https://<username>.github.io/<repo>/`.

## Refreshing the data

```bash
node scripts/sim/runScenario.js     # refreshes scenario.json (group tables + bracket)
node scripts/sim/runSimulation.js   # refreshes predictions.json (probability table)
git add scenario.json predictions.json
git commit -m "Refresh Elo-based predictions"
git push
```

`runSimulation.js` accepts an optional simulation count (default 20,000), e.g.
`node scripts/sim/runSimulation.js 50000`. Both pages cache-bust their JSON fetch
with a timestamp query string, so refreshed files are picked up on next load.

**Updating with live tournament results.** Edit `results.json` and add an entry for
each completed group-stage match:

```json
{
  "group": "A",
  "home": "Mexico",
  "away": "South Africa",
  "homeGoals": 2,
  "awayGoals": 0,
  "date": "2026-06-11"
}
```

Team names must exactly match the names used in `scripts/sim/tournament.js`'s
`GROUPS`. On the next run of either script, each result is (a) applied directly to
that group's standings - the fixture is excluded from simulation entirely - and (b)
used to update both teams' Elo ratings via the standard World Cup Elo formula (see
Methodology below), which then feeds into every subsequent match probability
(remaining group fixtures and the whole knockout bracket).

## Methodology

**Match probabilities.** Derived from each team's current
[Elo rating](https://en.wikipedia.org/wiki/World_Football_Elo_Ratings) using
eloratings.net's expected-result formula:

```
dr = (homeElo + homeAdvantage) - awayElo   [homeAdvantage = 100, 0 if neutral]
We = 1 / (10^(-dr/400) + 1)
```

`We` (draw counts as 0.5) is split into separate win/draw/loss probabilities via an
empirical draw model: ~26% draw probability for evenly matched teams (dr≈0), falling
to a floor of ~12% for lopsided matchups.

**Group stage.** Each group is a full round-robin. Standings use points, then goal
difference, then goals scored; goal differences are sampled from Poisson
distributions calibrated to each match's win probability (for tiebreak purposes only).

**Round of 32.** Top 2 from each group plus the 8 best third-placed teams advance.
The bracket uses the **official FIFA Round of 32 structure** (Matches 73-88, per the
2026 tournament regulations / [Wikipedia: 2026 FIFA World Cup knockout
stage](https://en.wikipedia.org/wiki/2026_FIFA_World_Cup_knockout_stage)). The 8
"3rd-placed" slots are filled by a backtracking search that assigns each qualifying
third-place team to a slot whose eligible-groups set includes that team's group -
guaranteed to find a structurally valid assignment, so a matchup like "England vs a
3rd-place team from Group F" (which Match 80's rules don't permit) can never occur.
This is still an approximation of FIFA's exact 495-scenario Annex C table (which
specifies one fixed assignment per combination of qualifying groups), but it always
produces a matchup the regulations would consider possible.

**Knockouts.** No draws — tied matches go to penalties, modelled as roughly a coin
flip with a small Elo-based tilt toward the favourite.

**Host advantage.** USA, Canada, and Mexico receive the +100 Elo boost in *every*
match they play, including knockout rounds. This is a deliberate choice consistent
with the eloratings.net convention, and is one reason host-nation probabilities here
may sit above what you'd see in betting/prediction markets.

**"Most likely scenario" vs. probability table.** `scenario.json` is a single
representative bracket - useful for following one coherent narrative - not a
forecast with a stated probability of occurring exactly as shown (the chance of every
result landing on the modal outcome is small). `predictions.json` is the underlying
distribution and is the more statistically meaningful output for "what's the chance
Brazil reaches the semis."

**Live results & Elo updates.** Completed group-stage matches (tracked in
`results.json`) are applied directly to group standings rather than simulated, and
update both teams' Elo ratings using eloratings.net's own formula:

```
Elo_new = Elo_old + K * G * (W - We)
```

where K=60 (World Cup matches), G is a goal-difference weight (1 for a draw/1-goal
margin, 1.5 for 2 goals, (11+N)/8 for N≥3 goals), W is the actual result (1/0.5/0 for
win/draw/loss), and We is the pre-match expected result (including home advantage
where applicable). Updated ratings then feed into every remaining fixture - both
the rest of that team's group and the entire knockout bracket. See
`scripts/sim/eloUpdate.js`.

**Climate/altitude adjustment.** Group-stage matches include a small (±25 Elo-point)
adjustment based on whether each team is "accustomed" (by federation/confederation)
to the altitude or heat/humidity of that group's representative host venue - e.g.
Andean CONMEBOL nations get a boost at Mexico City's altitude; CONCACAF
Caribbean/Central American, West African, and Gulf/Asian teams get a boost at hot,
humid venues, while less-acclimatised teams take a smaller penalty. Each group is
assigned one representative venue (its most climatically distinctive host city,
since groups actually play across 2-3 cities) - see `scripts/sim/venues.js` for the
full venue table, team classifications, and an explicit caveat: **the adjustment
size is a clearly-labelled judgement call, not a fitted parameter**, unlike Elo
itself. Not applied to knockout matches, since venues there depend on the bracket
outcome.

**v1→v2 status.** Live results integration and the climate/altitude adjustment were
added after the initial release (see above). Both are intentionally conservative -
small Elo-equivalent effects layered on top of the core Elo model, clearly
documented here and in each JSON output's `methodology` block.

## Disclaimer

This is an independent, simplified simulation for illustrative purposes - not an
official forecast from FIFA, eloratings.net, or any other body.
