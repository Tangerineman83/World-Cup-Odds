// Maps the team codes used throughout this app (derived from eloratings.net)
// to flagcdn.com codes for flag icons. Most match ISO 3166-1 alpha-2 directly
// (lowercased); a handful of overrides are needed for non-ISO entities
// (UK home nations) or codes that differ between eloratings.net and ISO.
//
// flagcdn.com usage: https://flagcdn.com/h24/<code>.png (or .svg for crisp
// scaling at any size). UK home nations use gb-eng / gb-sct / gb-wls / gb-nir.
const FLAG_CODE_OVERRIDES = {
  EN: 'gb-eng',  // England
  SQ: 'gb-sct',  // Scotland
  WL: 'gb-wls',  // Wales (not currently in the tournament, included for completeness)
  NI: 'gb-nir',  // Northern Ireland (ditto)
};

// Returns the flagcdn.com code for a given eloratings.net team code, or null
// if no code is available (caller should omit the flag in that case).
function flagCodeFor(teamCode) {
  if (!teamCode) return null;
  if (FLAG_CODE_OVERRIDES[teamCode]) return FLAG_CODE_OVERRIDES[teamCode];
  return teamCode.toLowerCase();
}

// Returns an <img> element's src URL for a flag at the given pixel height
// (flagcdn serves fixed-height variants: h20, h24, h40, h60, h80, h120, h240).
function flagUrl(teamCode, height = 24) {
  const code = flagCodeFor(teamCode);
  if (!code) return null;
  return `https://flagcdn.com/h${height}/${code}.png`;
}

module.exports = { FLAG_CODE_OVERRIDES, flagCodeFor, flagUrl };
