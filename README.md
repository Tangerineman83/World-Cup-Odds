# World Cup 2026 — Elo Predictions

A static site with two views of an Elo-based prediction model for the 2026 FIFA
World Cup:

- **`index.html`** — the "most likely scenario": predicted group standings (1st-4th
  for all 12 groups, with relative-strength Elo bars) and a full knockout bracket
  tree (Round of 32 → Final → Champion) with drawn connector lines, built by taking
  the modal group outcome and then a "chalk" (favourite-wins) bracket. Each group
  table and the third-placed-teams table can be toggled between **Projected**
  (default - each team's chance of finishing 1st-4th, from the simulation),
  **Actual** (today's real table, from results played so far), and **Off the
  Fence** (a single concrete Pts/GD/GF table - the modal simulated outcome,
  rather than a spread of probabilities). The third-placed-teams table ranks
  across groups by points, then goal difference, then goals scored, then FIFA
  World Ranking (the same tiebreak the simulation itself uses) for the Actual
  and Off the Fence views; the Projected view instead ranks by each team's
  modelled probability of qualifying as a top-8 third. **Click any team name**
  to trace its predicted route: the team's group row, every bracket match
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
elo_baseline.json     <- frozen pre-tournament Elo snapshot (one-time, see Methodology)
results.json          <- all 72 group-stage fixtures; fill in scores as played
scripts/
  eloSource.js        <- fetches eloratings.net/World.tsv (used only by compareToLive.js)
  countryMap.js        <- maps Elo codes <-> team names
  sim/
    tournament.js        <- groups, host nations, Round-of-32 bracket structure
    eloModel.js          <- Elo -> win/draw/loss probability model
    eloUpdate.js          <- Elo update formula (K=60, goal-difference weighted)
    eloBaseline.js        <- baseline + results.json -> current ratings (deterministic)
    resultsSource.js       <- loads results.json, extracts played fixtures per group
    groupStage.js           <- simulates one group's round-robin (with goal sim for tiebreaks)
    simulateTournament.js   <- full Monte Carlo tournament (groups -> R32 -> ... -> final)
    mostLikely.js            <- modal group order + chalk bracket ("most likely scenario")
    runSimulation.js         <- runs N simulations, writes predictions.json
    runScenario.js            <- computes the most-likely scenario, writes scenario.json
    compareToLive.js          <- MANUAL diagnostic: baseline+results vs live eloratings.net
```

## Deploying

1. Push this repo to GitHub.
2. In repo Settings → Pages, set source to the branch/root containing `index.html`.
3. Live at `https://<username>.github.io/<repo>/`.

## Refreshing the data

```bash
node scripts/sim/runSimulation.js   # refreshes predictions.json (probability table)
node scripts/sim/runScenario.js     # refreshes scenario.json (group tables + bracket)
git add scenario.json predictions.json
git commit -m "Refresh Elo-based predictions"
git push
```

Run `runSimulation.js` first - `runScenario.js` reads its output (`pChampion`) to
compute each team's `worldRank`. `runSimulation.js` accepts an optional simulation
count (default 20,000), e.g. `node scripts/sim/runSimulation.js 50000`. Both pages
cache-bust their JSON fetch with a timestamp query string, so refreshed files are
picked up on next load.

**No live fetch is needed or used.** Ratings are computed deterministically from
`elo_baseline.json` (a frozen pre-tournament Elo snapshot) plus every played result
in `results.json`, applied in date order via the standard World Cup Elo formula.
Same baseline + same `results.json` always produces the same ratings - see
Methodology below for why.

**Updating with live tournament results.** `results.json` lists all 72 group-stage
fixtures up front with `homeGoals`/`awayGoals`/`date` set to `null`. To record a
result, find the fixture and fill in the two goal counts (and optionally the date):

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

Team names are pre-populated correctly - nothing to type. Only fixtures where both
`homeGoals` and `awayGoals` are non-null are treated as played: each is (a) applied
directly to that group's standings (excluded from simulation) and (b) included in
the deterministic Elo calculation described above. Then re-run both scripts (or
trigger the GitHub Action).

**Checking the baseline is still accurate.** Periodically (e.g. after each round of
group matches), run:

```bash
node scripts/sim/compareToLive.js
```

This fetches LIVE ratings from eloratings.net and compares them to our
baseline+results.json-derived ratings, flagging any team that's drifted by more
than 15 points. This script needs network access and is for local/manual use only -
it's not part of the GitHub Actions workflow.

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
If points/GD/goals-scored are all still tied, we fall back to FIFA World Ranking
(lower rank wins) as a final tiebreak. FIFA's actual tiebreak order also includes
head-to-head results (above goal difference) and a disciplinary "team conduct" score
(between goals-scored and FIFA ranking) - neither is modelled, since we have no
data source for head-to-head-specific stats or card counts, but both are rare
deciders (most ties resolve by goal difference or goals scored). The same
points -> GD -> goals -> FIFA-ranking order is used for ranking the 12 third-placed
teams against each other, matching the official 2026 third-place tiebreak criteria.

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

**Ratings: frozen baseline + deterministic results.json updates.** Rather than
fetching live ratings from eloratings.net on every run, the pipeline starts from
`elo_baseline.json` - a one-time snapshot of every team's Elo rating taken just
before the tournament began (2026-06-11) - and applies every played result from
`results.json`, in date order, using eloratings.net's own update formula:

```
Elo_new = Elo_old + K * G * (W - We)
```

where K=60 (World Cup matches), G is a goal-difference weight (1 for a draw/1-goal
margin, 1.5 for 2 goals, (11+N)/8 for N≥3 goals), W is the actual result (1/0.5/0 for
win/draw/loss), and We is the pre-match expected result (including home advantage
where applicable). See `scripts/sim/eloUpdate.js` for the formula and
`scripts/sim/eloBaseline.js` for how it's applied to the baseline.

**Home advantage decay schedule.** The three co-hosts (USA, Canada, Mexico) get a
+100 Elo home-advantage boost (`HOME_ADVANTAGE` in `scripts/sim/eloModel.js`,
eloratings.net's convention) in matches at home - but this boost is scaled down
over the tournament via `HOME_ADVANTAGE_SCHEDULE` in `scripts/sim/tournament.js`:
100% for a host's 1st group match, 75% for their 2nd, 50% for their 3rd, and a flat
25% (`KNOCKOUT_HOME_ADVANTAGE_MULTIPLIER`) for any knockout match they reach. The
rationale: the "extra" boost beyond what's already reflected in a host's Elo is
likely strongest for the tournament-opening atmosphere and fades as the tournament
progresses - this is a judgement call, not derived from data. For real played
results (`applyResultsToElo` in `scripts/sim/eloUpdate.js`), the match number is
the chronological count of that host's group matches processed so far. For
simulated/unplayed group fixtures (`groupStage.js`), since unplayed fixtures
aren't dated, each of a host's remaining fixtures uses the AVERAGE of the
schedule's not-yet-used entries (e.g. if they've played 1 of 3, both remaining
fixtures use avg(75%, 50%) = 62.5%) - an approximation that favours simplicity
over precise fixture ordering.

**In-tournament delta multiplier (1.5x).** Every in-tournament result's Elo delta
(as computed by the formula above) is multiplied by
`IN_TOURNAMENT_DELTA_MULTIPLIER = 1.5` (in `scripts/sim/eloUpdate.js`), applied
uniformly to every World Cup 2026 match as it's played - not decayed, and not
limited to a team's most recent matches. The rationale: a team's performance at
this tournament, against tournament-quality opposition and under tournament
conditions, is more representative of their true current strength than their
pre-tournament rating - so it should move the rating proportionally further. As a
team plays more tournament matches, their rating becomes increasingly anchored to
their actual tournament form rather than their pre-tournament baseline. This is a
deliberate, uniform methodological choice (similar in spirit to eloratings.net's
own use of a higher K for World Cup matches than for friendlies) - not a
team-specific or judgment-based adjustment.

**Why a frozen baseline instead of a live fetch?** eloratings.net updates its own
ratings after matches too, on its own schedule. If we fetched live ratings (which
may or may not already reflect a given match) AND separately applied our own delta
for that same match, we could double-count it. Starting from a fixed,
never-refetched baseline and applying only our own `results.json`-driven updates
makes the calculation fully deterministic and immune to this - there is exactly one
source of rating movement. The trade-off is that our ratings will gradually diverge
from eloratings.net's live values over the tournament - partly *by design* now
(the 1.5x multiplier means our results-driven movement is always 50% larger than
eloratings.net's own), and partly for the same reasons as before (a team plays a
friendly we don't track, small formula/rounding differences compounding). Run
`node scripts/sim/compareToLive.js` periodically (locally, since it needs network
access) to check for *unexplained* drift - the script accounts for the expected
1.5x effect and flags only residual differences beyond that, which would suggest a
missing/extra result rather than the multiplier itself. If unexplained drift grows
large, consider re-freezing `elo_baseline.json` from a fresh live fetch between
matchdays (with `results.json` reset accordingly, so the new baseline + new results
don't double-count either).

Completed group-stage matches are also applied directly to that group's standings
(excluded from simulation, real scoreline used instead) - independent of the rating
calculation above.

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
