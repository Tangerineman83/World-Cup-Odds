(function () {
  const groupsGrid = document.getElementById('groups-grid');
  const bracket = document.getElementById('bracket');
  const bracketWrap = document.getElementById('bracket-wrap');
  const svg = document.getElementById('bracket-lines');
  const metaUpdated = document.getElementById('meta-updated');
  const clearBtn = document.getElementById('clear-selection');
  const scrollHint = document.getElementById('scroll-hint');

  let data = null;
  let selectedTeam = null; // team name, or null

  const GROUP_ORDER = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L'];

  // ----------------------------------------------------------------------
  // Group tables
  // ----------------------------------------------------------------------

  function teamButton(team) {
    if (!team) {
      return `<span class="team-cell team-tbd">TBD</span>`;
    }
    const safeName = team.name.replace(/"/g, '&quot;');
    return `<button class="team-cell" data-team="${safeName}">${team.name}<span class="code">${team.code || ''}</span></button>`;
  }

  function renderGroups(maxElo) {
    groupsGrid.innerHTML = '';
    for (const letter of GROUP_ORDER) {
      const g = data.groups[letter];
      const card = document.createElement('div');
      card.className = 'group-card';

      const pct = (g.probability * 100).toFixed(1);
      const confidenceClass = g.probability >= 0.3 ? 'conf-high' : g.probability >= 0.15 ? 'conf-mid' : 'conf-low';

      let rows = '';
      g.order.forEach((team, i) => {
        const posLabel = ['1st', '2nd', '3rd', '4th'][i];
        const advances = i < 2;
        const isBestThird = i === 2 && data.bestThirds.some((t) => t.name === team.name);
        let rowClass = '';
        if (advances) rowClass = 'advances';
        else if (isBestThird) rowClass = 'maybe-advances';
        else rowClass = 'eliminated';

        const barPct = Math.max(4, Math.round((team.elo / maxElo) * 100));

        rows += `<tr class="${rowClass}" data-team="${team.name}">
          <td class="pos-col">${posLabel}</td>
          <td class="team-col">${teamButton(team)}</td>
          <td class="elo-col">
            <span class="elo-bar-wrap"><span class="elo-bar" style="width:${barPct}%"></span></span>
            <span class="elo-num">${team.elo}</span>
          </td>
        </tr>`;
      });

      card.innerHTML = `
        <div class="group-card-header">
          <h3>Group ${letter}</h3>
          <span class="confidence ${confidenceClass}" title="Probability of this exact 1st-4th order occurring">${pct}%</span>
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

  // Each round definition: key into `data`, display label, and how many
  // R32 "slots" (out of 16) each match in this round spans vertically.
  // R32: 16 matches x 1 slot. R16: 8 x 2. QF: 4 x 4. SF: 2 x 8. Final: 1 x 16.
  function getRounds() {
    return [
      { key: 'r32', label: 'Round of 32', matches: data.r32, span: 1 },
      { key: 'r16', label: 'Round of 16', matches: data.r16, span: 2 },
      { key: 'qf', label: 'Quarter-finals', matches: data.qf, span: 4 },
      { key: 'sf', label: 'Semi-finals', matches: data.sf, span: 8 },
      { key: 'final', label: 'Final', matches: [data.final], span: 16 },
    ];
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

    rounds.forEach((round) => {
      const col = document.createElement('div');
      col.className = 'bracket-col';
      col.dataset.round = round.key;
      col.style.gridTemplateRows = `auto repeat(${totalSlots}, 1fr)`;

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
    champCol.style.gridTemplateRows = `auto repeat(${totalSlots}, 1fr)`;
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
      path.dataset.from = 'F';
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

    allTeamEls.forEach((el) => {
      const isMatch = el.dataset.team === selectedTeam;
      el.classList.toggle('highlight', isMatch);
      el.classList.toggle('dim', !isMatch && el.closest('.bracket-wrap') !== null);
    });

    groupRows.forEach((el) => {
      const isMatch = el.dataset.team === selectedTeam;
      el.classList.toggle('row-highlight', isMatch);
    });

    // Highlight match boxes the team appears in
    const path = teamMatchPath(selectedTeam);
    const pathMatchIds = new Set(path.map((p) => p.matchId));
    document.querySelectorAll('.match').forEach((matchEl) => {
      matchEl.classList.toggle('match-highlight', pathMatchIds.has(matchEl.dataset.matchId));
    });
    if (champEl()) {
      champEl().classList.toggle('match-highlight', data.champion.name === selectedTeam);
    }

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
    metaUpdated.textContent = 'Scenario generated ' + d.toLocaleString(undefined, {
      dateStyle: 'medium', timeStyle: 'short',
    });
  }

  function maxEloAcrossAllTeams() {
    let max = 0;
    for (const g of Object.values(data.groups)) {
      for (const t of g.order) max = Math.max(max, t.elo);
    }
    return max;
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
      renderMeta();
      renderGroups(maxEloAcrossAllTeams());
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
