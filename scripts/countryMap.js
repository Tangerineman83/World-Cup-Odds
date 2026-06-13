// Maps eloratings.net country codes (as used in World.tsv, column 3)
// to full country names as used in Polymarket's "Will X win the 2026 FIFA World Cup?" markets.
//
// Only includes the 48 teams qualified for the 2026 FIFA World Cup.
// Elo codes are mostly FIFA trigraphs but eloratings.net uses some idiosyncratic two-letter
// codes for certain nations - these have been verified against World.tsv.

const ELO_TO_NAME = {
  ES: 'Spain',
  AR: 'Argentina',
  FR: 'France',
  EN: 'England',
  BR: 'Brazil',
  PT: 'Portugal',
  CO: 'Colombia',
  NL: 'Netherlands',
  EC: 'Ecuador',
  DE: 'Germany',
  NO: 'Norway',
  HR: 'Croatia',
  TR: 'Turkiye',
  JP: 'Japan',
  BE: 'Belgium',
  UY: 'Uruguay',
  CH: 'Switzerland',
  MX: 'Mexico',
  US: 'USA',
  CA: 'Canada',
  MA: 'Morocco',
  KR: 'South Korea',
  PY: 'Paraguay',
  CI: "Ivory Coast",
  DZ: 'Algeria',
  EG: 'Egypt',
  GH: 'Ghana',
  SN: 'Senegal',
  TN: 'Tunisia',
  RS: 'Serbia',
  AT: 'Austria',
  SE: 'Sweden',
  SQ: 'Scotland',
  PA: 'Panama',
  CV: 'Cape Verde',
  CD: 'Congo DR',
  QA: 'Qatar',
  ZA: 'South Africa',
  AU: 'Australia',
  NZ: 'New Zealand',
  JO: 'Jordan',
  SA: 'Saudi Arabia',
  IR: 'Iran',
  UZ: 'Uzbekistan',
  CW: 'Curacao',
  HT: 'Haiti',
  IQ: 'Iraq',
  BA: 'Bosnia-Herzegovina',
  CZ: 'Czechia',
};

// Normalizes a name for matching: lowercase, strip diacritics (e.g. "Curaçao" -> "curacao").
function normalize(name) {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

// Reverse map: normalized Polymarket team name -> Elo code, for matching market slugs/titles
const NAME_TO_ELO = {};
for (const [code, name] of Object.entries(ELO_TO_NAME)) {
  NAME_TO_ELO[normalize(name)] = code;
}

module.exports = { ELO_TO_NAME, NAME_TO_ELO, normalize };
