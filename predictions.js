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
  const modelToggleNegbinBtn = document.getElementById('model-toggle-negbin');
  const modelToggleExistingBtn = document.getElementById('model-toggle-existing');

  let currentData = null;
  let sortKey = 'eloRating';
  let sortDir = 'desc';
  let selectedTeamName = null;
  let selectedFlowCol = null; // column index (0-3) of the selected node, or null
  let selectedFlowKey = null;

  // Model toggle: 'existing' (Poisson + single-Elo, predictions.json) or
  // 'negbin' (dual-Elo Negative Binomial, predictions_negbin.json).
  // Persisted via localStorage so the choice survives a page reload/revisit
  // (this is the live deployed site, not a sandboxed artifact - localStorage
  // is fine here). Defaults to 'negbin' per the integration decision to make
  // it the default the user sees, with a link back to the existing model.
  const MODEL_STORAGE_KEY = 'worldCupOdds.model';
  let currentModel = localStorage.getItem(MODEL_STORAGE_KEY) || 'negbin';

  // Normalizes a NegBin team record onto the SAME field names render()
  // already expects from predictions.json (eloRating/eloChange/eloBaseline),
  // rather than scattering "if negbin..." branches through render() itself.
  // NegBin has no single overall-Elo "change" figure the way the existing
  // engine does (eloUpdate.js's single-number delta) - eloOverall here is
  // the pre-tournament baseline Elo unmodified by in-tournament form (the
  // dual-Elo split only moves attack/defense, not the shared overall
  // number - see updateEloSplit.js), so eloChange is always shown as null
  // (no arrow) for NegBin rows rather than a misleading invented number.
  function normalizeTeam(t, model) {
    if (model === 'existing') return t;
    return {
      ...t,
      eloRating: t.eloOverall,
      eloChange: null,
      eloBaseline: null,
    };
  }

  const PCT_KEYS = new Set([
    'pRoundOf16', 'pQuarterFinal', 'pSemiFinal', 'pFinal', 'pChampion',
  ]);

  const { fmtPct, flagImgHtml } = window.ScenarioFlow;

  // Heatmap-style intensity for probability cells: subtle background tint
  // scaled to value, using the existing palette's accent colors.
  function pctStyle(p, colorVar) {
    if (p == null) return '';
    const alpha = Math.min(p, 1) * 0.35; // cap so even 100% isn't overwhelming
    return `background: color-mix(in srgb, var(${colorVar}) ${(alpha * 100).toFixed(0)}%, transparent);`;
  }

  function render() {
    if (!currentData) return;
    const rows = currentData.teams.map((t) => normalizeTeam(t, currentModel));

    rows.sort((a, b) => {
      let av = a[sortKey];
      let bv = b[sortKey];
      if (typeof av === 'string') {
        const cmp = av.localeCompare(bv);
        return sortDir === 'asc' ? cmp : -cmp;
      }
      const cmp = av - bv;
      return sortDir === 'asc' ? cmp : -cmp;
    });

    tbody.innerHTML = '';
    for (const row of rows) {
      const tr = document.createElement('tr');
      tr.dataset.team = row.name;
      tr.classList.add('team-row');
      if (row.name === selectedTeamName) tr.classList.add('team-row-selected');

      const tdTeam = document.createElement('td');
      tdTeam.className = 'col-team';
      const flagHtml = flagImgHtml(row.code, 24);
      tdTeam.innerHTML = `<span class="team-name-wrap">${flagHtml}<span class="team-name">${row.name}</span></span>`;

      const tdGroup = document.createElement('td');
      tdGroup.className = 'col-num';
      tdGroup.textContent = row.group;

      const tdFifa = document.createElement('td');
      tdFifa.className = 'col-num';
      tdFifa.textContent = row.fifaRank != null ? '#' + row.fifaRank : '—';
      tdFifa.title = 'Official FIFA World Ranking (11 June 2026)';

      const tdRating = document.createElement('td');
      tdRating.className = 'col-num col-rating';
      if (row.eloRating != null) {
        const change = row.eloChange;
        const ARROW_THRESHOLD = 2;
        let changeHtml = '';
        if (change != null && change >= ARROW_THRESHOLD) {
          changeHtml = `<span class="change-up">&#9650;${Math.round(change)}</span>`;
        } else if (change != null && change <= -ARROW_THRESHOLD) {
          changeHtml = `<span class="change-down">&#9660;${Math.round(Math.abs(change))}</span>`;
        }
        tdRating.innerHTML = `${Math.round(row.eloRating)}${changeHtml ? ' ' + changeHtml : ''}`;
        tdRating.title = row.eloBaseline != null
          ? `Pre-tournament: ${Math.round(row.eloBaseline)}. Current: ${Math.round(row.eloRating)} (${change >= 0 ? '+' : ''}${change.toFixed(1)}).`
          : `Current rating: ${Math.round(row.eloRating)}.`;
      } else {
        tdRating.textContent = '—';
      }

      tr.append(tdTeam, tdGroup, tdFifa, tdRating);

      const stageCols = [
        ['pRoundOf16', '--host'],
        ['pQuarterFinal', '--host'],
        ['pSemiFinal', '--pos'],
        ['pFinal', '--pos'],
        ['pChampion', '--pos'],
      ];

      for (const [key, colorVar] of stageCols) {
        const td = document.createElement('td');
        td.className = 'col-num pct-cell';
        td.textContent = fmtPct(row[key]);
        td.style.cssText = pctStyle(row[key], colorVar);
        if (key === 'pChampion') td.classList.add('champion-cell');
        tr.appendChild(td);
      }

      tbody.appendChild(tr);
    }

    table.querySelectorAll('th.sortable').forEach((th) => {
      th.classList.remove('sorted-asc', 'sorted-desc');
      if (th.dataset.key === sortKey) {
        th.classList.add(sortDir === 'asc' ? 'sorted-asc' : 'sorted-desc');
      }
    });
  }

  function renderMeta() {
    if (!currentData) return;
    const d = new Date(currentData.generatedAt);
    metaUpdated.textContent = 'Updated ' + d.toLocaleString(undefined, {
      dateStyle: 'medium',
    });
    metaSims.textContent = 'Based on ' + currentData.numSimulations.toLocaleString() + ' tournaments';
  }

  async function load() {
    const filename = currentModel === 'existing' ? 'predictions.json' : 'predictions_negbin.json';
    const scriptName = currentModel === 'existing' ? 'runSimulation.js' : 'runFullNegBinPipeline.js';
    try {
      const res = await fetch(filename + '?_=' + Date.now());
      if (!res.ok) throw new Error(filename + ' not found (HTTP ' + res.status + ')');
      currentData = await res.json();
      renderMeta();
      render();
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="9" class="error-row">Couldn't load ${filename}: ${e.message}. Run <code>node scripts/sim/${scriptName}</code> and commit the result.</td></tr>`;
    }
  }

  function setModel(model) {
    if (model === currentModel) return;
    currentModel = model;
    localStorage.setItem(MODEL_STORAGE_KEY, model);
    selectedTeamName = null;
    selectedFlowCol = null;
    selectedFlowKey = null;
    updateModelToggleUI();
    load();
  }

  function updateModelToggleUI() {
    if (!modelToggleNegbinBtn || !modelToggleExistingBtn) return;
    modelToggleNegbinBtn.classList.toggle('is-active', currentModel === 'negbin');
    modelToggleExistingBtn.classList.toggle('is-active', currentModel === 'existing');
    modelToggleNegbinBtn.setAttribute('aria-selected', String(currentModel === 'negbin'));
    modelToggleExistingBtn.setAttribute('aria-selected', String(currentModel === 'existing'));
  }

  table.querySelectorAll('th.sortable').forEach((th) => {
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

  tbody.addEventListener('click', (e) => {
    const tr = e.target.closest('tr.team-row');
    if (!tr || !tr.dataset.team) return;
    const name = tr.dataset.team;
    selectedTeamName = name;
    render();
    openTeamModal(name);
  });

  scenarioModalClose.addEventListener('click', closeScenarioModal);
  scenarioModalBackdrop.addEventListener('click', (e) => {
    if (e.target === scenarioModalBackdrop) closeScenarioModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !scenarioModalBackdrop.hidden) closeScenarioModal();
  });

  function closeScenarioModal() {
    scenarioModalBackdrop.hidden = true;
    selectedTeamName = null;
    selectedFlowCol = null;
    selectedFlowKey = null;
    render();
  }

  function renderModalFlow(team) {
    window.ScenarioFlow.renderFlow(
      scenarioModalFlow,
      team,
      { selectedCol: selectedFlowCol, selectedKey: selectedFlowKey },
      (col, key) => {
        selectedFlowCol = col;
        selectedFlowKey = key;
        renderModalFlow(team);
      }
    );
  }

  function openTeamModal(name) {
    const team = currentData.teams.find((t) => t.name === name);
    if (!team) return;

    selectedFlowCol = null;
    selectedFlowKey = null;

    const flagHtml = flagImgHtml(team.code, 32);
    scenarioModalTitle.innerHTML = `${flagHtml}${team.name}`;

    window.ScenarioFlow.renderGauge(scenarioModalGauge, team);
    renderModalFlow(team);

    scenarioModalBackdrop.hidden = false;
  }

  if (modelToggleNegbinBtn && modelToggleExistingBtn) {
    modelToggleNegbinBtn.addEventListener('click', () => setModel('negbin'));
    modelToggleExistingBtn.addEventListener('click', () => setModel('existing'));
  }

  updateModelToggleUI();
  load();
})();
