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

    // World ranking (1 = strongest) based on rating, computed once across
    // the full unsorted list so it doesn't change as the table is re-sorted.
    const byRating = [...currentData.teams].sort((a, b) => b.eloRating - a.eloRating);
    const rankByName = new Map(byRating.map((t, i) => [t.name, i + 1]));

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

      const FLAG_CODE_OVERRIDES = { EN: 'gb-eng', SQ: 'gb-sct', WL: 'gb-wls', NI: 'gb-nir' };
      function flagUrl(code, height) {
        if (!code) return null;
        const c = FLAG_CODE_OVERRIDES[code] || code.toLowerCase();
        return `https://flagcdn.com/h${height}/${c}.png`;
      }

      const tdTeam = document.createElement('td');
      tdTeam.className = 'col-team';
      const flag = flagUrl(row.code, 24);
      const flagHtml = flag
        ? `<img class="flag-icon" src="${flag}" srcset="${flagUrl(row.code, 48)} 2x" alt="" loading="lazy" onerror="if(!this.dataset.retried){this.dataset.retried='1';this.removeAttribute('srcset');this.src='${flag}';}else{this.outerHTML='<span class=&quot;flag-icon&quot;></span>';}">`
        : '';
      tdTeam.innerHTML = `<span class="team-name-wrap">${flagHtml}<span class="team-name">${row.name}</span><span class="code">${row.code || ''}</span></span>`;

      const tdGroup = document.createElement('td');
      tdGroup.className = 'col-num';
      tdGroup.textContent = row.group;

      const tdRank = document.createElement('td');
      tdRank.className = 'col-num';
      tdRank.textContent = '#' + rankByName.get(row.name);
      tdRank.title = `Rating: ${Math.round(row.eloRating)}`;

      tr.append(tdTeam, tdGroup, tdRank);

      const stageCols = [
        ['pGroupWinner', '--accent'],
        ['pRunnerUp', '--accent'],
        ['pRoundOf32', '--host'],
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
      dateStyle: 'medium', timeStyle: 'short',
    });
    metaSims.textContent = 'Based on ' + currentData.numSimulations.toLocaleString() + ' tournaments';
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
