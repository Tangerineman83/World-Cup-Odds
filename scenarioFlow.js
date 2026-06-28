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
  // knockout rounds. Each column is a round (R32→R16→QF→SF→Final→Winner).
  // Node height = probability of reaching that round. The advance ribbon
  // from round N to N+1 represents the probability of advancing.
  // Eliminated flow drops below each node.
  //
  // Opponent labels show ALL possible opponents at each round, weighted by
  // their bracket-slot probability (not just the modal single opponent).
  // Derived by traversing the fixed bracket tree and weighting each possible
  // opponent by their own probability of reaching that round.

  const KO_ROUND_COLORS = {
    r32:    '#818cf8',
    r16:    '#60a5fa',
    qf:     '#34d399',
    sf:     '#fbbf24',
    final:  '#f97316',
    winner: '#4ade80',
    out:    '#475569',
  };

  // Bracket feed structure: matchId -> [feedA, feedB]
  const KO_PAIRS = {
    M89:  ['M74','M77'], M90:  ['M73','M75'],
    M91:  ['M76','M78'], M92:  ['M79','M80'],
    M93:  ['M83','M84'], M94:  ['M81','M82'],
    M95:  ['M86','M88'], M96:  ['M85','M87'],
    M97:  ['M89','M90'], M98:  ['M93','M94'],
    M99:  ['M91','M92'], M100: ['M95','M96'],
    M101: ['M97','M98'], M102: ['M99','M100'],
    M104: ['M101','M102'],
  };

  const STAGE_P_KEY = {
    r32: 'pRoundOf32', r16: 'pRoundOf16',
    qf: 'pQuarterFinal', sf: 'pSemiFinal', final: 'pFinal',
  };

  // Given a match id, return all team names that could appear in it
  // by recursively traversing the bracket tree down to R32 fixtures.
  function teamsInMatch(matchId, scenarioData) {
    const r32 = scenarioData.r32 || [];
    const r32m = r32.find(m => m.id === matchId);
    if (r32m) return new Set([r32m.home.name, r32m.away.name]);
    const [a, b] = KO_PAIRS[matchId] || [];
    if (!a) return new Set();
    const sa = teamsInMatch(a, scenarioData);
    const sb = teamsInMatch(b, scenarioData);
    return new Set([...sa, ...sb]);
  }

  // Find which match a team appears in at a given stage in the scenario.
  // Handles the fact that 'final' is a single object not an array, and
  // that a team may not appear in the final if they're the modal loser in SF.
  function findTeamMatch(teamName, stage, scenarioData) {
    let matches = scenarioData[stage] || [];
    if (!Array.isArray(matches)) matches = [matches];
    for (const m of matches) {
      if (m.home?.name === teamName || m.away?.name === teamName) return m;
    }
    // For 'final': the team may be in the SF feeding the Final but not yet
    // the modal finalist. Find their SF match and infer the Final match id.
    if (stage === 'final') {
      const sfMatches = scenarioData.sf || [];
      for (const sf of sfMatches) {
        if (sf.home?.name === teamName || sf.away?.name === teamName) {
          // This SF feeds into the Final via KO_PAIRS
          return { id: 'M104', _inferredFor: teamName, _sfId: sf.id };
        }
      }
    }
    return null;
  }

  // Return opponent distribution for a team at a given stage:
  // [{name, code, pct}] sorted desc, pct conditional on being the opponent
  // (sums to 1 across all possible opponents in that bracket slot).
  function opponentDistribution(teamName, stage, scenarioData, predictionsByTeam) {
    const tm = findTeamMatch(teamName, stage, scenarioData);
    if (!tm) return [];

    const matchId = tm.id;
    const [feedA, feedB] = KO_PAIRS[matchId] || [];

    // R32: opponent is always the fixed other team (group stage complete)
    if (!feedA) {
      const r32m = (scenarioData.r32 || []).find(m => m.id === matchId);
      if (!r32m) return [];
      const opp = r32m.home.name === teamName ? r32m.away : r32m.home;
      return [{ name: opp.name, code: opp.code, pct: 1.0 }];
    }

    // Find which feed the team comes from, opponent comes from the other
    const inFeedA = teamsInMatch(feedA, scenarioData).has(teamName);
    const oppFeed = inFeedA ? feedB : feedA;
    const oppTeams = teamsInMatch(oppFeed, scenarioData);

    const pKey = STAGE_P_KEY[stage];
    const weights = {};
    for (const t of oppTeams) {
      const pred = predictionsByTeam[t];
      if (pred) weights[t] = pred[pKey] || 0;
    }
    const total = Object.values(weights).reduce((s, v) => s + v, 0);
    if (total === 0) return [];

    return Object.entries(weights)
      .map(([name, w]) => ({
        name, pct: w / total,
        code: (predictionsByTeam[name] || {}).code || null,
      }))
      .sort((a, b) => b.pct - a.pct);
  }

  // ── renderKnockoutFlow ────────────────────────────────────────────────────
  //
  // NEW DESIGN: per-opponent-node Sankey.
  //
  // Layout (left → right):
  //   [Team] → [R32 node] → [R16 nodes…] → [QF nodes…] → [SF nodes…] → [Final nodes…] → [Win] + [Don't Win]
  //
  // Each intermediate node represents one possible opponent at that round.
  // Node height ∝ joint probability = P(team reaches round AND faces that opponent).
  // From each node, two flows leave:
  //   • Win flow (top, coloured) → fans out into the opponent nodes of the next round
  //   • Loss flow (bottom, grey) → merges into the "Don't Win" terminal on the right
  // Opponents with joint probability below a threshold are grouped into an "Other" node.
  // Terminal nodes:
  //   • "Win" (green, top-right) accumulates pChampion
  //   • "Don't Win" (slate, bottom-right) accumulates 1 – pChampion

  function renderKnockoutFlow(svgEl, team, scenarioData, predsList) {
    if (!team || !scenarioData) return;

    const predsByName = {};
    if (predsList) for (const t of predsList) predsByName[t.name] = t;
    predsByName[team.name] = team;

    // ── 1. Build nodes per round ──────────────────────────────────────────

    // Stage sequence and their pReach values
    const STAGES = [
      { key: 'r32',   label: 'Last 32', pKey: 'pRoundOf32'    },
      { key: 'r16',   label: 'Last 16', pKey: 'pRoundOf16'    },
      { key: 'qf',    label: 'QF',      pKey: 'pQuarterFinal' },
      { key: 'sf',    label: 'SF',      pKey: 'pSemiFinal'    },
      { key: 'final', label: 'Final',   pKey: 'pFinal'        },
    ];

    // Filter to stages the team actually reaches
    const activeStages = STAGES.filter(s => (team[s.pKey] || 0) > 0.0001);
    if (activeStages.length === 0) { svgEl.innerHTML = ''; return; }

    // Joint P threshold: opponents below this are grouped into "Other"
    const THRESHOLD = 0.025;
    // Max shown per node before grouping
    const MAX_SHOWN = 6;

    // For each stage, build the list of opponent nodes:
    // [{ oppName, jointP, condP }] sorted by jointP desc, with an "Other" bucket if needed
    function buildOpponentNodes(stage) {
      const pReach = team[stage.pKey] || 0;
      if (pReach < 0.0001) return [];

      // R32: single fixed opponent
      if (stage.key === 'r32') {
        const r32m = (scenarioData.r32 || []).find(m =>
          m.home?.name === team.name || m.away?.name === team.name
        );
        if (!r32m) return [];
        const opp = r32m.home.name === team.name ? r32m.away : r32m.home;
        return [{ oppName: opp.name, jointP: pReach, condP: 1.0, isOther: false }];
      }

      // Later rounds: find opponent feed and weight by pReach of each potential opponent
      // Find team's match at this stage
      let stageMatches = scenarioData[stage.key] || [];
      if (!Array.isArray(stageMatches)) stageMatches = [stageMatches];

      let teamMatch = stageMatches.find(m =>
        m.home?.name === team.name || m.away?.name === team.name
      );

      // For Final: team may not be in modal final — find via SF
      if (!teamMatch && stage.key === 'final') {
        const sfMatches = scenarioData.sf || [];
        for (const sf of sfMatches) {
          if (sf.home?.name === team.name || sf.away?.name === team.name) {
            teamMatch = { id: 'M104' }; break;
          }
        }
      }
      if (!teamMatch) return [];

      const [feedA, feedB] = KO_PAIRS[teamMatch.id] || [];
      if (!feedA) return [];

      const inFeedA = teamsInMatch(feedA, scenarioData).has(team.name);
      const oppFeed = inFeedA ? feedB : feedA;
      const oppTeams = [...teamsInMatch(oppFeed, scenarioData)];

      const pKey = STAGE_P_KEY[stage.key];
      const weights = {};
      for (const t of oppTeams) {
        weights[t] = (predsByName[t] || {})[pKey] || 0;
      }
      const totalW = Object.values(weights).reduce((s, v) => s + v, 0);
      if (totalW === 0) return [];

      const rawNodes = Object.entries(weights)
        .map(([name, w]) => ({ oppName: name, condP: w / totalW, jointP: (w / totalW) * pReach }))
        .sort((a, b) => b.jointP - a.jointP);

      // Apply threshold + max shown
      const shown = rawNodes.filter((n, i) => n.jointP >= THRESHOLD && i < MAX_SHOWN);
      const others = rawNodes.filter((n, i) => n.jointP < THRESHOLD || i >= MAX_SHOWN);

      const result = shown.map(n => ({ ...n, isOther: false }));
      if (others.length > 0) {
        const otherJoint = others.reduce((s, n) => s + n.jointP, 0);
        const otherCond  = others.reduce((s, n) => s + n.condP,  0);
        result.push({ oppName: `+${others.length} others`, jointP: otherJoint, condP: otherCond, isOther: true });
      }
      return result;
    }

    const stageNodes = activeStages.map(s => ({
      ...s,
      nodes: buildOpponentNodes(s),
      pReach: team[s.pKey] || 0,
      pReachNext: null, // filled below
    }));

    // Fill pReachNext: probability of reaching the next stage
    for (let i = 0; i < stageNodes.length; i++) {
      if (i < stageNodes.length - 1) {
        stageNodes[i].pReachNext = stageNodes[i + 1].pReach;
      } else {
        // Last stage (Final): pReachNext = pChampion
        stageNodes[i].pReachNext = team.pChampion || 0;
      }
    }

    // ── 2. Layout constants ───────────────────────────────────────────────

    const W = 1100, H = 480;
    const PAD_TOP = 36, PAD_BOT = 28, PAD_LEFT = 72, PAD_RIGHT = 90;
    const usableW = W - PAD_LEFT - PAD_RIGHT;
    const usableH = H - PAD_TOP - PAD_BOT;

    // Columns: Team | R32 | R16 | QF | SF | Final | Win/DontWin
    const nCols = stageNodes.length + 2; // +1 for team source, +1 for terminals
    const colW = usableW / (nCols - 1);
    const colX = i => PAD_LEFT + i * colW;

    const teamColX    = colX(0);
    const stageColXs  = stageNodes.map((_, i) => colX(i + 1));
    const terminalColX = colX(nCols - 1);

    // Height scale: map probability to pixels
    const SCALE = usableH * 0.88; // p=1 → 88% of usable height
    const MIN_H  = 3;
    const pH = p => Math.max(MIN_H, p * SCALE);

    const NODE_W = 10;
    const GAP    = 5;  // gap between stacked nodes in a column

    // Win terminal centred in top 40% of usable area; Don't Win in bottom 40%
    const winTermY   = PAD_TOP + usableH * 0.13;
    const loseTermY  = PAD_TOP + usableH * 0.58;

    // ── 3. Position each node ─────────────────────────────────────────────

    // For each stage column, stack nodes vertically centred on the column midpoint.
    // Track y0 (top edge) of each node.
    for (let si = 0; si < stageNodes.length; si++) {
      const col = stageNodes[si];
      const totalH = col.nodes.reduce((s, n) => s + pH(n.jointP), 0)
                   + GAP * Math.max(0, col.nodes.length - 1);
      let y = PAD_TOP + (usableH - totalH) / 2;
      for (const n of col.nodes) {
        n.y0 = y;
        n.h  = pH(n.jointP);
        n.cx = stageColXs[si];
        y += n.h + GAP;
      }
    }

    // ── 4. SVG helpers ────────────────────────────────────────────────────

    let svg = '<defs>';

    // Colour per stage
    const COL = {
      r32: '#818cf8', r16: '#60a5fa', qf: '#34d399',
      sf: '#fbbf24', final: '#f97316',
      win: '#4ade80', lose: '#475569', team: '#5eead4',
    };

    // Gradient for each stage transition
    for (let si = 0; si < stageNodes.length; si++) {
      const c0 = si === 0 ? COL.team : COL[stageNodes[si - 1].key];
      const c1 = COL[stageNodes[si].key];
      svg += `<linearGradient id="kgA${si}" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%" stop-color="${c0}" stop-opacity="0.7"/>
        <stop offset="100%" stop-color="${c1}" stop-opacity="0.7"/>
      </linearGradient>`;
      // win→next gradient
      if (si < stageNodes.length - 1) {
        const cNext = COL[stageNodes[si + 1].key];
        svg += `<linearGradient id="kgW${si}" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stop-color="${c1}" stop-opacity="0.6"/>
          <stop offset="100%" stop-color="${cNext}" stop-opacity="0.6"/>
        </linearGradient>`;
      }
    }
    svg += '</defs>';

    // Draw a cubic bezier ribbon between two horizontal spans
    function ribbon(x0, y0top, y0bot, x1, y1top, y1bot, fill, title='', opacity=0.5) {
      const mx = (x0 + x1) / 2;
      return `<path d="M${x0},${y0top} C${mx},${y0top} ${mx},${y1top} ${x1},${y1top}
               L${x1},${y1bot} C${mx},${y1bot} ${mx},${y0bot} ${x0},${y0bot} Z"
               fill="${fill}" opacity="${opacity}">
               ${title ? `<title>${title}</title>` : ''}</path>`;
    }

    // Node rectangle + label
    function nodeRect(x, y0, h, color, label, prob, isOther = false) {
      const labelX = x + NODE_W / 2 + 5;
      const midY   = y0 + h / 2;
      const nameStyle = `font-size:9px;fill:${isOther ? '#64748b' : '#cbd5e1'};font-family:system-ui,sans-serif`;
      const probStyle = `font-size:8px;fill:#94a3b8;font-family:system-ui,sans-serif;font-variant-numeric:tabular-nums`;
      return `<rect x="${x - NODE_W/2}" y="${y0}" width="${NODE_W}" height="${Math.max(h,2)}"
                fill="${color}" rx="2" opacity="${isOther ? 0.45 : 0.9}"/>
              <text x="${labelX}" y="${midY - 1}" dominant-baseline="auto" style="${nameStyle}">${label}</text>
              <text x="${labelX}" y="${midY + 10}" dominant-baseline="auto" style="${probStyle}">${prob}</text>`;
    }

    // ── 5. Draw flows ─────────────────────────────────────────────────────

    // (a) Team source node → R32 node(s)
    const teamH  = pH(team.pRoundOf32 || 1);
    const teamY0 = PAD_TOP + (usableH - teamH) / 2;
    const firstCol = stageNodes[0];

    // Ribbon from team node to R32 nodes
    let srcWinY = teamY0; // tracks where the win flow top is on the source node
    for (const n of firstCol.nodes) {
      // All flow from team → each R32 node is proportional to n.jointP / total
      const ribbonH_src = pH(n.jointP);
      svg += ribbon(
        teamColX + NODE_W/2, srcWinY, srcWinY + ribbonH_src,
        n.cx - NODE_W/2,     n.y0,    n.y0 + n.h,
        `url(#kgA0)`, `${n.oppName}: ${fmtPct(n.jointP)}`
      );
      srcWinY += ribbonH_src;
    }

    // (b) Within each stage: win flow → next stage nodes, loss flow → Don't Win terminal
    for (let si = 0; si < stageNodes.length; si++) {
      const col     = stageNodes[si];
      const isLast  = si === stageNodes.length - 1;
      const nextCol = isLast ? null : stageNodes[si + 1];

      // Conditional win rate for this stage
      const pWinRate = col.pReach > 0 ? col.pReachNext / col.pReach : 0;

      for (const n of col.nodes) {
        const winH  = pH(n.jointP * pWinRate);
        const loseH = pH(n.jointP * (1 - pWinRate));

        // Win flow: top portion of node
        n.winY0  = n.y0;
        n.winY1  = n.y0 + winH;
        // Loss flow: bottom portion
        n.loseY0 = n.winY1;
        n.loseY1 = n.y0 + n.h;

        // Loss ribbon → Don't Win terminal (drawn later)
        // Store for now; we'll accumulate them
      }

      if (!isLast) {
        // Fan out win flows from this stage's nodes to next stage's nodes.
        //
        // Each source node n has a win flow height of pH(n.jointP * pWinRate).
        // Each destination node dn has a total incoming height of pH(dn.jointP).
        // Ribbon from (n → dn) has height proportional to:
        //   src contribution = winH(n) * dn.condP   (dn's share of the win pool)
        //   dst contribution = pH(dn.jointP) * (winH(n) / totalWinH)  (n's share of dn's inflow)
        // Both allocations are equivalent (same area), so we use a single consistent
        // allocation: for each dn, carve pH(dn.jointP) from sources top-to-bottom.

        // Track current write position on each src node's win range
        const srcCursors = Object.fromEntries(col.nodes.map(n => [n.oppName, n.winY0]));

        for (const dn of nextCol.nodes) {
          let destCur = dn.y0;
          // Allocate dn.jointP proportionally across src win flows
          for (const sn of col.nodes) {
            const snWinH = pH(sn.jointP * pWinRate);
            if (snWinH < 0.5) continue;
            // This src contributes condP(sn) * pH(dn.jointP) to dn's inflow
            // and dn.condP * snWinH to dn's total from this src
            const sliceH = snWinH * dn.condP; // how much of sn's win goes to dn
            if (sliceH < 0.5) { srcCursors[sn.oppName] += sliceH; continue; }
            const dstSlice = pH(dn.jointP) * (snWinH / pH(col.pReachNext));
            if (dstSlice < 0.5) { srcCursors[sn.oppName] += sliceH; destCur += dstSlice; continue; }
            svg += ribbon(
              sn.cx + NODE_W/2, srcCursors[sn.oppName], srcCursors[sn.oppName] + sliceH,
              dn.cx - NODE_W/2, destCur,                 destCur + dstSlice,
              `url(#kgW${si})`,
              `${sn.oppName} wins → vs ${dn.oppName}: ${fmtPct(sn.jointP * pWinRate * dn.condP)}`,
              0.45
            );
            srcCursors[sn.oppName] += sliceH;
            destCur += dstSlice;
          }
        }
      } else {
        // Last stage (Final): win flows → Win terminal
        let winTermCur = winTermY;
        for (const n of col.nodes) {
          const wh = n.winY1 - n.winY0;
          if (wh < 0.5) continue;
          svg += ribbon(
            n.cx + NODE_W/2, n.winY0, n.winY1,
            terminalColX - NODE_W/2, winTermCur, winTermCur + wh,
            `url(#kgW${si})` , `${n.oppName} final: ${fmtPct(n.jointP * pWinRate)}`, 0.5
          );
          winTermCur += wh;
        }
      }
    }

    // (c) Loss flows → Don't Win terminal
    // Collect all loss ribbons in order (top-to-bottom within each stage col)
    let loseCur = loseTermY;
    for (let si = 0; si < stageNodes.length; si++) {
      const col = stageNodes[si];
      const pWinRate = col.pReach > 0 ? col.pReachNext / col.pReach : 0;
      for (const n of col.nodes) {
        const lh = n.loseY1 - n.loseY0;
        if (lh < 0.5) continue;
        svg += ribbon(
          n.cx + NODE_W/2, n.loseY0, n.loseY1,
          terminalColX - NODE_W/2, loseCur, loseCur + lh,
          COL.lose, `Out at ${col.label}: ${fmtPct(n.jointP * (1 - pWinRate))}`, 0.28
        );
        loseCur += lh;
      }
    }

    // ── 6. Draw nodes (on top of ribbons) ─────────────────────────────────

    // Team source node
    svg += `<rect x="${teamColX - NODE_W/2}" y="${teamY0}" width="${NODE_W}" height="${teamH}"
              fill="${COL.team}" rx="2" opacity="0.9"/>`;
    svg += `<text x="${teamColX + NODE_W/2 + 5}" y="${teamY0 + teamH/2 + 1}"
              dominant-baseline="middle"
              style="font-size:10px;font-weight:700;fill:#e2e8f0;font-family:system-ui,sans-serif">${team.name}</text>`;

    // Stage nodes
    for (let si = 0; si < stageNodes.length; si++) {
      const col = stageNodes[si];
      const color = COL[col.key];
      for (const n of col.nodes) {
        svg += nodeRect(n.cx, n.y0, n.h, color, n.oppName, fmtPct(n.jointP), n.isOther);
      }
      // Column header
      svg += `<text x="${stageColXs[si]}" y="${PAD_TOP - 14}" text-anchor="middle"
                style="font-size:9px;fill:#64748b;font-family:system-ui,sans-serif">${col.label}</text>`;
      svg += `<text x="${stageColXs[si]}" y="${PAD_TOP - 4}" text-anchor="middle"
                style="font-size:10px;font-weight:600;fill:#94a3b8;font-family:system-ui,sans-serif;font-variant-numeric:tabular-nums">${fmtPct(col.pReach)}</text>`;
    }

    // Terminal nodes
    const winH_terminal  = pH(team.pChampion || 0);
    const loseH_terminal = pH(1 - (team.pChampion || 0));
    svg += `<rect x="${terminalColX - NODE_W/2}" y="${winTermY}" width="${NODE_W}" height="${winH_terminal}"
              fill="${COL.win}" rx="2" opacity="0.9"/>
            <text x="${terminalColX + NODE_W/2 + 5}" y="${winTermY + winH_terminal/2 - 5}"
              dominant-baseline="middle"
              style="font-size:9px;font-weight:700;fill:#4ade80;font-family:system-ui,sans-serif">Win</text>
            <text x="${terminalColX + NODE_W/2 + 5}" y="${winTermY + winH_terminal/2 + 8}"
              dominant-baseline="middle"
              style="font-size:10px;font-weight:700;fill:#4ade80;font-family:system-ui,sans-serif;font-variant-numeric:tabular-nums">${fmtPct(team.pChampion)}</text>`;

    svg += `<rect x="${terminalColX - NODE_W/2}" y="${loseTermY}" width="${NODE_W}" height="${loseH_terminal}"
              fill="${COL.lose}" rx="2" opacity="0.7"/>
            <text x="${terminalColX + NODE_W/2 + 5}" y="${loseTermY + loseH_terminal/2 - 5}"
              dominant-baseline="middle"
              style="font-size:9px;fill:#94a3b8;font-family:system-ui,sans-serif">Don't win</text>
            <text x="${terminalColX + NODE_W/2 + 5}" y="${loseTermY + loseH_terminal/2 + 8}"
              dominant-baseline="middle"
              style="font-size:10px;fill:#94a3b8;font-family:system-ui,sans-serif;font-variant-numeric:tabular-nums">${fmtPct(1 - (team.pChampion || 0))}</text>`;

    svgEl.innerHTML = svg;
    svgEl.setAttribute('viewBox', `0 0 ${W} ${H}`);
  }

  window.ScenarioFlow = { fmtPct, flagImgHtml, OUTCOME_BUCKETS, sumPct, bucketTotal, renderGauge, renderFlow, renderKnockoutFlow };
})();
