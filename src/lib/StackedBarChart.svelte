<script lang="ts">
  interface BarSegment { label: string; color: string; value: number; }
  interface BarGroup { label: string; segments: BarSegment[]; }

  let {
    groups,
    title,
    hiddenLabels = [],
    onToggleLabel = null,
  }: {
    groups: BarGroup[];
    title: string;
    hiddenLabels?: string[];
    onToggleLabel?: ((label: string) => void) | null;
  } = $props();

  const ML = 60, MR = 20, MT = 8, MB = 36;
  const W = 620, H = 220;
  const IW = W - ML - MR;
  const IH = H - MT - MB;

  const legend = $derived.by(() => {
    const seen = new Set<string>();
    const items: BarSegment[] = [];
    for (const group of groups) {
      for (const segment of group.segments) {
        if (seen.has(segment.label)) continue;
        seen.add(segment.label);
        items.push(segment);
      }
    }
    return items;
  });

  function isLabelVisible(label: string) {
    return !hiddenLabels.includes(label);
  }

  const visibleGroups = $derived(groups.map(group => ({
    ...group,
    segments: group.segments.filter(segment => isLabelVisible(segment.label))
  })));
  const totals = $derived(visibleGroups.map(group => group.segments.reduce((sum, segment) => sum + segment.value, 0)));
  const vMax = $derived(Math.max(...totals, 1));
  const barGap = 18;
  const barWidth = $derived(groups.length ? Math.min(76, Math.max(28, (IW - Math.max(0, groups.length - 1) * barGap) / groups.length)) : 52);
  const barsWidth = $derived(groups.length * barWidth + Math.max(0, groups.length - 1) * barGap);
  const barsStartX = $derived((IW - barsWidth) / 2);

  let hoveredGroupIdx = $state<number | null>(null);

  function barX(i: number) {
    return barsStartX + i * (barWidth + barGap);
  }

  function ty(v: number) {
    return IH - (v / vMax) * IH;
  }

  function fmtVal(v: number) {
    if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(1) + 'M';
    if (Math.abs(v) >= 1e3) return (v / 1e3).toFixed(1) + 'K';
    return Number.isInteger(v) ? String(v) : v.toFixed(2);
  }

  function truncLabel(s: string, maxChars: number): string {
    return s.length > maxChars ? s.slice(0, maxChars - 1) + '...' : s;
  }

  function stackSegments(segments: BarSegment[]) {
    let start = 0;
    return segments.map(segment => {
      const entry = { segment, start, end: start + segment.value };
      start = entry.end;
      return entry;
    });
  }
</script>

<div class="chart-wrap">
  <div class="chart-header">
    <span class="chart-title">{title}</span>
    <span class="chart-legend">
      {#each legend as item}
        {#if onToggleLabel}
          <button
            type="button"
            class="leg-item leg-button"
            class:leg-off={!isLabelVisible(item.label)}
            aria-pressed={isLabelVisible(item.label)}
            onclick={() => onToggleLabel?.(item.label)}
          >
            <span class="leg-dot" style="background:{item.color}"></span>{item.label}
          </button>
        {:else}
          <span class="leg-item"><span class="leg-dot" style="background:{item.color}"></span>{item.label}</span>
        {/if}
      {/each}
    </span>
  </div>

  {#if groups.length === 0}
    <div class="no-data">No data</div>
  {:else}
    <svg role="img" aria-label={title} width="100%" viewBox="0 0 {W} {H}" preserveAspectRatio="none" style="display:block">
      <g transform="translate({ML},{MT})">
        {#each [0, 0.25, 0.5, 0.75, 1] as f}
          {@const yp = IH - f * IH}
          <line x1="0" y1={yp} x2={IW} y2={yp} stroke="#eee" stroke-width="1" />
          <text x="-6" y={yp} text-anchor="end" dominant-baseline="middle" font-size="10" fill="#999">{fmtVal(f * vMax)}</text>
        {/each}
        <line x1="0" y1="0" x2="0" y2={IH} stroke="#ddd" />
        <line x1="0" y1={IH} x2={IW} y2={IH} stroke="#ddd" />

        {#each visibleGroups as group, groupIdx}
          {@const x = barX(groupIdx)}
          {@const total = totals[groupIdx]}
          {@const isHovered = hoveredGroupIdx === groupIdx}
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <g
            onmouseenter={() => { hoveredGroupIdx = groupIdx; }}
            onmouseleave={() => { hoveredGroupIdx = null; }}
          >
            {#if group.segments.some(segment => segment.value > 0)}
              {#each stackSegments(group.segments.filter(segment => segment.value > 0)) as entry}
                {@const y1 = ty(entry.end)}
                {@const y2 = ty(entry.start)}
                <rect
                  x={x}
                  y={y1}
                  width={barWidth}
                  height={Math.max(1, y2 - y1)}
                  fill={entry.segment.color}
                  opacity={hoveredGroupIdx !== null && !isHovered ? 0.38 : 0.86}
                  rx="2"
                />
              {/each}
            {:else}
              <rect x={x} y={IH - 1} width={barWidth} height="1" fill="#ddd" rx="3" />
            {/if}
            {#if isHovered}
              <text x={x + barWidth / 2} y={Math.max(10, ty(total) - 6)} text-anchor="middle" font-size="10" font-weight="700" fill="#333">{fmtVal(total)}</text>
            {/if}
          </g>
          <text
            x={x + barWidth / 2}
            y={IH + 16}
            text-anchor="middle"
            font-size="10"
            fill={isHovered ? '#333' : '#888'}
            font-weight={isHovered ? '700' : '400'}
          >{truncLabel(group.label, barWidth > 52 ? 14 : 9)}</text>
        {/each}
      </g>
    </svg>

    {#if hoveredGroupIdx !== null}
      {@const group = visibleGroups[hoveredGroupIdx]}
      {@const total = totals[hoveredGroupIdx]}
      <div class="tooltip">
        <div class="tt-label">{group.label}</div>
        <div class="tt-total">Total avg: <strong>{fmtVal(total)}</strong></div>
        <div class="tt-divider"></div>
        {#each group.segments.filter(segment => segment.value > 0).slice().sort((a, b) => b.value - a.value) as segment}
          <div class="tt-row">
            <span class="tt-dot" style="background:{segment.color}"></span>
            <span class="tt-key">{segment.label}</span>
            <span class="tt-val">{fmtVal(segment.value)}</span>
          </div>
        {/each}
      </div>
    {/if}
  {/if}
</div>

<style>
  .chart-wrap { border: 1px solid #e8e8e8; border-radius: 6px; padding: 10px 12px; background: #fff; position: relative; }
  .chart-header { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; flex-wrap: wrap; }
  .chart-title { font-size: 12px; font-weight: 700; color: #333; font-family: monospace; }
  .chart-legend { display: flex; gap: 10px; flex-wrap: wrap; }
  .leg-item { display: flex; align-items: center; gap: 4px; font-size: 11px; color: #555; }
  .leg-button { border: none; background: transparent; padding: 0; cursor: pointer; font: inherit; }
  .leg-button:hover { color: #111; }
  .leg-button.leg-off { color: #aaa; text-decoration: line-through; }
  .leg-button.leg-off .leg-dot { opacity: 0.28; }
  .leg-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
  .no-data { font-size: 12px; color: #aaa; padding: 20px 0; text-align: center; }

  .tooltip {
    position: absolute;
    top: 42px;
    right: 14px;
    z-index: 20;
    pointer-events: none;
    background: #1e1f2e;
    color: #e0e0e0;
    border: 1px solid #3a3b50;
    border-radius: 7px;
    padding: 9px 11px;
    font-size: 11px;
    min-width: 170px;
    max-width: 260px;
    box-shadow: 0 6px 20px rgba(0,0,0,0.35);
  }
  .tt-label { font-weight: 700; color: #fff; margin-bottom: 2px; }
  .tt-total { font-size: 10px; color: #9ca3af; margin-bottom: 5px; }
  .tt-total strong { color: #e0e0e0; }
  .tt-divider { height: 1px; background: #3a3b50; margin-bottom: 5px; }
  .tt-row { display: flex; align-items: center; gap: 6px; padding: 1.5px 0; }
  .tt-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
  .tt-key { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .tt-val { font-variant-numeric: tabular-nums; }
</style>
