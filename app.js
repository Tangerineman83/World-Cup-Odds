(function () {
  const groupResultsGrid = document.getElementById('group-results-grid');
  const oddsTableWrap = document.getElementById('odds-table-wrap');
  const bracket = document.getElementById('bracket');
  const bracketWrap = document.getElementById('bracket-wrap');
  const svg = document.getElementById('bracket-lines');
  const metaUpdated = document.getElementById('meta-updated');
  const metaResults = document.getElementById('meta-results');
  const clearBtn = document.getElementById('clear-selection');
  const scrollHint = document.getElementById('scroll-hint');
  const scenarioModalBackdrop = document.getElementById('scenario-modal-backdrop');
  const scenarioModal = document.getElementById('scenario-modal');
  const scenarioModalClose = document.getElementById('scenario-modal-close');
  const scenarioModalTitle = document.getElementById('scenario-modal-title');
  const predictorBody = document.getElementById('predictor-body');
  const resetPicksBtn = document.getElementById('reset-picks');
  let data = null;           // scenario_negbin.json
  let predictionsByName = null;  // predictions_negbin.json teams map
  let allResults = [];       // results.json
  let splitRatings = null;   // elo_current_split.json ratings (attack/defense/overall)
  let selectedTeam = null;
  let cachedVisualOrders = null;
  let cachedRankByName = null;

  const { flagImgHtml, fmtPct } = window.ScenarioFlow;

  // ── Match predictor state ─────────────────────────────────────────────────
  // userPicks: matchId -> { homeName, awayName, bucketIdx }
  // homeName/awayName record which pairing the pick was made for, so a pick
  // is silently invalidated if an upstream change means different teams now
  // contest that match.
  const userPicks = new Map();
  let openPredictorMatchId = null;

  // Constants duplicated from the Node simulation - keep in sync:
  //   KO_GOALS_MULTIPLIER      scripts/sim/knockoutNegBin.js
  //   penalty tilt formula     scripts/sim/knockoutNegBin.js (0.5 ± clamp(eloDiff/4000, ±0.05))
  // alpha/sigma/r arrive at runtime via scenario_negbin.json's negBinConstants,
  // so those never need manual syncing.
  const KO_GOALS_MULTIPLIER = 0.90;
  const GD_MAX = 5; // distribution buckets clamp at ±5 goal difference

  // ── Utility ───────────────────────────────────────────────────────────────

  function teamButton(team) {
    if (!team) {
      return `<span class="team-cell team-tbd"><span class="flag-icon" style="background:var(--border)"></span>TBC</span>`;
    }
    const safeName = team.name.replace(/"/g, '&quot;');
    return `<button class="team-cell" data-team="${safeName}">${flagImgHtml(team.code, 24)}${team.name}</button>`;
  }

  const GROUP_ORDER = ['A','B','C','D','E','F','G','H','I','J','K','L'];

  // ── Group results display ─────────────────────────────────────────────────

  function renderGroupResults() {
    if (!groupResultsGrid) return;
    const byGroup = {};
    for (const r of allResults) {
      if (!r.group || r.homeGoals == null) continue;
      if (!byGroup[r.group]) byGroup[r.group] = [];
      byGroup[r.group].push(r);
    }

    let html = '';
    for (const g of GROUP_ORDER) {
      const matches = byGroup[g];
      if (!matches || !matches.length) continue;
      html += `<div class="group-results-block">
        <h3 class="group-results-title">Group ${g}</h3>
        <div class="group-results-matches">`;
      for (const m of matches) {
        const hTeam = data.groups[g]?.order.find(t => t.name === m.home) || { name: m.home, code: null };
        const aTeam = data.groups[g]?.order.find(t => t.name === m.away) || { name: m.away, code: null };
        const hWon = m.homeGoals > m.awayGoals;
        const aWon = m.awayGoals > m.homeGoals;
        html += `<div class="result-row">
          <span class="result-team ${hWon ? 'result-winner' : ''}">${flagImgHtml(hTeam.code, 20)}${m.home}</span>
          <span class="result-score">${m.homeGoals}–${m.awayGoals}</span>
          <span class="result-team result-team-away ${aWon ? 'result-winner' : ''}">${m.away}${flagImgHtml(aTeam.code, 20)}</span>
        </div>`;
      }
      html += `</div></div>`;
    }
    groupResultsGrid.innerHTML = html;
  }

  // ── Tournament odds table ─────────────────────────────────────────────────

  function renderOddsTable() {
    if (!oddsTableWrap || !predictionsByName) return;

    // Build per-team stats from all played results (group stage + knockout)
    const stats = {};
    for (const r of allResults) {
      if (r.homeGoals == null) continue;
      for (const [name, gf, ga, won] of [
        [r.home, r.homeGoals, r.awayGoals, r.homeGoals > r.awayGoals],
        [r.away, r.awayGoals, r.homeGoals, r.awayGoals > r.homeGoals],
      ]) {
        if (!stats[name]) stats[name] = { w: 0, gf: 0, ga: 0 };
        stats[name].gf += gf;
        stats[name].ga += ga;
        if (won) stats[name].w += 1;
      }
    }

    // Build rows from predictions, sorted by pChampion desc
    const rows = [...predictionsByName.values()]
      .sort((a, b) => (b.pChampion || 0) - (a.pChampion || 0));

    let html = `<table class="odds-table">
      <thead>
        <tr>
          <th class="ot-team">Team</th>
          <th class="ot-num ot-highlight" title="Chance of winning the tournament">🏆 To win</th>
          <th class="ot-num" title="Total wins including group stage">Wins</th>
          <th class="ot-num" title="Goals scored across all played matches">GF</th>
          <th class="ot-num" title="Goals conceded across all played matches">GA</th>
        </tr>
      </thead>
      <tbody>`;

    for (let i = 0; i < rows.length; i++) {
      const t = rows[i];
      const s = stats[t.name] || { w: 0, gf: 0, ga: 0 };
      const pct = t.pChampion || 0;
      // Heatmap intensity on the win odds cell
      const alpha = Math.min(pct / 0.25, 1) * 0.4; // scale so 25%+ = full intensity
      const bg = `background:rgba(74,222,128,${alpha.toFixed(3)})`;
      html += `<tr class="ot-row" data-team="${t.name.replace(/"/g,'&quot;')}">
        <td class="ot-team">${flagImgHtml(t.code, 20)}<button class="team-cell ot-name-btn" data-team="${t.name.replace(/"/g,'&quot;')}">${t.name}</button></td>
        <td class="ot-num ot-highlight" style="${bg}">${fmtPct(pct)}</td>
        <td class="ot-num">${s.w}</td>
        <td class="ot-num">${s.gf}</td>
        <td class="ot-num">${s.ga}</td>
      </tr>`;
    }

    html += `</tbody></table>`;
    oddsTableWrap.innerHTML = html;
  }

  // ── Modal: team knockout pathway Sankey ───────────────────────────────────

  // ── Match predictor: NegBin goal-difference distributions ────────────────
  //
  // Mirrors the Node simulation maths (groupStageNegBin.js expectedGoals +
  // NegBin PMF, knockoutNegBin.js KO alpha reduction and penalty tilt) so the
  // browser can compute the outcome distribution for ANY pairing - including
  // hypothetical SF/final pairings created by the user's own picks - without
  // any precomputed data. Ratings come from elo_current_split.json.

  function logGammaFn(x) {
    const g = 7, c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028,
      771.32342877765313, -176.61502916214059, 12.507343278686905,
      -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
    if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGammaFn(1 - x);
    x -= 1; let a = c[0]; const t = x + g + 0.5;
    for (let i = 1; i < g + 2; i++) a += c[i] / (x + i);
    return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
  }
  function negBinPMF(k, mu, r) {
    const p = r / (r + mu);
    return Math.exp(logGammaFn(k + r) - logGammaFn(r) - logGammaFn(k + 1)
      + r * Math.log(p) + k * Math.log(1 - p));
  }

  // Returns the outcome distribution for a knockout pairing as an ordered
  // bucket array, home-favouring outcomes first (left of the axis):
  //   [home by 5+, ..., home by 1, draw→home pens, draw→away pens,
  //    away by 1, ..., away by 5+]
  // Each bucket: { key, label, gd, pensWinner|null, p }.
  function computeGdDistribution(homeName, awayName) {
    const params = data.negBinConstants;
    const hR = splitRatings[homeName], aR = splitRatings[awayName];
    if (!params || !hR || !aR) return null;
    const koAlpha = params.alpha + Math.log(KO_GOALS_MULTIPLIER);
    const clamp = (v, lim) => Math.max(-lim, Math.min(lim, v));
    const muH = Math.exp(koAlpha + clamp((hR.attack - aR.defense) / params.sigma, 1.5));
    const muA = Math.exp(koAlpha + clamp((aR.attack - hR.defense) / params.sigma, 1.5));
    const r = params.r;

    const gdP = {}; // gd (clamped to ±GD_MAX) -> prob
    let total = 0;
    for (let h = 0; h <= 9; h++) {
      const ph = negBinPMF(h, muH, r);
      for (let a = 0; a <= 9; a++) {
        const j = ph * negBinPMF(a, muA, r);
        const gd = Math.max(-GD_MAX, Math.min(GD_MAX, h - a));
        gdP[gd] = (gdP[gd] || 0) + j;
        total += j;
      }
    }
    for (const k of Object.keys(gdP)) gdP[k] /= total;

    // Penalty tilt for the drawn bucket - same formula as knockoutNegBin.js
    const eloDiff = (hR.overall ?? 1800) - (aR.overall ?? 1800);
    const tilt = 0.5 + Math.max(-0.05, Math.min(0.05, eloDiff / 4000));

    const buckets = [];
    for (let gd = GD_MAX; gd >= 1; gd--) {
      buckets.push({ key: `h${gd}`, label: gd === GD_MAX ? `+${gd}+` : `+${gd}`,
        gd, pensWinner: null, p: gdP[gd] || 0 });
    }
    const pDraw = gdP[0] || 0;
    buckets.push({ key: 'ph', label: 'pens', gd: 0, pensWinner: 'home', p: pDraw * tilt });
    buckets.push({ key: 'pa', label: 'pens', gd: 0, pensWinner: 'away', p: pDraw * (1 - tilt) });
    for (let gd = 1; gd <= GD_MAX; gd++) {
      buckets.push({ key: `a${gd}`, label: gd === GD_MAX ? `+${gd}+` : `+${gd}`,
        gd: -gd, pensWinner: null, p: gdP[-gd] || 0 });
    }
    return buckets;
  }

  function modalBucketIdx(buckets) {
    let best = 0;
    for (let i = 1; i < buckets.length; i++) if (buckets[i].p > buckets[best].p) best = i;
    return best;
  }

  // ── Effective knockout bracket (actual > user pick > most likely) ────────
  //
  // The interactive rounds are QF (M97-M100), SF (M101, M102) and the final
  // (M104). QF participants are fixed (R16 is complete); SF and final
  // participants are derived from whoever the effective winner of each feeder
  // is. Precedence per match: actual played result, then a user pick made for
  // this exact pairing, then the most likely outcome computed live.
  const INTERACTIVE_PAIRS = [
    ['M101', ['M97', 'M98']],
    ['M102', ['M99', 'M100']],
    ['M104', ['M101', 'M102']],
  ];

  function actualWinnerName(m) {
    // Mirrors scripts/sim/knockoutResult.js resolveKnockoutWinner precedence
    if (m.homeGoals > m.awayGoals) return m.home;
    if (m.awayGoals > m.homeGoals) return m.away;
    if (m.aetHomeGoals != null && m.aetAwayGoals != null && m.aetHomeGoals !== m.aetAwayGoals) {
      return m.aetHomeGoals > m.aetAwayGoals ? m.home : m.away;
    }
    if (m.penaltyWinner === 'home') return m.home;
    if (m.penaltyWinner === 'away') return m.away;
    return null;
  }

  // Resolve one interactive match given its participants. Returns
  // { home, away, winner, pWin, userPick, locked } where home/away/winner are
  // team objects ({ name, code }).
  function resolveInteractive(matchId, homeTeam, awayTeam) {
    const played = allResults.find(r => r.id === matchId && r.homeGoals != null);
    if (played) {
      const wName = actualWinnerName(played);
      const winner = wName === homeTeam.name ? homeTeam : awayTeam;
      return { id: matchId, home: homeTeam, away: awayTeam, winner, pWin: 1.0, userPick: null, locked: true };
    }

    const pick = userPicks.get(matchId);
    const pickValid = pick && pick.homeName === homeTeam.name && pick.awayName === awayTeam.name;
    if (pick && !pickValid) userPicks.delete(matchId); // stale - participants changed

    const buckets = computeGdDistribution(homeTeam.name, awayTeam.name);
    if (!buckets) {
      return { id: matchId, home: homeTeam, away: awayTeam, winner: homeTeam, pWin: null, userPick: null, locked: false };
    }

    const idx = pickValid ? pick.bucketIdx : modalBucketIdx(buckets);
    const b = buckets[idx];
    const homeWins = b.gd > 0 || (b.gd === 0 && b.pensWinner === 'home');
    const winner = homeWins ? homeTeam : awayTeam;
    // pWin shown for unpicked matches = live overall progression prob of winner
    let pWin = null;
    if (!pickValid) {
      let pHome = 0;
      for (const bb of buckets) {
        if (bb.gd > 0 || (bb.gd === 0 && bb.pensWinner === 'home')) pHome += bb.p;
      }
      pWin = homeWins ? pHome : 1 - pHome;
    }
    return {
      id: matchId, home: homeTeam, away: awayTeam, winner, pWin,
      userPick: pickValid ? { bucket: b } : null, locked: false,
    };
  }

  // Builds the effective qf/sf/final match objects from picks + results.
  function effectiveKnockout() {
    const teamRef = (t) => ({ name: t.name, code: t.code });
    const byId = new Map();

    for (const m of (data.qf || [])) {
      byId.set(m.id, resolveInteractive(m.id, teamRef(m.home), teamRef(m.away)));
    }
    for (const [matchId, [fromA, fromB]] of INTERACTIVE_PAIRS) {
      const home = byId.get(fromA).winner;
      const away = byId.get(fromB).winner;
      byId.set(matchId, resolveInteractive(matchId, home, away));
    }
    return byId;
  }

  // ── Predictor modal ───────────────────────────────────────────────────────

  const ROUND_LABEL = { qf: 'Quarter-final', sf: 'Semi-final', final: 'Final' };

  function openPredictor(matchId, roundKey) {
    const eff = effectiveKnockout();
    const m = eff.get(matchId);
    if (!m) return;
    openPredictorMatchId = matchId;

    scenarioModalTitle.innerHTML =
      `${teamButton(m.home)}<span class="predictor-vs">v</span>${teamButton(m.away)}` +
      `<span class="predictor-round">${ROUND_LABEL[roundKey] || ''}</span>`;

    renderPredictorBody(m);
    scenarioModalBackdrop.hidden = false;
  }

  function renderPredictorBody(m) {
    const buckets = computeGdDistribution(m.home.name, m.away.name);
    if (!buckets) { predictorBody.innerHTML = '<p class="predictor-note">Distribution unavailable.</p>'; return; }

    const played = allResults.find(r => r.id === m.id && r.homeGoals != null);
    let selIdx;
    if (played) {
      // Locked: mark the actual outcome's bucket
      let gd = played.homeGoals - played.awayGoals;
      if (gd === 0 && played.aetHomeGoals != null) gd = played.aetHomeGoals - played.aetAwayGoals;
      gd = Math.max(-GD_MAX, Math.min(GD_MAX, gd));
      if (gd !== 0) {
        selIdx = buckets.findIndex(b => b.gd === gd);
      } else {
        selIdx = buckets.findIndex(b => b.gd === 0 && b.pensWinner === played.penaltyWinner);
      }
      if (selIdx < 0) selIdx = modalBucketIdx(buckets);
    } else {
      const pick = userPicks.get(m.id);
      selIdx = (pick && pick.homeName === m.home.name && pick.awayName === m.away.name)
        ? pick.bucketIdx : modalBucketIdx(buckets);
    }

    const maxP = Math.max(...buckets.map(b => b.p), 0.001);
    const barsHtml = buckets.map((b, i) => {
      const hPct = Math.max(2, (b.p / maxP) * 100);
      const side = b.gd > 0 || (b.gd === 0 && b.pensWinner === 'home') ? 'home' : 'away';
      const sel = i === selIdx ? ' predictor-bar-selected' : '';
      return `
        <div class="predictor-col${sel}" data-bucket="${i}">
          <div class="predictor-bar-pct">${(b.p * 100).toFixed(0)}%</div>
          <div class="predictor-bar-track"><div class="predictor-bar predictor-bar-${side}" style="height:${hPct}%"></div></div>
          <div class="predictor-bar-label">${b.label}</div>
        </div>`;
    }).join('');

    const winnerNote = (idx) => {
      const b = buckets[idx];
      const wName = (b.gd > 0 || (b.gd === 0 && b.pensWinner === 'home')) ? m.home.name : m.away.name;
      const how = b.gd === 0 ? 'on penalties' : `by ${Math.abs(b.gd)}${Math.abs(b.gd) === GD_MAX ? '+' : ''}`;
      return `${wName} wins ${how}`;
    };

    predictorBody.innerHTML = `
      <div class="predictor-axis-teams">
        <span class="predictor-axis-home">← ${m.home.name} wins</span>
        <span class="predictor-axis-away">${m.away.name} wins →</span>
      </div>
      <div class="predictor-chart">${barsHtml}</div>
      ${played ? `
        <p class="predictor-locked-note">Final result — this match has been played and can't be adjusted.</p>
      ` : `
        <input type="range" class="predictor-slider" id="predictor-slider"
               min="0" max="${buckets.length - 1}" step="1" value="${selIdx}"
               aria-label="Select predicted goal difference">
        <p class="predictor-selection" id="predictor-selection">${winnerNote(selIdx)}</p>
        <p class="predictor-note">Slide (or tap a bar) to set your own prediction — the rest of the bracket updates to match. Default is the most likely outcome.</p>
      `}
    `;

    if (!played) {
      const slider = document.getElementById('predictor-slider');
      const selectionEl = document.getElementById('predictor-selection');
      const applyPick = (idx) => {
        userPicks.set(m.id, { homeName: m.home.name, awayName: m.away.name, bucketIdx: idx });
        selectionEl.textContent = winnerNote(idx);
        predictorBody.querySelectorAll('.predictor-col').forEach((el, i) =>
          el.classList.toggle('predictor-bar-selected', i === idx));
        slider.value = idx;
        updateResetVisibility();
        renderBracket();
        scheduleRedraw();
      };
      slider.addEventListener('input', () => applyPick(parseInt(slider.value, 10)));
      predictorBody.querySelectorAll('.predictor-col').forEach((el) => {
        el.addEventListener('click', () => applyPick(parseInt(el.dataset.bucket, 10)));
      });
    }
  }

  function closeScenarioModal() {
    scenarioModalBackdrop.hidden = true;
    openPredictorMatchId = null;
  }

  function updateResetVisibility() {
    resetPicksBtn.hidden = userPicks.size === 0;
  }

  function resetAllPicks() {
    userPicks.clear();
    updateResetVisibility();
    if (openPredictorMatchId) {
      const eff = effectiveKnockout();
      const m = eff.get(openPredictorMatchId);
      if (m) renderPredictorBody(m);
    }
    renderBracket();
    scheduleRedraw();
  }

  // ── Bracket rendering ─────────────────────────────────────────────────────

  const R16_PAIRS = [
    ['M89', ['M74', 'M77']],
    ['M90', ['M73', 'M75']],
    ['M91', ['M76', 'M78']],
    ['M92', ['M79', 'M80']],
    ['M93', ['M83', 'M84']],
    ['M94', ['M81', 'M82']],
    ['M95', ['M86', 'M88']],
    ['M96', ['M85', 'M87']],
  ];
  const QF_PAIRS = [
    ['M97', ['M89', 'M90']],
    ['M98', ['M93', 'M94']],
    ['M99', ['M91', 'M92']],
    ['M100', ['M95', 'M96']],
  ];
  const SF_PAIRS = [
    ['M101', ['M97', 'M98']],
    ['M102', ['M99', 'M100']],
  ];
  const FINAL_PAIR_KEY = ['M104', ['M101', 'M102']];

  function computeVisualOrders(finalMatchId, pairsByRound) {
    const childrenOf = new Map();
    for (const pairs of Object.values(pairsByRound)) {
      for (const [matchId, children] of pairs) childrenOf.set(matchId, children);
    }
    const visualOrders = [[finalMatchId]];
    let current = [finalMatchId];
    while (childrenOf.has(current[0])) {
      const next = [];
      for (const id of current) {
        const children = childrenOf.get(id);
        if (children) next.push(...children);
        else next.push(id);
      }
      visualOrders.push(next);
      current = next;
    }
    return visualOrders.reverse();
  }

  function getRounds() {
    if (!cachedVisualOrders) {
      const pairsByRound = { sf: SF_PAIRS, qf: QF_PAIRS, r16: R16_PAIRS, final: [FINAL_PAIR_KEY] };
      cachedVisualOrders = computeVisualOrders(FINAL_PAIR_KEY[0], pairsByRound);
    }
    const [r32Order, r16Order, qfOrder, sfOrder] = cachedVisualOrders;
    const byId = (matches) => new Map((matches || []).map((m) => [m.id, m]));
    const r32ById = byId(data.r32);
    const r16ById = byId(data.r16);
    // QF onward: effective bracket (actual result > user pick > most likely),
    // recomputed on every render so user picks propagate through SF and final.
    const eff = effectiveKnockout();
    return [
      { key: 'r32',   label: 'Round of 32',    matches: r32Order.map(id => r32ById.get(id)).filter(Boolean), span: 1 },
      { key: 'r16',   label: 'Round of 16',    matches: r16Order.map(id => r16ById.get(id)).filter(Boolean), span: 2 },
      { key: 'qf',    label: 'Quarter-finals', matches: qfOrder.map(id => eff.get(id)).filter(Boolean),      span: 4 },
      { key: 'sf',    label: 'Semi-finals',    matches: sfOrder.map(id => eff.get(id)).filter(Boolean),      span: 8 },
      { key: 'final', label: 'Final',          matches: [eff.get('M104')].filter(Boolean),                    span: 16 },
    ];
  }

  function matchHtml(m, roundKey) {
    // Check if this match has an actual result in allResults
    const played = allResults.find(r => r.id === m.id && r.homeGoals != null);
    const hasResult = !!played;

    // Winner resolution mirrors scripts/sim/knockoutResult.js's
    // resolveKnockoutWinner() precedence: 90min score -> AET score ->
    // penaltyWinner. Browser code can't require() that Node module, so the
    // same three-step logic is duplicated here — keep both in sync if the
    // precedence ever changes.
    let homeWon = false, awayWon = false, decidedBy = null;
    if (hasResult) {
      if (played.homeGoals > played.awayGoals) { homeWon = true; decidedBy = '90min'; }
      else if (played.awayGoals > played.homeGoals) { awayWon = true; decidedBy = '90min'; }
      else if (played.aetHomeGoals != null && played.aetAwayGoals != null && played.aetHomeGoals !== played.aetAwayGoals) {
        if (played.aetHomeGoals > played.aetAwayGoals) { homeWon = true; decidedBy = 'aet'; }
        else { awayWon = true; decidedBy = 'aet'; }
      } else if (played.penaltyWinner === 'home') { homeWon = true; decidedBy = 'penalties'; }
      else if (played.penaltyWinner === 'away') { awayWon = true; decidedBy = 'penalties'; }
      // else: level after 90 (and AET, if recorded) with no penalty winner
      // recorded yet — neither side highlighted, falls through to the
      // unplayed/chalk display below via hasResult staying true but
      // homeWon/awayWon both false (existing behaviour for this edge case).
    } else {
      homeWon = m.winner && m.home && m.winner.name === m.home.name;
      awayWon = m.winner && m.away && m.winner.name === m.away.name;
    }

    // Score display: show the AET score if that's what decided it
    // (e.g. 2-1 after extra time, having been 1-1 at 90), otherwise the
    // 90-minute score, with a '(pens)' suffix whenever penalties decided it
    // regardless of which score line is shown.
    let scoreLine = hasResult ? `${played.homeGoals}–${played.awayGoals}` : '';
    if (decidedBy === 'aet') scoreLine = `${played.aetHomeGoals}–${played.aetAwayGoals} (AET)`;
    if (decidedBy === 'penalties') scoreLine += ' (pens)';

    let scoreOrPct;
    if (hasResult) {
      scoreOrPct = `<span class="win-pct">${scoreLine}</span>`;
    } else if (m.userPick) {
      const b = m.userPick.bucket;
      const pickTxt = b.gd === 0 ? 'pens' : `+${Math.abs(b.gd)}${Math.abs(b.gd) === GD_MAX ? '+' : ''}`;
      scoreOrPct = `<span class="win-pct win-pick">${pickTxt} · pick</span>`;
    } else {
      scoreOrPct = m.pWin != null ? `<span class="win-pct">${(m.pWin * 100).toFixed(0)}%</span>` : '';
    }
    const pickable = ['qf', 'sf', 'final'].includes(roundKey);
    return `
      <div class="match${pickable ? ' match-pickable' : ''}${m.userPick ? ' match-picked' : ''}" data-match-id="${m.id}" data-round="${roundKey}">
        <div class="match-team ${homeWon ? 'match-winner' : 'match-loser'}" data-team="${m.home ? m.home.name : ''}">
          ${teamButton(m.home)}
          ${homeWon ? scoreOrPct : ''}
        </div>
        <div class="match-team ${awayWon ? 'match-winner' : 'match-loser'}" data-team="${m.away ? m.away.name : ''}">
          ${teamButton(m.away)}
          ${awayWon ? scoreOrPct : ''}
        </div>
      </div>
    `;
  }

  function renderBracket() {
    bracket.innerHTML = '';
    const rounds = getRounds();
    const totalSlots = 16;
    const SLOT_MIN_HEIGHT = '68px';
    const rowTemplate = `auto repeat(${totalSlots}, minmax(${SLOT_MIN_HEIGHT}, 1fr))`;

    rounds.forEach((round) => {
      const col = document.createElement('div');
      col.className = 'bracket-col';
      col.dataset.round = round.key;
      col.style.gridTemplateRows = rowTemplate;
      const heading = document.createElement('div');
      heading.className = 'bracket-col-heading';
      heading.style.gridRow = '1';
      heading.textContent = round.label;
      col.appendChild(heading);
      round.matches.forEach((m, i) => {
        const wrapper = document.createElement('div');
        wrapper.className = 'bracket-slot';
        wrapper.style.gridRow = `${i * round.span + 2} / span ${round.span}`;
        wrapper.innerHTML = matchHtml(m, round.key);
        col.appendChild(wrapper);
      });
      bracket.appendChild(col);
    });

    const champCol = document.createElement('div');
    champCol.className = 'bracket-col bracket-champion-col';
    champCol.style.gridTemplateRows = rowTemplate;
    champCol.innerHTML = `
      <div class="bracket-col-heading" style="grid-row:1;grid-column:1;">Champion</div>
      <div class="bracket-slot champion-slot" style="grid-row: 2 / span ${totalSlots};">
        <div class="champion-card" data-team="${data.champion.name}">
          <span class="trophy" aria-hidden="true">🏆</span>
          ${teamButton(data.champion)}
        </div>
      </div>
    `;
    bracket.appendChild(champCol);
  }

  // ── SVG connector lines ───────────────────────────────────────────────────

  function drawConnectors() {
    const wrapRect = bracketWrap.getBoundingClientRect();
    const scrollLeft = bracketWrap.scrollLeft;
    const scrollTop = bracketWrap.scrollTop;
    svg.innerHTML = '';
    svg.setAttribute('width', bracket.scrollWidth);
    svg.setAttribute('height', bracket.scrollHeight);
    const rounds = getRounds();

    function points(el) {
      const r = el.getBoundingClientRect();
      return {
        left: r.left - wrapRect.left + scrollLeft,
        right: r.right - wrapRect.left + scrollLeft,
        midY: r.top - wrapRect.top + scrollTop + r.height / 2,
      };
    }

    function pathBetween(fromEl, toEl) {
      const f = points(fromEl), t = points(toEl);
      const midX = f.right + (t.left - f.right) / 2;
      return `M ${f.right} ${f.midY} H ${midX} V ${t.midY} H ${t.left}`;
    }

    const matchEls = {};
    for (const round of rounds) {
      matchEls[round.key] = round.matches.map((m) =>
        bracket.querySelector(`.match[data-round="${round.key}"][data-match-id="${m.id}"]`)
      );
    }
    const champCardEl = bracket.querySelector('.champion-card');

    function connect(fromKey, toKey, toEls) {
      matchEls[fromKey].forEach((el, i) => {
        const target = toEls[Math.floor(i / 2)];
        if (!el || !target) return;
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', pathBetween(el, target));
        path.setAttribute('class', 'connector');
        path.dataset.from = el.closest('.match').dataset.matchId;
        path.dataset.to = target.classList.contains('match') ? target.dataset.matchId : 'champion';
        path.dataset.fromRound = fromKey;
        svg.appendChild(path);
      });
    }

    connect('r32', 'r16', matchEls.r16);
    connect('r16', 'qf', matchEls.qf);
    connect('qf', 'sf', matchEls.sf);
    connect('sf', 'final', matchEls.final);
    if (matchEls.final[0] && champCardEl) {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', pathBetween(matchEls.final[0], champCardEl));
      path.setAttribute('class', 'connector');
      path.dataset.from = data.final.id;
      path.dataset.to = 'champion';
      path.dataset.fromRound = 'final';
      svg.appendChild(path);
    }
  }

  // ── Selection / highlight ─────────────────────────────────────────────────

  function teamMatchPath(teamName) {
    const rounds = getRounds();
    const path = [];
    for (const round of rounds) {
      for (const m of round.matches) {
        if ((m.home && m.home.name === teamName) || (m.away && m.away.name === teamName)) {
          path.push({ roundKey: round.key, matchId: m.id, won: m.winner && m.winner.name === teamName });
        }
      }
    }
    return path;
  }

  function applyHighlight() {
    const allTeamEls = document.querySelectorAll('[data-team]');
    const allConnectors = svg.querySelectorAll('.connector');
    if (!selectedTeam) {
      allTeamEls.forEach(el => el.classList.remove('highlight', 'dim'));
      allConnectors.forEach(el => el.classList.remove('connector-highlight'));
      document.querySelectorAll('.match, .champion-card').forEach(el => el.classList.remove('match-highlight'));
      clearBtn.hidden = true;
      return;
    }
    clearBtn.hidden = false;
    const path = teamMatchPath(selectedTeam);
    const pathMatchIds = new Set(path.map(p => p.matchId));
    document.querySelectorAll('.match').forEach(el => {
      el.classList.toggle('match-highlight', pathMatchIds.has(el.dataset.matchId));
    });
    const champCard = bracket.querySelector('.champion-card');
    if (champCard) champCard.classList.toggle('match-highlight', data.champion.name === selectedTeam);
    allTeamEls.forEach(el => {
      const isSelected = el.dataset.team === selectedTeam;
      const matchEl = el.closest('.match');
      const inPathMatch = matchEl && pathMatchIds.has(matchEl.dataset.matchId);
      el.classList.toggle('highlight', isSelected);
      el.classList.toggle('dim', !isSelected && !inPathMatch && el.closest('.bracket-wrap') !== null);
    });
    const wonMatchIds = new Set(path.filter(p => p.won).map(p => p.matchId));
    allConnectors.forEach(el => {
      el.classList.toggle('connector-highlight', wonMatchIds.has(el.dataset.from));
    });
  }

  // ── Click handling ────────────────────────────────────────────────────────

  function onTeamClick(e) {
    // Interactive rounds: tapping anywhere on a QF/SF/final match card opens
    // the outcome predictor for that match.
    const matchEl = e.target.closest('.match-pickable');
    if (matchEl && matchEl.closest('.bracket-wrap')) {
      openPredictor(matchEl.dataset.matchId, matchEl.dataset.round);
      return;
    }

    // Elsewhere: team taps toggle the path highlight (no modal).
    const target = e.target.closest('[data-team]');
    if (!target || !target.dataset.team) return;
    const teamName = target.dataset.team;

    if (target.closest('.bracket-wrap') || target.closest('.r32-results-grid') ||
        target.closest('.group-results-grid')) {
      selectedTeam = selectedTeam === teamName ? null : teamName;
      applyHighlight();
      if (selectedTeam) {
        const path = teamMatchPath(selectedTeam);
        if (path.length) {
          const el = bracket.querySelector(`.match[data-match-id="${path[0].matchId}"]`);
          if (el) el.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
        }
      }
    }
  }

  // ── Meta ──────────────────────────────────────────────────────────────────

  function renderMeta() {
    const d = new Date(data.generatedAt);
    metaUpdated.textContent = 'Updated ' + d.toLocaleString(undefined, { dateStyle: 'medium' });
    const n = data.resultsApplied || 0;
    metaResults.textContent = n > 0 ? `${n} result${n === 1 ? '' : 's'} played` : 'No matches yet';
  }

  // ── Data loading ──────────────────────────────────────────────────────────

  async function loadResults() {
    try {
      const res = await fetch('results.json?_=' + Date.now());
      if (!res.ok) return;
      const json = await res.json();
      allResults = json.results || [];
    } catch (_) {}
  }

  async function loadSplitRatings() {
    try {
      const res = await fetch('elo_current_split.json?_=' + Date.now());
      if (!res.ok) return;
      const json = await res.json();
      splitRatings = json.ratings || null;
    } catch (_) {}
  }

  async function loadPredictions() {
    try {
      const res = await fetch('predictions_negbin.json?_=' + Date.now());
      if (!res.ok) return;
      const json = await res.json();
      predictionsByName = new Map((json.teams || []).map(t => [t.name, t]));
    } catch (_) {}
  }

  let resizeTimer = null;
  function scheduleRedraw() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(drawConnectors, 80);
  }

  async function load() {
    try {
      const res = await fetch('scenario_negbin.json?_=' + Date.now());
      if (!res.ok) throw new Error('scenario_negbin.json not found (HTTP ' + res.status + ')');
      data = await res.json();
    } catch (e) {
      if (bracket) bracket.innerHTML = `<p class="error-row">Couldn't load scenario_negbin.json: ${e.message}.</p>`;
      return;
    }

    cachedVisualOrders = null;
    cachedRankByName = null;

    await Promise.all([loadResults(), loadPredictions(), loadSplitRatings()]);
    updateResetVisibility();

    renderMeta();
    renderGroupResults();
    renderOddsTable();
    renderBracket();
    requestAnimationFrame(() => requestAnimationFrame(drawConnectors));

    window.addEventListener('resize', scheduleRedraw);

    let scrollHintHidden = bracketWrap.scrollWidth <= bracketWrap.clientWidth + 4;
    if (scrollHintHidden && scrollHint) scrollHint.classList.add('hidden');
    bracketWrap.addEventListener('scroll', () => {
      scheduleRedraw();
      if (!scrollHintHidden && bracketWrap.scrollLeft > 20) {
        if (scrollHint) scrollHint.classList.add('hidden');
        scrollHintHidden = true;
      }
    });

    document.body.addEventListener('click', onTeamClick);
    clearBtn.addEventListener('click', () => { selectedTeam = null; applyHighlight(); });
    resetPicksBtn.addEventListener('click', resetAllPicks);
    scenarioModalClose.addEventListener('click', closeScenarioModal);
    scenarioModalBackdrop.addEventListener('click', e => {
      if (e.target === scenarioModalBackdrop) closeScenarioModal();
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && !scenarioModalBackdrop.hidden) closeScenarioModal();
    });
  }

  load();
})();
