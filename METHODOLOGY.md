# World-Cup-Odds: model methodology (replication grade)

- **Repo:** `Tangerineman83/World-Cup-Odds` (public). Read at HEAD `d53b491` (14 Nov 2026 13:00 UK, an automated "Refresh predictions" commit). The last human commit was `2026-07-16 16:19 +02:00`. History: 331 commits by Tangerineman83 and 494 by github-actions[bot].
- **Read method:** a read-only local clone at `/workspace/modelling/methods/_clones/World-Cup-Odds`, with the push URL set to `DISABLED`. Nothing in the repo was changed. One scratch run was made in a separate copy (`/tmp/wco`) to check timing and reproducibility (see §6).
- **Written:** 14 Nov 2026 (Europe/London) for job t177u.
- **Citations:** `file:line` refers to HEAD `d53b491`. Every parameter value below is quoted from code or committed data. Where a value is not in the repo, it says **unknown**.
- **Status of findings:** on 14 Nov 2026 (t183s760) Callum decided this repo **stays archived as it is**. The issues in §9 are recorded as known issues, not as a list of fixes to make.

---

## 1. Purpose

The repo predicts the 2026 FIFA World Cup (48 teams, 12 groups of 4, a Round of 32 and then knockouts, 104 matches). It produces:

1. Per-team probabilities of finishing 1st or 2nd in the group and of reaching the R32, R16, QF, SF and Final, and of winning, from a Monte Carlo run (`predictions_negbin.json`).
2. A single deterministic "most likely scenario": modal group orderings plus a "chalk" (favourite-wins) bracket (`scenario_negbin.json`).

Both files feed a static GitHub Pages site (`index.html`/`app.js` and `predictions.html`/`predictions.js`).

There are two engines in the repo:

| Engine | Status | Files |
|---|---|---|
| **Dual-Elo Negative Binomial (live)** | Run twice daily by GitHub Actions. The site reads its outputs (`app.js:17-18` read `scenario_negbin.json` / `predictions_negbin.json`). | `buildEloSplit.js`, `updateEloSplit.js`, `calibrateNegBin.js`, `groupStageNegBin.js`, `knockoutNegBin.js`, `simulateTournamentNegBin.js`, `runSimulationNegBin.js`, `mostLikelyNegBin.js`, `runScenarioNegBin.js`, `validateNegBin.js`, orchestrated by `runFullNegBinPipeline.js` |
| Scalar-Elo W/D/L + Poisson (legacy) | The code is still present, but its outputs (`predictions.json`, `scenario.json`) are **not in the repo at HEAD**. The README still describes it as the live engine (stale). | `eloModel.js`, `eloUpdate.js`, `eloBaseline.js`, `groupStage.js`, `simulateTournament.js`, `runSimulation.js`, `mostLikely.js`, `runScenario.js` |

This doc covers the live NegBin engine in full. The legacy engine is summarised in §10.

---

## 2. Data sources (with dates)

| Data | Source / URL | Date / vintage | Where |
|---|---|---|---|
| Pre-tournament overall Elo, 48 teams | `https://www.eloratings.net/World.tsv` (`scripts/eloSource.js:4`). Columns used: col 2 = code, col 3 = rating (`eloSource.js:34-35`). | Frozen snapshot, `fetchedAt: "2026-06-11"` (`elo_baseline.json`) | `elo_baseline.json` (`.ratings`, 48 keys) |
| Historical international results (for the attack/defence split) | `https://raw.githubusercontent.com/martj42/international_results/master/results.csv` (`buildEloSplit.js:35`). Community dataset, not FIFA. | Fetched when `buildEloSplit.js` last ran. Output `generatedAt: 2026-06-29T17:11:13Z`. Matches strictly before `2026-06-11` (`buildEloSplit.js:85`). | `elo_baseline_split.json` |
| In-tournament results | Hand-entered by Callum in `results.json` (104 fixtures: 72 group, plus R32 to Final with `id` M73–M104). Fields: `homeGoals`, `awayGoals`, `aetHomeGoals`, `aetAwayGoals`, `penaltyWinner`, `date`. | Played dates 2026-06-11 to 2026-07-15. **M103 (France v England) and M104 (Spain v Argentina) have teams but null scores.** The 16 Jul commit added the teams only. The file's `lastUpdated` field still says `2026-06-20` (stale). | `results.json` |
| FIFA World Ranking (final tiebreak only) | FIFA/Coca-Cola ranking, "as of the 11 June 2026 update", via The Sporting News (`scripts/fifaRankings.js:1-4`) | 11 Jun 2026 | `scripts/fifaRankings.js` |
| Groups and bracket | Hard-coded from the 2026 regulations (`tournament.js:5-18` groups, `:65-82` R32 M73–M88, `:100-133` R16 to Final) | n/a | `scripts/sim/tournament.js` |
| Venue climate | Hard-coded: 16 venues with altitude and heat bands (`venues.js:18-35`), one venue per group (`venues.js:106-119`) | n/a, author judgement | `scripts/sim/venues.js` |

Referenced but **missing from the repo:** `elo-negbin-revised.md` (the "paper" cited for Section 4 and Section 5 calibration, e.g. `buildEloSplit.js:90`, `updateEloSplit.js` constants status). Its content is **unknown**.

---

## 3. Model equations and parameters

### 3.1 Stage 1: baseline attack/defence split (`buildEloSplit.js`, manual only)

For each team $i$, the script takes the last $N_w$ matches before the cutoff date.

| Parameter | Value | Location |
|---|---|---|
| $N_w$ (window) | 20 | `buildEloSplit.js:45` |
| Cutoff date | `2026-06-11` | `:85` |

Each match margin is capped at $C$ goals (the winner's tally becomes loser + $C$).

| Parameter | Value | Location |
|---|---|---|
| $C$ (margin cap) | 3 | `:68`, rule at `:74-79` |

Each match is weighted by opponent strength, where $\bar E$ is the mean overall Elo of the 48-team pool:

$$w_m = \min\!\big(2.5,\ \max(0.4,\ 1 + (E_{opp}-\bar E)/400)\big)$$

| Parameter | Value | Location |
|---|---|---|
| Weight scale | 400 | `buildEloSplit.js:260` |
| Weight floor | 0.4 | `:261` |
| Weight cap | 2.5 | `:262` |

The formula is at `:271-273`. An opponent outside the 48-team pool gets $w=1$ (`:268`).

Weighted goals for and against per match:

$$\text{GF}_i = \frac{\sum w_m g^{for}_m}{\sum w_m},\quad \text{GA}_i = \frac{\sum w_m g^{ag}_m}{\sum w_m}\quad(\text{`:336-347`})$$

The pool baselines are the unweighted means across the teams that have matches: $\overline{GF}=1.59$, $\overline{GA}=0.98$ (`elo_baseline_split.json`, computed at `:393-394`).

**Shrinkage:** $s_i=\min(1, n_i/N_w)$ (`:421`).

**Floors:** GF and GA are floored at 0.1 (`:428-429`).

The split is then:

$$\text{Att}_i = E_i + s_i\,\kappa\,\ln\!\frac{\max(GF_i,0.1)}{\overline{GF}},\qquad
\text{Def}_i = E_i - s_i\,\kappa\,\ln\!\frac{\max(GA_i,0.1)}{\overline{GA}}\quad(\text{`:430-436`})$$

$\kappa = 60$ (`KAPPA_PLACEHOLDER`, `:101`). The code labels it as a placeholder, not a fitted value. The comments record that it was earlier 120, then 80.

If a team has 0 matches, Att = Def = overall (`:405-418`). A window spanning more than 3 years is flagged `thinHistory` (`:357-364`).

### 3.2 Stage 2: in-tournament rating updates (`updateEloSplit.js`, run every refresh)

Results are applied in date order. Ties keep the original file order (`:464-472`).

**Expected goals used in the update** (placeholder constants, *not* the calibrated ones):

$$\mu = \min\!\Big(3.0,\ \exp\big(\alpha_0 + \gamma_0 h + \operatorname{clip}_{[-1.5,1.5]}\big((\text{Att}-\text{Def})/\sigma_0\big)\big)\Big)\quad(\text{`:256-277`})$$

| Parameter | Value | Location |
|---|---|---|
| $\alpha_0$ | $\ln 1.3 = 0.26236$ | `:91` |
| $\gamma_0$ | 0.15 | `:97` |
| $\sigma_0$ | 250 | `:104` |
| Cap on $\mu$ | 3.0 | `:270` |

The home factor $h$ is applied only for a host nation (`HOST_NATIONS` = USA, Canada, Mexico, `:254`):
- **Group matches:** $h$ comes from `HOME_ADVANTAGE_SCHEDULE = [1, 0.75, 0.5]` by the host's group-match number (`tournament.js:33`; used at `updateEloSplit.js:348-359`).
- **Knockouts:** $h = 0.25$ (`KNOCKOUT_HOME_ADVANTAGE_MULTIPLIER`, `tournament.js:39`).

**Update rule.** First, the tapered goal delta (`:208-233`):

$$\Delta(a,e) = 0.5\,(a-e)$$

| Parameter | Value | Location |
|---|---|---|
| `SURPLUS_WEIGHT` | 0.5 | `:206` |

If the team "won this dimension" and $\Delta<0$, then $\Delta$ is set to 0.

Then, for the home team (the away team mirrors it):

$$\text{Att}_H \mathrel{+}= K\,r(n_H)\,\Delta(g_H,\mu_H),\qquad \text{Def}_H \mathrel{+}= K\,r(n_H)\,\Delta(\mu_A,g_A)\quad(\text{`:393-405`})$$

| Parameter | Value | Location |
|---|---|---|
| $K$ | 40 (`K_GOALS_PLACEHOLDER`) | `:129` |
| Match-count ramp $r(n)$ | $\min(1, n/3)$ (`MATCH_COUNT_RAMP_FULL = 3`) | `:150-156` |

The ramp counts the team's tournament match number, including the current one.

**Clean-sheet trend bonus** (after all matches, group stage only, `:514-525`):

$$\text{Def} \mathrel{+}= 20\cdot\max\!\Big(0,\frac{cs/gm - 0.5}{1-0.5}\Big)\quad\text{if } gm\ge 2$$

| Parameter | Value | Location |
|---|---|---|
| `CS_TREND_BONUS` | 20 | `:250` |
| `CS_THRESHOLD` | 0.5 | `:251` |
| `CS_MIN_MATCHES` | 2 | `:252` |

The output is `elo_current_split.json`. At HEAD it has 102 results applied. Example: Spain Att 2179.94 / Def 2211.39; Argentina 2063.30 / 2095.82.

### 3.3 Stage 3: match model used in simulation (`groupStageNegBin.js`, `knockoutNegBin.js`)

Expected goals for the attacking side $A$ against defending side $D$ (`groupStageNegBin.js:106-122`):

$$\ln\mu = \alpha + \gamma\cdot\frac{H}{100} + \operatorname{clip}_{[-1.5,1.5]}\!\Big(\frac{\text{Att}_A-\text{Def}_D}{\sigma}\Big)$$

Here $H$ is an Elo-equivalent adjustment:
- **Group stage** (`:285-298`):
  - The host side gets $H = 100\cdot\bar m + c$, where $\bar m$ is the mean of the *remaining* entries of `[1, 0.75, 0.5]` after the host's known matches (`:242-254`).
  - The other side gets $H=-c$.
  - $c$ is the climate differential: $c=\text{clim}(\text{home})-\text{clim}(\text{away})$ at the group's single assigned venue.
- **Climate** (`venues.js:71-91`), CLIMATE_ADJUSTMENT_ELO = 25:
  - A high-altitude venue gives +25 if the team is in `ALTITUDE_ACCUSTOMED`, otherwise −12.5.
  - A hot venue gives +25 or −12.5 by `HEAT_ACCUSTOMED`.
  - Only Mexico City is "high"; Monterrey, Atlanta, Dallas, Houston and Miami are "hot".
  - At neutral venues, climate still applies.
- **Knockouts** (`knockoutNegBin.js:53-80`):
  - The host gets $H = 100\times0.25 = 25$.
  - No climate is applied (`climateAdjustment` is imported but unused).
  - $\alpha$ is shifted by $\ln 0.90$ (`KO_GOALS_MULTIPLIER = 0.90`, `:47`, applied at `:59-62`).

**Goals distribution:** $G\sim\text{NegBin}(\text{mean }\mu,\ \text{dispersion } r)$, sampled as a Gamma–Poisson mixture (`groupStageNegBin.js:172-175`):

$$\lambda\sim\text{Gamma}(\text{shape }r,\ \text{scale }\mu/r),\quad G\mid\lambda\sim\text{Poisson}(\lambda)$$

- Gamma uses Marsaglia–Tsang with a Box–Muller normal (`:131-158`).
- Poisson uses Knuth's multiplication method (`:160-170`).
- Home and away goals are independent given their means (no correlation term).

The log-pmf (`calibrateNegBin.js:120-125`) is:

$$\ln p(k)=\ln\Gamma(k+r)-\ln\Gamma(r)-\ln\Gamma(k+1)+r\ln\tfrac{r}{r+\mu}-k\ln\!\big(1+\tfrac{r}{\mu}\big)$$

$\ln\Gamma$ uses the Lanczos approximation with g=7 and 9 coefficients (`:101-118`).

**Parameters in use at HEAD** (`negbin_calibration.json` → `recommendedParams`, loaded at `groupStageNegBin.js:72-88`; values are rounded to 2 dp at write, `calibrateNegBin.js:534-537`):

| Param | Value used | Fitted value | Meaning |
|---|---|---|---|
| $\alpha$ | 0.22 | 0.22 | log baseline goals (e^0.22 ≈ 1.25) |
| $\gamma$ | 0.40 | 0.40 | log home effect per full host boost |
| $\sigma$ | 575 | 575 | Elo points per log-goal unit |
| $r$ | **12** | 40 (pinned at upper bound) | NegBin dispersion. Overridden to `R_VALIDATED_FALLBACK = 12` (`calibrateNegBin.js:94`) because the fit exceeded `R_OVERFIT_THRESHOLD = 25` (`:95`, rule `:495-498`) |
| $\kappa$ | 158.84 fitted, **not used by the simulation** | 158.84 | See §9, bug 1 |

The fallback when `negbin_calibration.json` is missing is $\alpha=\ln1.3$, $\gamma=0.15$, $\sigma=250$, $r=8$ (`groupStageNegBin.js:62-67`).

**Group ranking** (`groupStageNegBin.js:315-323`): points (3/1/0), then GD, then GF, then FIFA rank. Head-to-head and fair play are **not** modelled.

**Third-place ranking:** the best 8 thirds by the same keys (`simulateTournament.js:47-57`).

**Assigning thirds to R32 slots:** a first-feasible backtracking search over each slot's eligible-group list (`thirdPlace.js:34-71`, slot order `tournament.js:87`). This approximates FIFA's Annex C table; it does not reproduce it.

**Knockout draws:** if 90-minute goals are level, the match goes straight to penalties (no extra-time simulation). Home wins with probability $0.5+\operatorname{clip}_{[-0.05,0.05]}(\Delta E_{overall}/4000)$ (`knockoutNegBin.js:96-98`), using *overall* Elo.

---

## 4. Calibration method (`calibrateNegBin.js`, run every refresh)

- **Data:** all played results (102 matches = 204 goal observations at HEAD), sorted by date.
- **Likelihood:** $\sum \ln p_{NB}(k\mid\mu,r)$ over home and away goals (`:226-233`).
- **Ratings in the likelihood:**
  - The baseline Att/Def are **re-derived from Stage 1 stats using the trial $\kappa$** (`rederiveBaselineRatings`, `:152-173`).
  - They are then replayed match by match with a simplified update, $\Delta\text{Att}=K_r(g-\mu)$, $\Delta\text{Def}=K_r(\mu_{opp}-g_{opp})$, with $K_r=12$ (`K_GOALS_FOR_REPLAY`, `:187`, applied `:214-221`).
  - The replay has no taper, no ramp, no μ cap and no clean-sheet bonus.
  - The home term is a binary $\gamma$ for any host side (`:129-134`), with no schedule or knockout multiplier.
  - Each match is scored on pre-match ratings, so there is no leakage.
- **Optimiser:** coordinate-wise grid refine (`gridRefineSearch`, `:341-374`).
  - 6 rounds × 5 parameters (`:427-430`), with 13 grid points per scan (`steps = 12`, `:348`).
  - The span halves each round, centred on the current value and clipped to bounds (`:354-357`).
  - It is deterministic: two runs on the same inputs give identical output (checked; see §6).
- **Start values** (`:405-411`): $\alpha=\ln1.3$, $\gamma=0.15$, $\sigma=250$, $\kappa=$ the baseline $\kappa$ (60), $r=8$.
- **Bounds** (`:419-425`):
  - $\alpha\in[\ln0.6,\ln2.5]$
  - $\gamma\in[0,0.8]$
  - $\sigma\in[100,900]$
  - $\kappa\in[40,250]$
  - $r\in[1,40]$
- **Pinned-at-bound rule** (`:454-463`): a parameter within 2% of the range of a bound is flagged.
  - If $\kappa$ is pinned, the recommended $\kappa$ = baseline $\kappa$ (`:491-494`).
  - If $r>25$, the recommended $r=12$ (`:495-498`).
- **Result at HEAD:**
  - Log-likelihood: fitted −286.03 vs placeholder −306.21.
  - `pinnedAtBound: ["r"]`, `overriddenParams: ["r"]`.

**Out-of-sample check** (`validateNegBin.js`, manual, last run 2026-06-21 on 36 matches):
- Rolling origin over matchdays, starting at index 5 (`:92`).
- 5 rounds per train-only fit, start $\kappa=120$, $r$ bound [1,60] (`:95-101`).
- Fixed reference $r\in\{3,5,8,12,20,33.04,60,1000\}$ (`:93`).
- Result (`negbin_validation.json`): 4 splits; pooled best fixed $r=12$ (test LL −112.578 vs −112.771 for $r=1000$ ≈ Poisson). That is a very small margin.
- **It has not been re-run on the full 102 matches.**

---

## 5. Simulation steps, RNG and seeding

Orchestrator: `scripts/sim/runFullNegBinPipeline.js` `main()`, arg `numSimulations` (default 100000, `:57`).

1. `updateEloSplit.main()` writes `elo_current_split.json`.
2. `calibrateNegBin.main()` writes `negbin_calibration.json`.
3. `clearParamsCache()` (`:88-89`), so step 4 reads the new calibration.
4. `runSimulationNegBin.main(N)` (`runSimulationNegBin.js:77-269`). For each of the N tournaments, `simulateTournamentNegBin` (`simulateTournamentNegBin.js:35-144`) runs:
   - **Groups A–L:** a full round robin in fixed pair order (i<j). Known results are applied as fixed, and 8 `rand()` draws are burned per known match to keep the stream aligned (`groupStageNegBin.js:281`).
   - **R32:** from standings, the best-8 thirds and the slot assignment. For a known knockout result, the winner comes from `resolveKnockoutWinner` (90 min, then AET, then penalties, `knockoutResult.js:34-61`), again with 8 burned draws. Otherwise the match is simulated.
   - **R16, QF and SF:** the same, by `ROUND_OF_16_PAIRS` and so on.
   - **Final and third-place playoff are always simulated.** The code does not check `knownByMatchId` here (`simulateTournamentNegBin.js:118-132`; see §9).
   - Counts are collected for stage reach, group positions, (pts, GD, GF) histograms per finishing bucket and R32 opponents (`runSimulationNegBin.js:148-210`).
5. `runScenarioNegBin.main()` (`runScenarioNegBin.js:113+`):
   - **Modal group order:** from 20,000 group simulations per group (`mostLikelyNegBin.js:43-98, 151`). It takes the modal joint ordering and its modal (pts, GD, GF) table.
   - **Best 8 thirds:** ranked by $P(\text{qualify}\mid 3\text{rd})$ estimated from step 4 (`runScenarioNegBin.js:178-205`).
   - **Chalk bracket:** `chalkWinnerNegBin` computes exact W/D/L by summing the joint NB pmf over 0..10 goals (`groupStageNegBin.js:189-200`). The draw is split by the same ±0.05 Elo tilt, and the favourite advances. Known results override this (`mostLikelyNegBin.js:110-139, 217-232`).
   - **Group fixture predictions:** the modal scoreline over 0..7 goals (`groupStageNegBin.js:208-217`).

**RNG:**
- Each tournament gets its own `mulberry32` PRNG (`shared.js:20-27`), seeded with `(Math.random() * 2**31) | 0` (`runSimulationNegBin.js:149`, likewise `mostLikelyNegBin.js:52`).
- **There is no master seed and no seed argument**, so outputs are **not reproducible** run to run.
- Calibration and rating updates are deterministic.

**Monte Carlo error:** the standard error of a probability is $\sqrt{p(1-p)/N}$, about ±0.0015 at $p=0.6$ with $N=100{,}000$. This is not reported by the code.

---

## 6. Checks run for this doc (scratch copy `/tmp/wco`, not the repo)

- `node scripts/sim/runFullNegBinPipeline.js 2000` (Node v24.22.1) completed in 1.0 s.
  - The calibration it produced is identical to the committed `negbin_calibration.json`: fitted α .22, γ .40, σ 575, κ 158.84, r 40; recommended r 12.
- Two runs of the simulation at N=2000 gave Spain pChampion 0.6125 and then 0.6085. This confirms the output is non-deterministic. The committed 100k run shows Spain 0.60541, Argentina 0.39459. Everything else is decided except the final.
- The header comment's timings ("~30s" calibration, "~3min" simulation, `runFullNegBinPipeline.js:37`) date from the group stage. With 102 of 104 results known, a run now takes about 1 s.

---

## 7. Outputs

| File | Content |
|---|---|
| `elo_current_split.json` | Per-team overall/attack/defence, match counts, `matchLog` of per-match deltas, `cleanSheetBonusLog`, constants used |
| `negbin_calibration.json` | Initial, fitted and recommended params, pinned/overridden lists, log-likelihoods, optimisation log |
| `predictions_negbin.json` | `numSimulations`, constants, and per team: `pGroupWinner`, `pRunnerUp`, `pRoundOf32`…`pChampion`, `outcomeScenarios`, `pooledScenarios`, `thirdPlaceScenarios`, `pointsNodes`, `r32Opponents`, `currentStanding`. Scenario labels are shown only if their probability is at least 0.01 (`SCENARIO_THRESHOLD`) or 0.005 (`LABEL_THRESHOLD`) (`shared.js:91-92`) |
| `scenario_negbin.json` | Modal groups (order, probability, modal pts/GD/GF), `allThirds`, `bestThirds`, bracket `r32`…`final`, `thirdPlacePlayoff`, `champion`, next-fixture modal score predictions with a confidence % |
| `negbin_validation.json` | Rolling-origin CV (manual) |

---

## 8. Validation present

- **Unit or regression tests: none.** There is no test directory and `package.json` has no `test` script.
- **Workflow sanity gate** (`.github/workflows/refresh-predictions.yml:32-48`): ΣpChampion must be within 0.01 of 1, and the scenario must have a champion. Otherwise there is no commit.
- **`build-elo-split.yml` gates:** the output must have exactly 48 teams, and it logs zero-match, thin-history and κ status. All 48 canonical names must match the dataset or the script aborts (`buildEloSplit.js:476-485`).
- **Calibration self-checks:** a small-sample warning when there are fewer than 20 matches (`:400-402`) and the pinned-bound warning.
- **Out-of-sample:** `validateNegBin.js` (above), last run 21 Jun 2026.
- **`compareToLive.js`:** compares the legacy scalar ratings with live eloratings.net and flags drift over 15 points (README). This is manual and for the legacy engine only.
- **No backtest** against bookmaker odds or past tournaments was found.

---

## 9. Known limits and bugs noticed

These remain known issues under the 14 Nov 2026 archive decision (t183s760). They are not a work list.


1. **The calibration and the simulation use different rating paths.**
   - Calibration fits (α, γ, σ, r) on ratings rebuilt with the fitted κ (158.84) and a replay K of 12, with no taper, ramp, cap, clean-sheet bonus or home schedule.
   - The simulation uses `elo_current_split.json`, built with κ = 60 and K = 40 with taper, ramp, the μ cap of 3.0 and the clean-sheet bonus.
   - The fitted κ is never applied. The comment at `calibrateNegBin.js:187` says K=12 "matches updateEloSplit.js's current placeholder", but that placeholder is 40 (`updateEloSplit.js:129`).
   - `updateEloSplit.js` also still uses the placeholder α/γ/σ for its expected goals. A faithful replication should copy this behaviour as it is, or fix it deliberately.
2. **Home-term units differ:** binary γ in calibration; γ·H/100 with the schedule and climate in simulation.
3. **The final and the third-place playoff ignore known results** in the Monte Carlo (`simulateTournamentNegBin.js:118-132`). The chalk bracket does honour them.
4. **M103/M104 scores were never entered.** The site has been simulating a final that has already been played since July, and the twice-daily cron keeps committing slightly different numbers (unseeded).
5. **Not reproducible:** there is no master seed (§5).
6. The chalk bracket uses the group α in knockouts (no `KO_GOALS_MULTIPLIER`), while the Monte Carlo applies 0.90 (`mostLikelyNegBin.js:121` vs `knockoutNegBin.js:59-62`).
7. **Simplifications:**
   - One venue per group for climate.
   - No head-to-head or fair-play tiebreaks.
   - Third-slot assignment is first-feasible, not FIFA Annex C.
   - No extra time.
   - Penalties use overall Elo.
   - Goals are independent given μ.
8. **r pinned at its bound:** r = 40 sits on the upper bound and is overridden to 12, using CV evidence from only 36 matches.
9. **Stale README and docs:** the README describes the legacy engine, 20,000 simulations and `scenario.json`/`predictions.json`. `results.json.lastUpdated` = 2026-06-20. `elo-negbin-revised.md` is missing.
10. **Simple CSV parser:** a naive comma split (`buildEloSplit.js:144-156`). It would break on quoted commas.

---

## 10. Reusable methods

Each method below is written so it can be lifted into another model. Under t183s760 the issues named here stay as known issues; they are not fixes to apply in this repo.

### 10.1 Elo-to-goals mapping

**What it is.** A log-linear map from an attack/defence Elo split to expected goals:

\[\ln\mu = \alpha + \gamma\cdot H/100 + \operatorname{clip}_{[-1.5,1.5]}((\mathrm{Att}_A-\mathrm{Def}_D)/\sigma)\]

with a hard cap on \(\mu\) of 3.0 in the rating-update path. The split itself is built from a shrunk, opponent-weighted log-ratio of goals for and against, scaled by a \(\kappa\) in Elo points (§3.1–3.3).

**Where else it applies.** Any rating-to-intensity sports model (football, hockey, or other low-scoring counts). The same “skill difference, clipped, then exp, then a mean cap” shape is the count-data cousin of a logit win-probability model. It does not carry over directly to Novara/novsim asset returns, which shock a return, not a goal mean.

**Known pitfalls (as found in this repo).** The simulation reads fitted \((\alpha,\gamma,\sigma)\) from `negbin_calibration.json`, but `updateEloSplit.js` still uses the placeholder \(\alpha=\ln 1.3\), \(\gamma=0.15\), \(\sigma=250\) when it updates ratings. Home-term units also differ: calibration uses a binary \(\gamma\); the simulation uses \(\gamma\cdot H/100\) plus a host schedule and climate. Climate is imported but unused in knockouts.

### 10.2 Negative binomial dispersion fitting

**What it is.** Goals are \(G\sim\mathrm{NegBin}(\mu,r)\), sampled as a Gamma–Poisson mixture. \(r\) (and \(\alpha,\gamma,\sigma,\kappa\)) are fitted by maximising the held-in-order log-likelihood with a deterministic coordinate-wise grid refine. A pin-at-bound rule then overrides an extreme fit: if fitted \(r>25\), the recommended \(r\) is 12 (`R_VALIDATED_FALLBACK`).

**Where else it applies.** Any over-dispersed count model (match goals, claims, arrivals) where a Poisson is too tight. The “fit, then override a pinned bound with a validated fallback” pattern is reusable. It is not the same problem as Novara-Lite’s Student-t / normal asset shocks, but the idea — fit a tail parameter, then refuse a boundary value — is.

**Known pitfalls.** At HEAD, fitted \(r=40\) sits on the upper bound and is overridden to 12, using rolling-origin evidence from only 36 matches (last run 21 Jun 2026), not the current 102. The fitted \(\kappa=158.84\) is never applied in the simulation, which still builds ratings with \(\kappa=60\). Calibration also replays ratings with \(K=12\), no taper/ramp/cap/clean-sheet bonus, while the live update uses \(K=40\) with all of those. A replication must copy this split behaviour as it is.

### 10.3 Knockout adjustments

**What it is.** Knockout expected goals reuse the same map, then multiply the mean by \(0.90\) (`KO_GOALS_MULTIPLIER`), shrink host advantage to \(H=25\), skip extra time, and break a 90-minute tie with a penalty probability \(0.5+\mathrm{clip}_{[-0.05,0.05]}(\Delta E_{\mathrm{overall}}/4000)\).

**Where else it applies.** Any multi-stage tournament or play-off where the knockout game is tighter and more often tied than the group game. The “scale the mean, then a small Elo-tilted coin flip for the tie-break” pattern can be reused for other cups. It is not used in the retirement engines.

**Known pitfalls.** The chalk (most-likely) bracket uses the group-stage \(\alpha\) and omits the 0.90 multiplier, so chalk and Monte Carlo are not the same knockout model. There is no extra time. Climate is not applied in knockouts. The final and third-place playoff in the Monte Carlo ignore known results (§9.3–9.4).

### 10.4 Calibration and cross-validation

**What it is.** Each played match is scored on pre-match ratings (no leakage). A rolling-origin validation (`validateNegBin.js`) refits on a growing prefix and tests the next matchdays, comparing a fitted \(r\) with a grid of fixed \(r\) values.

**Where else it applies.** Sequential sports models, and more generally any path-dependent calibration that must not peek at the same match it scores. Rolling-origin CV is the standard sibling of the time-series split; the same discipline is useful wherever Novara-style or pipeline models are calibrated on a expanding history (the Investment-Pipeline pre-registration is the governance analogue, not the same statistical tool).

**Known pitfalls.** The calibration rating path is not the simulation rating path (different \(\kappa\), \(K\), home term, and update extras). The out-of-sample file has not been re-run on the full 102-match set. There are no unit tests; the only automated numeric gate is \(\sum p_{\mathrm{Champion}}\approx 1\).

### 10.5 Bracket simulation

**What it is.** For each of \(N\) (default 100,000) tournaments: group round-robins (known results applied, eight RNG draws burned to keep the stream aligned), best-eight thirds, a first-feasible slot assignment, then R32–SF, and always-simulated final and third-place matches. A separate “chalk” path builds a modal group order and a favourite-advances bracket. Each tournament is drawn from a `mulberry32` PRNG.

**Where else it applies.** Any multi-stage knockout (World Cups, domestic cups). The “burn draws on known results so the RNG stays aligned” trick is reusable in any Monte Carlo that mixes fixed and random events. The PRNG itself (`mulberry32`) also appears in Novara-Lite. The outer loop — many independent tournaments, then empirical frequencies — is the same shape as Novara / novsim path-wise Monte Carlo, with a bracket in place of a pot recursion.

**Known pitfalls.** There is no master seed: each tournament is seeded with `(Math.random() * 2**31) | 0`, so runs are not reproducible. The Monte Carlo never consults known results for the final or the third-place playoff, and the two remaining scores were never entered, so the twice-daily job has kept committing slightly different finals after the real final was played. There are no tests.

## 11. Legacy scalar-Elo engine (summary)

- **Win probability** (`eloModel.js`):
  - $dr=(E_H+100\,m+c)-E_A$, with `HOME_ADVANTAGE = 100` (`:11`).
  - $W_e=1/(10^{-dr/400}+1)$ (`:14-16`).
  - $P_D=0.12+(0.26-0.12)e^{-|dr|/400}$ (`:24-31`).
  - $P_W=W_e-P_D/2$, renormalised (`:45-57`).
- **Scorelines** (`groupStage.js`): a W/D/L outcome is drawn first. Then goals are drawn from Poisson with $\lambda_H = 2.0(0.35+P_W)$ and $\lambda_A=2.0(0.35+P_L)$, and forced to agree with the outcome. Group ranking includes a head-to-head mini-league.
- **Rating updates** (`eloUpdate.js`):
  - $K=60$ (`:35`), multiplied by `IN_TOURNAMENT_DELTA_MULTIPLIER = 1.5` (`:39`).
  - Goal-difference weight: 1 for a margin ≤1, 1.5 for 2, $(11+n)/8$ for 3 or more (`:41-46`).
- **Knockouts:** the same penalty tilt. The default N in the README is 20,000; the code default is 100,000 (`runSimulation.js:27`). The seed is unseeded, as in the live engine.

---

## 12. Run recipe

Requires Node ≥ 18 (`package.json` engines; CI uses Node 20). There are no npm dependencies.

```bash
git clone https://github.com/Tangerineman83/World-Cup-Odds && cd World-Cup-Odds
# optional, needs network: rebuild the baseline split from martj42 + elo_baseline.json
node scripts/sim/buildEloSplit.js           # writes elo_baseline_split.json (manual; workflow build-elo-split.yml)
# full live pipeline (ratings -> calibration -> Monte Carlo -> scenario)
node scripts/sim/runFullNegBinPipeline.js 100000
# optional diagnostics
node scripts/sim/validateNegBin.js          # rolling-origin CV -> negbin_validation.json
node scripts/sim/compareToLive.js           # legacy-engine drift vs eloratings.net (network)
```

- **Entry function:** `runFullNegBinPipeline.js` → `main()`. The phase functions are each exported as `main()` from their own files.
- **Inputs to edit:** `results.json` only.
- **To make it reproducible:** replace `Math.random()` at `runSimulationNegBin.js:149` and `mostLikelyNegBin.js:52` with a seeded master PRNG (e.g. `mulberry32(SEED)`). That is a code change and has not been made.

## 13. Parameters marked unknown

- The contents of `elo-negbin-revised.md` (the cited design and calibration note) are unknown: it is not in the repo.
- How the hand-picked climate lists, the venue bands, the home-advantage schedule `[1, 0.75, 0.5]`, the KO multiplier 0.90, the clean-sheet constants and the penalty tilt 1/4000 were derived is unknown. Their values are in the code, but no calibration source is given.
- The exact martj42 dataset commit or vintage used for `elo_baseline_split.json` is unknown. Only the run time (2026-06-29) is recorded.
