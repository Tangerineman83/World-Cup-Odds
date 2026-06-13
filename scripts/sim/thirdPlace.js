const { ROUND_OF_32, THIRD_PLACE_SLOT_ORDER } = require('./tournament');

// Parses a "3RD:A,B,C,D,F" slot string into { groups: ['A','B','C','D','F'] }
function parseThirdSlot(slot) {
  const groups = slot.slice(4).split(',');
  return { groups };
}

// Pre-compute each 3RD-slot's allowed group set, in THIRD_PLACE_SLOT_ORDER order.
const THIRD_SLOTS = THIRD_PLACE_SLOT_ORDER.map((matchId) => {
  const match = ROUND_OF_32.find((m) => m.id === matchId);
  const slotStr = match.away.startsWith('3RD:') ? match.away : match.home;
  return { matchId, ...parseThirdSlot(slotStr) };
});

// Assigns the 8 qualifying third-placed teams (each with a `.group` field) to
// the 8 "3RD:<groups>" slots in ROUND_OF_32, such that every team's group is
// in its assigned slot's eligible set.
//
// This is an approximation of FIFA's Annex C: the *real* Annex C is a single
// pre-published lookup table (one of 495 rows) for the specific combination
// of 8 qualifying groups, which can assign teams in ways a naive matching
// might not (e.g. balancing which confederations meet early). Here we instead
// search for ANY assignment where every team's group is eligible for its
// slot - guaranteed to exist for any valid combination of 8 thirds, since
// each team's group appears in at least one slot's eligible set by
// construction of the official slot definitions - using backtracking search
// ordered by slot (in official match order) and by team rank (best-ranked
// thirds tried first for each slot). This guarantees every R32 matchup is one
// FIFA's regulations would consider possible, even if not the exact Annex C
// pairing for this combination.
//
// Returns a Map from R32 match id (e.g. 'M74') -> team object.
function assignThirdPlaceSlots(bestThirds) {
  const n = THIRD_SLOTS.length; // 8
  const used = new Array(bestThirds.length).fill(false);
  const assignment = new Array(n).fill(null); // index into bestThirds, per slot

  function backtrack(slotIdx) {
    if (slotIdx === n) return true;
    const slot = THIRD_SLOTS[slotIdx];
    for (let teamIdx = 0; teamIdx < bestThirds.length; teamIdx++) {
      if (used[teamIdx]) continue;
      if (!slot.groups.includes(bestThirds[teamIdx].group)) continue;
      used[teamIdx] = true;
      assignment[slotIdx] = teamIdx;
      if (backtrack(slotIdx + 1)) return true;
      used[teamIdx] = false;
      assignment[slotIdx] = null;
    }
    return false;
  }

  const solved = backtrack(0);

  const result = new Map();
  if (solved) {
    THIRD_SLOTS.forEach((slot, i) => {
      result.set(slot.matchId, bestThirds[assignment[i]]);
    });
    return result;
  }

  // Fallback (should not occur for a valid 8-team combination): assign
  // remaining teams to remaining slots in order, ignoring eligibility.
  const remaining = [...bestThirds];
  for (const slot of THIRD_SLOTS) {
    result.set(slot.matchId, remaining.shift());
  }
  return result;
}

module.exports = { assignThirdPlaceSlots, THIRD_SLOTS };
