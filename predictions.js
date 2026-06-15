(function () {
  const tbody = document.getElementById('table-body');
  const metaUpdated = document.getElementById('meta-updated');
  const metaSims = document.getElementById('meta-sims');
  const table = document.getElementById('predictions-table');
  const teamDetail = document.getElementById('team-detail');
  const teamDetailTitle = document.getElementById('team-detail-title');
  const teamDetailClose = document.getElementById('team-detail-close');
  const teamDetailGauge = document.getElementById('team-detail-gauge');
  const teamDetailFlow = document.getElementById('team-detail-flow');
  const teamDetailScenarios = document.getElementById('team-detail-scenarios');

  let currentData = null;
  let sortKey = 'pChampion';
  let sortDir = 'desc';
  let selectedTeamName = null;
  let selectedBucket = null; // which flow segment's scenarios are shown

  const PCT_KEYS = new Set([
    'pGroupWinner', 'pRunnerUp', 'pRoundOf32', 'pRoundOf16',
    'pQuarterFinal', 'pSemiFinal', 'pFinal', 'pChampion',
  ]);

  function fmtPct(p) {
    if (p == null) return '—';
    if (p < 0.001) return '<0.1%';
    return (p * 100).toFixed(1) + '%';
  }

  const FLAG_CODE_OVERRIDES = { EN: 'gb-eng', SQ: 'gb-sct', WL: 'gb-wls', NI: 'gb-nir' };
  function flagUrl(code, height) {
    if (!code) return null;
    const c = FLAG_CODE_OVERRIDES[code] || code.toLowerCase();
    return `https://flagcdn.com/h${height}/${c}.png`;
  }

  // Builds a flag <img> with retry/fallback: flagcdn occasionally fails a
  // handful of concurrent requests on first load. Retry once via a
  // differently-sized (non-srcset) URL; if that also fails, remove the
  // broken-image element entirely so no placeholder icon (e.g. "?") is left
  // behind. height: base (1x) pixel height; the 2x retina image is requested
  // via srcset at 2x height.
  function flagImgHtml(code, height) {
    const flag = flagUrl(code, height);
    if (!flag) return `<span class="flag-icon"></span>`;
    const retina = flagUrl(code, height * 2);
    return `<img class="flag-icon" src="${flag}" srcset="${retina} 2x" alt="" loading="lazy" onerror="if(!this.dataset.retried){this.dataset.retried='1';this.removeAttribute('srcset');this.src='${flag}';}else{this.outerHTML='<span class=&quot;flag-icon&quot;></span>';}">`;
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
      tr.dataset.team = row.name;
      tr.classList.add('team-row');
      if (row.name === selectedTeamName) tr.classList.add('team-row-selected');

      const tdTeam = document.createElement('td');
      tdTeam.className = 'col-team';
      const flagHtml = flagImgHtml(row.code, 24);
      tdTeam.innerHTML = `<span class="team-name-wrap">${flagHtml}<span class="team-name">${row.name}</span><span class="code">${row.code || ''}</span></span>`;

      const tdGroup = document.createElement('td');
      tdGroup.className = 'col-num';
      tdGroup.textContent = row.group;

      const tdRank = document.createElement('td');
      tdRank.className = 'col-num';
      tdRank.textContent = '#' + rankByName.get(row.name);
      tdRank.title = `Rating: ${Math.round(row.eloRating)}`;

      const tdFifa = document.createElement('td');
      tdFifa.className = 'col-num';
      tdFifa.textContent = row.fifaRank != null ? '#' + row.fifaRank : '—';
      tdFifa.title = 'Official FIFA World Ranking (11 June 2026)';

      // Rating: current (adjusted-for-tournament-performance) rating, with
      // the change from the pre-tournament rating shown as a signed point
      // value + directional arrow. Small changes (rounding noise / no
      // results yet) show neither.
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
          ? `Pre-tournament rating: ${Math.round(row.eloBaseline)}. Adjusted for tournament performance so far: ${Math.round(row.eloRating)} (${change >= 0 ? '+' : ''}${change.toFixed(1)}).`
          : `Adjusted for tournament performance so far: ${Math.round(row.eloRating)}.`;
      } else {
        tdRating.textContent = '—';
      }

      tr.append(tdRank, tdTeam, tdGroup, tdFifa, tdRating);

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
      tbody.innerHTML = `<tr><td colspan="14" class="error-row">Couldn't load predictions.json: ${e.message}. Run <code>node scripts/sim/runSimulation.js</code> and commit the result.</td></tr>`;
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

  tbody.addEventListener('click', (e) => {
    const tr = e.target.closest('tr.team-row');
    if (!tr || !tr.dataset.team) return;
    const name = tr.dataset.team;
    if (selectedTeamName === name) {
      closeTeamDetail();
    } else {
      selectedTeamName = name;
      selectedBucket = null;
      render();
      openTeamDetail(name);
    }
  });

  teamDetailClose.addEventListener('click', closeTeamDetail);

  function closeTeamDetail() {
    selectedTeamName = null;
    selectedBucket = null;
    teamDetail.hidden = true;
    render();
  }

  // The 5 mutually-exclusive group-stage outcome buckets, in display order
  // (best to worst), matching outcomeScenarios in predictions.json.
  const OUTCOME_BUCKETS = [
    { key: 'first', label: '1st in group', shortLabel: '1st', color: '#4ade80', desc: 'Automatic advance' },
    { key: 'second', label: '2nd in group', shortLabel: '2nd', color: '#86efac', desc: 'Automatic advance' },
    { key: 'thirdQualified', label: '3rd, advance as a wildcard', shortLabel: '3rd (through)', color: '#5eead4', desc: 'Advance via top-8 third' },
    { key: 'thirdEliminated', label: '3rd, eliminated', shortLabel: '3rd (out)', color: '#94a3b8', desc: 'Misses out on tiebreaks' },
    { key: 'fourth', label: '4th in group', shortLabel: '4th', color: '#64748b', desc: 'Eliminated' },
  ];

  function sumPct(scenarios) {
    return (scenarios || []).reduce((sum, e) => sum + e.pct, 0);
  }

  function bucketTotal(team, key) {
    return sumPct((team.outcomeScenarios || {})[key]);
  }

  // Renders the qualification gauge: a segmented horizontal bar showing
  // P(Last 32) split into "as group winner/runner-up" vs "as a top-8 third",
  // with the headline % and a sub-breakdown.
  function renderGauge(team) {
    const pWinnerOrRunnerUp = team.pGroupWinner + team.pRunnerUp;
    const pThird = bucketTotal(team, 'thirdQualified');
    const pAdvance = team.pRoundOf32;
    const pWinnerOrRunnerUpShare = pAdvance > 0 ? (pWinnerOrRunnerUp / pAdvance) * 100 : 0;
    const pThirdShare = pAdvance > 0 ? (pThird / pAdvance) * 100 : 0;

    teamDetailGauge.innerHTML = `
      <div class="gauge-headline">
        <span class="gauge-pct">${fmtPct(pAdvance)}</span>
        <span class="gauge-label">&nbsp;chance of reaching the Last 32</span>
      </div>
      <div class="gauge-bar">
        <div class="gauge-seg gauge-seg-direct" style="width:${pWinnerOrRunnerUpShare}%" title="As group winner or runner-up: ${fmtPct(pWinnerOrRunnerUp)}"></div>
        <div class="gauge-seg gauge-seg-wildcard" style="width:${pThirdShare}%" title="As a top-8 third-placed team: ${fmtPct(pThird)}"></div>
      </div>
      <div class="gauge-sub">
        <span><span class="gauge-dot gauge-dot-direct"></span>1st or 2nd: ${fmtPct(pWinnerOrRunnerUp)}</span>
        <span><span class="gauge-dot gauge-dot-wildcard"></span>Wildcard 3rd: ${fmtPct(pThird)}</span>
      </div>
    `;
  }

  // Renders the outcome flow diagram: a single source node (100% of sims)
  // flowing into 5 target nodes (the OUTCOME_BUCKETS), with ribbon
  // thickness proportional to each bucket's probability. Clicking a ribbon
  // or target node selects that bucket and shows its scenario breakdown
  // below (see renderScenarios).
  function renderFlow(team) {
    const W = 640, H = 320;
    const sourceX = 90, targetX = 430;
    const nodeWidth = 14;
    const topMargin = 32, bottomMargin = 10;
    const usableH = H - topMargin - bottomMargin;

    const buckets = OUTCOME_BUCKETS.map((b) => ({ ...b, pct: bucketTotal(team, b.key) }));
    const total = buckets.reduce((sum, b) => sum + b.pct, 0) || 1;

    // Source node spans the full height (100%).
    const sourceY0 = topMargin, sourceY1 = topMargin + usableH;

    // Target nodes stacked with small gaps, heights proportional to pct.
    const gap = 6;
    const totalGap = gap * (buckets.length - 1);
    let y = topMargin;
    const targets = buckets.map((b) => {
      const h = Math.max((b.pct / total) * (usableH - totalGap), b.pct > 0 ? 2 : 0);
      const seg = { ...b, y0: y, y1: y + h };
      y += h + gap;
      return seg;
    });

    // Ribbons: cubic bezier from a slice of the source node to each target
    // node, stacked in source order matching target order (so ribbons don't
    // cross).
    let sy = sourceY0;
    const ribbons = targets.map((t) => {
      const h = t.y1 - t.y0;
      const ribbon = {
        ...t,
        sy0: sy,
        sy1: sy + h,
      };
      sy += h;
      return ribbon;
    });

    const midX = (sourceX + targetX) / 2;
    let svg = '';

    // Source node + label (label sits above the node, centred, to avoid
    // needing wide left margin for long team names)
    svg += `<rect x="${sourceX - nodeWidth}" y="${sourceY0}" width="${nodeWidth}" height="${sourceY1 - sourceY0}" fill="#5b6890" rx="2"></rect>`;
    svg += `<text x="${sourceX - nodeWidth / 2}" y="${sourceY0 - 14}" text-anchor="middle" class="flow-source-label">${team.name}</text>`;
    svg += `<text x="${sourceX - nodeWidth / 2}" y="${sourceY0 - 1}" text-anchor="middle" class="flow-source-sublabel">100% of sims</text>`;

    for (const r of ribbons) {
      if (r.pct <= 0) continue;
      const isSelected = selectedBucket === r.key;
      const opacity = selectedBucket == null ? 0.55 : (isSelected ? 0.85 : 0.18);
      const path = `M ${sourceX} ${r.sy0}
        C ${midX} ${r.sy0}, ${midX} ${r.y0}, ${targetX} ${r.y0}
        L ${targetX} ${r.y1}
        C ${midX} ${r.y1}, ${midX} ${r.sy1}, ${sourceX} ${r.sy1}
        Z`;
      svg += `<path d="${path}" fill="${r.color}" opacity="${opacity}" class="flow-ribbon" data-bucket="${r.key}"></path>`;
    }

    for (const t of targets) {
      if (t.pct <= 0) continue;
      const isSelected = selectedBucket === t.key;
      svg += `<rect x="${targetX}" y="${t.y0}" width="${nodeWidth}" height="${t.y1 - t.y0}" fill="${t.color}" rx="2" class="flow-node${isSelected ? ' flow-node-selected' : ''}" data-bucket="${t.key}"></rect>`;
      const midY = (t.y0 + t.y1) / 2;
      const pctLabel = fmtPct(t.pct);
      const labelX = targetX + nodeWidth + 8;
      svg += `<text x="${labelX}" y="${midY + 4}" text-anchor="start" class="flow-target-label" data-bucket="${t.key}">${t.shortLabel} <tspan class="flow-target-pct">${pctLabel}</tspan></text>`;
    }

    teamDetailFlow.innerHTML = svg;
    teamDetailFlow.setAttribute('viewBox', `0 0 ${W} ${H}`);

    teamDetailFlow.querySelectorAll('[data-bucket]').forEach((el) => {
      el.addEventListener('click', () => {
        const key = el.dataset.bucket;
        selectedBucket = selectedBucket === key ? null : key;
        renderFlow(team);
        renderScenarios(team);
      });
    });
  }

  // Renders the (points, gd) scenario breakdown for the currently-selected
  // bucket (or a prompt if none selected).
  function renderScenarios(team) {
    if (!selectedBucket) {
      teamDetailScenarios.innerHTML = `<p class="scenario-prompt">Tap a segment above to see the most likely points/goal-difference records behind it.</p>`;
      return;
    }

    const bucketDef = OUTCOME_BUCKETS.find((b) => b.key === selectedBucket);
    const scenarios = (team.outcomeScenarios || {})[selectedBucket] || [];
    const bucketPct = bucketTotal(team, selectedBucket);

    if (scenarios.length === 0 || bucketPct === 0) {
      teamDetailScenarios.innerHTML = `<p class="scenario-prompt">${team.name} essentially never finish this way - not enough simulations to break down.</p>`;
      return;
    }

    let rows = '';
    for (const s of scenarios) {
      const isOthers = s.points === null;
      const label = isOthers
        ? `<span class="scenario-others">Other records</span>`
        : `${s.points} pt${s.points === 1 ? '' : 's'}, GD ${s.gd >= 0 ? '+' : ''}${s.gd}`;
      // pct is unconditional (a fraction of ALL simulations) - rows for this
      // bucket sum to bucketPct (the bucket's overall probability, shown in
      // the heading). Bar width uses the same unconditional value, so bars
      // are also comparable across different buckets.
      const pctDisplay = fmtPct(s.pct);
      const barWidth = Math.max(s.pct * 100, 1.5);
      rows += `<div class="scenario-row">
        <span class="scenario-label">${label}</span>
        <div class="scenario-bar-wrap">
          <div class="scenario-bar-track"><div class="scenario-bar-fill${isOthers ? ' scenario-others-fill' : ''}" style="width:${barWidth}%"></div></div>
          <span class="scenario-pct">${pctDisplay}</span>
        </div>
      </div>`;
    }

    teamDetailScenarios.innerHTML = `
      <h3 class="scenario-heading">${bucketDef.label} <span class="scenario-heading-pct">(${fmtPct(bucketPct)} overall)</span></h3>
      <p class="scenario-subtitle">${bucketDef.desc} - most likely group-stage points/goal-difference records when this happens.</p>
      ${rows}
    `;
  }

  function openTeamDetail(name) {
    const team = currentData.teams.find((t) => t.name === name);
    if (!team) return;

    const flagHtml = flagImgHtml(team.code, 32);
    teamDetailTitle.innerHTML = `${flagHtml}${team.name} <span class="code">${team.code || ''}</span>`;

    renderGauge(team);
    renderFlow(team);
    renderScenarios(team);

    teamDetail.hidden = false;
    teamDetail.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  load();
})();
