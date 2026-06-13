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
// Official FIFA structure (Matches 73-88), per the 2026 World Cup regulations
// and https://en.wikipedia.org/wiki/2026_FIFA_World_Cup_knockout_stage.
//
// Fixed slots (winners/runners-up) are unambiguous. The eight "3rd Group
// X/Y/Z/.../W" slots depend on which 8 third-placed teams actually qualify
// (FIFA's 495-scenario Annex C table). We approximate Annex C with a
// constraint-respecting greedy assignment (see resolveThirdPlaceSlots in
// simulateTournament.js / mostLikely.js): each "3RD:<groups>" slot is filled
// with the best-ranked qualifying third whose group is in that slot's
// allowed set, processed in official match order (74, 77, 79, 80, 81, 82, 85, 87).
// This guarantees every matchup is one FIFA could actually produce, even
// though it won't reproduce all 495 exact scenarios.
const ROUND_OF_32 = [
  { id: 'M73', home: 'R:A', away: 'R:B' },
  { id: 'M74', home: 'W:E', away: '3RD:A,B,C,D,F' },
  { id: 'M75', home: 'W:F', away: 'R:C' },
  { id: 'M76', home: 'W:C', away: 'R:F' },
  { id: 'M77', home: 'W:I', away: '3RD:C,D,F,G,H' },
  { id: 'M78', home: 'R:E', away: 'R:I' },
  { id: 'M79', home: 'W:A', away: '3RD:C,E,F,H,I' },
  { id: 'M80', home: 'W:L', away: '3RD:E,H,I,J,K' },
  { id: 'M81', home: 'W:D', away: '3RD:B,E,F,I,J' },
  { id: 'M82', home: 'W:G', away: '3RD:A,E,H,I,J' },
  { id: 'M83', home: 'R:K', away: 'R:L' },
  { id: 'M84', home: 'W:H', away: 'R:J' },
  { id: 'M85', home: 'W:B', away: '3RD:E,F,G,I,J' },
  { id: 'M86', home: 'W:J', away: 'R:H' },
  { id: 'M87', home: 'W:K', away: '3RD:D,E,I,J,L' },
  { id: 'M88', home: 'R:D', away: 'R:G' },
];

// Order in which the eight "3RD:<groups>" slots are resolved when assigning
// the 8 qualifying third-placed teams to slots. This is the order the slots
// appear in FIFA's official match list (74, 77, 79, 80, 81, 82, 85, 87).
const THIRD_PLACE_SLOT_ORDER = ['M74', 'M77', 'M79', 'M80', 'M81', 'M82', 'M85', 'M87'];

// Round of 16 pairings, by R32 match id (winner of R32-X plays winner of R32-Y).
// Official FIFA match numbers (89-96):
//   M89 = Winner M74 vs Winner M77
//   M90 = Winner M73 vs Winner M75
//   M91 = Winner M76 vs Winner M78
//   M92 = Winner M79 vs Winner M80
//   M93 = Winner M83 vs Winner M84
//   M94 = Winner M81 vs Winner M82
//   M95 = Winner M86 vs Winner M88
//   M96 = Winner M85 vs Winner M87
// Each entry here is [officialMatchId, [fromR32IdA, fromR32IdB]].
const ROUND_OF_16_PAIRS = [
  ['M89', ['M74', 'M77']],
  ['M90', ['M73', 'M75']],
  ['M91', ['M76', 'M78']],
  ['M92', ['M79', 'M80']],
  ['M93', ['M83', 'M84']],
  ['M94', ['M81', 'M82']],
  ['M95', ['M86', 'M88']],
  ['M96', ['M85', 'M87']],
];

// Quarter-finals (97-100):
//   M97 = Winner M89 vs Winner M90
//   M98 = Winner M93 vs Winner M94
//   M99 = Winner M91 vs Winner M92
//   M100 = Winner M95 vs Winner M96
const QUARTER_FINAL_PAIRS = [
  ['M97', ['M89', 'M90']],
  ['M98', ['M93', 'M94']],
  ['M99', ['M91', 'M92']],
  ['M100', ['M95', 'M96']],
];

// Semi-finals (101-102):
//   M101 = Winner M97 vs Winner M98
//   M102 = Winner M99 vs Winner M100
const SEMI_FINAL_PAIRS = [
  ['M101', ['M97', 'M98']],
  ['M102', ['M99', 'M100']],
];

// Final (104) and third-place playoff (103)
const FINAL_PAIR = ['M104', ['M101', 'M102']];
const THIRD_PLACE_PAIR = ['M103', ['M101', 'M102']]; // losers of M101/M102

module.exports = {
  GROUPS,
  HOST_NATIONS,
  ROUND_OF_32,
  THIRD_PLACE_SLOT_ORDER,
  ROUND_OF_16_PAIRS,
  QUARTER_FINAL_PAIRS,
  SEMI_FINAL_PAIRS,
  FINAL_PAIR,
  THIRD_PLACE_PAIR,
};
