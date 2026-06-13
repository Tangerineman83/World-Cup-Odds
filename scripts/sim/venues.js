// Venue altitude/climate classification for the 2026 FIFA World Cup (16 host
// cities across USA, Mexico, Canada), used to compute a small "climate
// adjustment" alongside the existing host-nation Elo bonus.
//
// IMPORTANT CAVEAT: unlike Elo (which is calibrated against decades of match
// results), there is no standard public dataset of "climate adjustment
// factors" for international football. The altitudeBand/heatBand
// classifications below are grounded in real, well-documented physical
// conditions (Mexico City's altitude, Gulf-Coast/Southern US summer heat),
// but the *size* of the adjustment (CLIMATE_ADJUSTMENT_ELO below) is a
// judgement call, not a fitted parameter. Treat this as a modest, clearly-
// labelled methodological adjustment, not a precision instrument.

// altitudeBand: 'high' (>1800m, significant physiological effect),
//               'moderate' (600-1800m), 'sea' (<600m)
// heatBand: 'hot' (typically hot+humid in June/July),
//           'warm', 'mild' (cooler host climates, e.g. Pacific Northwest/Canada)
const VENUES = {
  'Mexico City': { country: 'Mexico', altitudeBand: 'high', heatBand: 'mild', elevationM: 2240 },
  'Guadalajara': { country: 'Mexico', altitudeBand: 'moderate', heatBand: 'warm', elevationM: 1566 },
  'Monterrey': { country: 'Mexico', altitudeBand: 'sea', heatBand: 'hot', elevationM: 540 },
  'Atlanta': { country: 'USA', altitudeBand: 'sea', heatBand: 'hot', elevationM: 320 },
  'Boston': { country: 'USA', altitudeBand: 'sea', heatBand: 'mild', elevationM: 43 },
  'Dallas': { country: 'USA', altitudeBand: 'sea', heatBand: 'hot', elevationM: 131 },
  'Houston': { country: 'USA', altitudeBand: 'sea', heatBand: 'hot', elevationM: 13 },
  'Kansas City': { country: 'USA', altitudeBand: 'sea', heatBand: 'warm', elevationM: 256 },
  'Los Angeles': { country: 'USA', altitudeBand: 'sea', heatBand: 'warm', elevationM: 71 },
  'Miami': { country: 'USA', altitudeBand: 'sea', heatBand: 'hot', elevationM: 2 },
  'New York/New Jersey': { country: 'USA', altitudeBand: 'sea', heatBand: 'warm', elevationM: 4 },
  'Philadelphia': { country: 'USA', altitudeBand: 'sea', heatBand: 'warm', elevationM: 12 },
  'San Francisco Bay Area': { country: 'USA', altitudeBand: 'sea', heatBand: 'mild', elevationM: 15 },
  'Seattle': { country: 'USA', altitudeBand: 'sea', heatBand: 'mild', elevationM: 56 },
  'Toronto': { country: 'Canada', altitudeBand: 'sea', heatBand: 'warm', elevationM: 76 },
  'Vancouver': { country: 'Canada', altitudeBand: 'sea', heatBand: 'mild', elevationM: 2 },
};

// Per-team climate profile: does this team's footballing environment
// typically involve high altitude and/or hot+humid conditions? Derived from
// each federation's home-confederation conditions (a simplifying proxy - it
// does not account for individual players' club-level conditions).
//
// altitudeAccustomed: true for nations whose home/regional matches are
// commonly played at significant altitude (Andean CONMEBOL nations; a few
// others with high-altitude capitals/stadiums).
// heatAccustomed: true for nations from consistently hot/humid football
// environments (Caribbean & Central American CONCACAF, Gulf/South/Southeast
// Asian AFC nations, much of CAF).
//
// This is intentionally coarse - see CLIMATE_ADJUSTMENT_ELO for how small the
// resulting adjustment is.
const ALTITUDE_ACCUSTOMED = new Set([
  'Bolivia', 'Ecuador', 'Colombia', 'Peru', 'Mexico',
]);

const HEAT_ACCUSTOMED = new Set([
  // CONCACAF Caribbean / Central America
  'Panama', 'Costa Rica', 'Jamaica', 'Haiti', 'Curacao', 'Honduras', 'Guatemala', 'Trinidad and Tobago',
  // CAF (West/Central Africa - hot, humid)
  'Senegal', 'Ivory Coast', 'Ghana', 'Nigeria', 'Cameroon', 'DR Congo', 'Morocco', 'Tunisia', 'Algeria', 'South Africa', 'Cape Verde',
  // AFC (Gulf, South/Southeast Asia)
  'Saudi Arabia', 'Qatar', 'Jordan', 'Iran', 'Uzbekistan', 'South Korea', 'Japan', 'Australia',
]);

// Elo-equivalent adjustment applied per qualifying condition. Deliberately
// small relative to the +100 host-nation advantage - this reflects a real
// but modest acclimatisation effect, not a dominant factor. Applied
// symmetrically: a team WITH the relevant accustomedness at a venue WITH
// that condition gets +ADJ; a team WITHOUT it gets -ADJ/2 (the discomfort is
// real but typically smaller than the comfort benefit to the acclimatised
// side). Both teams sharing the same profile cancel out.
const CLIMATE_ADJUSTMENT_ELO = 25;

// Returns the Elo-equivalent climate adjustment for a team at a given venue.
// Positive = advantage, negative = disadvantage. teamName must match the
// keys used in ALTITUDE_ACCUSTOMED / HEAT_ACCUSTOMED (team display names).
function climateAdjustment(teamName, venueName) {
  const venue = VENUES[venueName];
  if (!venue) return 0;

  let adj = 0;

  if (venue.altitudeBand === 'high') {
    adj += ALTITUDE_ACCUSTOMED.has(teamName) ? CLIMATE_ADJUSTMENT_ELO : -CLIMATE_ADJUSTMENT_ELO / 2;
  }

  if (venue.heatBand === 'hot') {
    adj += HEAT_ACCUSTOMED.has(teamName) ? CLIMATE_ADJUSTMENT_ELO : -CLIMATE_ADJUSTMENT_ELO / 2;
  }

  return adj;
}

// Per-group "representative venue" for the climate adjustment, used only for
// GROUP-STAGE matches. Each group's 6 matches are actually spread across 2-3
// cities (per the published 2026 schedule); rather than encode the full
// 104-match schedule, we pick ONE representative venue per group - generally
// the most climatically distinctive of that group's host cities - and apply
// its altitude/heat profile to all of that group's matches. This is a
// simplification: it will over- or under-state the effect for individual
// matches played in a different city, but gives a directionally sensible
// adjustment without requiring the full schedule.
//
// Knockout matches: no climate adjustment is applied, since the venue for
// any given knockout fixture depends on the bracket outcome and isn't known
// in advance.
const GROUP_VENUE = {
  A: 'Mexico City',           // Mexico's group - includes the Estadio Azteca opener
  B: 'Toronto',                // Canada's group
  C: 'Philadelphia',           // Brazil/Morocco/Haiti/Scotland - East Coast
  D: 'Los Angeles',             // USA's group - West Coast
  E: 'Houston',                 // hot/humid Gulf Coast venue
  F: 'Dallas',                  // hot Texas venue
  G: 'Seattle',                 // mild Pacific Northwest
  H: 'Guadalajara',              // Spain/Uruguay group includes a Mexico leg
  I: 'Boston',                   // France/Senegal/Norway - East Coast, mild
  J: 'Dallas',                   // Argentina/Algeria - hot Texas venue
  K: 'Guadalajara',               // Portugal/Colombia - Mexico leg
  L: 'New York/New Jersey',        // England/Croatia/Ghana/Panama - East Coast
};

module.exports = { VENUES, ALTITUDE_ACCUSTOMED, HEAT_ACCUSTOMED, CLIMATE_ADJUSTMENT_ELO, climateAdjustment, GROUP_VENUE };
