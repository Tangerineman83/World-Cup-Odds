(function () {
  const tbody = document.getElementById('table-body');
  const metaUpdated = document.getElementById('meta-updated');
  const metaVolume = document.getElementById('meta-volume');
  const refreshBtn = document.getElementById('refresh-btn');
  const table = document.getElementById('comparison-table');

  let currentData = null;
  let sortKey = 'eloRank';
  let sortDir = 'asc'; // 'asc' or 'desc'

  function fmtRank(r) {
    return r == null ? '—' : String(r);
  }

  function fmtRating(r) {
    return r == null ? '—' : String(r);
  }

  function fmtProb(p) {
    return p == null ? '—' : (p * 100).toFixed(1) + '%';
  }

  function fmtDiff(d) {
    if (d == null) return '—';
    if (d === 0) return '0';
    return (d > 0 ? '+' : '') + d;
  }

  function diffClass(d) {
    if (d == null) return 'no-data';
    if (d > 0) return 'diff-pos';
    if (d < 0) return 'diff-neg';
    return 'diff-zero';
  }

  function render() {
    if (!currentData) return;
    const rows = [...currentData.teams];

    rows.sort((a, b) => {
      let av = a[sortKey];
      let bv = b[sortKey];

      // Nulls sort to the bottom regardless of direction
      const aNull = av == null;
      const bNull = bv == null;
      if (aNull && bNull) return 0;
      if (aNull) return 1;
      if (bNull) return -1;

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
      tdTeam.innerHTML = `${row.team}<span class="code">${row.code || ''}</span>`;

      const tdElo = document.createElement('td');
      tdElo.className = 'col-num';
      tdElo.textContent = fmtRating(row.eloRating);
      if (row.eloRating == null) tdElo.classList.add('no-data');

      const tdEloRank = document.createElement('td');
      tdEloRank.className = 'col-num';
      tdEloRank.innerHTML = row.eloRank == null
        ? '<span class="no-data">—</span>'
        : `<span class="rank-pill rank-elo">${row.eloRank}</span>`;

      const tdProb = document.createElement('td');
      tdProb.className = 'col-num';
      tdProb.textContent = fmtProb(row.impliedProbability);
      if (row.impliedProbability == null) tdProb.classList.add('no-data');

      const tdOddsRank = document.createElement('td');
      tdOddsRank.className = 'col-num';
      tdOddsRank.innerHTML = row.oddsRank == null
        ? '<span class="no-data">—</span>'
        : `<span class="rank-pill rank-odds">${row.oddsRank}</span>`;

      const tdDiff = document.createElement('td');
      tdDiff.className = 'col-num ' + diffClass(row.rankDiff);
      tdDiff.textContent = fmtDiff(row.rankDiff);

      tr.append(tdTeam, tdElo, tdEloRank, tdProb, tdOddsRank, tdDiff);
      tbody.appendChild(tr);
    }

    // Update header sort indicators
    table.querySelectorAll('th.sortable').forEach((th) => {
      th.classList.remove('sorted-asc', 'sorted-desc');
      if (th.dataset.key === sortKey) {
        th.classList.add(sortDir === 'asc' ? 'sorted-asc' : 'sorted-desc');
      }
    });
  }

  function renderMeta() {
    if (!currentData) return;
    const updated = currentData.meta && currentData.meta.lastUpdated;
    if (updated) {
      const d = new Date(updated);
      metaUpdated.textContent = 'Last updated ' + d.toLocaleString(undefined, {
        dateStyle: 'medium', timeStyle: 'short',
      });
    }
    if (currentData.eventVolume != null) {
      const vol = currentData.eventVolume;
      const fmtVol = vol >= 1e9
        ? '$' + (vol / 1e9).toFixed(2) + 'B'
        : '$' + (vol / 1e6).toFixed(1) + 'M';
      metaVolume.textContent = 'Market volume: ' + fmtVol;
    }
    if (currentData.meta && currentData.meta.lastError) {
      metaUpdated.textContent += ' (last refresh attempt failed — showing cached data)';
    }
  }

  async function load() {
    try {
      const res = await fetch('/api/comparison');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load data');
      currentData = data;
      renderMeta();
      render();
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="6" class="error-row">Couldn't load live data: ${e.message}</td></tr>`;
    }
  }

  table.querySelectorAll('th.sortable').forEach((th) => {
    th.addEventListener('click', () => {
      const key = th.dataset.key;
      if (sortKey === key) {
        sortDir = sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        sortKey = key;
        // Sensible default direction per column: ranks/team ascending, ratings/prob descending
        sortDir = (key === 'eloRank' || key === 'oddsRank' || key === 'team') ? 'asc' : 'desc';
      }
      render();
    });
  });

  refreshBtn.addEventListener('click', async () => {
    refreshBtn.disabled = true;
    refreshBtn.textContent = 'Refreshing…';
    try {
      await fetch('/api/refresh', { method: 'POST' });
      await load();
    } finally {
      refreshBtn.disabled = false;
      refreshBtn.textContent = 'Refresh';
    }
  });

  load();
})();
