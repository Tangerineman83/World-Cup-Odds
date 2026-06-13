// Elo-based match outcome model.
//
// eloratings.net's "expected result" We treats a draw as W=0.5, so We is really
// P(win) + 0.5 * P(draw), not P(win) alone. To get separate win/draw/loss
// probabilities we need an auxiliary model for how often draws occur as a
// function of team strength gap. We use a standard empirical approach
// (similar to the "Davidson" ordinal model used in several public Elo-based
// World Cup simulators): draw probability is highest when teams are evenly
// matched and decays as the rating gap grows.

const HOME_ADVANTAGE = 100; // Elo points, per eloratings.net convention

// We(dr) = 1 / (10^(-dr/400) + 1)
function expectedResult(dr) {
  return 1 / (Math.pow(10, -dr / 400) + 1);
}

// Empirical draw-probability curve, calibrated so that:
//  - evenly matched teams (dr=0) draw ~26% of the time (roughly matches
//    historical international football draw rates)
//  - draw probability falls off as the gap widens, approaching ~12% for
//    very lopsided matchups (it never goes to zero - even big favourites
//    draw occasionally)
const BASE_DRAW_PROB = 0.26;
const MIN_DRAW_PROB = 0.12;
const DRAW_DECAY = 400; // larger = slower decay with rating gap

function drawProbability(dr) {
  const gap = Math.abs(dr);
  const decay = Math.exp(-gap / DRAW_DECAY);
  return MIN_DRAW_PROB + (BASE_DRAW_PROB - MIN_DRAW_PROB) * decay;
}

// Returns { pWin, pDraw, pLoss } for the team on the "home" side of dr.
// dr = (homeElo + homeAdvantage) - awayElo, i.e. already adjusted.
// Constraints: pWin + 0.5*pDraw = We(dr), and pWin + pDraw + pLoss = 1.
function matchProbabilities(homeElo, awayElo, { neutralVenue = false } = {}) {
  const dr = (homeElo + (neutralVenue ? 0 : HOME_ADVANTAGE)) - awayElo;
  const we = expectedResult(dr);
  const pDraw = drawProbability(dr);
  let pWin = we - pDraw / 2;
  let pLoss = 1 - pWin - pDraw;

  // Numerical safety: clamp to [0,1] in case of extreme rating gaps
  pWin = Math.min(Math.max(pWin, 0), 1);
  pLoss = Math.min(Math.max(pLoss, 0), 1);
  const total = pWin + pDraw + pLoss;
  return { pWin: pWin / total, pDraw: pDraw / total, pLoss: pLoss / total };
}

module.exports = { expectedResult, drawProbability, matchProbabilities, HOME_ADVANTAGE };
