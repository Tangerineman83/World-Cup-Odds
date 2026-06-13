(function () {
  const tbody = document.getElementById('table-body');
  const metaUpdated = document.getElementById('meta-updated');
  const metaSims = document.getElementById('meta-sims');
  const table = document.getElementById('predictions-table');

  let currentData = null;
  let sortKey = 'pChampion';
  let sortDir = 'desc';

  const PCT_KEYS = new Set([
    'pGroupWinner', 'pRunnerUp', 'pRoundOf32', 'pRoundOf16',
    'pQuarterFinal', 'pSemiFinal', 'pFinal', 'pChampion',
  ]);

  function fmtPct(p) {
    if (p == null) return '—';
    if (p < 0.001) return '<0.1%';
    return (p * 100).toFixed(1) + '%';
  }

  // Heatmap-style intensity for probability cells: subtle background tint
  // scaled to value, using the existing palette's accent colors.
  function pctStyle(p, colorVar) {
    if (p == null) return '';
    const alpha = Math.min(p, 1) * 0.35; // cap so even 100% isn't overwhelming
    return `background: color-mix(in srgb, var(${colorVar}) ${(alpha * 100).toFixed(0)}%, transparent);`;
  }

  function render() {
    if (!currentData) return;
    const rows = [...currentData.teams];

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

      const tdTeam = document.createElement('td');
      tdTeam.className = 'col-team';
      tdTeam.innerHTML = `${row.name}<span class="code">${row.code || ''}</span>`;

      const tdGroup = document.createElement('td');
      tdGroup.className = 'col-num';
      tdGroup.textContent = row.group;

      const tdElo = document.createElement('td');
      tdElo.className = 'col-num';
      tdElo.textContent = row.eloRating;

      tr.append(tdTeam, tdGroup, tdElo);

      const stageCols = [
        ['pGroupWinner', '--elo'],
        ['pRunnerUp', '--elo'],
        ['pRoundOf32', '--odds'],
        ['pRoundOf16', '--odds'],
        ['pQuarterFinal', '--odds'],
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
    metaUpdated.textContent = 'Simulated ' + d.toLocaleString(undefined, {
      dateStyle: 'medium', timeStyle: 'short',
    });
    metaSims.textContent = currentData.numSimulations.toLocaleString() + ' simulations';
  }

  async function load() {
    try {
      const res = await fetch('predictions.json?_=' + Date.now());
      if (!res.ok) throw new Error('predictions.json not found (HTTP ' + res.status + ')');
      currentData = await res.json();
      renderMeta();
      render();
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="11" class="error-row">Couldn't load predictions.json: ${e.message}. Run <code>node scripts/sim/runSimulation.js</code> and commit the result.</td></tr>`;
    }
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

  load();
})();
