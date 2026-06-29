// buildEloSplit.js
//
// PHASE 1 (data sourcing + ELOa/ELOd derivation) of the dual-Elo Negative
// Binomial project. This script is STANDALONE and ADDITIVE:
//   - It does not modify elo_baseline.json, eloModel.js, eloUpdate.js,
//     groupStage.js, or anything currently driving the live site.
//   - It reads the existing elo_baseline.json (scalar ratings) and the
//     existing countryMap.js (canonical 48 team names) as inputs.
//   - It writes a NEW file, elo_baseline_split.json, containing per-team
//     { overall, attack, defense } ratings plus the underlying GF/GA stats
//     used to derive them, for later phases to consume.
//
// Run with: node buildEloSplit.js
//
// Data source: martj42/international_results (GitHub), a free, no-key,
// community-maintained dataset of men's full international results from
// 1872 to present, updated daily (more frequently during major tournaments).
// Columns (verified against the live file): date, home_team, away_team,
// home_score, away_score, tournament, city, country, neutral.
// This is NOT an official FIFA source - it's a widely-used community dataset
// (used by, among others, the Alan Turing Institute's own international
// football prediction model). Spot-check a handful of recent results against
// another source (e.g. Wikipedia) before fully trusting a fresh pull.
//
// IMPORTANT CAVEAT: this dataset uses "current" team names (e.g. a 1950s
// match involving a since-renamed federation is labelled with today's name),
// which mostly helps matching but can occasionally surprise you for teams
// that have changed name/identity. See TEAM_NAME_ALIASES below for the
// specific reconciliation needed against this project's canonical names
// (countryMap.js / elo_baseline.json keys).

const fs = require('fs');
const path = require('path');

const RESULTS_CSV_URL = 'https://raw.githubusercontent.com/martj42/international_results/master/results.csv';

const BASELINE_PATH = path.join(__dirname, '..', '..', 'elo_baseline.json');
const OUTPUT_PATH = path.join(__dirname, '..', '..', 'elo_baseline_split.json');

// How many of each team's most recent matches (prior to the tournament) to
// use for the GF/GA calibration window. Chosen as a starting point per the
// phased plan - revisit once Phase 1 output is reviewed. Matches are
// filtered to the cutoff date below before taking the most recent N, so
// "recent" means recent relative to the tournament, not relative to today.
const CALIBRATION_WINDOW_MATCHES = 20;

// GOAL_MARGIN_CAP: a single historical match's goal margin is capped at
// this value before being added to either team's gf/ga totals - e.g. a 6-0
// result is treated as 3-0 (winner's tally reduced to loser's goals + cap;
// see capMatchMargin below for the exact rule). Addresses a real, traced
// case: Canada's pre-tournament gaPerMatch (0.55, very low) was already
// baked in before any 2026 matches were played, from their full 20-match
// historical window - capping protects against any single extreme
// historical result (e.g. a blowout where the opponent finished a player
// or two down, or any other unusual one-off circumstance) being weighted
// as if it were a fully representative result. One unusual match shouldn't
// carry the same evidential weight in a 20-match average as a normal one.
//
// HONEST LIMITATION: this only helps if a team's low GA (or high GF) comes
// from a FEW extreme outlier matches. If it instead comes from a broad
// pattern of generally weaker opposition across many matches (e.g. a
// schedule with many low-scoring-against results, none of them
// individually "extreme"), capping each match's margin won't meaningfully
// change the average - that's the separate, harder problem of adjusting
// for opponent strength, not addressed here. Check whether this materially
// moved a disputed team's numbers after re-running, rather than assuming
// it resolved them outright.
const GOAL_MARGIN_CAP = 3;

// Caps a single match's goal margin: the winning side's tally is reduced
// to (loser's goals + GOAL_MARGIN_CAP) if the raw margin exceeds the cap -
// e.g. 6-0 (margin 6) -> 3-0; 5-1 (margin 4) -> 4-1; 4-1 (margin 3, already
// at the cap) -> unchanged. Draws (margin 0) are never affected.
function capMatchMargin(gf, ga) {
  const margin = gf - ga;
  if (Math.abs(margin) <= GOAL_MARGIN_CAP) return { gf, ga };
  if (margin > 0) return { gf: ga + GOAL_MARGIN_CAP, ga };
  return { gf, ga: gf + GOAL_MARGIN_CAP };
}

// Only matches strictly before this date are eligible for the baseline
// calibration window, so no in-tournament 2026 results leak into what's
// meant to be a PRE-tournament baseline. Matches eloBaseline.js's existing
// rationale of a frozen pre-tournament starting point.
const TOURNAMENT_CUTOFF_DATE = '2026-06-11';

// Elo-points-per-log-unit scaling constant for converting a team's GF/GA
// ratio (relative to the 48-team baseline) into an Elo delta. THIS IS A
// PLACEHOLDER STARTING VALUE, not a fitted constant - per the revised paper
// (Section 5), kappa should be fitted by regression once we have a first
// pass of output to examine, not hand-picked. Flagging clearly so it isn't
// mistaken for a calibrated figure.
//
// Reduced from 80 to 60. Reduced from 120 to 80. At 120, teams with extreme GA ratios (e.g.
// Ecuador at 0.35 GA/match vs pool average 0.98) received defence bonuses
// of 120+ Elo points over their overall rating — landing them 4th in the
// world defensively despite an overall rating of 1938. At 80 the same team
// gets a ~82-point bonus (defence ~2020), which preserves the directional
// signal (Ecuador genuinely defended well in CONMEBOL qualifying) while
// keeping the magnitude proportionate to their overall quality.
const KAPPA_PLACEHOLDER = 60;

// --- Team name reconciliation -----------------------------------------
//
// Canonical names (this project's names, matching countryMap.js values and
// elo_baseline.json keys) -> a LIST of candidate names this dataset might
// use, tried in order. Most of the 48 teams match directly (no entry
// needed); this table only needs entries where the canonical name might
// differ from the dataset's name. Using a list (not a single guess) means
// a wrong first guess degrades to "try the next candidate" instead of a
// hard failure - verifyTeamCoverage records exactly which candidate
// actually matched, so the resolution is logged, not silently assumed.
const CANONICAL_TO_DATASET_NAME = {
  'USA': ['United States'],
  'South Korea': ['South Korea', 'Korea Republic', 'Korea South'],
  'Ivory Coast': ['Ivory Coast', "Côte d'Ivoire", "Cote d'Ivoire"],
  'Congo DR': ['DR Congo', 'Congo DR', 'Democratic Republic of the Congo'],
  'Turkiye': ['Turkey', 'Türkiye', 'Turkiye'],
  'Curacao': ['Curaçao', 'Curacao'],
  'Bosnia-Herzegovina': ['Bosnia and Herzegovina', 'Bosnia-Herzegovina'],
  // First failure encountered in practice: "Czechia" alone did not match
  // (confirmed via a real GitHub Actions run, 2026-06-21) - the dataset
  // most likely retains the pre-2016-rename "Czech Republic", per its own
  // documented "current name as of when the dataset entry was last
  // updated" convention not always being perfectly current for every
  // recent rename. Trying both, in this order, rather than guessing again.
  'Czechia': ['Czech Republic', 'Czechia'],
};

function normalizeName(name) {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

// --- CSV parsing ---------------------------------------------------------
//
// Minimal CSV parser sufficient for this dataset's format (no embedded
// commas/quotes in the columns we use - city/country values are plain).
// If the upstream file ever introduces quoted fields with embedded commas,
// swap this for a proper CSV library (e.g. csv-parse).
function parseCsv(text) {
  const lines = text.split('\n').filter((l) => l.trim().length > 0);
  const header = lines[0].split(',');
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    if (cols.length < header.length) continue; // skip malformed trailing lines
    const row = {};
    header.forEach((h, idx) => { row[h.trim()] = cols[idx]; });
    rows.push(row);
  }
  return rows;
}

async function fetchResultsCsv() {
  const res = await fetch(RESULTS_CSV_URL);
  if (!res.ok) {
    throw new Error(`Failed to fetch results.csv: HTTP ${res.status}`);
  }
  const text = await res.text();
  return parseCsv(text);
}

// --- Team coverage verification ------------------------------------------
//
// Before computing anything, confirm every one of the 48 canonical team
// names resolves to SOME name actually present in the fetched data, trying
// each candidate in CANONICAL_TO_DATASET_NAME (or the canonical name itself
// if no entry exists) in order and recording which one matched. Fails
// loudly only if NONE of a team's candidates match - this is the safeguard
// against the alias table being wrong, while no longer hard-failing on a
// single wrong first guess the way a single-string table would.
function verifyTeamCoverage(rows, canonicalNames) {
  const datasetNames = new Set();
  for (const r of rows) {
    datasetNames.add(normalizeName(r.home_team));
    datasetNames.add(normalizeName(r.away_team));
  }

  const missing = [];
  const resolved = {};
  const resolutionLog = []; // for visibility into which candidate matched, per team
  for (const canonical of canonicalNames) {
    const candidates = CANONICAL_TO_DATASET_NAME[canonical] || [canonical];
    let matched = null;
    for (const candidate of candidates) {
      if (datasetNames.has(normalizeName(candidate))) {
        matched = candidate;
        break;
      }
    }
    if (matched) {
      resolved[canonical] = matched;
      resolutionLog.push({ canonical, matched, triedFirst: candidates[0], usedFallback: matched !== candidates[0] });
    } else {
      missing.push({ canonical, triedAs: candidates });
    }
  }

  return { resolved, missing, resolutionLog };
}

// --- GF/GA computation -----------------------------------------------------
//
// --- Opponent-strength weighting ------------------------------------------
//
// PROBLEM THIS SOLVES: a flat (unweighted) average of GF/GA over a team's
// last 20 historical matches treats a clean sheet against a top-10 side
// identically to a clean sheet against a side ranked 80th. Traced, real
// case: Canada's baseline gaPerMatch (0.55 over 20 matches) was already
// elevating their pre-tournament defense rating to within range of
// genuine elite sides (~1830, comparable to Germany's OVERALL rating)
// despite Canada's own overall rating (1767) correctly showing them as a
// clearly weaker side - because a flat average can't distinguish "20
// matches of genuinely world-class defending" from "20 matches against a
// schedule that happens to be weaker on average than Germany's or the
// Netherlands' schedule". This is the more rigorous fix, beyond
// GOAL_MARGIN_CAP (which only catches a few extreme single-match outliers,
// and was confirmed - via cappedMatchCount - to barely move Canada's
// number at all).
//
// METHOD: each historical match's contribution to a team's gf/ga average
// is weighted by how strong the opponent was, RELATIVE to the 48-team
// World Cup pool's own average overall Elo (elo_baseline.json - already
// the trusted, in-use rating for the live site, not a new external
// source). A match against an opponent ABOVE the pool average gets weight
// > 1 (counts for more); a match against an opponent BELOW the pool
// average gets weight < 1 (counts for less). This directly fixes the
// Canada-style case: their many low-GA results, mostly presumably against
// weaker CONCACAF opposition, will now be down-weighted rather than taken
// at full face value.
//
// HONEST LIMITATION 1 - COVERAGE: elo_baseline.json only contains the 48
// teams that qualified for THIS World Cup, not the full universe of
// national teams Canada (or any team) actually played historically -
// e.g. Caribbean/Central American sides that didn't qualify won't be
// found. An opponent not found in elo_baseline.json gets NEUTRAL weight
// (1.0, the pool average) rather than being dropped or assumed weak/strong
// - "no information" should not silently bias the result in either
// direction. opponentCoverage in the output reports exactly what
// fraction of each team's window had a real (non-neutral-fallback) weight
// applied, so this gap is visible, not hidden.
//
// HONEST LIMITATION 2 - CURRENT, NOT HISTORICAL, OPPONENT STRENGTH:
// elo_baseline.json is a single CURRENT snapshot (pre-2026-tournament),
// used here even for matches played 1-2 years earlier in a team's
// calibration window. This assumes opponents' relative strength hasn't
// shifted dramatically over that window - reasonable for most teams over
// ~1-2 years, weaker for any team whose rating has moved a lot recently. A
// genuinely time-varying historical rating source was investigated
// (FIFA's own historical rankings via third-party mirrors) but the best
// available free source only covers up to September 2024, leaving a real
// gap for the more recent half of most teams' windows - using
// elo_baseline.json was chosen as the more consistent single limitation
// over two different partial-coverage data sources compounding each
// other.
const OPPONENT_WEIGHT_SCALE = 400; // Elo points - how strongly opponent strength affects the weight; matches the conventional Elo expected-score scale (eloModel.js's own logistic uses a similar order of magnitude)
const OPPONENT_WEIGHT_MIN = 0.4; // floor, so an extremely weak known opponent doesn't reduce a match's weight to near-zero
const OPPONENT_WEIGHT_MAX = 2.5; // ceiling, so an extremely strong known opponent doesn't dominate the average

function computeOpponentWeight(opponentCanonicalName, overallEloByName, poolAverageElo) {
  if (!opponentCanonicalName || overallEloByName[opponentCanonicalName] == null) {
    // Unknown opponent (not in our 48-team pool, e.g. a non-qualified
    // CONCACAF/regional side) - neutral weight, not a penalty or bonus.
    return { weight: 1, knownOpponent: false };
  }
  const opponentElo = overallEloByName[opponentCanonicalName];
  const eloDiff = opponentElo - poolAverageElo;
  const rawWeight = 1 + eloDiff / OPPONENT_WEIGHT_SCALE;
  const weight = Math.max(OPPONENT_WEIGHT_MIN, Math.min(OPPONENT_WEIGHT_MAX, rawWeight));
  return { weight, knownOpponent: true };
}

// For each canonical team, walk the dataset (filtered to before the
// tournament cutoff), take the most recent CALIBRATION_WINDOW_MATCHES
// matches the team played (as either home or away), and compute average
// goals-for and goals-against per match over that window.
function computeTeamGoalStats(rows, resolvedNames, cutoffDate, windowSize, overallEloByName) {
  const byTeam = {}; // canonical name -> array of { date, gf, ga }
  // Initialize every canonical team up front (not just ones with matches),
  // so a team with zero matches in the data still gets a proper { matchesUsed: 0 }
  // entry downstream, rather than being silently absent from goalStats.
  for (const canonical of Object.keys(resolvedNames)) {
    byTeam[canonical] = [];
  }

  const nameToCanonical = {};
  for (const [canonical, datasetName] of Object.entries(resolvedNames)) {
    nameToCanonical[normalizeName(datasetName)] = canonical;
  }

  for (const r of rows) {
    if (!r.date || r.date >= cutoffDate) continue;
    const homeGoals = Number(r.home_score);
    const awayGoals = Number(r.away_score);
    if (!Number.isFinite(homeGoals) || !Number.isFinite(awayGoals)) continue;

    const homeCanonical = nameToCanonical[normalizeName(r.home_team)];
    const awayCanonical = nameToCanonical[normalizeName(r.away_team)];

    // Cap the margin ONCE per match (not independently per side) so both
    // teams' records of the same match stay mutually consistent - e.g. a
    // 6-0 capped to 3-0 should appear as gf=3,ga=0 for the winner and
    // gf=0,ga=3 for the loser, not two different cap decisions.
    const capped = capMatchMargin(homeGoals, awayGoals);
    const cappedHomeGoals = capped.gf;
    const cappedAwayGoals = capped.ga;
    const wasCapped = cappedHomeGoals !== homeGoals || cappedAwayGoals !== awayGoals;

    if (homeCanonical) {
      byTeam[homeCanonical].push({ date: r.date, gf: cappedHomeGoals, ga: cappedAwayGoals, wasCapped, opponent: awayCanonical || null });
    }
    if (awayCanonical) {
      byTeam[awayCanonical].push({ date: r.date, gf: cappedAwayGoals, ga: cappedHomeGoals, wasCapped, opponent: homeCanonical || null });
    }
  }

  const stats = {};
  const poolAverageElo = average(Object.values(overallEloByName));
  for (const [canonical, matches] of Object.entries(byTeam)) {
    matches.sort((a, b) => a.date.localeCompare(b.date));
    const windowMatches = matches.slice(-windowSize);
    const n = windowMatches.length;

    // Weighted average: each match's gf/ga contributes proportionally to
    // its opponent-strength weight (see computeOpponentWeight), not
    // equally. A weight of 1.5 means that match counts 1.5x as much toward
    // the average as a neutral (weight-1.0) match would.
    let weightedGfSum = 0;
    let weightedGaSum = 0;
    let totalWeight = 0;
    let knownOpponentCount = 0;
    for (const m of windowMatches) {
      const { weight, knownOpponent } = computeOpponentWeight(m.opponent, overallEloByName, poolAverageElo);
      weightedGfSum += m.gf * weight;
      weightedGaSum += m.ga * weight;
      totalWeight += weight;
      if (knownOpponent) knownOpponentCount++;
    }
    // Weighted average per match - totalWeight, not n, is the correct
    // denominator here (using n would silently under/over-count relative
    // to the weights actually applied).
    const gfPerMatchWeighted = n > 0 ? weightedGfSum / totalWeight : null;
    const gaPerMatchWeighted = n > 0 ? weightedGaSum / totalWeight : null;
    const opponentCoverage = n > 0 ? round2(knownOpponentCount / n) : null;
    const cappedCount = windowMatches.filter((m) => m.wasCapped).length;
    const windowStart = n > 0 ? windowMatches[0].date : null;
    const windowEnd = n > 0 ? windowMatches[n - 1].date : null;
    // If the window's matches span more than ~3 years, this team has thin
    // recent fixture history - the "recent form" assumption behind the
    // calibration window is weaker for them than for a team whose last 20
    // matches all happened in the last year or two. Surfaced as a flag
    // rather than silently treated the same as a well-sampled team.
    const spanYears = (n > 1) ? (new Date(windowEnd) - new Date(windowStart)) / (1000 * 60 * 60 * 24 * 365) : 0;
    stats[canonical] = {
      matchesUsed: n,
      gfPerMatch: gfPerMatchWeighted,
      gaPerMatch: gaPerMatchWeighted,
      windowStart,
      windowEnd,
      thinHistory: spanYears > 3,
      cappedMatchCount: cappedCount,
      opponentCoverage,
    };
  }
  return stats;
}

// --- ELOa / ELOd derivation -------------------------------------------------
//
// ELO_attack  = overall + shrink * kappa * ln(GF_team / GF_baseline)
// ELO_defense = overall - shrink * kappa * ln(GA_team / GA_baseline)
//
// where GF_baseline / GA_baseline are the unweighted average across all 48
// teams' window stats, and `shrink` = min(1, matchesUsed / windowSize) is a
// confidence weight: a team with a full window of matches gets the full
// attack/defense split, a team with only a handful of matches gets a
// proportionally damped split (pulled toward overall), and a team with zero
// matches collapses exactly to attack = defense = overall. This avoids
// treating thin historical data as if it were as reliable as a full window,
// without needing a separate "fallback to overall" special case - it falls
// out of the same formula at matchesUsed = 0.
//
// A team with exactly-average scoring/conceding (or zero matches) gets
// ELO_attack = ELO_defense = ELO_overall, recovering the monolithic model
// as a special case - see Section 3 of the revised methodology paper.
function deriveEloSplit(overallRatings, goalStats, kappa, windowSize) {
  const teams = Object.keys(goalStats).filter((t) => goalStats[t].matchesUsed > 0);

  const gfBaseline = average(teams.map((t) => goalStats[t].gfPerMatch));
  const gaBaseline = average(teams.map((t) => goalStats[t].gaPerMatch));

  const split = {};
  for (const team of Object.keys(goalStats)) {
    const overall = overallRatings[team];
    const g = goalStats[team];

    if (overall == null) {
      split[team] = { error: 'no overall Elo baseline found for this team' };
      continue;
    }
    if (g.matchesUsed === 0) {
      // Zero matches: shrink factor is 0, so attack/defense collapse to
      // overall exactly. Still flagged with a warning so it's visible which
      // teams got no real signal at all, distinct from teams that got a
      // shrunk-but-nonzero adjustment.
      split[team] = {
        overall,
        attack: overall,
        defense: overall,
        shrinkFactor: 0,
        matchesUsed: 0,
        warning: 'no matches found in calibration window - attack/defense fall back to overall (shrinkFactor 0)',
      };
      continue;
    }

    const shrinkFactor = round2(Math.min(1, g.matchesUsed / windowSize));
    // Floor goals-per-match at a small epsilon before taking the log ratio.
    // A team that has been shut out (0 goals for, or 0 conceded) in its
    // window would otherwise produce ln(0) = -Infinity. 0.1 is a soft floor
    // equivalent to "conceded/scored about 1 goal every 10 matches" - low
    // enough not to distort teams with any real scoring/conceding record,
    // but finite.
    const gfSafe = Math.max(g.gfPerMatch, 0.1);
    const gaSafe = Math.max(g.gaPerMatch, 0.1);
    const attackDelta = shrinkFactor * kappa * Math.log(gfSafe / gfBaseline);
    const defenseDelta = shrinkFactor * kappa * Math.log(gaSafe / gaBaseline);

    split[team] = {
      overall,
      attack: round2(overall + attackDelta),
      defense: round2(overall - defenseDelta),
      shrinkFactor,
      gfPerMatch: round2(g.gfPerMatch),
      gaPerMatch: round2(g.gaPerMatch),
      matchesUsed: g.matchesUsed,
      windowStart: g.windowStart,
      windowEnd: g.windowEnd,
      thinHistory: g.thinHistory,
      cappedMatchCount: g.cappedMatchCount,
      opponentCoverage: g.opponentCoverage,
    };
  }

  return { split, gfBaseline: round2(gfBaseline), gaBaseline: round2(gaBaseline) };
}

function average(values) {
  const valid = values.filter((v) => v != null && Number.isFinite(v));
  return valid.reduce((a, b) => a + b, 0) / valid.length;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// --- Main ------------------------------------------------------------------

async function main() {
  console.log('Loading existing pre-tournament Elo baseline...');
  const baselineRaw = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf-8'));
  const overallRatings = baselineRaw.ratings;
  const canonicalNames = Object.keys(overallRatings);
  console.log(`  ${canonicalNames.length} teams in elo_baseline.json`);

  console.log(`Fetching historical results from ${RESULTS_CSV_URL} ...`);
  const rows = await fetchResultsCsv();
  console.log(`  ${rows.length} rows parsed`);

  console.log('Verifying team name coverage against canonical 48...');
  const { resolved, missing, resolutionLog } = verifyTeamCoverage(rows, canonicalNames);
  if (missing.length > 0) {
    console.error('ERROR: the following teams could not be matched in the dataset (none of their candidate names found):');
    for (const m of missing) {
      console.error(`  - ${m.canonical} (tried: ${m.triedAs.map((c) => `"${c}"`).join(', ')})`);
    }
    console.error('Add another candidate to CANONICAL_TO_DATASET_NAME[<team>] and re-run.');
    console.error('Aborting - no output written, to avoid a baseline with missing teams.');
    process.exitCode = 1;
    return;
  }
  console.log(`  All ${canonicalNames.length} teams matched.`);
  const usedFallback = resolutionLog.filter((r) => r.usedFallback);
  if (usedFallback.length > 0) {
    console.log(`  Note: ${usedFallback.length} team(s) matched via a fallback candidate, not the first guess:`);
    for (const r of usedFallback) {
      console.log(`    - ${r.canonical}: matched as "${r.matched}" (first guess "${r.triedFirst}" did not match)`);
    }
  }

  console.log(`Computing GF/GA over the last ${CALIBRATION_WINDOW_MATCHES} matches per team (before ${TOURNAMENT_CUTOFF_DATE})...`);
  const goalStats = computeTeamGoalStats(rows, resolved, TOURNAMENT_CUTOFF_DATE, CALIBRATION_WINDOW_MATCHES, overallRatings);

  const sparse = Object.entries(goalStats).filter(([, s]) => s.matchesUsed < CALIBRATION_WINDOW_MATCHES || s.thinHistory);
  if (sparse.length > 0) {
    console.log(`  Note: ${sparse.length} team(s) have incomplete or thinly-spread recent history:`);
    for (const [team, s] of sparse) {
      const reasons = [];
      if (s.matchesUsed < CALIBRATION_WINDOW_MATCHES) reasons.push(`only ${s.matchesUsed} matches found`);
      if (s.thinHistory) reasons.push(`window spans ${s.windowStart} to ${s.windowEnd} (unusually wide)`);
      console.log(`    - ${team}: ${reasons.join('; ')}`);
    }
  }

  // Capped-match summary - see GOAL_MARGIN_CAP's own comment for why this
  // matters: if very few matches were actually capped for a team whose
  // numbers still look like an outlier, that's real evidence the cap
  // ISN'T the fix for that team (their numbers come from a broad pattern
  // across many matches, not a few extreme ones) - surfaced here so that's
  // checkable at a glance rather than discovered by re-deriving it later.
  const teamsWithCappedMatches = Object.entries(goalStats).filter(([, s]) => s.cappedMatchCount > 0);
  const totalCappedAcrossField = teamsWithCappedMatches.reduce((sum, [, s]) => sum + s.cappedMatchCount, 0);
  console.log(`  Goal-margin cap (+/-${GOAL_MARGIN_CAP}): ${totalCappedAcrossField} historical match-observations capped across ${teamsWithCappedMatches.length} team(s).`);
  if (teamsWithCappedMatches.length > 0) {
    const sortedByCapped = teamsWithCappedMatches.sort((a, b) => b[1].cappedMatchCount - a[1].cappedMatchCount);
    console.log('  Most-affected teams:', sortedByCapped.slice(0, 8).map(([team, s]) => `${team} (${s.cappedMatchCount})`).join(', '));
  }

  // Opponent-strength weighting coverage summary - see
  // computeOpponentWeight's own comment for why low coverage matters: a
  // team whose historical opponents are mostly OUTSIDE our 48-team pool
  // (e.g. a heavy CONCACAF/regional schedule) gets little real benefit
  // from this weighting, since most of their matches fall back to neutral
  // weight 1.0 for lack of a known opponent rating - surfaced here so
  // that's visible per-team, not just assumed to have helped.
  const coverageEntries = Object.entries(goalStats).filter(([, s]) => s.opponentCoverage != null);
  const avgCoverage = coverageEntries.length > 0
    ? round2(coverageEntries.reduce((sum, [, s]) => sum + s.opponentCoverage, 0) / coverageEntries.length)
    : null;
  console.log(`  Opponent-strength weighting coverage: ${Math.round((avgCoverage || 0) * 100)}% average across the field (i.e. this fraction of each team's window had an opponent found in our 48-team pool and thus a real, non-neutral weight).`);
  const lowestCoverage = coverageEntries.sort((a, b) => a[1].opponentCoverage - b[1].opponentCoverage).slice(0, 8);
  console.log('  Lowest-coverage teams (weighting has least to work with for these):', lowestCoverage.map(([team, s]) => `${team} (${Math.round(s.opponentCoverage * 100)}%)`).join(', '));

  console.log('Deriving ELOa / ELOd split with confidence-weighted shrinkage (kappa is a placeholder - see header comment)...');
  const { split, gfBaseline, gaBaseline } = deriveEloSplit(overallRatings, goalStats, KAPPA_PLACEHOLDER, CALIBRATION_WINDOW_MATCHES);

  const output = {
    generatedAt: new Date().toISOString(),
    source: RESULTS_CSV_URL,
    baselineSource: baselineRaw.source,
    baselineFetchedAt: baselineRaw.fetchedAt,
    tournamentCutoffDate: TOURNAMENT_CUTOFF_DATE,
    calibrationWindowMatches: CALIBRATION_WINDOW_MATCHES,
    kappa: KAPPA_PLACEHOLDER,
    kappaStatus: 'PLACEHOLDER - not yet fitted by regression, see Section 5 of elo-negbin-revised.md',
    gfBaseline,
    gaBaseline,
    ratings: split,
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
  console.log(`\nWritten: ${OUTPUT_PATH}`);
  console.log('This file is NEW and ADDITIVE - elo_baseline.json and all current');
  console.log('app behaviour are unchanged. Nothing currently reads elo_baseline_split.json.');
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Fatal error:', err);
    process.exitCode = 1;
  });
}

module.exports = {
  parseCsv,
  normalizeName,
  verifyTeamCoverage,
  computeTeamGoalStats,
  deriveEloSplit,
  capMatchMargin,
  computeOpponentWeight,
  CANONICAL_TO_DATASET_NAME,
};
