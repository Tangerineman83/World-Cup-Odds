(function () {
  const groupsGrid = document.getElementById('groups-grid');
  const bracket = document.getElementById('bracket');
  const metaUpdated = document.getElementById('meta-updated');

  let data = null;
  let selectedTeam = null; // team name, or null

  const GROUP_ORDER = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L'];

  function teamCell(team, { rankLabel } = {}) {
    if (!team) {
      return `<span class="team-cell team-tbd">TBD</span>`;
    }
    const safeName = team.name.replace(/"/g, '&quot;');
    const rankHtml = rankLabel ? `<span class="rank-label">${rankLabel}</span>` : '';
    return `${rankHtml}<button class="team-cell" data-team="${safeName}">${team.name}<span class="code">${team.code || ''}</span></button>`;
  }

  function renderGroups() {
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
        const advances = i < 2; // 1st/2nd always advance; 3rd may advance as a "best third"
        const isBestThird = i === 2 && data.bestThirds.some((t) => t.name === team.name);
        let rowClass = '';
        if (advances) rowClass = 'advances';
        else if (isBestThird) rowClass = 'maybe-advances';
        else rowClass = 'eliminated';

        rows += `<tr class="${rowClass}" data-team="${team.name}">
          <td class="pos-col">${posLabel}</td>
          <td class="team-col">${teamCell(team)}</td>
          <td class="elo-col">${team.elo}</td>
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

  // Builds a map: team name -> { round: matchObj, side: 'home'|'away'|'winner-only' }
  // for quick path lookups. Also returns the ordered list of rounds.
  function getRounds() {
    return [
      { key: 'r32', label: 'Round of 32', matches: data.r32 },
      { key: 'r16', label: 'Round of 16', matches: data.r16 },
      { key: 'qf', label: 'Quarter-finals', matches: data.qf },
      { key: 'sf', label: 'Semi-finals', matches: data.sf },
      { key: 'final', label: 'Final', matches: [data.final] },
    ];
  }

  function matchHtml(m, roundKey) {
    const homeWon = m.winner && m.home && m.winner.name === m.home.name;
    const awayWon = m.winner && m.away && m.winner.name === m.away.name;
    const pctLabel = m.pWin != null ? `${(m.pWin * 100).toFixed(0)}%` : '';

    return `
      <div class="match" data-match-id="${m.id}" data-round="${roundKey}">
        <div class="match-team ${homeWon ? 'match-winner' : 'match-loser'}" data-team="${m.home ? m.home.name : ''}">
          ${teamCell(m.home)}
          ${homeWon ? `<span class="win-pct">${pctLabel}</span>` : ''}
        </div>
        <div class="match-team ${awayWon ? 'match-winner' : 'match-loser'}" data-team="${m.away ? m.away.name : ''}">
          ${teamCell(m.away)}
          ${awayWon ? `<span class="win-pct">${pctLabel}</span>` : ''}
        </div>
      </div>
    `;
  }

  function renderBracket() {
    bracket.innerHTML = '';
    const rounds = getRounds();

    for (const round of rounds) {
      const col = document.createElement('div');
      col.className = 'bracket-col';
      col.dataset.round = round.key;

      const heading = document.createElement('div');
      heading.className = 'bracket-col-heading';
      heading.textContent = round.label;
      col.appendChild(heading);

      const matchesWrap = document.createElement('div');
      matchesWrap.className = 'bracket-matches';
      matchesWrap.innerHTML = round.matches.map((m) => matchHtml(m, round.key)).join('');
      col.appendChild(matchesWrap);

      bracket.appendChild(col);
    }

    // Champion column
    const champCol = document.createElement('div');
    champCol.className = 'bracket-col bracket-champion-col';
    champCol.innerHTML = `
      <div class="bracket-col-heading">Champion</div>
      <div class="bracket-matches">
        <div class="champion-card">
          ${teamCell(data.champion)}
          <span class="trophy" aria-hidden="true">🏆</span>
        </div>
      </div>
    `;
    bracket.appendChild(champCol);
  }

  // Highlights every occurrence of `teamName` across group tables and the
  // bracket, and dims everything else slightly.
  function applyHighlight() {
    const allTeamEls = document.querySelectorAll('[data-team]');
    if (!selectedTeam) {
      allTeamEls.forEach((el) => el.classList.remove('highlight', 'dim'));
      document.querySelectorAll('.match').forEach((el) => el.classList.remove('match-highlight'));
      return;
    }

    allTeamEls.forEach((el) => {
      const isMatch = el.dataset.team === selectedTeam;
      el.classList.toggle('highlight', isMatch);
      el.classList.toggle('dim', !isMatch);
    });

    // Highlight matches the team actually appears in
    document.querySelectorAll('.match').forEach((matchEl) => {
      const teams = [...matchEl.querySelectorAll('[data-team]')].map((e) => e.dataset.team);
      matchEl.classList.toggle('match-highlight', teams.includes(selectedTeam));
    });
  }

  function onTeamClick(e) {
    const target = e.target.closest('[data-team]');
    if (!target || !target.dataset.team) return;
    const team = target.dataset.team;
    if (!team) return;

    selectedTeam = selectedTeam === team ? null : team;
    applyHighlight();
  }

  function renderMeta() {
    const d = new Date(data.generatedAt);
    metaUpdated.textContent = 'Scenario generated ' + d.toLocaleString(undefined, {
      dateStyle: 'medium', timeStyle: 'short',
    });
  }

  async function load() {
    try {
      const res = await fetch('scenario.json?_=' + Date.now());
      if (!res.ok) throw new Error('scenario.json not found (HTTP ' + res.status + ')');
      data = await res.json();
      renderMeta();
      renderGroups();
      renderBracket();

      document.body.addEventListener('click', onTeamClick);
    } catch (e) {
      groupsGrid.innerHTML = `<p class="error-row">Couldn't load scenario.json: ${e.message}. Run <code>node scripts/sim/runScenario.js</code> and commit the result.</p>`;
    }
  }

  load();
})();
