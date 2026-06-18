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
    const W = 980, H = 520;
    const topMargin = 32, bottomMargin = 16;
    const usableH = H - topMargin - bottomMargin;
    const nodeWidth = 10;
    const colX = [200, 380, 560, 800]; // current | points | points+gd | outcome

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
    // Every distinct combo gets its own node now - there's no "Other"
    // catch-all. showLabel (from the data layer, true above 0.5%) controls
    // whether the node's text label is drawn; the node and its ribbons are
    // always drawn regardless, so thin slivers are still visible/hoverable,
    // just without a label cluttering the column.
    const pooled = team.pooledScenarios || [];
    const col3 = pooled.map((e) => {
      const key = `ptsgd:${e.points},${e.gd}`;
      const label = `${e.points}pt${e.points === 1 ? '' : 's'}, GD ${e.gd >= 0 ? '+' : ''}${e.gd}`;
      return { key, label, color: PTS_NODE_COLOR, pct: e.total, points: e.points, byBucket: e.byBucket, showLabel: e.showLabel };
    });

    // ---- Column 4: outcome buckets ----
    const col4 = OUTCOME_BUCKETS.map((b) => ({ ...b, key: b.key, pct: bucketTotal(team, b.key) }));

    const columns = [col1, col2, col3, col4];

    function layout(nodes, gap) {
      const total = nodes.reduce((sum, n) => sum + n.pct, 0) || 1;
      const totalGap = gap * Math.max(nodes.length - 1, 0);
      const available = Math.max(usableH - totalGap, 0);

      // Two-pass sizing: first give every node its proportional height,
      // floored at MIN_NODE_H so thin nodes are still visible/clickable.
      // With many nodes (some teams have 90+ distinct points/GD combos),
      // that floor can push the SUM of heights past `available` - so the
      // second pass proportionally shrinks every node by the same factor
      // to bring the total back to exactly `available`. This keeps thin
      // nodes visible without ever pushing the column's total height past
      // the chart's own viewBox (which was clipping the bottom rows for
      // high-entropy teams before this fix).
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

    // ---- Ribbons: col1->col2, col2->col3, col3->col4 ----
    // Each ribbon set uses the same "outer loop = source node, inner loop =
    // matching target nodes in display order" stacking approach so ribbons
    // never cross within a single node's stack.
    const ribbonSets = []; // one array per adjacent column pair

    // col1 -> col2: the single current-standing node feeds every points
    // node, sized by that points node's own probability (since col1 is
    // 100% by definition, the split mirrors col2's own distribution).
    {
      const target = byKey[1];
      const sourceNode = laidOut[0][0];
      let sourceCursor = sourceNode.y0;
      const targetCursors = new Map(laidOut[1].map((n) => [n.key, n.y0]));
      const ribbons = [];
      for (const t of laidOut[1]) {
        const p = t.pct;
        if (!p) continue;
        const sy0 = sourceCursor;
        const sy1 = sourceCursor + (sourceNode.y1 - sourceNode.y0) * p;
        sourceCursor = sy1;
        const ty0 = targetCursors.get(t.key);
        const ty1 = ty0 + (t.y1 - t.y0); // whole node (1:1 - only one source)
        targetCursors.set(t.key, ty1);
        ribbons.push({ fromKey: sourceNode.key, toKey: t.key, pct: p, y0a: sy0, y1a: sy1, y0b: ty0, y1b: ty1 });
      }
      ribbonSets.push(ribbons);
    }

    // col2 -> col3: each points node fans out into its GD breakdown
    // (byGd), matched to col3 nodes by points+gd key.
    {
      const sourceCursors = new Map(laidOut[1].map((n) => [n.key, n.y0]));
      const targetCursors = new Map(laidOut[2].map((n) => [n.key, n.y0]));
      const ribbons = [];
      for (const s of laidOut[1]) {
        const gdEntries = Object.entries(s.byGd || {}).sort((a, b) => Number(b[0]) - Number(a[0]));
        for (const [gdStr, p] of gdEntries) {
          if (!p) continue;
          const gd = Number(gdStr);
          const pointsVal = Number(s.key.split(':')[1]);
          // Find which col3 node this (points,gd) combo belongs to. Every
          // combo now has its own node (no "Other" folding), so this
          // should always resolve.
          const targetKey = `ptsgd:${pointsVal},${gd}`;
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

    // col3 -> col4: each points+gd node fans out into outcome buckets
    // (byBucket) - same logic as the old 2-column version.
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

    // ---- Selection / highlight logic ----
    // selKey identifies a node by its OWN key, unique only within its
    // column - so we also track which column index it's in.
    const selCol = state && state.selectedCol;
    const selKey = state && state.selectedKey;

    // Build adjacency (key -> connected keys in neighbouring columns) once,
    // so highlighting can trace outward from any selected node in any
    // column to every other column, not just the adjacent ones.
    function neighboursOf(colIdx, key) {
      const result = new Set();
      if (colIdx > 0) {
        for (const r of ribbonSets[colIdx - 1]) if (r.toKey === key) result.add(r.fromKey);
      }
      if (colIdx < columns.length - 1) {
        for (const r of ribbonSets[colIdx] || []) if (r.fromKey === key) result.add(r.toKey);
      }
      return result;
    }

    // highlightSet[colIdx] = Set of keys in that column connected to the
    // selection, found by breadth-first expansion outward in both
    // directions from the selected node.
    const highlightSets = columns.map(() => new Set());
    if (selKey != null && selCol != null) {
      highlightSets[selCol].add(selKey);
      // Expand left from selCol
      let frontier = new Set([selKey]);
      for (let c = selCol; c > 0; c--) {
        const prev = new Set();
        for (const k of frontier) for (const r of ribbonSets[c - 1]) if (r.toKey === k) prev.add(r.fromKey);
        for (const k of prev) highlightSets[c - 1].add(k);
        frontier = prev;
      }
      // Expand right from selCol
      frontier = new Set([selKey]);
      for (let c = selCol; c < columns.length - 1; c++) {
        const next = new Set();
        for (const k of frontier) for (const r of ribbonSets[c]) if (r.fromKey === k) next.add(r.toKey);
        for (const k of next) highlightSets[c + 1].add(k);
        frontier = next;
      }
    }


    let svg = '';

    // Gradient defs: col3->col4 ribbons use a slate->bucket-colour
    // gradient (as before); col1->col2 and col2->col3 ribbons use a flat
    // slate fill (both ends are pts/gd nodes, so a gradient would be a
    // no-op anyway).
    const gradientDefs = OUTCOME_BUCKETS.map((b) =>
      `<linearGradient id="flow-grad-${b.key}" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%" stop-color="${PTS_NODE_COLOR}"/>
        <stop offset="100%" stop-color="${b.color}"/>
      </linearGradient>`
    ).join('');
    svg += `<defs>${gradientDefs}</defs>`;

    function ribbonPath(x0, x1, r) {
      const midX = (x0 + x1) / 2;
      return `M ${x0} ${r.y0a}
        C ${midX} ${r.y0a}, ${midX} ${r.y0b}, ${x1} ${r.y0b}
        L ${x1} ${r.y1b}
        C ${midX} ${r.y1b}, ${midX} ${r.y1a}, ${x0} ${r.y1a} Z`;
    }

    // Draw ribbons (3 sets), nodes, and labels for each column.
    for (let c = 0; c < columns.length; c++) {
      if (c < columns.length - 1) {
        const x0 = colX[c], x1 = colX[c + 1];
        const setIdx = c;
        for (const r of ribbonSets[setIdx]) {
          let opacity = 0.42;
          if (selKey != null) {
            const connected = highlightSets[c].has(r.fromKey) && highlightSets[c + 1].has(r.toKey);
            opacity = connected ? 0.85 : 0.06;
          }
          const fill = (c === columns.length - 2) ? `url(#flow-grad-${r.toKey})` : PTS_NODE_COLOR;
          svg += `<path d="${ribbonPath(x0, x1, r)}" fill="${fill}" opacity="${opacity}" class="flow-ribbon" data-col="${c}" data-key="${r.fromKey}"><title>${fmtPct(r.pct)}</title></path>`;
        }
      }
    }

    // Minimum vertical gap (px) between two consecutive shown labels in the
    // same column, to stop adjacent thin rows' text visually overlapping
    // even when both individually clear the showLabel/0.5% threshold. Only
    // matters for dense columns (col 3 on high-entropy teams); columns 1/2/4
    // never have enough rows to trigger this.
    const MIN_LABEL_GAP = 13;
    let lastLabelY = columns.map(() => -Infinity);

    for (let c = 0; c < columns.length; c++) {
      const x = colX[c];
      for (const n of laidOut[c]) {
        if (n.pct <= 0) continue;
        const isSelected = selCol === c && selKey === n.key;
        const dimmed = selKey != null && !highlightSets[c].has(n.key);
        const midY = (n.y0 + n.y1) / 2;

        // Decide label visibility BEFORE drawing the node, so nodes with no
        // label (too thin to read, or skipped to avoid colliding with the
        // previous label) can be rendered at reduced opacity - they're
        // still real, hoverable/clickable, full-colour-on-select data, just
        // visually de-emphasised since there's no text to anchor them to.
        const labelWouldCollide = midY - lastLabelY[c] < MIN_LABEL_GAP;
        const showsLabel = n.showLabel !== false && !labelWouldCollide;

        let opacity = 1;
        if (dimmed) opacity = 0.25;
        else if (!showsLabel) opacity = 0.55;
        svg += `<rect x="${x - nodeWidth / 2}" y="${n.y0}" width="${nodeWidth}" height="${n.y1 - n.y0}" fill="${n.color}" rx="2" opacity="${opacity}" class="flow-node${isSelected ? ' flow-node-selected' : ''}" data-col="${c}" data-key="${n.key}"><title>${n.label} - ${fmtPct(n.pct)}</title></rect>`;

        if (!showsLabel) continue;
        lastLabelY[c] = midY;
        const anchor = c === 0 ? 'end' : (c === columns.length - 1 ? 'start' : (c % 2 === 1 ? 'end' : 'start'));
        const labelX = c === 0 ? x - nodeWidth / 2 - 8
          : c === columns.length - 1 ? x + nodeWidth / 2 + 8
          : (c === 1 ? x - nodeWidth / 2 - 8 : x + nodeWidth / 2 + 8);
        const pctSpan = `<tspan class="flow-target-pct">${fmtPct(n.pct)}</tspan>`;
        const displayLabel = c === columns.length - 1 ? (n.shortLabel || n.label) : n.label;
        const text = c === 0 ? displayLabel
          : (c === 1 ? `${pctSpan} ${displayLabel}` : `${displayLabel} ${pctSpan}`);
        svg += `<text x="${labelX}" y="${midY + 4}" text-anchor="${anchor}" class="flow-target-label${dimmed ? ' flow-label-dimmed' : ''}" data-col="${c}" data-key="${n.key}">${text}</text>`;
      }
    }

    // Column headers
    const headers = [team.name, 'Final points', 'Points / GD', 'Group finish'];
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
        if (selCol === col && selKey === key) {
          onSelect(null, null);
        } else {
          onSelect(col, key);
        }
      });
    });
  }
  window.ScenarioFlow = { fmtPct, flagImgHtml, OUTCOME_BUCKETS, sumPct, bucketTotal, renderGauge, renderFlow };
})();
