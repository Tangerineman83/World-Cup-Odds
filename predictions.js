(function () {
  const tbody = document.getElementById('table-body');
  const metaUpdated = document.getElementById('meta-updated');
  const metaSims = document.getElementById('meta-sims');
  const table = document.getElementById('predictions-table');
  const scenarioModalBackdrop = document.getElementById('scenario-modal-backdrop');
  const scenarioModalTitle = document.getElementById('scenario-modal-title');
  const scenarioModalClose = document.getElementById('scenario-modal-close');
  const scenarioModalGauge = document.getElementById('scenario-modal-gauge');
  const scenarioModalFlow = document.getElementById('scenario-modal-flow');

  let currentData = null;
  let scenarioData = null;
  let sortKey = 'eloRating';
  let sortDir = 'desc';
  let selectedTeamName = null;
  let selectedFlowCol = null;
  let selectedFlowKey = null;

  const { fmtPct, flagImgHtml, renderKnockoutFlow } = window.ScenarioFlow;

  function pctStyle(p, colorVar) {
    if (p == null) return '';
    const alpha = Math.min(p, 1) * 0.35;
    return `background: color-mix(in srgb, var(${colorVar}) ${(alpha * 100).toFixed(0)}%, transparent);`;
  }

  function render() {
    if (!currentData) return;
    const rows = currentData.teams.map(t => ({
      ...t,
      eloRating: t.eloOverall,
      eloChange: null,
      eloBaseline: null,
    }));

    rows.sort((a, b) => {
      const av = a[sortKey], bv = b[sortKey];
      if (typeof av === 'string') {
        const cmp = av.localeCompare(bv);
        return sortDir === 'asc' ? cmp : -cmp;
      }
      return sortDir === 'asc' ? av - bv : bv - av;
    });

    tbody.innerHTML = '';
    for (const row of rows) {
      const tr = document.createElement('tr');
      tr.dataset.team = row.name;
      tr.classList.add('team-row');
      if (row.name === selectedTeamName) tr.classList.add('team-row-selected');

      const tdTeam = document.createElement('td');
      tdTeam.className = 'col-team';
      tdTeam.innerHTML = `<span class="team-name-wrap">${flagImgHtml(row.code, 24)}<span class="team-name">${row.name}</span></span>`;

      const tdGroup = document.createElement('td');
      tdGroup.className = 'col-num';
      tdGroup.textContent = row.group;

      const tdFifa = document.createElement('td');
      tdFifa.className = 'col-num';
      tdFifa.textContent = row.fifaRank != null ? '#' + row.fifaRank : '—';
      tdFifa.title = 'Official FIFA World Ranking (June 2026)';

      const tdRating = document.createElement('td');
      tdRating.className = 'col-num col-rating';
      tdRating.textContent = row.eloRating != null ? Math.round(row.eloRating) : '—';

      tr.append(tdTeam, tdGroup, tdFifa, tdRating);

      for (const [key, colorVar] of [
        ['pRoundOf16', '--host'],
        ['pQuarterFinal', '--host'],
        ['pSemiFinal', '--pos'],
        ['pFinal', '--pos'],
        ['pChampion', '--pos'],
      ]) {
        const td = document.createElement('td');
        td.className = 'col-num pct-cell';
        td.textContent = fmtPct(row[key]);
        td.style.cssText = pctStyle(row[key], colorVar);
        if (key === 'pChampion') td.classList.add('champion-cell');
        tr.appendChild(td);
      }

      tbody.appendChild(tr);
    }

    table.querySelectorAll('th.sortable').forEach(th => {
      th.classList.remove('sorted-asc', 'sorted-desc');
      if (th.dataset.key === sortKey) th.classList.add(sortDir === 'asc' ? 'sorted-asc' : 'sorted-desc');
    });
  }

  function renderMeta() {
    if (!currentData) return;
    const d = new Date(currentData.generatedAt);
    metaUpdated.textContent = 'Updated ' + d.toLocaleString(undefined, { dateStyle: 'medium' });
    if (metaSims) metaSims.textContent = 'Based on ' + currentData.numSimulations.toLocaleString() + ' tournaments';
  }

  async function load() {
    try {
      const [predRes, scenRes] = await Promise.all([
        fetch('predictions_negbin.json?_=' + Date.now()),
        fetch('scenario_negbin.json?_=' + Date.now()),
      ]);
      if (!predRes.ok) throw new Error('predictions_negbin.json not found');
      currentData = await predRes.json();
      if (scenRes.ok) scenarioData = await scenRes.json();
      renderMeta();
      render();
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="9" class="error-row">Couldn't load predictions: ${e.message}</td></tr>`;
    }
  }

  table.querySelectorAll('th.sortable').forEach(th => {
    th.addEventListener('click', () => {
      const key = th.dataset.key;
      if (sortKey === key) {
        sortDir = sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        sortKey = key;
        sortDir = (key === 'name' || key === 'group') ? 'asc' : 'desc';
      }
      render();
    });
  });

  tbody.addEventListener('click', e => {
    const tr = e.target.closest('tr.team-row');
    if (!tr || !tr.dataset.team) return;
    selectedTeamName = tr.dataset.team;
    render();
    openTeamModal(selectedTeamName);
  });

  scenarioModalClose.addEventListener('click', closeModal);
  scenarioModalBackdrop.addEventListener('click', e => {
    if (e.target === scenarioModalBackdrop) closeModal();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !scenarioModalBackdrop.hidden) closeModal();
  });

  function closeModal() {
    scenarioModalBackdrop.hidden = true;
    selectedTeamName = null;
    selectedFlowCol = null;
    selectedFlowKey = null;
    render();
  }

  function openTeamModal(name) {
    const team = currentData.teams.find(t => t.name === name);
    if (!team) return;
    selectedFlowCol = null;
    selectedFlowKey = null;
    scenarioModalTitle.innerHTML = `${flagImgHtml(team.code, 32)}${team.name}`;

    // Gauge shows knockout progression
    const pChamp = team.pChampion || 0;
    scenarioModalGauge.innerHTML = `
      <div class="gauge-headline">
        <span class="gauge-pct">${fmtPct(pChamp)}</span>
        <span class="gauge-label">&nbsp;chance of winning the tournament</span>
      </div>
      <div class="ko-stage-probs">
        <span><span class="ko-pip" style="background:#818cf8"></span>Last 32: ${fmtPct(team.pRoundOf32)}</span>
        <span><span class="ko-pip" style="background:#60a5fa"></span>Last 16: ${fmtPct(team.pRoundOf16)}</span>
        <span><span class="ko-pip" style="background:#34d399"></span>QF: ${fmtPct(team.pQuarterFinal)}</span>
        <span><span class="ko-pip" style="background:#fbbf24"></span>SF: ${fmtPct(team.pSemiFinal)}</span>
        <span><span class="ko-pip" style="background:#f97316"></span>Final: ${fmtPct(team.pFinal)}</span>
      </div>
    `;

    // Knockout Sankey
    renderKnockoutFlow(scenarioModalFlow, team, scenarioData);
    scenarioModalBackdrop.hidden = false;
  }

  load();
})();
