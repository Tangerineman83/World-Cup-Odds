(function () {
  const groupsGrid = document.getElementById('groups-grid');
  const thirdsTableBody = document.getElementById('thirds-table-body');
  const bracket = document.getElementById('bracket');
  const bracketWrap = document.getElementById('bracket-wrap');
  const svg = document.getElementById('bracket-lines');
  const metaUpdated = document.getElementById('meta-updated');
  const clearBtn = document.getElementById('clear-selection');
  const scrollHint = document.getElementById('scroll-hint');
  const scenarioModalBackdrop = document.getElementById('scenario-modal-backdrop');
  const scenarioModal = document.getElementById('scenario-modal');
  const scenarioModalClose = document.getElementById('scenario-modal-close');
  const scenarioModalGauge = document.getElementById('scenario-modal-gauge');
  const scenarioModalFlow = document.getElementById('scenario-modal-flow');
  let scenarioFlowSide = null;
  let scenarioFlowKey = null;

  let data = null;
  let selectedTeam = null; // team name, or null

  const GROUP_ORDER = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L'];

  // ----------------------------------------------------------------------
  // Flags (flagcdn.com) - maps team codes to flag image codes. Most match
  // ISO 3166-1 alpha-2 lowercased; UK home nations need their gb-xxx codes.
  // ----------------------------------------------------------------------
  const FLAG_CODE_OVERRIDES = {
    EN: 'gb-eng', // England
    SQ: 'gb-sct', // Scotland
    WL: 'gb-wls', // Wales
    NI: 'gb-nir', // Northern Ireland
  };

  function flagUrl(teamCode, height = 24) {
    if (!teamCode) return null;
    const code = FLAG_CODE_OVERRIDES[teamCode] || teamCode.toLowerCase();
    return `https://flagcdn.com/h${height}/${code}.png`;
  }

  // ----------------------------------------------------------------------
  // Group tables
  // ----------------------------------------------------------------------

  function teamButton(team) {
    if (!team) {
      return `<span class="team-cell team-tbd"><span class="flag-icon" style="background:var(--border)"></span>To be confirmed</span>`;
    }
    const safeName = team.name.replace(/"/g, '&quot;');
    const flag = flagUrl(team.code);
    // onerror: flagcdn occasionally fails a handful of concurrent requests on
    // first load. Retry once via the non-retina (1x) URL; if that also fails,
    // hide the broken-image icon and fall back to the placeholder background
    // (this.outerHTML swap to a plain span keeps layout/spacing identical).
    const flagHtml = flag
      ? `<img class="flag-icon" src="${flag}" srcset="${flagUrl(team.code, 48)} 2x" alt="" loading="eager" onerror="if(!this.dataset.retried){this.dataset.retried='1';this.removeAttribute('srcset');this.src='${flag}';}else{this.outerHTML='<span class=&quot;flag-icon&quot;></span>';}">`
      : `<span class="flag-icon"></span>`;
    return `<button class="team-cell" data-team="${safeName}">${flagHtml}${team.name}<span class="code">${team.code || ''}</span></button>`;
  }

  // Renders a small circular "how sure are we" ring. pct is 0-1.
  // Colour reflects confidence tier (mirrors group-row advance colours).
  function confidenceRing(pct) {
    const pctLabel = Math.round(pct * 100);
    const tier = pct >= 0.3 ? 'conf-high' : pct >= 0.15 ? 'conf-mid' : 'conf-low';
    const r = 16;
    const circumference = 2 * Math.PI * r;
    const offset = circumference * (1 - pct);
    return `
      <div class="confidence-ring" title="How sure we are about this exact order: ${pctLabel}%">
        <svg width="38" height="38" viewBox="0 0 38 38">
          <circle class="ring-track" cx="19" cy="19" r="${r}" transform="rotate(-90 19 19)"></circle>
          <circle class="ring-progress ${tier}" cx="19" cy="19" r="${r}"
            stroke-dasharray="${circumference.toFixed(2)}"
            stroke-dashoffset="${offset.toFixed(2)}"
            transform="rotate(-90 19 19)"></circle>
          <text class="ring-label" x="19" y="19" text-anchor="middle" dominant-baseline="central">${pctLabel}%</text>
        </svg>
      </div>
    `;
  }

  // Renders a compact 4-segment stacked bar showing P(1st)/P(2nd)/P(3rd)/P(4th)
  // for a team within its group, plus a text summary for screen readers /
  // hover tooltips.
  function positionProbBar(probs) {
    const labels = ['1st', '2nd', '3rd', '4th'];
    const segments = probs.map((p, i) => {
      const pct = Math.max(0, p * 100);
      return `<span class="pp-seg pp-seg-${i}" style="width:${pct.toFixed(1)}%" title="${labels[i]}: ${pct.toFixed(0)}%"></span>`;
    }).join('');

    const summary = probs.map((p, i) => `${labels[i]} ${(p * 100).toFixed(0)}%`).join(' · ');

    return `
      <div class="pp-bar" role="img" aria-label="Finishing position probabilities: ${summary}">${segments}</div>
      <div class="pp-summary">${summary}</div>
    `;
  }

  // Each team's world ranking (1 = most likely to win the tournament),
  // precomputed in scenario.json from predictions.json's pChampion - so this
  // matches the ranking shown on the odds page, not raw rating. Falls back
  // to an Elo-based rank only if worldRank is missing (e.g. older scenario.json).
  let cachedRankByName = null;
  function rankByName() {
    if (cachedRankByName) return cachedRankByName;
    const all = [];
    for (const g of Object.values(data.groups)) {
      for (const t of g.order) all.push(t);
    }
    if (all.every((t) => t.worldRank != null)) {
      cachedRankByName = new Map(all.map((t) => [t.name, t.worldRank]));
    } else {
      all.sort((a, b) => b.elo - a.elo);
      cachedRankByName = new Map(all.map((t, i) => [t.name, i + 1]));
    }
    return cachedRankByName;
  }

  function renderThirds() {
    if (!thirdsTableBody) return;
    const thirds = data.allThirds || [];
    if (thirds.length === 0) {
      thirdsTableBody.innerHTML = '<tr><td colspan="4" class="loading-row">No data available.</td></tr>';
      return;
    }

    let rows = '';
    thirds.forEach((team, i) => {
      let lastCol;
      if (team.qualifies && team.opponent) {
        lastCol = `
          <div class="third-fixture">
            <span class="third-fixture-label">Plays</span>
            ${teamButton(team.opponent)}
          </div>`;
      } else {
        lastCol = `<span class="third-out">Out</span>`;
      }

      const chanceCell = team.pQualifyGiven3rd != null ? Math.round(team.pQualifyGiven3rd * 100) + '%' : '—';
      const chanceTitle = team.pFinish3rd != null
        ? `${Math.round(team.pFinish3rd * 100)}% chance of finishing 3rd in Group ${team.group}; of those cases, ${Math.round(team.pQualifyGiven3rd * 100)}% are also a top-8 third overall`
        : '';

      rows += `<tr data-team="${team.name}" class="${team.qualifies ? 'third-qualifies' : 'third-eliminated'}">
        <td class="col-team">${teamButton(team)}</td>
        <td class="col-num">${team.group}</td>
        <td class="col-num third-chance" title="${chanceTitle}">${chanceCell}</td>
        <td class="col-thirdpct">${lastCol}</td>
      </tr>`;

      // Divider after the 8th team: 8 of 12 thirds advance to the Last 32.
      if (i === 7 && thirds.length > 8) {
        rows += `<tr class="thirds-divider-row" aria-hidden="true">
          <td colspan="4"><div class="thirds-divider"><span>8 go through to the Last 32</span><span>4 go home</span></div></td>
        </tr>`;
      }
    });

    thirdsTableBody.innerHTML = rows;
  }

  // Opens the "road to the Last 32" Sankey popup.
  // Uses the shared scenarioFlow.js renderer (window.ScenarioFlow).
  function openScenarioModal(team) {
    if (!team.pooledScenarios || team.pooledScenarios.length === 0) return;
    scenarioFlowSide = null;
    scenarioFlowKey = null;
    scenarioModal.querySelector('.modal-title').innerHTML = teamButton(team);
    // In index.html, the popup is opened from the thirds table where the
    // "Chance" column shows P(qualify | finish 3rd), not the unconditional
    // pRoundOf32. Pass this as the headline to avoid confusion between the
    // two figures.
    const gaugeContext = team.pQualifyGiven3rd != null ? {
      pct: team.pQualifyGiven3rd,
      label: 'chance of qualifying as a top-8 third (if they finish 3rd)',
    } : null;
    window.ScenarioFlow.renderGauge(scenarioModalGauge, team, gaugeContext);
    renderModalFlow(team);
    scenarioModalBackdrop.hidden = false;
  }

  function renderModalFlow(team) {
    window.ScenarioFlow.renderFlow(
      scenarioModalFlow, team,
      { selectedSide: scenarioFlowSide, selectedKey: scenarioFlowKey },
      (side, key) => {
        scenarioFlowSide = side;
        scenarioFlowKey = key;
        renderModalFlow(team);
      }
    );
  }

  function closeScenarioModal() {
    scenarioModalBackdrop.hidden = true;
    scenarioFlowSide = null;
    scenarioFlowKey = null;
  }


  function renderGroups() {
    groupsGrid.innerHTML = '';
    for (const letter of GROUP_ORDER) {
      const g = data.groups[letter];
      const card = document.createElement('div');
      card.className = 'group-card';

      let rows = '';
      g.order.forEach((team, i) => {
        const posLabel = ['1st', '2nd', '3rd', '4th'][i];
        const advances = i < 2;
        const isBestThird = i === 2 && data.bestThirds.some((t) => t.name === team.name);
        let rowClass = '';
        if (advances) rowClass = 'advances';
        else if (isBestThird) rowClass = 'maybe-advances';
        else rowClass = 'eliminated';

        const posProbs = team.positionProbabilities || [0, 0, 0, 0];
        const posBarHtml = positionProbBar(posProbs);

        rows += `<tr class="${rowClass}" data-team="${team.name}">
          <td class="pos-col">${posLabel}</td>
          <td class="team-col">
            ${teamButton(team)}
            ${posBarHtml}
          </td>
        </tr>`;
      });

      card.innerHTML = `
        <div class="group-card-header">
          <h3>Group ${letter}</h3>
          ${confidenceRing(g.probability)}
        </div>
        <table class="group-table">
          <tbody>${rows}</tbody>
        </table>
      `;
      groupsGrid.appendChild(card);
    }
  }

  // ----------------------------------------------------------------------
  // Bracket
  // ----------------------------------------------------------------------

  // Bracket topology (mirrors scripts/sim/tournament.js pairing tables).
  // Each entry: [matchId, [fromIdA, fromIdB]] - the two matches whose winners
  // feed into this match. Used to compute a left-to-right visual order for
  // each round so a match's column position sits directly between its two
  // "parent" matches from the previous round - regardless of FIFA's official
  // numbering order (M89-M96 etc.), which is not bracket-tree order.
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

  // Recursively computes a left-to-right visual order for every round by
  // working DOWN the tree from the Final: the Final's two children occupy
  // the left and right halves of the SF row; each SF match's two children
  // occupy halves of its half of the QF row; and so on down to R32. This
  // guarantees every match sits exactly centered between (i.e. "nests
  // between") its two parent matches in the previous round, which is what
  // the CSS grid span math in renderBracket() assumes.
  //
  // pairsByRound: { r16: R16_PAIRS, qf: QF_PAIRS, sf: SF_PAIRS } - lookup
  // tables from matchId -> [childIdA, childIdB] in the round below.
  function computeVisualOrders(finalMatchId, pairsByRound) {
    const childrenOf = new Map(); // matchId -> [childIdA, childIdB]
    for (const pairs of Object.values(pairsByRound)) {
      for (const [matchId, children] of pairs) childrenOf.set(matchId, children);
    }

    // visualOrders[roundIndex] = array of matchIds in left-to-right order,
    // roundIndex 0 = final, 1 = SF, 2 = QF, 3 = R16, 4 = R32
    const visualOrders = [[finalMatchId]];
    let current = [finalMatchId];
    while (childrenOf.has(current[0])) {
      const next = [];
      for (const id of current) {
        const children = childrenOf.get(id);
        if (children) next.push(...children);
        else next.push(id); // shouldn't happen given well-formed pairsByRound
      }
      visualOrders.push(next);
      current = next;
    }

    // visualOrders is [final, sf, qf, r16, r32] (deepest last)
    return visualOrders.reverse(); // -> [r32, r16, qf, sf, final]
  }

  // Each round definition: key into `data`, display label, visually-ordered
  // matches, and how many R32 "slots" (out of 16) each match in this round
  // spans vertically. R32: 16 matches x 1 slot. R16: 8 x 2. QF: 4 x 4.
  // SF: 2 x 8. Final: 1 x 16.
  //
  // R32's order (data.r32, i.e. M73-M88) is already left-to-right
  // bracket-tree order by construction (see tournament.js). Every
  // subsequent round is reordered so each match sits between its two
  // parent matches from the previous round.
  let cachedRounds = null;
  function getRounds() {
    if (cachedRounds) return cachedRounds;

    const pairsByRound = { sf: SF_PAIRS, qf: QF_PAIRS, r16: R16_PAIRS };
    // FINAL_PAIR_KEY = ['M104', ['M101','M102']] - treat as the SF->Final link
    pairsByRound.final = [FINAL_PAIR_KEY];

    const [r32Order, r16Order, qfOrder, sfOrder, finalOrder] =
      computeVisualOrders(FINAL_PAIR_KEY[0], pairsByRound);

    const byId = (matches) => new Map(matches.map((m) => [m.id, m]));
    const r32ById = byId(data.r32);
    const r16ById = byId(data.r16);
    const qfById = byId(data.qf);
    const sfById = byId(data.sf);

    const r32 = r32Order.map((id) => r32ById.get(id)).filter(Boolean);
    const r16 = r16Order.map((id) => r16ById.get(id)).filter(Boolean);
    const qf = qfOrder.map((id) => qfById.get(id)).filter(Boolean);
    const sf = sfOrder.map((id) => sfById.get(id)).filter(Boolean);
    const final = [data.final];

    cachedRounds = [
      { key: 'r32', label: 'Round of 32', matches: r32, span: 1 },
      { key: 'r16', label: 'Round of 16', matches: r16, span: 2 },
      { key: 'qf', label: 'Quarter-finals', matches: qf, span: 4 },
      { key: 'sf', label: 'Semi-finals', matches: sf, span: 8 },
      { key: 'final', label: 'Final', matches: final, span: 16 },
    ];
    return cachedRounds;
  }

  function matchHtml(m, roundKey) {
    const homeWon = m.winner && m.home && m.winner.name === m.home.name;
    const awayWon = m.winner && m.away && m.winner.name === m.away.name;
    const pctLabel = m.pWin != null ? `${(m.pWin * 100).toFixed(0)}%` : '';

    return `
      <div class="match" data-match-id="${m.id}" data-round="${roundKey}">
        <div class="match-team ${homeWon ? 'match-winner' : 'match-loser'}" data-team="${m.home ? m.home.name : ''}">
          ${teamButton(m.home)}
          ${homeWon ? `<span class="win-pct">${pctLabel}</span>` : ''}
        </div>
        <div class="match-team ${awayWon ? 'match-winner' : 'match-loser'}" data-team="${m.away ? m.away.name : ''}">
          ${teamButton(m.away)}
          ${awayWon ? `<span class="win-pct">${pctLabel}</span>` : ''}
        </div>
      </div>
    `;
  }

  // Renders the bracket as a CSS grid: 16 rows (slot units) x N columns.
  // Each match's container spans `span` rows, positioned at slot index*span + 1.
  function renderBracket() {
    bracket.innerHTML = '';
    const rounds = getRounds();
    const totalSlots = 16;
    // Minimum height for one "slot unit" (= one R32 match's worth of vertical
    // space). Without this, `repeat(16, 1fr)` forces every row track to the
    // same height regardless of content, so a 2-row match box (.match has two
    // .match-team rows, each ~1.6rem incl. padding -> ~54px total) overflows
    // a 1fr R32 track and visually overlaps neighbouring matches/connectors.
    // minmax(SLOT_MIN_HEIGHT, 1fr) guarantees every track is tall enough for
    // an R32 box; larger-span rounds (R16=2 tracks, QF=4, ...) then get
    // proportionally more room and center their single box within it.
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
      heading.style.gridColumn = '1';
      heading.textContent = round.label;
      col.appendChild(heading);

      round.matches.forEach((m, i) => {
        const wrapper = document.createElement('div');
        wrapper.className = 'bracket-slot';
        const startRow = i * round.span + 2; // +2: row 1 is heading, grid is 1-indexed
        wrapper.style.gridRow = `${startRow} / span ${round.span}`;
        wrapper.innerHTML = matchHtml(m, round.key);
        col.appendChild(wrapper);
      });

      bracket.appendChild(col);
    });

    // Champion column
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

  // ----------------------------------------------------------------------
  // SVG connector lines
  // ----------------------------------------------------------------------

  // For each match in rounds 2..N (R16, QF, SF, Final, Champion), draws two
  // bracket-style connector paths from its two "parent" matches (the two
  // matches in the previous round whose winner feeds into this one).
  function drawConnectors() {
    const wrapRect = bracketWrap.getBoundingClientRect();
    const scrollLeft = bracketWrap.scrollLeft;
    const scrollTop = bracketWrap.scrollTop;

    svg.innerHTML = '';
    svg.setAttribute('width', bracket.scrollWidth);
    svg.setAttribute('height', bracket.scrollHeight);

    const rounds = getRounds();

    // Helper: get a match element's right-center and left-center points,
    // relative to the bracket container's scrollable content box.
    function points(matchEl) {
      const r = matchEl.getBoundingClientRect();
      const left = r.left - wrapRect.left + scrollLeft;
      const right = r.right - wrapRect.left + scrollLeft;
      const midY = r.top - wrapRect.top + scrollTop + r.height / 2;
      return { left, right, midY };
    }

    function pathBetween(fromMatchEl, toMatchEl) {
      const from = points(fromMatchEl);
      const to = points(toMatchEl);
      const midX = from.right + (to.left - from.right) / 2;
      return `M ${from.right} ${from.midY} H ${midX} V ${to.midY} H ${to.left}`;
    }

    // Map round key -> array of match elements, in order
    const matchEls = {};
    for (const round of rounds) {
      matchEls[round.key] = round.matches.map((m) =>
        bracket.querySelector(`.match[data-round="${round.key}"][data-match-id="${m.id}"]`)
      );
    }
    // Champion card acts as the "final round" target
    const championCardEl = bracket.querySelector('.champion-card');

    // R32 -> R16: pairs (0,1)->0, (2,3)->1, ...
    function connect(fromKey, toKey, toEls) {
      const fromEls = matchEls[fromKey];
      fromEls.forEach((el, i) => {
        const targetIdx = Math.floor(i / 2);
        const target = toEls[targetIdx];
        if (!el || !target) return;
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', pathBetween(el, target));
        path.setAttribute('class', 'connector');
        path.dataset.from = el.closest('.match').dataset.matchId;
        path.dataset.to = target.classList && target.classList.contains('match') ? target.dataset.matchId : 'champion';
        path.dataset.fromRound = fromKey;
        svg.appendChild(path);
      });
    }

    connect('r32', 'r16', matchEls.r16);
    connect('r16', 'qf', matchEls.qf);
    connect('qf', 'sf', matchEls.sf);
    connect('sf', 'final', matchEls.final);
    // Final -> Champion (single connector)
    if (matchEls.final[0] && championCardEl) {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', pathBetween(matchEls.final[0], championCardEl));
      path.setAttribute('class', 'connector');
      path.dataset.from = data.final.id;
      path.dataset.to = 'champion';
      path.dataset.fromRound = 'final';
      svg.appendChild(path);
    }
  }

  // ----------------------------------------------------------------------
  // Selection / path highlighting
  // ----------------------------------------------------------------------

  // Returns the ordered list of match ids (across all rounds) that a given
  // team appears in, based on scenario.json's home/away/winner fields.
  function teamMatchPath(teamName) {
    const rounds = getRounds();
    const path = [];
    for (const round of rounds) {
      for (const m of round.matches) {
        const inMatch = (m.home && m.home.name === teamName) || (m.away && m.away.name === teamName);
        if (inMatch) path.push({ roundKey: round.key, matchId: m.id, won: m.winner && m.winner.name === teamName });
      }
    }
    return path;
  }

  function applyHighlight() {
    const allTeamEls = document.querySelectorAll('[data-team]');
    const allConnectors = svg.querySelectorAll('.connector');
    const groupRows = document.querySelectorAll('.group-table tr');

    if (!selectedTeam) {
      allTeamEls.forEach((el) => el.classList.remove('highlight', 'dim'));
      allConnectors.forEach((el) => el.classList.remove('connector-highlight'));
      groupRows.forEach((el) => el.classList.remove('row-highlight', 'row-dim'));
      document.querySelectorAll('.match, .champion-card').forEach((el) => el.classList.remove('match-highlight'));
      clearBtn.hidden = true;
      return;
    }

    clearBtn.hidden = false;

    // Highlight match boxes the team appears in
    const path = teamMatchPath(selectedTeam);
    const pathMatchIds = new Set(path.map((p) => p.matchId));
    document.querySelectorAll('.match').forEach((matchEl) => {
      matchEl.classList.toggle('match-highlight', pathMatchIds.has(matchEl.dataset.matchId));
    });
    if (champEl()) {
      champEl().classList.toggle('match-highlight', data.champion.name === selectedTeam);
    }

    // A [data-team] element should NOT be dimmed if either:
    //  - it's the selected team themselves, OR
    //  - it sits inside a match box that's on the selected team's path
    //    (i.e. it's an opponent the selected team plays/played in THAT
    //    specific match - keeping it visible there). Crucially this is
    //    scoped to that match box only: the same team name appearing in a
    //    DIFFERENT, unrelated match elsewhere in the bracket is still
    //    dimmed, so unrelated fixtures don't look like part of the path.
    allTeamEls.forEach((el) => {
      const isSelected = el.dataset.team === selectedTeam;
      const matchEl = el.closest('.match');
      const inPathMatch = matchEl && pathMatchIds.has(matchEl.dataset.matchId);
      el.classList.toggle('highlight', isSelected);
      el.classList.toggle('dim', !isSelected && !inPathMatch && el.closest('.bracket-wrap') !== null);
    });

    groupRows.forEach((el) => {
      const isMatch = el.dataset.team === selectedTeam;
      el.classList.toggle('row-highlight', isMatch);
    });

    // Highlight connectors along the team's path, but only up to (and
    // including) the connector leaving the last match they won.
    // A connector with data-from = matchId is "on the path" if the team
    // won that match (i.e. progressed via that connector).
    const wonMatchIds = new Set(path.filter((p) => p.won).map((p) => p.matchId));
    allConnectors.forEach((el) => {
      el.classList.toggle('connector-highlight', wonMatchIds.has(el.dataset.from));
    });
  }

  function champEl() {
    return bracket.querySelector('.champion-card');
  }

  function onTeamClick(e) {
    // Clicks on a team's OWN cell within the third-place table open the
    // qualification-scenario popup instead of toggling the bracket
    // highlight. Scoped to .col-team specifically so clicking the opponent
    // shown in "Next match" doesn't open this team's popup.
    const thirdsCell = e.target.closest('#thirds-table-body td.col-team');
    if (thirdsCell) {
      const row = thirdsCell.closest('tr[data-team]');
      const team = row && (data.allThirds || []).find((t) => t.name === row.dataset.team);
      if (team) openScenarioModal(team);
      return;
    }

    const target = e.target.closest('[data-team]');
    if (!target || !target.dataset.team) return;
    const team = target.dataset.team;
    if (!team) return;

    selectedTeam = selectedTeam === team ? null : team;
    applyHighlight();

    if (selectedTeam) {
      // Scroll the bracket so the team's earliest active match is visible
      const path = teamMatchPath(selectedTeam);
      if (path.length) {
        const el = bracket.querySelector(`.match[data-match-id="${path[0].matchId}"]`);
        if (el) el.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
      }
    }
  }

  // ----------------------------------------------------------------------
  // Meta + load
  // ----------------------------------------------------------------------

  function renderMeta() {
    const d = new Date(data.generatedAt);
    metaUpdated.textContent = 'Updated ' + d.toLocaleString(undefined, {
      dateStyle: 'medium', timeStyle: 'short',
    });

    const metaResults = document.getElementById('meta-results');
    const n = data.resultsApplied || 0;
    if (n > 0) {
      metaResults.textContent = `${n} result${n === 1 ? '' : 's'} played so far`;
      metaResults.title = 'Matches already played are used as-is, and have updated each team\'s rating.';
    } else {
      metaResults.textContent = 'No matches played yet';
    }
  }

  let resizeTimer = null;
  function scheduleRedraw() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(drawConnectors, 80);
  }

  async function load() {
    try {
      const res = await fetch('scenario.json?_=' + Date.now());
      if (!res.ok) throw new Error('scenario.json not found (HTTP ' + res.status + ')');
      data = await res.json();
      cachedRounds = null;
      cachedRankByName = null;
      renderMeta();
      renderGroups();
      renderThirds();
      renderBracket();

      // Initial connector draw after layout settles
      requestAnimationFrame(() => requestAnimationFrame(drawConnectors));

      window.addEventListener('resize', scheduleRedraw);
      bracketWrap.addEventListener('scroll', scheduleRedraw);

      document.body.addEventListener('click', onTeamClick);
      clearBtn.addEventListener('click', () => {
        selectedTeam = null;
        applyHighlight();
      });

      scenarioModalClose.addEventListener('click', closeScenarioModal);
      scenarioModalBackdrop.addEventListener('click', (e) => {
        if (e.target === scenarioModalBackdrop) closeScenarioModal();
      });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !scenarioModalBackdrop.hidden) closeScenarioModal();
      });

      // Hide the scroll hint once the user has scrolled the bracket
      bracketWrap.addEventListener('scroll', () => {
        if (bracketWrap.scrollLeft > 20) scrollHint.classList.add('hidden');
      }, { once: true });
      // Also hide it if the bracket already fits without scrolling
      if (bracketWrap.scrollWidth <= bracketWrap.clientWidth + 4) {
        scrollHint.classList.add('hidden');
      }
    } catch (e) {
      groupsGrid.innerHTML = `<p class="error-row">Couldn't load scenario.json: ${e.message}. Run <code>node scripts/sim/runScenario.js</code> and commit the result.</p>`;
    }
  }

  load();
})();
