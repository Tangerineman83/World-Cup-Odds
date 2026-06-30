// knockoutResult.js
//
// Single shared source of truth for "who actually won this knockout match",
// given a result record from results.json. Knockout matches can be decided
// at three different points, and EVERY consumer of a known knockout result
// needs to check them in the same order:
//
//   1. 90-minute score (homeGoals/awayGoals) — if not level, this decides it.
//   2. Extra time score (aetHomeGoals/aetAwayGoals) — only meaningful when
//      homeGoals===awayGoals at 90. If AET score is also not level, this
//      decides it (rare in practice — most AET draws still go to penalties,
//      but a golden-goal-style late winner is structurally possible and the
//      schema supports it).
//   3. penaltyWinner ('home'|'away') — only used when still level after AET
//      (or after 90 minutes if no AET fields are present, since not every
//      data source will populate them).
//
// Centralising this logic avoids the bug class where one consumer (e.g. the
// bracket-building code) checks penaltyWinner correctly but another (e.g.
// an Elo-update helper) only checks 90-minute goals and silently mishandles
// a penalty-shootout match - this happened in practice when AET/penalty
// awareness was added to some call sites but not others; see project history.
//
// Returns: { winnerName, loserName, decidedBy } where decidedBy is one of
// '90min' | 'aet' | 'penalties' | null (null only if the match cannot yet
// be resolved - e.g. level after 90 with no AET/penaltyWinner recorded,
// which should not happen once a knockout match has actually finished, but
// is handled gracefully rather than throwing).
//
// `result` shape: { home, away, homeGoals, awayGoals, aetHomeGoals,
// aetAwayGoals, penaltyWinner }. aetHomeGoals/aetAwayGoals/penaltyWinner are
// all optional - omitted or null is treated identically (not yet known /
// not applicable).
function resolveKnockoutWinner(result) {
  const { home, away, homeGoals, awayGoals, aetHomeGoals, aetAwayGoals, penaltyWinner } = result;

  // 1. 90-minute score
  if (homeGoals > awayGoals) return { winnerName: home, loserName: away, decidedBy: '90min' };
  if (awayGoals > homeGoals) return { winnerName: away, loserName: home, decidedBy: '90min' };

  // Level after 90 minutes - check extra time, if recorded.
  if (aetHomeGoals != null && aetAwayGoals != null) {
    if (aetHomeGoals > aetAwayGoals) return { winnerName: home, loserName: away, decidedBy: 'aet' };
    if (aetAwayGoals > aetHomeGoals) return { winnerName: away, loserName: home, decidedBy: 'aet' };
    // Still level after AET - must go to penalties from here.
  }

  // 2/3. Penalties - used whenever still level (whether or not AET fields
  // were populated at all; a data source may record only the penalty
  // winner without ever filling in AET fields, since in practice AET often
  // doesn't change the scoreline).
  if (penaltyWinner === 'home') return { winnerName: home, loserName: away, decidedBy: 'penalties' };
  if (penaltyWinner === 'away') return { winnerName: away, loserName: home, decidedBy: 'penalties' };

  // Level after 90 (and AET, if recorded), with no penalty winner recorded
  // yet. This is a legitimate transient state - e.g. the build ran between
  // full time and the shootout being recorded - so callers must handle a
  // null return (typically: treat as not yet decided, fall back to
  // simulating/predicting this match as if unplayed).
  return { winnerName: null, loserName: null, decidedBy: null };
}

module.exports = { resolveKnockoutWinner };
