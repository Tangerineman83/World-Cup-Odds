// Shared "road to the Last 32" Sankey-style flow diagram + qualification
// gauge, used by both predictions.html (any team) and index.html (the 12
// third-placed teams' popup) - see scenarioFlow.js script tag on both pages.
//
// Renders a two-sided flow: LEFT = the 5 mutually-exclusive group-stage
// outcome buckets (1st/2nd/3rd-qualified/3rd-eliminated/4th), RIGHT = the
// pooled (points,gd) outcomes across all buckets ("best to poorest", Other
// last) - see pooledScenarios/outcomeScenarios in predictions.json /
// scenario.json. Ribbons connect each left bucket to every right-side node
// it contributes to, stacked so ribbons from the same side don't cross.
//
// Exposes window.ScenarioFlow = { flagImgHtml, fmtPct, OUTCOME_BUCKETS,
// renderGauge, renderFlow }.

(function () {
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
  // differently-sized (non-srcset) URL; if that also fails, fall back to a
  // plain placeholder span (matching .flag-icon's background) so no broken
  // image icon is left behind.
  function flagImgHtml(code, height) {
    const flag = flagUrl(code, height);
    if (!flag) return `<span class="flag-icon"></span>`;
    const retina = flagUrl(code, height * 2);
    return `<img class="flag-icon" src="${flag}" srcset="${retina} 2x" alt="" loading="eager" onerror="if(!this.dataset.retried){this.dataset.retried='1';this.removeAttribute('srcset');this.src='${flag}';}else{this.outerHTML='<span class=&quot;flag-icon&quot;></span>';}">`;
  }

  // The 5 mutually-exclusive group-stage outcome buckets, ordered best to
  // worst. Colours follow a semantic scale: bright green (automatic advance)
  // → teal (top-8-third advance) → amber (partial success, eliminated) → red
  // (fully eliminated). This makes qualifying vs eliminated paths immediately
  // distinguishable without needing labels.
  const OUTCOME_BUCKETS = [
    { key: 'first',           label: '1st in group',                shortLabel: '1st',          color: '#4ade80', desc: 'Automatic advance' },
    { key: 'second',          label: '2nd in group',                shortLabel: '2nd',          color: '#86efac', desc: 'Automatic advance' },
    { key: 'thirdQualified',  label: '3rd, advance as a top-8 third', shortLabel: '3rd (through)', color: '#5eead4', desc: 'Advance via top-8 third' },
    { key: 'thirdEliminated', label: '3rd, eliminated',             shortLabel: '3rd (out)',    color: '#fb923c', desc: 'Misses out on tiebreaks' },
    { key: 'fourth',          label: '4th in group',                shortLabel: '4th',          color: '#f87171', desc: 'Eliminated' },
  ];

  function sumPct(scenarios) {
    return (scenarios || []).reduce((sum, e) => sum + e.pct, 0);
  }

  function bucketTotal(team, key) {
    return sumPct((team.outcomeScenarios || {})[key]);
  }

  // Renders the qualification gauge into gaugeEl.
  //   team: predictions/scenario team object
  //   gaugeContext (optional): if provided, adds a secondary note showing a
  //     conditional probability — used by index.html's thirds-table popup
  //     to surface P(qualify | finish 3rd), which is what the "Chance"
  //     column shows. The headline always stays as the unconditional
  //     P(reach Last 32), since that's the figure the Sankey below
  //     decomposes (1st + 2nd + 3rd-through bands sum to it) - showing a
  //     different, conditional figure as the headline made it look like the
  //     Sankey's bands didn't add up, when really they were answering a
  //     different question.
  //     Shape: { pct: number, label: string }
  // Renders the qualification gauge into gaugeEl.
  //   team: predictions/scenario team object
  //   gaugeContext (optional): if provided, overrides the headline with a
  //     conditional probability and adds a plain-language explainer note -
  //     used by index.html's thirds-table popup, where the relevant number
  //     is P(qualify | finish 3rd) (matching the "Chance" column), not the
  //     unconditional P(reach Last 32) that the Sankey below decomposes.
  //     Since these are different questions with different answers, the
  //     note explains in plain terms why the Sankey's numbers are a
  //     "bigger picture" rather than something that should add up to the
  //     headline.
  //     Shape: { pct: number, label: string }
  // Renders the qualification gauge into gaugeEl.
  //   team: predictions/scenario team object
  //   gaugeContext (optional): if provided, adds a short, plain-English note
  //     explaining a DIFFERENT, more specific probability — used by
  //     index.html's thirds-table popup to surface P(qualify | finish 3rd),
  //     which is what the "Chance" column shows there. The headline always
  //     stays as the unconditional P(reach Last 32 by any route), since
  //     that's the number the chart below it decomposes (the 1st + 2nd +
  //     3rd-through bands sum exactly to it). The same chart is reused on
  //     predictions.html for every team, so keeping one consistent
  //     headline meaning across both pages avoids the chart and the
  //     headline seeming to disagree.
  //     Shape: { pct: number, label: string }
  function renderGauge(gaugeEl, team, gaugeContext) {
    const pWinnerOrRunnerUp = (team.pGroupWinner || 0) + (team.pRunnerUp || 0);
    const pThird = bucketTotal(team, 'thirdQualified');
    const pAdvance = team.pRoundOf32 || 0;
    const pWinnerOrRunnerUpShare = pAdvance > 0 ? (pWinnerOrRunnerUp / pAdvance) * 100 : 0;
    const pThirdShare = pAdvance > 0 ? (pThird / pAdvance) * 100 : 0;

    // Plain-English explainer (written for an easy, "explain it to a child"
    // reading level): two short sentences, each one simple idea, no jargon
    // like "unconditional" or "conditional".
    const explainerNote = gaugeContext
      ? `<div class="gauge-context-note">${fmtPct(gaugeContext.pct)} ${gaugeContext.label} The number above is bigger. It counts every way through, not just this one.</div>`
      : '';

    gaugeEl.innerHTML = `
      <div class="gauge-headline">
        <span class="gauge-pct">${fmtPct(pAdvance)}</span>
        <span class="gauge-label">&nbsp;chance of reaching the Last 32</span>
      </div>
      <div class="gauge-bar">
        <div class="gauge-seg gauge-seg-direct" style="width:${pWinnerOrRunnerUpShare}%" title="As group winner or runner-up: ${fmtPct(pWinnerOrRunnerUp)}"></div>
        <div class="gauge-seg gauge-seg-third" style="width:${pThirdShare}%" title="As a top-8 third-placed team: ${fmtPct(pThird)}"></div>
      </div>
      <div class="gauge-sub">
        <span><span class="gauge-dot gauge-dot-direct"></span>1st or 2nd: ${fmtPct(pWinnerOrRunnerUp)}</span>
        <span><span class="gauge-dot gauge-dot-third"></span>Top-8 third: ${fmtPct(pThird)}</span>
      </div>
      ${explainerNote}
    `;
  }

  // Node colours: pts/GD nodes on the left use a neutral slate, outcome
  // nodes on the right use each bucket's own colour (OUTCOME_BUCKETS[].color).
  const PTS_NODE_COLOR = '#7c8db5';

  // Renders the two-sided flow diagram into svgEl.
  //   team: a predictions.json/scenario.json team entry (needs
  //     outcomeScenarios and pooledScenarios).
  //   state: { selectedSide: 'left'|'right'|null, selectedKey: string|null }
  //     - selectedKey is a bucket key (left) or a "points,gd" key / "other"
  //     (right).
  //   onSelect(side, key): called when a node/ribbon is clicked; pass
  //     null/null to clear selection.
  // Renders the 4-column flow diagram into svgEl:
  //   1. Current standing  - a single fixed node (points/gd banked so far
  //      from matches already played; not simulated)
  //   2. Final points      - the points total a team ends the group stage
  //      on (pointsNodes)
  //   3. Final points + GD - same total, broken down by goal difference
  //      (pooledScenarios)
  //   4. Group finish      - the 5 outcome buckets (OUTCOME_BUCKETS)
  // Ribbons only ever connect ADJACENT columns. Clicking any node
  // highlights every ribbon/node connected to it, in EVERY column (found
  // by tracing forward/backward through the ribbon graph), not just the
  // column next to it.
  function renderFlow(svgEl, team, state, onSelect) {
    const W = 1180, H = 520;
    const topMargin = 32, bottomMargin = 16;
    const usableH = H - topMargin - bottomMargin;
    const nodeWidth = 10;
    // 5 columns: current | points | points+gd | outcome | R32 opponent
    const colX = [200, 370, 540, 740, 980];

    // ---- Column 1: current standing (single fixed node, pct = 1) ----
    const cur = team.currentStanding || { points: 0, gd: 0, played: 0 };
    const curLabel = cur.played > 0
      ? `${cur.points}pt${cur.points === 1 ? '' : 's'}, GD ${cur.gd >= 0 ? '+' : ''}${cur.gd} so far`
      : 'Not yet played';
    const col1 = [{ key: 'current', label: curLabel, color: PTS_NODE_COLOR, pct: 1 }];

    // ---- Column 2: final points totals ----
    const pointsNodes = team.pointsNodes || [];
    const col2 = pointsNodes.map((n) => ({
      key: `pts:${n.points}`, label: `${n.points}pt${n.points === 1 ? '' : 's'}`,
      color: PTS_NODE_COLOR, pct: n.total, byGd: n.byGd,
    }));

    // ---- Column 3: final points + GD (pooledScenarios) ----
    const pooled = team.pooledScenarios || [];
    const col3 = pooled.map((e) => {
      const key = `ptsgd:${e.points},${e.gd}`;
      const label = `${e.points}pt${e.points === 1 ? '' : 's'}, GD ${e.gd >= 0 ? '+' : ''}${e.gd}`;
      return { key, label, color: PTS_NODE_COLOR, pct: e.total, points: e.points, byBucket: e.byBucket, showLabel: e.showLabel };
    });

    // ---- Column 4: outcome buckets ----
    const col4 = OUTCOME_BUCKETS.map((b) => ({ ...b, key: b.key, pct: bucketTotal(team, b.key) }));

    // ---- Column 5: R32 opponents (only qualifying flows continue here) ----
    // pct values here are unconditional (fraction of ALL sims), matching
    // the convention used throughout columns 1-4. Non-qualifying flows
    // (thirdEliminated, fourth) stop at col4 - their ribbons simply don't
    // connect to col5.
    const r32OpponentsRaw = team.r32Opponents || [];
    const R32_OPP_THRESHOLD = 0.005; // hide opponents below 0.5%
    const shownOpps = r32OpponentsRaw.filter((o) => o.pct >= R32_OPP_THRESHOLD);
    const otherOppPct = r32OpponentsRaw.filter((o) => o.pct < R32_OPP_THRESHOLD)
      .reduce((s, o) => s + o.pct, 0);
    const col5 = [
      ...shownOpps.map((o) => ({
        key: `r32opp:${o.opponent}`,
        label: o.opponent,
        shortLabel: o.opponent,
        color: '#818cf8',  // indigo - visually distinct from outcome bucket colours
        pct: o.pct,
        showLabel: true,
        code: o.code,
      })),
      ...(otherOppPct > 0.002 ? [{ key: 'r32opp:other', label: 'Other', shortLabel: 'Other', color: '#475569', pct: otherOppPct, showLabel: true }] : []),
    ];

    // Which col4 buckets feed into col5 (the qualifying ones only).
    const QUALIFYING_BUCKETS = new Set(['first', 'second', 'thirdQualified']);

    const columns = [col1, col2, col3, col4, col5];

    function layout(nodes, gap) {
      const total = nodes.reduce((sum, n) => sum + n.pct, 0) || 1;
      const totalGap = gap * Math.max(nodes.length - 1, 0);
      const available = Math.max(usableH - totalGap, 0);
      const MIN_NODE_H = 1.5;
      const rawHeights = nodes.map((n) => n.pct > 0 ? Math.max((n.pct / total) * available, MIN_NODE_H) : 0);
      const rawTotal = rawHeights.reduce((sum, h) => sum + h, 0) || 1;
      const scale = rawTotal > available ? available / rawTotal : 1;
      let y = topMargin;
      return nodes.map((n, i) => {
        const h = rawHeights[i] * scale;
        const seg = { ...n, y0: y, y1: y + h };
        y += h + gap;
        return seg;
      });
    }

    const gaps = columns.map((nodes) => Math.max(1.5, Math.min(6, 260 / Math.max(nodes.length, 1))));
    const laidOut = columns.map((nodes, i) => layout(nodes, gaps[i]));
    const byKey = laidOut.map((nodes) => new Map(nodes.map((n) => [n.key, n])));

    // ---- Ribbons ----
    const ribbonSets = [];

    // col1 -> col2
    {
      const sourceNode = laidOut[0][0];
      let sourceCursor = sourceNode.y0;
      const targetCursors = new Map(laidOut[1].map((n) => [n.key, n.y0]));
      const ribbons = [];
      for (const t of laidOut[1]) {
        if (!t.pct) continue;
        const sy0 = sourceCursor;
        const sy1 = sourceCursor + (sourceNode.y1 - sourceNode.y0) * t.pct;
        sourceCursor = sy1;
        const ty0 = targetCursors.get(t.key);
        const ty1 = ty0 + (t.y1 - t.y0);
        targetCursors.set(t.key, ty1);
        ribbons.push({ fromKey: sourceNode.key, toKey: t.key, pct: t.pct, y0a: sy0, y1a: sy1, y0b: ty0, y1b: ty1 });
      }
      ribbonSets.push(ribbons);
    }

    // col2 -> col3
    {
      const sourceCursors = new Map(laidOut[1].map((n) => [n.key, n.y0]));
      const targetCursors = new Map(laidOut[2].map((n) => [n.key, n.y0]));
      const ribbons = [];
      for (const s of laidOut[1]) {
        const gdEntries = Object.entries(s.byGd || {}).sort((a, b) => Number(b[0]) - Number(a[0]));
        for (const [gdStr, p] of gdEntries) {
          if (!p) continue;
          const targetKey = `ptsgd:${Number(s.key.split(':')[1])},${Number(gdStr)}`;
          const t = byKey[2].get(targetKey);
          if (!t) continue;
          const sy0 = sourceCursors.get(s.key);
          const sy1 = sy0 + (s.y1 - s.y0) * (p / s.pct);
          sourceCursors.set(s.key, sy1);
          const ty0 = targetCursors.get(t.key);
          const ty1 = ty0 + (t.y1 - t.y0) * (p / t.pct);
          targetCursors.set(t.key, ty1);
          ribbons.push({ fromKey: s.key, toKey: t.key, pct: p, y0a: sy0, y1a: sy1, y0b: ty0, y1b: ty1 });
        }
      }
      ribbonSets.push(ribbons);
    }

    // col3 -> col4
    {
      const sourceCursors = new Map(laidOut[2].map((n) => [n.key, n.y0]));
      const targetCursors = new Map(laidOut[3].map((n) => [n.key, n.y0]));
      const ribbons = [];
      for (const s of laidOut[2]) {
        for (const bucket of OUTCOME_BUCKETS) {
          const p = (s.byBucket || {})[bucket.key];
          if (!p) continue;
          const t = byKey[3].get(bucket.key);
          if (!t) continue;
          const sy0 = sourceCursors.get(s.key);
          const sy1 = sy0 + (s.y1 - s.y0) * (p / s.pct);
          sourceCursors.set(s.key, sy1);
          const ty0 = targetCursors.get(t.key);
          const ty1 = ty0 + (t.y1 - t.y0) * (p / t.pct);
          targetCursors.set(t.key, ty1);
          ribbons.push({ fromKey: s.key, toKey: bucket.key, pct: p, y0a: sy0, y1a: sy1, y0b: ty0, y1b: ty1, bucketColor: bucket.color });
        }
      }
      ribbonSets.push(ribbons);
    }

    // col4 -> col5: only qualifying buckets flow to R32 opponents.
    // The r32Opponents pct values are unconditional fractions of ALL N sims,
    // same as col4 bucket pcts. Each qualifying bucket node's height in col4
    // maps to the R32 opponent nodes proportionally by shared pct.
    {
      const sourceCursors = new Map(laidOut[3].map((n) => [n.key, n.y0]));
      const targetCursors = new Map(laidOut[4].map((n) => [n.key, n.y0]));
      const ribbons = [];

      // Total qualifying mass (unconditional) for normalisation
      const totalQualifying = col4
        .filter((b) => QUALIFYING_BUCKETS.has(b.key))
        .reduce((s, b) => s + b.pct, 0);

      if (totalQualifying > 0 && col5.length > 0) {
        for (const s of laidOut[3]) {
          if (!QUALIFYING_BUCKETS.has(s.key) || s.pct <= 0) continue;
          // This bucket's share of the total qualifying mass
          const bucketShare = s.pct / totalQualifying;

          for (const opp of laidOut[4]) {
            if (opp.pct <= 0) continue;
            // Unconditional probability that this team qualifies via THIS bucket
            // AND faces this opponent = opp.pct * bucketShare
            // (independence assumption: opponent distribution is the same
            // regardless of whether Scotland came 1st/2nd/3rd-qualified)
            const p = opp.pct * bucketShare;
            if (p < 0.0005) continue;

            const sy0 = sourceCursors.get(s.key);
            const sy1 = sy0 + (s.y1 - s.y0) * (opp.pct / totalQualifying);
            sourceCursors.set(s.key, sy1);

            const ty0 = targetCursors.get(opp.key);
            const ty1 = ty0 + (opp.y1 - opp.y0) * bucketShare;
            targetCursors.set(opp.key, ty1);

            ribbons.push({ fromKey: s.key, toKey: opp.key, pct: p,
              y0a: sy0, y1a: sy1, y0b: ty0, y1b: ty1, bucketColor: s.color });
          }
        }
      }
      ribbonSets.push(ribbons);
    }

    // ---- Selection / highlight logic ----
    const selCol = state && state.selectedCol;
    const selKey = state && state.selectedKey;
    const highlightSets = columns.map(() => new Set());
    if (selKey != null && selCol != null) {
      highlightSets[selCol].add(selKey);
      let frontier = new Set([selKey]);
      for (let c = selCol; c > 0; c--) {
        const prev = new Set();
        for (const k of frontier) for (const r of ribbonSets[c - 1]) if (r.toKey === k) prev.add(r.fromKey);
        for (const k of prev) highlightSets[c - 1].add(k);
        frontier = prev;
      }
      frontier = new Set([selKey]);
      for (let c = selCol; c < columns.length - 1; c++) {
        const next = new Set();
        for (const k of frontier) for (const r of (ribbonSets[c] || [])) if (r.fromKey === k) next.add(r.toKey);
        for (const k of next) highlightSets[c + 1].add(k);
        frontier = next;
      }
    }

    let svg = '';

    // Gradient defs: col3->col4 uses bucket colour gradients; col4->col5
    // uses indigo gradient to signal R32 advancement.
    const gradientDefs = [
      ...OUTCOME_BUCKETS.map((b) =>
        `<linearGradient id="flow-grad-${b.key}" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stop-color="${PTS_NODE_COLOR}"/>
          <stop offset="100%" stop-color="${b.color}"/>
        </linearGradient>`
      ),
      `<linearGradient id="flow-grad-r32" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%" stop-color="${PTS_NODE_COLOR}"/>
        <stop offset="100%" stop-color="#818cf8"/>
      </linearGradient>`,
    ].join('');
    svg += `<defs>${gradientDefs}</defs>`;

    function ribbonPath(x0, x1, r) {
      const midX = (x0 + x1) / 2;
      return `M ${x0} ${r.y0a} C ${midX} ${r.y0a}, ${midX} ${r.y0b}, ${x1} ${r.y0b}
        L ${x1} ${r.y1b} C ${midX} ${r.y1b}, ${midX} ${r.y1a}, ${x0} ${r.y1a} Z`;
    }

    for (let c = 0; c < columns.length; c++) {
      if (c < columns.length - 1) {
        const x0 = colX[c], x1 = colX[c + 1];
        for (const r of (ribbonSets[c] || [])) {
          let opacity = 0.42;
          if (selKey != null) {
            const connected = highlightSets[c].has(r.fromKey) && highlightSets[c + 1].has(r.toKey);
            opacity = connected ? 0.85 : 0.06;
          }
          // col3->col4: bucket colour gradient; col4->col5: r32 gradient; others: flat
          let fill;
          if (c === 2) fill = `url(#flow-grad-${r.toKey})`;
          else if (c === 3) fill = `url(#flow-grad-r32)`;
          else fill = PTS_NODE_COLOR;
          svg += `<path d="${ribbonPath(x0, x1, r)}" fill="${fill}" opacity="${opacity}" class="flow-ribbon" data-col="${c}" data-key="${r.fromKey}"><title>${fmtPct(r.pct)}</title></path>`;
        }
      }
    }

    const MIN_LABEL_GAP = 13;
    let lastLabelY = columns.map(() => -Infinity);

    for (let c = 0; c < columns.length; c++) {
      const x = colX[c];
      for (const n of laidOut[c]) {
        if (n.pct <= 0) continue;
        const isSelected = selCol === c && selKey === n.key;
        const dimmed = selKey != null && !highlightSets[c].has(n.key);
        const midY = (n.y0 + n.y1) / 2;
        const labelWouldCollide = midY - lastLabelY[c] < MIN_LABEL_GAP;
        const showsLabel = n.showLabel !== false && !labelWouldCollide;
        let opacity = 1;
        if (dimmed) opacity = 0.25;
        else if (!showsLabel) opacity = 0.55;
        svg += `<rect x="${x - nodeWidth / 2}" y="${n.y0}" width="${nodeWidth}" height="${n.y1 - n.y0}" fill="${n.color}" rx="2" opacity="${opacity}" class="flow-node${isSelected ? ' flow-node-selected' : ''}" data-col="${c}" data-key="${n.key}"><title>${n.label} - ${fmtPct(n.pct)}</title></rect>`;
        if (!showsLabel) continue;
        lastLabelY[c] = midY;
        const isLast = c === columns.length - 1;
        const anchor = c === 0 ? 'end' : (isLast ? 'start' : (c % 2 === 1 ? 'end' : 'start'));
        const labelX = c === 0 ? x - nodeWidth / 2 - 8
          : isLast ? x + nodeWidth / 2 + 8
          : (c === 1 ? x - nodeWidth / 2 - 8 : x + nodeWidth / 2 + 8);
        const pctSpan = `<tspan class="flow-target-pct">${fmtPct(n.pct)}</tspan>`;
        const displayLabel = (c === columns.length - 1) ? (n.shortLabel || n.label) : n.label;
        const text = c === 0 ? displayLabel
          : (c === 1 ? `${pctSpan} ${displayLabel}` : `${displayLabel} ${pctSpan}`);
        svg += `<text x="${labelX}" y="${midY + 4}" text-anchor="${anchor}" class="flow-target-label${dimmed ? ' flow-label-dimmed' : ''}" data-col="${c}" data-key="${n.key}">${text}</text>`;
      }
    }

    // Column headers
    const headers = [team.name, 'Final points', 'Points / GD', 'Group finish', 'R32 opponent'];
    for (let c = 0; c < columns.length; c++) {
      svg += `<text x="${colX[c]}" y="${topMargin - 14}" text-anchor="middle" class="flow-source-label">${c === 0 ? team.name : ''}</text>`;
      svg += `<text x="${colX[c]}" y="${topMargin - 1}" text-anchor="middle" class="flow-source-sublabel">${headers[c]}</text>`;
    }

    svgEl.innerHTML = svg;
    svgEl.setAttribute('viewBox', `0 0 ${W} ${H}`);

    svgEl.querySelectorAll('[data-key]').forEach((el) => {
      el.addEventListener('click', () => {
        const col = Number(el.dataset.col);
        const key = el.dataset.key;
        if (selCol === col && selKey === key) onSelect(null, null);
        else onSelect(col, key);
      });
    });
  }

  // ── Knockout stage flow diagram ─────────────────────────────────────────
  //
  // Renders a horizontal Sankey showing a team's pathway through the
  // knockout rounds. Each column is a round (R32 → R16 → QF → SF → Final →
  // Winner). Node height = probability of reaching that round. The ribbon
  // from round N to round N+1 represents the probability of winning that
  // round and advancing. A "eliminated" node at each round absorbs the
  // probability mass that doesn't advance.
  //
  // Uses per-team probabilities from predictions_negbin.json plus the modal
  // opponent path from scenario_negbin.json.

  const KO_ROUND_COLORS = {
    r32:    '#818cf8',   // indigo
    r16:    '#60a5fa',   // blue
    qf:     '#34d399',   // emerald
    sf:     '#fbbf24',   // amber
    final:  '#f97316',   // orange
    winner: '#4ade80',   // green
    out:    '#475569',   // slate (eliminated)
  };

  function renderKnockoutFlow(svgEl, team, scenarioData, onSelect) {
    // team: predictions_negbin.json team entry (has pRoundOf32..pChampion)
    // scenarioData: scenario_negbin.json (for modal opponent labels)
    if (!team) return;

    const W = 900, H = 360;
    const topM = 40, botM = 20, leftM = 60, rightM = 80;
    const usableW = W - leftM - rightM;
    const usableH = H - topM - botM;

    // Rounds: each has a probability of reaching it
    const rounds = [
      { key: 'r32',    label: 'Last 32', p: team.pRoundOf32    || 0 },
      { key: 'r16',    label: 'Last 16', p: team.pRoundOf16    || 0 },
      { key: 'qf',     label: 'QF',      p: team.pQuarterFinal || 0 },
      { key: 'sf',     label: 'SF',      p: team.pSemiFinal    || 0 },
      { key: 'final',  label: 'Final',   p: team.pFinal        || 0 },
      { key: 'winner', label: 'Winner',  p: team.pChampion     || 0 },
    ].filter(r => r.p > 0);

    if (rounds.length === 0) { svgEl.innerHTML = ''; return; }

    const nRounds = rounds.length;
    const colSpacing = usableW / Math.max(nRounds - 1, 1);
    const colXs = rounds.map((_, i) => leftM + i * colSpacing);

    const nodeW = 14;
    const maxNodeH = usableH * 0.85;
    const minNodeH = 3;

    // Node heights proportional to probability (capped so p=1 fills maxNodeH)
    function nodeH(p) { return Math.max(minNodeH, p * maxNodeH); }

    // Each round node is centred vertically; eliminated flows drop below
    const nodeMidY = topM + usableH * 0.38;

    // Build modal opponents from scenarioData
    function modalOpponent(roundKey) {
      if (!scenarioData) return null;
      const name = team.name;
      const searchIn = (matches) => {
        if (!matches) return null;
        for (const m of matches) {
          if (m.home?.name === name || m.away?.name === name) {
            return m.home?.name === name ? m.away?.name : m.home?.name;
          }
        }
        return null;
      };
      if (roundKey === 'r32')    return searchIn(scenarioData.r32);
      if (roundKey === 'r16')    return searchIn(scenarioData.r16);
      if (roundKey === 'qf')     return searchIn(scenarioData.qf);
      if (roundKey === 'sf')     return searchIn(scenarioData.sf);
      if (roundKey === 'final')  return scenarioData.final ? (
        scenarioData.final.home?.name === name
          ? scenarioData.final.away?.name
          : scenarioData.final.home?.name
      ) : null;
      return null;
    }

    let svg = '';

    // Gradient defs for advance ribbons
    const gradDefs = rounds.map((r, i) => {
      if (i === 0) return '';
      const c0 = KO_ROUND_COLORS[rounds[i-1].key];
      const c1 = KO_ROUND_COLORS[r.key];
      return `<linearGradient id="ko-grad-${i}" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%" stop-color="${c0}" stop-opacity="0.7"/>
        <stop offset="100%" stop-color="${c1}" stop-opacity="0.7"/>
      </linearGradient>`;
    }).join('');
    svg += `<defs>${gradDefs}</defs>`;

    // Draw advance ribbons first (behind nodes)
    for (let i = 1; i < rounds.length; i++) {
      const prev = rounds[i - 1];
      const curr = rounds[i];
      const x0 = colXs[i - 1] + nodeW / 2;
      const x1 = colXs[i] - nodeW / 2;
      const h0 = nodeH(prev.p);
      const h1 = nodeH(curr.p);
      const hy0 = nodeH(curr.p); // ribbon height at source = target height
      // Advance ribbon: top portion of prev node → full curr node
      const y0t = nodeMidY - h0 / 2;  // top of prev node
      const y1t = nodeMidY - h1 / 2;  // top of curr node
      const midX = (x0 + x1) / 2;
      const path = `M ${x0} ${y0t} C ${midX} ${y0t}, ${midX} ${y1t}, ${x1} ${y1t}
        L ${x1} ${y1t + h1} C ${midX} ${y1t + h1}, ${midX} ${y0t + hy0}, ${x0} ${y0t + hy0} Z`;
      svg += `<path d="${path}" fill="url(#ko-grad-${i})" opacity="0.55" class="ko-ribbon">
        <title>Advances to ${curr.label}: ${fmtPct(curr.p)}</title></path>`;

      // Eliminated ribbon: remaining portion of prev node drops down
      const elim = prev.p - curr.p;
      if (elim > 0.001) {
        const elimH = nodeH(elim);
        const ey0t = y0t + hy0;
        const ey0b = ey0t + elimH;
        const elimMidY = ey0t + elimH / 2;
        const elimDropY = nodeMidY + usableH * 0.35;
        const elimPath = `M ${x0} ${ey0t} C ${midX} ${ey0t}, ${x0 + 30} ${elimDropY}, ${x0 + 30} ${elimDropY}
          L ${x0 + 30} ${elimDropY + 4} C ${x0 + 30} ${elimDropY + 4}, ${midX} ${ey0b}, ${x0} ${ey0b} Z`;
        svg += `<path d="${elimPath}" fill="${KO_ROUND_COLORS.out}" opacity="0.25" class="ko-ribbon-out">
          <title>Eliminated at ${prev.label}: ${fmtPct(elim)}</title></path>`;
      }
    }

    // Draw round nodes
    for (let i = 0; i < rounds.length; i++) {
      const r = rounds[i];
      const cx = colXs[i];
      const h = nodeH(r.p);
      const y0 = nodeMidY - h / 2;
      const color = KO_ROUND_COLORS[r.key];

      svg += `<rect x="${cx - nodeW/2}" y="${y0}" width="${nodeW}" height="${h}"
        fill="${color}" rx="3" class="ko-node" data-round="${r.key}">
        <title>${r.label}: ${fmtPct(r.p)}</title></rect>`;

      // Round label above
      svg += `<text x="${cx}" y="${topM - 6}" text-anchor="middle"
        class="ko-round-label">${r.label}</text>`;

      // Probability label below node
      svg += `<text x="${cx}" y="${y0 + h + 14}" text-anchor="middle"
        class="ko-prob-label">${fmtPct(r.p)}</text>`;

      // Modal opponent label (vs X)
      if (r.key !== 'winner') {
        const opp = modalOpponent(r.key);
        if (opp) {
          svg += `<text x="${cx}" y="${y0 + h + 26}" text-anchor="middle"
            class="ko-opp-label">vs ${opp}</text>`;
        }
      }
    }

    // Team name header
    svg += `<text x="${leftM}" y="${topM - 22}" text-anchor="start"
      class="flow-source-label" style="font-size:11px">${team.name}</text>`;

    svgEl.innerHTML = svg;
    svgEl.setAttribute('viewBox', `0 0 ${W} ${H}`);
  }

  window.ScenarioFlow = { fmtPct, flagImgHtml, OUTCOME_BUCKETS, sumPct, bucketTotal, renderGauge, renderFlow, renderKnockoutFlow };
})();
