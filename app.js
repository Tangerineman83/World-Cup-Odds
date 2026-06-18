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
  const toggleActualBtn = document.getElementById('toggle-actual');
  const toggleProjectedBtn = document.getElementById('toggle-projected');
  const toggleOffFenceBtn = document.getElementById('toggle-off-fence');
  const groupsToggleHint = document.getElementById('groups-toggle-hint');
  const thirdsTableWrap = document.getElementById('thirds-table-wrap');
  const thirdsTableHead = document.getElementById('thirds-table-head');
  const thirdsIntro = document.getElementById('thirds-intro');
  const thirdsDisclaimer = document.getElementById('thirds-disclaimer');
  let groupsViewMode = 'projected'; // 'projected' | 'actual' | 'off-the-fence'
  let scenarioFlowCol = null;
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

  const THIRDS_TABLE_HEAD = {
    projected: `
      <tr>
        <th class="col-team">Team</th>
        <th class="col-num">Grp</th>
        <th class="col-num third-chance" title="Of all simulations where this team finishes 3rd in their group, the % where they're also one of the 8 best third-placed teams overall (ranked by points, then goal difference, then goals scored, then FIFA World Ranking - see footnote)">Chance</th>
        <th class="col-thirdpct">Next match</th>
      </tr>
    `,
    ranked: `
      <tr>
        <th class="col-team">Team</th>
        <th class="col-num">Grp</th>
        <th class="col-num">Pts</th>
        <th class="col-num">GD</th>
        <th class="col-num">GF</th>
      </tr>
    `,
  };

  const THIRDS_COPY = {
    projected: {
      intro: `Finishing 3rd doesn't always mean you're out — the best 8 of the 12 third-placed teams also go through to the Last 32, ranked by points, then goal difference, then goals scored. "Chance" is each team's likelihood of being one of those 8, given that they finish 3rd in their group. Here they are in the order they'll appear in the knockout rounds below, each shown with who they'd play next. The line marks the cutoff — the last 4 go home.`,
      disclaimer: `Chance is computed from the full simulation (see the tooltip) — the table itself is ordered by Chance, not by a single simulated table. Once all group games are finished, we'll confirm this table against the real final standings.`,
    },
    actual: {
      intro: `Today's 12 third-placed teams, ranked by the official tiebreak for sides that haven't played each other: points, then goal difference, then goals scored, then FIFA World Ranking. The top 8 would go through to the Last 32 if the group stage ended right now — the line marks that cutoff.`,
      disclaimer: `This is provisional, based on results played so far — not a final qualification result. It will keep changing as more group games are played.`,
    },
    'off-the-fence': {
      intro: `The 12 third-placed teams from our single most likely simulated outcome, ranked by the same tiebreak as Actual: points, then goal difference, then goals scored, then FIFA World Ranking. The top 8 go through to the Last 32 in this one scenario — the line marks that cutoff.`,
      disclaimer: `This is one concrete simulated scenario, not a probability — see the Projected toggle for each team's actual likelihood of qualifying.`,
    },
  };

  function renderThirds() {
    if (!thirdsTableBody) return;
    if (groupsViewMode === 'projected') {
      renderThirdsProjected();
    } else if (groupsViewMode === 'actual') {
      renderThirdsRanked(computeActualThirds(), 'actual');
    } else {
      renderThirdsRanked(computeOffFenceThirds(), 'off-the-fence');
    }
  }

  function renderThirdsProjected() {
    thirdsTableHead.innerHTML = THIRDS_TABLE_HEAD.projected;
    thirdsIntro.textContent = THIRDS_COPY.projected.intro;
    thirdsDisclaimer.textContent = THIRDS_COPY.projected.disclaimer;

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

  // Used by Actual and Off the Fence - thirdsList: array of
  // { name, code, group, points, gd, gf, fifaRank }, one entry per group
  // (see computeActualThirds/computeOffFenceThirds). Ranks via the shared
  // FIFA tiebreak order and renders a Pts/GD/GF table instead of Chance.
  function renderThirdsRanked(thirdsList, mode) {
    thirdsTableHead.innerHTML = THIRDS_TABLE_HEAD.ranked;
    thirdsIntro.textContent = THIRDS_COPY[mode].intro;
    thirdsDisclaimer.textContent = THIRDS_COPY[mode].disclaimer;

    const ranked = rankThirdsByFifaOrder(thirdsList);
    let rows = '';
    ranked.forEach((team, i) => {
      const qualifies = i < 8;
      const gdStr = (team.gd >= 0 ? '+' : '') + team.gd;

      rows += `<tr data-team="${team.name}" class="${qualifies ? 'third-qualifies' : 'third-eliminated'}">
        <td class="col-team">${teamButton(team)}</td>
        <td class="col-num">${team.group}</td>
        <td class="col-num">${team.points}</td>
        <td class="col-num">${gdStr}</td>
        <td class="col-num">${team.gf}</td>
      </tr>`;

      // Divider after the 8th team: 8 of 12 thirds advance to the Last 32.
      if (i === 7 && ranked.length > 8) {
        rows += `<tr class="thirds-divider-row" aria-hidden="true">
          <td colspan="5"><div class="thirds-divider"><span>8 go through to the Last 32</span><span>4 go home</span></div></td>
        </tr>`;
      }
    });

    thirdsTableBody.innerHTML = rows;
  }

  // Opens the "road to the Last 32" Sankey popup.
  // Uses the shared scenarioFlow.js renderer (window.ScenarioFlow).
  function openScenarioModal(team) {
    if (!team.pooledScenarios || team.pooledScenarios.length === 0) return;
    scenarioFlowCol = null;
    scenarioFlowKey = null;
    scenarioModal.querySelector('.modal-title').innerHTML = teamButton(team);
    // In index.html, the popup is opened from the thirds table where the
    // "Chance" column shows P(qualify | finish 3rd). The gauge headline
    // stays as the unconditional pRoundOf32 (matching what the chart's
    // 1st+2nd+3rd-through bands sum to); the Chance-column figure is shown
    // underneath as a short, plain-English note instead, so the two numbers
    // don't look like they're meant to add up to each other.
    const gaugeContext = team.pQualifyGiven3rd != null ? {
      pct: team.pQualifyGiven3rd,
      label: `is the table's "Chance" number. It only counts games where they finish 3rd.`,
    } : null;
    window.ScenarioFlow.renderGauge(scenarioModalGauge, team, gaugeContext);
    renderModalFlow(team);
    scenarioModalBackdrop.hidden = false;
  }

  function renderModalFlow(team) {
    window.ScenarioFlow.renderFlow(
      scenarioModalFlow, team,
      { selectedCol: scenarioFlowCol, selectedKey: scenarioFlowKey },
      (col, key) => {
        scenarioFlowCol = col;
        scenarioFlowKey = key;
        renderModalFlow(team);
      }
    );
  }

  function closeScenarioModal() {
    scenarioModalBackdrop.hidden = true;
    scenarioFlowCol = null;
    scenarioFlowKey = null;
  }


  // ----------------------------------------------------------------------
  // Actual (real-world) group table, computed from results.json directly -
  // independent of the simulation. Used for the Actual/Projected toggle.
  // ----------------------------------------------------------------------
  let resultsByGroup = null; // group letter -> array of played fixtures

  async function loadResults() {
    try {
      const res = await fetch('results.json?_=' + Date.now());
      const json = await res.json();
      resultsByGroup = {};
      for (const r of json.results || []) {
        if (r.homeGoals == null || r.awayGoals == null) continue;
        if (!resultsByGroup[r.group]) resultsByGroup[r.group] = [];
        resultsByGroup[r.group].push(r);
      }
    } catch (e) {
      resultsByGroup = {};
    }
  }

  // Full per-team predictions data (all 48 teams) - fetched purely so the
  // thirds-table "tap a team to see their road to the Last 32" popup works
  // for ANY team shown there. scenario.json's allThirds only carries this
  // data for the 12 teams the model itself expects to finish 3rd, but the
  // Actual/Off the Fence toggles can show a different team in that slot
  // (e.g. if the real or modal table differs from the model's main
  // scenario) - predictionsByName covers every team so the popup never
  // silently fails to open.
  let predictionsByName = null; // team name -> predictions.json team record

  async function loadPredictions() {
    try {
      const res = await fetch('predictions.json?_=' + Date.now());
      const json = await res.json();
      predictionsByName = new Map((json.teams || []).map((t) => [t.name, t]));
    } catch (e) {
      predictionsByName = new Map();
    }
  }

  // Orders one group's teams by the real-world table right now: points,
  // then overall goal difference, then overall goals scored, then
  // head-to-head points among the still-tied teams, then head-to-head goal
  // difference among the still-tied teams, then alphabetically as a final
  // deterministic fallback (teams with zero matches played, e.g., are tied
  // on everything and have no real result to separate them - alphabetical
  // is just a stable display order, not a meaningful ranking).
  // teamNames: the 4 team names in this group (any order).
  function computeActualOrder(teamNames, groupLetter) {
    const fixtures = (resultsByGroup && resultsByGroup[groupLetter]) || [];
    const stats = new Map(teamNames.map((name) => [name, { name, pts: 0, gf: 0, ga: 0, played: 0 }]));

    for (const r of fixtures) {
      const home = stats.get(r.home);
      const away = stats.get(r.away);
      if (!home || !away) continue;
      home.gf += r.homeGoals; home.ga += r.awayGoals; home.played += 1;
      away.gf += r.awayGoals; away.ga += r.homeGoals; away.played += 1;
      if (r.homeGoals > r.awayGoals) home.pts += 3;
      else if (r.homeGoals < r.awayGoals) away.pts += 3;
      else { home.pts += 1; away.pts += 1; }
    }

    function h2hPoints(name, against) {
      let pts = 0;
      for (const r of fixtures) {
        if (r.home === name && r.away === against) {
          pts += r.homeGoals > r.awayGoals ? 3 : r.homeGoals === r.awayGoals ? 1 : 0;
        } else if (r.away === name && r.home === against) {
          pts += r.awayGoals > r.homeGoals ? 3 : r.awayGoals === r.homeGoals ? 1 : 0;
        }
      }
      return pts;
    }
    function h2hGd(name, against) {
      let gd = 0;
      for (const r of fixtures) {
        if (r.home === name && r.away === against) gd += r.homeGoals - r.awayGoals;
        else if (r.away === name && r.home === against) gd += r.awayGoals - r.homeGoals;
      }
      return gd;
    }

    const list = [...stats.values()].map((s) => ({ ...s, gd: s.gf - s.ga }));

    // Group teams into tied clusters by (pts, gd, gf), and within each
    // cluster of 2+ teams, compare head-to-head among JUST that cluster.
    list.sort((a, b) => b.pts - a.pts || b.gd - a.gd || b.gf - a.gf || a.name.localeCompare(b.name));

    const result = [];
    let i = 0;
    while (i < list.length) {
      let j = i + 1;
      while (j < list.length && list[j].pts === list[i].pts && list[j].gd === list[i].gd && list[j].gf === list[i].gf) j++;
      const cluster = list.slice(i, j);
      if (cluster.length > 1) {
        cluster.sort((a, b) => {
          const h2hA = cluster.filter((t) => t.name !== a.name).reduce((sum, t) => sum + h2hPoints(a.name, t.name), 0);
          const h2hB = cluster.filter((t) => t.name !== b.name).reduce((sum, t) => sum + h2hPoints(b.name, t.name), 0);
          if (h2hA !== h2hB) return h2hB - h2hA;
          const gdA = cluster.filter((t) => t.name !== a.name).reduce((sum, t) => sum + h2hGd(a.name, t.name), 0);
          const gdB = cluster.filter((t) => t.name !== b.name).reduce((sum, t) => sum + h2hGd(b.name, t.name), 0);
          if (gdA !== gdB) return gdB - gdA;
          return a.name.localeCompare(b.name);
        });
      }
      result.push(...cluster);
      i = j;
    }
    return result;
  }

  // ----------------------------------------------------------------------
  // Cross-group third-place ranking, shared by the Actual and Off the Fence
  // thirds tables - both rank the 12 third-placed teams by the official
  // tiebreak order for teams that haven't played each other: points, goal
  // difference, goals scored, then FIFA World Ranking. This mirrors
  // scripts/sim/simulateTournament.js's pickBestThirds() exactly (the
  // model's own approximation, ignoring head-to-head/cards since neither is
  // modelled) - just applied to real or modal-scenario stats here instead of
  // a fresh Monte Carlo run. The Projected toggle's thirds table is
  // unaffected by this - it keeps using pQualifyGiven3rd (see renderThirds).
  // ----------------------------------------------------------------------

  // thirds: array of { name, group, points, gd, gf, fifaRank, ... }.
  // Returns a NEW array, same length, ranked best-to-worst.
  function rankThirdsByFifaOrder(thirds) {
    return [...thirds].sort((a, b) => {
      if (b.points !== a.points) return b.points - a.points;
      if (b.gd !== a.gd) return b.gd - a.gd;
      if (b.gf !== a.gf) return b.gf - a.gf;
      const rankA = a.fifaRank != null ? a.fifaRank : Infinity;
      const rankB = b.fifaRank != null ? b.fifaRank : Infinity;
      if (rankA !== rankB) return rankA - rankB;
      return a.name.localeCompare(b.name);
    });
  }

  // The 12 real, today's-table third-placed teams (one per group), from
  // computeActualOrder - i.e. "if the group stage ended right now".
  function computeActualThirds() {
    return GROUP_ORDER.map((letter) => {
      const g = data.groups[letter];
      const teamByName = new Map(g.order.map((t) => [t.name, t]));
      const third = computeActualOrder(g.order.map((t) => t.name), letter)[2];
      const team = teamByName.get(third.name) || {};
      return {
        name: third.name,
        code: team.code,
        group: letter,
        points: third.pts,
        gd: third.gd,
        gf: third.gf,
        played: third.played,
        fifaRank: team.fifaRank != null ? team.fifaRank : null,
      };
    });
  }

  // The 12 modal-scenario third-placed teams (one per group) - g.order[2]
  // is already the modal 3rd-place team, with points/gd/gf/fifaRank from
  // the single most common joint final table (see scripts/sim/mostLikely.js).
  function computeOffFenceThirds() {
    return GROUP_ORDER.map((letter) => {
      const third = data.groups[letter].order[2];
      return {
        name: third.name,
        code: third.code,
        group: letter,
        points: third.points,
        gd: third.gd,
        gf: third.gf,
        played: third.played,
        fifaRank: third.fifaRank != null ? third.fifaRank : null,
      };
    });
  }

  // Names of the 8 qualifying thirds for a given toggle mode - used both to
  // colour the 3rd-place row within each group card, and to draw the
  // cutoff line in the thirds table itself. Returns null for 'projected'
  // (which uses data.bestThirds/pQualifyGiven3rd instead - a probability,
  // not a ranking of one single table).
  function qualifyingThirdNamesForMode(mode) {
    if (mode === 'actual') return new Set(rankThirdsByFifaOrder(computeActualThirds()).slice(0, 8).map((t) => t.name));
    if (mode === 'off-the-fence') return new Set(rankThirdsByFifaOrder(computeOffFenceThirds()).slice(0, 8).map((t) => t.name));
    return null;
  }

  const GROUPS_TOGGLE_HINTS = {
    projected: "Projected: each team's chance of finishing 1st-4th, from the simulation.",
    actual: "Actual: today's real table, from results played so far.",
    'off-the-fence': "Off the Fence: the single most likely simulated outcome, shown as a table.",
  };

  function setGroupsViewMode(mode) {
    if (mode === groupsViewMode) return;
    groupsViewMode = mode;
    toggleProjectedBtn.classList.toggle('is-active', mode === 'projected');
    toggleProjectedBtn.setAttribute('aria-selected', mode === 'projected' ? 'true' : 'false');
    toggleActualBtn.classList.toggle('is-active', mode === 'actual');
    toggleActualBtn.setAttribute('aria-selected', mode === 'actual' ? 'true' : 'false');
    toggleOffFenceBtn.classList.toggle('is-active', mode === 'off-the-fence');
    toggleOffFenceBtn.setAttribute('aria-selected', mode === 'off-the-fence' ? 'true' : 'false');
    groupsToggleHint.textContent = GROUPS_TOGGLE_HINTS[mode];

    // Simple crossfade: fade the grid (and thirds table) out, swap content
    // while invisible, fade back in. Matches the .is-fading transitions
    // declared in styles.css.
    groupsGrid.classList.add('is-fading');
    thirdsTableWrap.classList.add('is-fading');
    setTimeout(() => {
      renderGroups();
      renderThirds();
      groupsGrid.classList.remove('is-fading');
      thirdsTableWrap.classList.remove('is-fading');
    }, 180);
  }

  // Shared row markup for the Actual and Off the Fence group tables - same
  // visual format (pos, team, "X pts · GD ±Y · Z/3 played"), just sourced
  // from different stats (real results.json vs the modal simulated table).
  function statsStyleRowHtml(posLabel, team, rowClass, row) {
    const gdStr = (row.gd >= 0 ? '+' : '') + row.gd;
    const statsHtml = `<span class="actual-stats">${row.pts}pt${row.pts === 1 ? '' : 's'} &middot; GD ${gdStr} &middot; ${row.played}/3 played</span>`;
    return `<tr class="${rowClass}" data-team="${row.name}">
      <td class="pos-col">${posLabel}</td>
      <td class="team-col">
        ${teamButton(team)}
        ${statsHtml}
      </td>
    </tr>`;
  }

  function renderGroups() {
    groupsGrid.innerHTML = '';
    // Only needed for 'actual'/'off-the-fence' - 'projected' colours its
    // 3rd-place row from data.bestThirds (a probability ranking) instead.
    const qualifyingThirdNames = groupsViewMode === 'projected' ? null : qualifyingThirdNamesForMode(groupsViewMode);

    for (const letter of GROUP_ORDER) {
      const g = data.groups[letter];
      const card = document.createElement('div');
      card.className = 'group-card';

      let rows = '';

      if (groupsViewMode === 'actual') {
        const teamByName = new Map(g.order.map((t) => [t.name, t]));
        const actualOrder = computeActualOrder(g.order.map((t) => t.name), letter);
        actualOrder.forEach((row, i) => {
          const posLabel = ['1st', '2nd', '3rd', '4th'][i];
          const team = teamByName.get(row.name) || row;
          // Provisional zone based on TODAY's actual table - not a real
          // qualification result (that only exists once the group is
          // finished), just "if the group ended right now".
          let rowClass;
          if (i < 2) rowClass = 'advances';
          else if (i === 2) rowClass = qualifyingThirdNames.has(row.name) ? 'maybe-advances' : 'eliminated';
          else rowClass = 'eliminated';
          rows += statsStyleRowHtml(posLabel, team, rowClass, row);
        });
      } else if (groupsViewMode === 'off-the-fence') {
        g.order.forEach((team, i) => {
          const posLabel = ['1st', '2nd', '3rd', '4th'][i];
          let rowClass;
          if (i < 2) rowClass = 'advances';
          else if (i === 2) rowClass = qualifyingThirdNames.has(team.name) ? 'maybe-advances' : 'eliminated';
          else rowClass = 'eliminated';
          rows += statsStyleRowHtml(posLabel, team, rowClass, { name: team.name, pts: team.points, gd: team.gd, played: team.played });
        });
      } else {
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
      }

      card.innerHTML = `
        <div class="group-card-header">
          <h3>Group ${letter}</h3>
          ${groupsViewMode === 'projected' ? confidenceRing(g.probability) : ''}
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
      const name = row && row.dataset.team;
      const team = name && ((data.allThirds || []).find((t) => t.name === name) || (predictionsByName && predictionsByName.get(name)));
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
      dateStyle: 'medium',
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
      await Promise.all([loadResults(), loadPredictions()]);
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

      toggleActualBtn.addEventListener('click', () => setGroupsViewMode('actual'));
      toggleProjectedBtn.addEventListener('click', () => setGroupsViewMode('projected'));
      toggleOffFenceBtn.addEventListener('click', () => setGroupsViewMode('off-the-fence'));

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
