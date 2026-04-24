<script lang="ts">
  interface ChartPoint { t: number; v: number; }
  interface ChartSeries { label: string; color: string; points: ChartPoint[]; }
  interface Marker { t: number; label: string; color?: string; }

  let {
    series,
    title,
    markers = [],
    originMs = null,
    showAllSeriesByDefault = false,
    onHoverTimeChange
  }: {
    series: ChartSeries[];
    title: string;
    markers?: Marker[];
    originMs?: number | null;
    showAllSeriesByDefault?: boolean;
    onHoverTimeChange?: (hoveredTime: number | null) => void;
  } = $props();

  const ML = 60, MR = 20, MT = 8, MB = 28;
  const W = 520, H = 190;
  const IW = W - ML - MR;
  const IH = H - MT - MB;

  let hiddenSeries = $state<string[]>([]);
  let lastSeriesSignature = $state('');

  const visibleSeries = $derived(series.filter(s => !hiddenSeries.includes(s.label)));
  const allPts = $derived(visibleSeries.flatMap(s => s.points));
  const markerTs = $derived(markers.map(m => m.t).filter(t => !isNaN(t)));
  const tMin = $derived(allPts.length ? Math.min(...allPts.map(p => p.t), ...markerTs) : 0);
  const tMax = $derived(allPts.length ? Math.max(...allPts.map(p => p.t), ...markerTs) : 1);
  const vMin = $derived(0); // always 0 for AAS-style charts
  const vMax = $derived(allPts.length ? Math.max(...allPts.map(p => p.v)) : 1);
  const tRange = $derived(tMax - tMin || 1);
  const vRange = $derived(vMax - vMin || 1);

  // Sorted unique timestamps for snap-to-data-point
  const uniqueTimes = $derived.by(() => {
    const s = new Set<number>();
    for (const sr of visibleSeries) for (const p of sr.points) s.add(p.t);
    return [...s].sort((a, b) => a - b);
  });

  $effect(() => {
    const signature = series.map((s) => s.label).join('\u001f');
    if (signature !== lastSeriesSignature) {
      lastSeriesSignature = signature;
      hiddenSeries = showAllSeriesByDefault ? [] : series.slice(1).map((s) => s.label);
      setHoveredTime(null);
      hoveredSeries = null;
    }
  });

  $effect(() => {
    const labels = new Set(series.map((s) => s.label));
    const nextHidden = hiddenSeries.filter((label) => labels.has(label));
    if (nextHidden.join('\u001f') !== hiddenSeries.join('\u001f')) hiddenSeries = nextHidden;
    if (hoveredSeries && !visibleSeries.some((s) => s.label === hoveredSeries)) hoveredSeries = null;
    if (visibleSeries.length === 0) setHoveredTime(null);
  });

  function tx(t: number) { return ((t - tMin) / tRange) * IW; }
  function ty(v: number) { return IH - ((v - vMin) / vRange) * IH; }
  function pts(points: ChartPoint[]) {
    return points.map(p => `${tx(p.t).toFixed(1)},${ty(p.v).toFixed(1)}`).join(' ');
  }
  function fmtVal(v: number) {
    if (Math.abs(v) >= 1e9) return (v / 1e9).toFixed(1) + 'G';
    if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(1) + 'M';
    if (Math.abs(v) >= 1e3) return (v / 1e3).toFixed(1) + 'K';
    return Number.isInteger(v) ? String(v) : v.toFixed(2);
  }
  function fmtRelTime(ms: number) {
    const s = ms / 1000;
    if (s >= 60) return (s / 60).toFixed(1) + 'm';
    return s.toFixed(0) + 's';
  }
  function fmtTimestamp(tOff: number): string {
    if (originMs != null) {
      const d = new Date(originMs + tOff);
      return d.toLocaleString('en-US', {
        month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
      });
    }
    const s = Math.round(tOff / 1000);
    return s < 60 ? `+${s}s` : `+${Math.floor(s / 60)}m ${s % 60}s`;
  }

  // ── Interaction ────────────────────────────────────────────────────────────
  let wrapperEl: HTMLDivElement | null = $state(null);
  let svgEl: SVGSVGElement | null = $state(null);
  let hoveredTime: number | null = $state(null);
  let hoveredSeries: string | null = $state(null);
  let tooltipX = $state(0);
  let tooltipY = $state(0);

  function setHoveredTime(next: number | null) {
    if (hoveredTime === next) return;
    hoveredTime = next;
    onHoverTimeChange?.(next);
  }

  function toggleSeries(label: string) {
    if (hiddenSeries.includes(label)) {
      hiddenSeries = hiddenSeries.filter((item) => item !== label);
      return;
    }
    hiddenSeries = [...hiddenSeries, label];
  }

  function snapTime(t: number): number | null {
    if (!uniqueTimes.length) return null;
    return uniqueTimes.reduce((n, x) => Math.abs(x - t) < Math.abs(n - t) ? x : n);
  }

  function onMouseMove(e: MouseEvent) {
    if (!svgEl || !wrapperEl) return;
    const svgRect = svgEl.getBoundingClientRect();
    const wRect = wrapperEl.getBoundingClientRect();
    const vbX = ((e.clientX - svgRect.left) / svgRect.width) * W;
    const vbY = ((e.clientY - svgRect.top) / svgRect.height) * H;
    const chartX = vbX - ML;
    const chartY = vbY - MT;
    if (chartX < 0 || chartX > IW || chartY < 0 || chartY > IH) {
      setHoveredTime(null); hoveredSeries = null; return;
    }
    const t = tMin + (chartX / IW) * tRange;
    setHoveredTime(snapTime(t));

    // Find nearest series by y-proximity (threshold: 22 viewBox units)
    if (hoveredTime !== null) {
      let minDist = 22, nearest: string | null = null;
      for (const sr of visibleSeries) {
        const pt = sr.points.find(p => p.t === hoveredTime);
        if (!pt) continue;
        const dist = Math.abs(ty(pt.v) - chartY);
        if (dist < minDist) { minDist = dist; nearest = sr.label; }
      }
      hoveredSeries = nearest;
    }

    const wx = e.clientX - wRect.left;
    const wy = e.clientY - wRect.top;
    tooltipX = wx < wRect.width * 0.55 ? wx + 16 : wx - 224;
    tooltipY = Math.max(40, wy - 20);
  }

  const crosshairX = $derived(hoveredTime !== null ? tx(hoveredTime) : null);

  const tooltipRows = $derived.by(() => {
    if (hoveredTime === null) return [];
    return visibleSeries
      .map(sr => ({ color: sr.color, label: sr.label, v: sr.points.find(p => p.t === hoveredTime)?.v ?? null }))
      .filter(r => r.v !== null)
      .sort((a, b) => (b.v ?? 0) - (a.v ?? 0)) as { color: string; label: string; v: number }[];
  });

  // Series ordered so highlighted series renders last (on top)
  const orderedSeries = $derived.by(() => {
    if (!hoveredSeries) return visibleSeries;
    return [...visibleSeries.filter(s => s.label !== hoveredSeries), ...visibleSeries.filter(s => s.label === hoveredSeries)];
  });

  let copyFlash = $state(false);
  let copyFlashX = $state(0);
  let copyFlashY = $state(0);
  let copyFlashTimer: ReturnType<typeof setTimeout> | null = null;

  function onChartClick(e: MouseEvent) {
    if (hoveredTime === null || tooltipRows.length === 0) return;
    const lines = [fmtTimestamp(hoveredTime), ...tooltipRows.map(r => `${r.label}: ${fmtVal(r.v)}`)];
    navigator.clipboard.writeText(lines.join('\n'));
    const wRect = wrapperEl!.getBoundingClientRect();
    copyFlashX = e.clientX - wRect.left;
    copyFlashY = e.clientY - wRect.top - 28;
    copyFlash = true;
    if (copyFlashTimer) clearTimeout(copyFlashTimer);
    copyFlashTimer = setTimeout(() => { copyFlash = false; }, 1200);
  }
</script>

<div class="chart-wrap" bind:this={wrapperEl}>
  <div class="chart-header">
    <span class="chart-title">{title}</span>
    <span class="chart-legend">
      {#each series as s}
        {@const hidden = hiddenSeries.includes(s.label)}
        <button
          type="button"
          class="leg-item"
          class:hidden={hidden}
          aria-pressed={!hidden}
          title={hidden ? `Show ${s.label}` : `Hide ${s.label}`}
          onclick={() => toggleSeries(s.label)}
        >
          <span class="leg-dot" style="background:{s.color}"></span>
          {s.label}
        </button>
      {/each}
    </span>
  </div>

  {#if series.length > 0 && visibleSeries.length === 0}
    <div class="no-data">All series hidden</div>
  {:else if allPts.length === 0}
    <div class="no-data">No data</div>
  {:else}
    <svg bind:this={svgEl} role="img" aria-label={title} width="100%" viewBox="0 0 {W} {H}" preserveAspectRatio="none"
         style="display:block;cursor:{hoveredTime !== null ? 'copy' : 'crosshair'}"
         onmousemove={onMouseMove} onmouseleave={() => { setHoveredTime(null); hoveredSeries = null; }}
         onclick={onChartClick}>
      <g transform="translate({ML},{MT})">
        <!-- Grid + Y axis -->
        {#each [0, 0.25, 0.5, 0.75, 1] as f}
          {@const yp = IH - f * IH}
          {@const val = vMin + f * vRange}
          <line x1="0" y1={yp} x2={IW} y2={yp} stroke="#eee" stroke-width="1" />
          <text x="-6" y={yp} text-anchor="end" dominant-baseline="middle" font-size="10" fill="#999">{fmtVal(val)}</text>
        {/each}
        <line x1="0" y1="0" x2="0" y2={IH} stroke="#ddd" />
        <line x1="0" y1={IH} x2={IW} y2={IH} stroke="#ddd" />
        <!-- X axis labels -->
        {#each [0, 0.25, 0.5, 0.75, 1] as f}
          {@const xp = f * IW}
          {@const relMs = f * tRange}
          <text x={xp} y={IH + 14} text-anchor="middle" font-size="10" fill="#999">{fmtRelTime(relMs)}</text>
        {/each}
        <!-- Markers -->
        {#each markers as m}
          {@const xp = tx(m.t)}
          <line x1={xp} y1="0" x2={xp} y2={IH} stroke={m.color ?? '#aaa'} stroke-width="1" stroke-dasharray="4,3" />
          <text x={xp + 3} y="8" font-size="9" fill={m.color ?? '#999'}>{m.label}</text>
        {/each}
        <!-- Series (highlighted last = on top) -->
        {#each orderedSeries as s}
          {@const isHighlighted = hoveredSeries === s.label}
          {@const isDimmed = hoveredSeries !== null && !isHighlighted}
          {#if s.points.length > 1}
            <polyline
              points={pts(s.points)}
              fill="none"
              stroke={s.color}
              stroke-width={isHighlighted ? 2.5 : 1.5}
              stroke-linejoin="round"
              stroke-linecap="round"
              opacity={isDimmed ? 0.2 : 1}
            />
          {/if}
          <!-- Dots: all points when no hover, only hovered time when hovering -->
          {#if hoveredTime === null}
            {#each s.points as p}
              <circle cx={tx(p.t)} cy={ty(p.v)} r="2.5" fill={s.color} />
            {/each}
          {:else}
            {@const pt = s.points.find(p => p.t === hoveredTime)}
            {#if pt}
              <circle cx={tx(pt.t)} cy={ty(pt.v)}
                      r={isHighlighted ? 4.5 : 3}
                      fill={s.color}
                      stroke={isHighlighted ? '#fff' : 'none'}
                      stroke-width="1.5"
                      opacity={isDimmed ? 0.2 : 1}
                      pointer-events="none" />
            {/if}
          {/if}
        {/each}
        <!-- Crosshair -->
        {#if crosshairX !== null}
          <line x1={crosshairX} y1="0" x2={crosshairX} y2={IH}
                stroke="#555" stroke-width="1" stroke-dasharray="3,2" pointer-events="none" />
        {/if}
      </g>
    </svg>

    <!-- Copy flash -->
    {#if copyFlash}
      <div class="copy-flash" style="left:{copyFlashX}px;top:{copyFlashY}px">Copied!</div>
    {/if}

    <!-- Tooltip -->
    {#if hoveredTime !== null && tooltipRows.length > 0}
      <div class="tooltip" style="left:{tooltipX}px;top:{tooltipY}px">
        <div class="tt-time">{fmtTimestamp(hoveredTime)}</div>
        <div class="tt-divider"></div>
        {#each tooltipRows as row}
          <div class="tt-row" class:tt-highlight={hoveredSeries === row.label}>
            <span class="tt-dot" style="background:{row.color}"></span>
            <span class="tt-label">{row.label}</span>
            <span class="tt-val">{fmtVal(row.v)}</span>
          </div>
        {/each}
      </div>
    {/if}
  {/if}
</div>

<style>
  .chart-wrap { border: 1px solid #e8e8e8; border-radius: 6px; padding: 10px 12px; background: #fff; position: relative; }
  .chart-header { display: flex; align-items: baseline; gap: 12px; margin-bottom: 6px; flex-wrap: wrap; }
  .chart-title { font-size: 12px; font-weight: 700; color: #333; font-family: monospace; }
  .chart-legend { display: flex; gap: 10px; flex-wrap: wrap; }
  .leg-item {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 11px;
    color: #555;
    background: none;
    border: 1px solid transparent;
    border-radius: 999px;
    padding: 2px 6px;
    cursor: pointer;
  }
  .leg-item:hover { background: #f7f7f7; border-color: #e3e3e3; }
  .leg-item.hidden { opacity: 0.45; }
  .leg-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
  .no-data { font-size: 12px; color: #aaa; padding: 20px 0; text-align: center; }

  .tooltip {
    position: absolute; z-index: 20; pointer-events: none;
    background: #1e1f2e; color: #e0e0e0;
    border: 1px solid #3a3b50; border-radius: 7px;
    padding: 9px 11px; font-size: 11px;
    min-width: 160px; max-width: 240px;
    box-shadow: 0 6px 20px rgba(0,0,0,0.35);
  }
  .tt-time { font-size: 11px; font-weight: 600; color: #9ca3af; white-space: nowrap; margin-bottom: 4px; }
  .tt-divider { height: 1px; background: #3a3b50; margin-bottom: 5px; }
  .tt-row { display: flex; align-items: center; gap: 5px; padding: 2px 0; }
  .tt-row.tt-highlight { font-weight: 600; color: #fff; }
  .tt-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
  .tt-label { flex: 1; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .tt-val { font-size: 11px; font-variant-numeric: tabular-nums; flex-shrink: 0; }

  .copy-flash {
    position: absolute; z-index: 30; pointer-events: none;
    background: #1e1f2e; color: #6ee7b7;
    border: 1px solid #3a3b50; border-radius: 5px;
    padding: 4px 9px; font-size: 11px; font-weight: 600;
    animation: fade-out 1.2s ease forwards;
  }
  @keyframes fade-out {
    0%   { opacity: 1; transform: translateY(0); }
    60%  { opacity: 1; transform: translateY(-4px); }
    100% { opacity: 0; transform: translateY(-8px); }
  }
</style>
