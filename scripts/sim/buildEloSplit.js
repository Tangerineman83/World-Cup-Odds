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
const KAPPA_PLACEHOLDER = 120;

// --- Team name reconciliation -----------------------------------------
//
// Canonical names (this project's names, matching countryMap.js values and
// elo_baseline.json keys) -> the name(s) this dataset uses. Most of the 48
// teams match directly; this table only needs entries where they differ.
// Compiled from the dataset's documented "current name" convention plus
// known FIFA naming differences. MUST be verified against actual fetched
// data (see verifyTeamCoverage below) before trusting the output - this
// table is a best-effort starting point, not a guarantee.
const CANONICAL_TO_DATASET_NAME = {
  'USA': 'United States',
  'South Korea': 'South Korea', // dataset uses "South Korea" not "Korea Republic" - verify
  'Ivory Coast': "Ivory Coast", // dataset may use "Côte d'Ivoire" - verify
  'Congo DR': 'DR Congo', // dataset may use "DR Congo" or "Congo DR" - verify
  'Turkiye': 'Turkey', // dataset predates the 2022 FIFA rebrand to "Turkiye" - verify
  'Curacao': 'Curaçao', // accented in source data - normalized on match, see normalizeName
  'Bosnia-Herzegovina': 'Bosnia and Herzegovina', // verify exact dataset spelling
  'Czechia': 'Czechia', // dataset may still use "Czech Republic" pre-rename - verify
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
// names (or their aliased dataset equivalent) actually appears in the
// fetched data. Fails loudly rather than silently producing a baseline with
// missing/zero teams - this is the safeguard against the alias table above
// being wrong or incomplete.
function verifyTeamCoverage(rows, canonicalNames) {
  const datasetNames = new Set();
  for (const r of rows) {
    datasetNames.add(normalizeName(r.home_team));
    datasetNames.add(normalizeName(r.away_team));
  }

  const missing = [];
  const resolved = {};
  for (const canonical of canonicalNames) {
    const aliasTarget = CANONICAL_TO_DATASET_NAME[canonical] || canonical;
    const normalized = normalizeName(aliasTarget);
    if (datasetNames.has(normalized)) {
      resolved[canonical] = aliasTarget;
    } else {
      missing.push({ canonical, triedAs: aliasTarget });
    }
  }

  return { resolved, missing };
}

// --- GF/GA computation -----------------------------------------------------
//
// For each canonical team, walk the dataset (filtered to before the
// tournament cutoff), take the most recent CALIBRATION_WINDOW_MATCHES
// matches the team played (as either home or away), and compute average
// goals-for and goals-against per match over that window.
function computeTeamGoalStats(rows, resolvedNames, cutoffDate, windowSize) {
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

    if (homeCanonical) {
      byTeam[homeCanonical].push({ date: r.date, gf: homeGoals, ga: awayGoals });
    }
    if (awayCanonical) {
      byTeam[awayCanonical].push({ date: r.date, gf: awayGoals, ga: homeGoals });
    }
  }

  const stats = {};
  for (const [canonical, matches] of Object.entries(byTeam)) {
    matches.sort((a, b) => a.date.localeCompare(b.date));
    const windowMatches = matches.slice(-windowSize);
    const n = windowMatches.length;
    const gfTotal = windowMatches.reduce((sum, m) => sum + m.gf, 0);
    const gaTotal = windowMatches.reduce((sum, m) => sum + m.ga, 0);
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
      gfPerMatch: n > 0 ? gfTotal / n : null,
      gaPerMatch: n > 0 ? gaTotal / n : null,
      windowStart,
      windowEnd,
      thinHistory: spanYears > 3,
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
  const { resolved, missing } = verifyTeamCoverage(rows, canonicalNames);
  if (missing.length > 0) {
    console.error('ERROR: the following teams could not be matched in the dataset:');
    for (const m of missing) {
      console.error(`  - ${m.canonical} (tried as "${m.triedAs}")`);
    }
    console.error('Add/fix entries in CANONICAL_TO_DATASET_NAME and re-run.');
    console.error('Aborting - no output written, to avoid a baseline with missing teams.');
    process.exitCode = 1;
    return;
  }
  console.log(`  All ${canonicalNames.length} teams matched.`);

  console.log(`Computing GF/GA over the last ${CALIBRATION_WINDOW_MATCHES} matches per team (before ${TOURNAMENT_CUTOFF_DATE})...`);
  const goalStats = computeTeamGoalStats(rows, resolved, TOURNAMENT_CUTOFF_DATE, CALIBRATION_WINDOW_MATCHES);

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
  CANONICAL_TO_DATASET_NAME,
};
