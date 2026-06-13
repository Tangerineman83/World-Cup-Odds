// 2026 FIFA World Cup tournament structure.
// Source: official FIFA draw (5 Dec 2025), groups A-L.
// Team names align with countryMap.js (ELO_TO_NAME values).

const GROUPS = {
  A: ['Mexico', 'South Africa', 'South Korea', 'Czechia'],
  B: ['Canada', 'Bosnia-Herzegovina', 'Qatar', 'Switzerland'],
  C: ['Brazil', 'Morocco', 'Haiti', 'Scotland'],
  D: ['USA', 'Paraguay', 'Australia', 'Turkiye'],
  E: ['Germany', 'Curacao', 'Ivory Coast', 'Ecuador'],
  F: ['Netherlands', 'Japan', 'Sweden', 'Tunisia'],
  G: ['Belgium', 'Egypt', 'Iran', 'New Zealand'],
  H: ['Spain', 'Cape Verde', 'Saudi Arabia', 'Uruguay'],
  I: ['France', 'Senegal', 'Iraq', 'Norway'],
  J: ['Argentina', 'Algeria', 'Austria', 'Jordan'],
  K: ['Portugal', 'Congo DR', 'Uzbekistan', 'Colombia'],
  L: ['England', 'Croatia', 'Ghana', 'Panama'],
};

// Host nations get a home-advantage boost in their group matches (and beyond,
// per eloratings.net convention of +100 Elo for the "home" side of a fixture).
// Co-hosts: USA, Canada, Mexico.
const HOST_NATIONS = new Set(['USA', 'Canada', 'Mexico']);

// --- Round of 32 bracket -------------------------------------------------
//
// The *official* bracket assigns 8 of the 12 third-placed teams to specific
// Round-of-32 slots via FIFA's 495-scenario "Annex C" table, which can only be
// resolved once final group standings are known. For this simulation we use a
// SIMPLIFIED, fixed assignment: in each simulated tournament, after determining
// the 8 best third-place teams (by points, then goal difference, then goals
// scored, then a random tiebreak), we assign them to the 8 "vs 3rd place" slots
// below in a fixed, deterministic order (ranked best-third to weakest-third
// against the labelled slots in matchup order). This is an approximation of
// the real Annex C mapping, not a reproduction of it.
//
// R32 matches use letters R32-1 .. R32-16. "W:X" = winner of group X,
// "R:X" = runner-up of group X, "3RD:n" = the nth-best third-place team
// (1 = best of the 8 qualifying thirds) under our simplified assignment.
const ROUND_OF_32 = [
  { id: 'R32-1', home: 'W:A', away: '3RD:1' },
  { id: 'R32-2', home: 'W:C', away: 'R:F' },
  { id: 'R32-3', home: 'W:E', away: '3RD:2' },
  { id: 'R32-4', home: 'R:A', away: 'R:B' },
  { id: 'R32-5', home: 'W:F', away: 'R:C' },
  { id: 'R32-6', home: 'W:B', away: '3RD:3' },
  { id: 'R32-7', home: 'W:I', away: '3RD:4' },
  { id: 'R32-8', home: 'R:E', away: 'R:I' },
  { id: 'R32-9', home: 'W:D', away: '3RD:5' },
  { id: 'R32-10', home: 'W:G', away: '3RD:6' },
  { id: 'R32-11', home: 'W:L', away: '3RD:7' },
  { id: 'R32-12', home: 'W:H', away: 'R:J' },
  { id: 'R32-13', home: 'W:J', away: '3RD:8' },
  { id: 'R32-14', home: 'R:K', away: 'R:L' },
  { id: 'R32-15', home: 'W:K', away: 'R:H' },
  { id: 'R32-16', home: 'R:D', away: 'R:G' },
];
// (3RD:n placeholders are filled in dynamically per simulation run - see simulate.js)

// Round of 16 pairings, by R32 match id (winner of R32-X plays winner of R32-Y)
const ROUND_OF_16_PAIRS = [
  ['R32-1', 'R32-2'],
  ['R32-3', 'R32-4'],
  ['R32-5', 'R32-6'],
  ['R32-7', 'R32-8'],
  ['R32-9', 'R32-10'],
  ['R32-11', 'R32-12'],
  ['R32-13', 'R32-14'],
  ['R32-15', 'R32-16'],
];

// Quarter-finals: winner of R16 match i plays winner of R16 match i+1, in pairs
const QUARTER_FINAL_PAIRS = [
  [0, 1], // R16 match 0 vs R16 match 1
  [2, 3],
  [4, 5],
  [6, 7],
];

// Semi-finals: QF winners paired 0v1, 2v3
const SEMI_FINAL_PAIRS = [
  [0, 1],
  [2, 3],
];

module.exports = {
  GROUPS,
  HOST_NATIONS,
  ROUND_OF_32,
  ROUND_OF_16_PAIRS,
  QUARTER_FINAL_PAIRS,
  SEMI_FINAL_PAIRS,
};
