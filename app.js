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
  const scenarioModalGauge = document.getElementById('scenario-modal-gauge');
  const scenarioModalFlow = document.getElementById('scenario-modal-flow');
  const scenarioModalTitle = document.getElementById('scenario-modal-title');
  let data = null;           // scenario_negbin.json
  let predictionsByName = null;  // predictions_negbin.json teams map
  let allResults = [];       // results.json
  let selectedTeam = null;
  let scenarioFlowCol = null;
  let scenarioFlowKey = null;
  let cachedRounds = null;
  let cachedRankByName = null;

  const { flagImgHtml, fmtPct, renderGauge, renderFlow, renderKnockoutFlow } = window.ScenarioFlow;

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

  function openKnockoutModal(teamName) {
    if (!teamName || !predictionsByName) return;
    const team = predictionsByName.get(teamName);
    if (!team) return;

    scenarioFlowCol = null;
    scenarioFlowKey = null;
    scenarioModalTitle.innerHTML = teamButton({ name: team.name, code: team.code });

    // Render knockout gauge (shows champion probability prominently)
    const pChamp = team.pChampion || 0;
    const pFinal = team.pFinal || 0;
    const pSF = team.pSemiFinal || 0;
    scenarioModalGauge.innerHTML = `
      <div class="gauge-headline">
        <span class="gauge-pct">${fmtPct(pChamp)}</span>
        <span class="gauge-label">&nbsp;chance of winning the tournament</span>
      </div>
      <div class="ko-stage-probs">
        <span><span class="ko-pip" style="background:#818cf8"></span>Last 32: ${fmtPct(team.pRoundOf32)}</span>
        <span><span class="ko-pip" style="background:#60a5fa"></span>Last 16: ${fmtPct(team.pRoundOf16)}</span>
        <span><span class="ko-pip" style="background:#34d399"></span>QF: ${fmtPct(team.pQuarterFinal)}</span>
        <span><span class="ko-pip" style="background:#fbbf24"></span>SF: ${fmtPct(pSF)}</span>
        <span><span class="ko-pip" style="background:#f97316"></span>Final: ${fmtPct(pFinal)}</span>
      </div>
    `;

    // Render knockout Sankey
    const predsList = predictionsByName ? [...predictionsByName.values()] : [];
    renderKnockoutFlow(scenarioModalFlow, team, data, predsList);
    scenarioModalBackdrop.hidden = false;
  }

  function closeScenarioModal() {
    scenarioModalBackdrop.hidden = true;
    scenarioFlowCol = null;
    scenarioFlowKey = null;
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
    if (cachedRounds) return cachedRounds;
    const pairsByRound = { sf: SF_PAIRS, qf: QF_PAIRS, r16: R16_PAIRS, final: [FINAL_PAIR_KEY] };
    const [r32Order, r16Order, qfOrder, sfOrder, finalOrder] =
      computeVisualOrders(FINAL_PAIR_KEY[0], pairsByRound);
    const byId = (matches) => new Map((matches || []).map((m) => [m.id, m]));
    const r32ById = byId(data.r32);
    const r16ById = byId(data.r16);
    const qfById  = byId(data.qf);
    const sfById  = byId(data.sf);
    cachedRounds = [
      { key: 'r32',   label: 'Round of 32',    matches: r32Order.map(id => r32ById.get(id)).filter(Boolean), span: 1 },
      { key: 'r16',   label: 'Round of 16',    matches: r16Order.map(id => r16ById.get(id)).filter(Boolean), span: 2 },
      { key: 'qf',    label: 'Quarter-finals', matches: qfOrder.map(id => qfById.get(id)).filter(Boolean),   span: 4 },
      { key: 'sf',    label: 'Semi-finals',    matches: sfOrder.map(id => sfById.get(id)).filter(Boolean),   span: 8 },
      { key: 'final', label: 'Final',          matches: [data.final],                                         span: 16 },
    ];
    return cachedRounds;
  }

  function matchHtml(m, roundKey) {
    // Check if this match has an actual result in allResults
    const played = allResults.find(r => r.id === m.id && r.homeGoals != null);
    const hasResult = !!played;
    const wentToPenalties = hasResult && played.homeGoals === played.awayGoals && played.penaltyWinner;
    const homeWon = hasResult
      ? (wentToPenalties ? played.penaltyWinner === 'home' : played.homeGoals > played.awayGoals)
      : (m.winner && m.home && m.winner.name === m.home.name);
    const awayWon = hasResult
      ? (wentToPenalties ? played.penaltyWinner === 'away' : played.awayGoals > played.homeGoals)
      : (m.winner && m.away && m.winner.name === m.away.name);
    const scoreOrPct = hasResult
      ? `<span class="win-pct">${played.homeGoals}–${played.awayGoals}${wentToPenalties ? ' (pens)' : ''}</span>`
      : (m.pWin != null ? `<span class="win-pct">${(m.pWin * 100).toFixed(0)}%</span>` : '');
    return `
      <div class="match" data-match-id="${m.id}" data-round="${roundKey}">
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
    const target = e.target.closest('[data-team]');
    if (!target || !target.dataset.team) return;
    const teamName = target.dataset.team;
    if (!teamName) return;

    // If inside bracket or result grids: toggle highlight + open modal
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
        openKnockoutModal(selectedTeam);
      } else {
        closeScenarioModal();
      }
      return;
    }
    // Otherwise just open modal
    openKnockoutModal(teamName);
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

    cachedRounds = null;
    cachedRankByName = null;

    await Promise.all([loadResults(), loadPredictions()]);

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
