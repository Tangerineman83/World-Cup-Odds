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
  // → teal (wildcard advance) → amber (partial success, eliminated) → red
  // (fully eliminated). This makes qualifying vs eliminated paths immediately
  // distinguishable without needing labels.
  const OUTCOME_BUCKETS = [
    { key: 'first',           label: '1st in group',                shortLabel: '1st',          color: '#4ade80', desc: 'Automatic advance' },
    { key: 'second',          label: '2nd in group',                shortLabel: '2nd',          color: '#86efac', desc: 'Automatic advance' },
    { key: 'thirdQualified',  label: '3rd, advance as a wildcard',  shortLabel: '3rd (through)', color: '#5eead4', desc: 'Advance via top-8 third' },
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
        <div class="gauge-seg gauge-seg-wildcard" style="width:${pThirdShare}%" title="As a top-8 third-placed team: ${fmtPct(pThird)}"></div>
      </div>
      <div class="gauge-sub">
        <span><span class="gauge-dot gauge-dot-direct"></span>1st or 2nd: ${fmtPct(pWinnerOrRunnerUp)}</span>
        <span><span class="gauge-dot gauge-dot-wildcard"></span>Wildcard 3rd: ${fmtPct(pThird)}</span>
      </div>
      ${explainerNote}
    `;
  }

  // Node colours: pts/GD nodes on the left use a neutral slate, outcome
  // nodes on the right use each bucket's own colour (OUTCOME_BUCKETS[].color).
  const PTS_NODE_COLOR = '#7c8db5';
  const OTHER_NODE_COLOR = '#475174';

  // Renders the two-sided flow diagram into svgEl.
  //   team: a predictions.json/scenario.json team entry (needs
  //     outcomeScenarios and pooledScenarios).
  //   state: { selectedSide: 'left'|'right'|null, selectedKey: string|null }
  //     - selectedKey is a bucket key (left) or a "points,gd" key / "other"
  //     (right).
  //   onSelect(side, key): called when a node/ribbon is clicked; pass
  //     null/null to clear selection.
  function renderFlow(svgEl, team, state, onSelect) {
    const W = 680, H = 360;
    const leftX = 120, rightX = 540;
    const nodeWidth = 12;
    const topMargin = 32, bottomMargin = 10;
    const usableH = H - topMargin - bottomMargin;

    // LEFT side: pts/GD combos from pooledScenarios (best to worst, Other last)
    const pooled = team.pooledScenarios || [];
    const leftNodes = pooled.map((e) => {
      const isOther = e.points === null;
      const key = isOther ? 'other' : `${e.points},${e.gd}`;
      const label = isOther ? 'Other' : `${e.points}pt${e.points === 1 ? '' : 's'}, GD ${e.gd >= 0 ? '+' : ''}${e.gd}`;
      return { side: 'left', key, label, color: PTS_NODE_COLOR, isOther, pct: e.total, byBucket: e.byBucket };
    });

    // RIGHT side: outcome buckets (1st / 2nd / 3rd-through / 3rd-out / 4th)
    const rightNodes = OUTCOME_BUCKETS.map((b) => ({
      ...b, side: 'right', key: b.key, pct: bucketTotal(team, b.key),
    }));

    const leftTotal = leftNodes.reduce((sum, n) => sum + n.pct, 0) || 1;
    const rightTotal = rightNodes.reduce((sum, n) => sum + n.pct, 0) || 1;

    function layout(nodes, total, gap) {
      const totalGap = gap * (nodes.length - 1);
      let y = topMargin;
      return nodes.map((n) => {
        const h = Math.max((n.pct / total) * (usableH - totalGap), n.pct > 0 ? 1.5 : 0);
        const seg = { ...n, y0: y, y1: y + h };
        y += h + gap;
        return seg;
      });
    }

    const leftGap = Math.max(1.5, Math.min(5, 240 / Math.max(leftNodes.length, 1)));
    const leftLaidOut = layout(leftNodes, leftTotal, leftGap);
    const rightLaidOut = layout(rightNodes, rightTotal, 6);

    const leftByKey = new Map(leftLaidOut.map((n) => [n.key, n]));
    const rightByKey = new Map(rightLaidOut.map((n) => [n.key, n]));

    // Ribbon stacking: outer loop = left (pts/GD) nodes (determines right-cursor
    // position per right node), inner loop = right (outcome bucket) nodes in order.
    // For each pts/GD node, iterate over outcome buckets in display order,
    // allocating a slice of the pts/GD node proportional to that bucket's
    // contribution, and a slice of the bucket node proportional to the same.
    // This ensures no crossing within either node's ribbon stack.
    const rightCursors = new Map(rightLaidOut.map((n) => [n.key, n.y0]));
    const ribbons = [];
    for (const left of leftLaidOut) {
      let leftCursor = left.y0;
      for (const bucket of OUTCOME_BUCKETS) {
        const p = (left.byBucket || {})[bucket.key];
        if (!p) continue;
        const right = rightByKey.get(bucket.key);
        if (!right) continue;

        const ly0 = leftCursor;
        const ly1 = leftCursor + (left.y1 - left.y0) * (p / left.pct);
        leftCursor = ly1;

        const rightTotalH = right.y1 - right.y0;
        const ry0 = rightCursors.get(bucket.key);
        const ry1 = ry0 + rightTotalH * (p / right.pct);
        rightCursors.set(bucket.key, ry1);

        ribbons.push({
          leftKey: left.key, rightKey: bucket.key, pct: p,
          ly0, ly1, ry0, ry1, color: bucket.color,
        });
      }
    }

    const midX = (leftX + rightX) / 2;
    let svg = '';

    const selSide = state && state.selectedSide;
    const selKey = state && state.selectedKey;

    function ribbonOpacity(r) {
      if (!selKey) return 0.45;
      const matches = (selSide === 'left' && r.leftKey === selKey) ||
                      (selSide === 'right' && r.rightKey === selKey);
      return matches ? 0.85 : 0.08;
    }

    function nodeIsDimmed(side, key) {
      if (!selKey) return false;
      if (selSide === side) return key !== selKey;
      return !ribbons.some((r) =>
        selSide === 'left' ? r.leftKey === selKey && r.rightKey === key
                           : r.rightKey === selKey && r.leftKey === key
      );
    }

    // Define a linear gradient per outcome bucket (slate → bucket colour),
    // used for ribbons flowing left-to-right. One gradient per unique bucket
    // colour, identified by the bucket key.
    const gradientDefs = OUTCOME_BUCKETS.map((b) =>
      `<linearGradient id="flow-grad-${b.key}" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%" stop-color="${PTS_NODE_COLOR}"/>
        <stop offset="100%" stop-color="${b.color}"/>
      </linearGradient>`
    ).join('');
    svg += `<defs>${gradientDefs}</defs>`;

    // Ribbons (drawn first so nodes sit on top)
    for (const r of ribbons) {
      const path = `M ${leftX} ${r.ly0}
        C ${midX} ${r.ly0}, ${midX} ${r.ry0}, ${rightX} ${r.ry0}
        L ${rightX} ${r.ry1}
        C ${midX} ${r.ry1}, ${midX} ${r.ly1}, ${leftX} ${r.ly1} Z`;
      const leftLabel = (leftByKey.get(r.leftKey) || {}).label || '';
      const rightLabel = OUTCOME_BUCKETS.find((b) => b.key === r.rightKey).shortLabel;
      const title = `${leftLabel} \u2192 ${rightLabel}: ${fmtPct(r.pct)}`;
      svg += `<path d="${path}" fill="url(#flow-grad-${r.rightKey})" opacity="${ribbonOpacity(r)}" class="flow-ribbon" data-side="left" data-key="${r.leftKey}"><title>${title}</title></path>`;
    }

    // Left nodes (pts/GD) - labels to the left
    for (const n of leftLaidOut) {
      if (n.pct <= 0) continue;
      const dimmed = nodeIsDimmed('left', n.key);
      const isSelected = selSide === 'left' && selKey === n.key;
      const nodeColor = n.isOther ? OTHER_NODE_COLOR : PTS_NODE_COLOR;
      svg += `<rect x="${leftX - nodeWidth}" y="${n.y0}" width="${nodeWidth}" height="${n.y1 - n.y0}" fill="${nodeColor}" rx="2" opacity="${dimmed ? 0.25 : 1}" class="flow-node${isSelected ? ' flow-node-selected' : ''}" data-side="left" data-key="${n.key}"></rect>`;
      const midY = (n.y0 + n.y1) / 2;
      svg += `<text x="${leftX - nodeWidth - 8}" y="${midY + 4}" text-anchor="end" class="flow-target-label${dimmed ? ' flow-label-dimmed' : ''}" data-side="left" data-key="${n.key}"><tspan class="flow-target-pct">${fmtPct(n.pct)}</tspan> ${n.label}</text>`;
    }

    // Right nodes (outcome buckets) - labels to the right
    for (const n of rightLaidOut) {
      if (n.pct <= 0) continue;
      const dimmed = nodeIsDimmed('right', n.key);
      const isSelected = selSide === 'right' && selKey === n.key;
      svg += `<rect x="${rightX}" y="${n.y0}" width="${nodeWidth}" height="${n.y1 - n.y0}" fill="${n.color}" rx="2" opacity="${dimmed ? 0.25 : 1}" class="flow-node${isSelected ? ' flow-node-selected' : ''}" data-side="right" data-key="${n.key}"></rect>`;
      const midY = (n.y0 + n.y1) / 2;
      svg += `<text x="${rightX + nodeWidth + 8}" y="${midY + 4}" text-anchor="start" class="flow-target-label${dimmed ? ' flow-label-dimmed' : ''}" data-side="right" data-key="${n.key}">${n.shortLabel} <tspan class="flow-target-pct">${fmtPct(n.pct)}</tspan></text>`;
    }

    // Column headers
    svg += `<text x="${leftX - nodeWidth / 2}" y="${topMargin - 14}" text-anchor="middle" class="flow-source-label">${team.name}</text>`;
    svg += `<text x="${leftX - nodeWidth / 2}" y="${topMargin - 1}" text-anchor="middle" class="flow-source-sublabel">Points / GD</text>`;
    svg += `<text x="${rightX + nodeWidth / 2}" y="${topMargin - 1}" text-anchor="middle" class="flow-source-sublabel">Group finish</text>`;

    svgEl.innerHTML = svg;
    svgEl.setAttribute('viewBox', `0 0 ${W} ${H}`);

    svgEl.querySelectorAll('[data-key]').forEach((el) => {
      el.addEventListener('click', () => {
        const side = el.dataset.side;
        const key = el.dataset.key;
        if (selSide === side && selKey === key) {
          onSelect(null, null);
        } else {
          onSelect(side, key);
        }
      });
    });
  }
  window.ScenarioFlow = { fmtPct, flagImgHtml, OUTCOME_BUCKETS, sumPct, bucketTotal, renderGauge, renderFlow };
})();
