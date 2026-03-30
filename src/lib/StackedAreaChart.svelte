<script lang="ts">
  interface ChartSeries { label: string; color: string; points: { t: number; v: number }[]; }
  interface Marker { t: number; label: string; color?: string; }
  interface RawRow { t: number; typeKey: string; eventKey: string; color: string; v: number; }

  let {
    series,
    rawRows = [],
    title,
    markers = [],
    originMs = null,
    showDetailToggle = true,
  }: {
    series: ChartSeries[];
    rawRows?: RawRow[];
    title: string;
    markers?: Marker[];
    originMs?: number | null;
    showDetailToggle?: boolean;
  } = $props();

  // Map typeKey → series color so broad-mode tooltip matches chart polygons
  const seriesColorMap = $derived(
    Object.fromEntries(series.map(s => [s.label, s.color]))
  );

  const ML = 60, MR = 20, MT = 8, MB = 28;
  const W = 520, H = 190;
  const IW = W - ML - MR;
  const IH = H - MT - MB;

  const allTimes = $derived.by(() => {
    const s = new Set<number>();
    for (const sr of series) for (const p of sr.points) s.add(p.t);
    for (const m of markers) if (!isNaN(m.t)) s.add(m.t);
    return [...s].sort((a, b) => a - b);
  });

  const tMin = $derived(allTimes.length ? allTimes[0] : 0);
  const tMax = $derived(allTimes.length ? allTimes[allTimes.length - 1] : 1);
  const tRange = $derived(tMax - tMin || 1);

  const stacked = $derived.by(() => {
    if (!series.length || !allTimes.length) return { bottoms: [] as number[][], tops: [] as number[][], vMax: 1 };
    const maps = series.map(s => new Map(s.points.map(p => [p.t, p.v])));
    const n = allTimes.length;
    const bottoms: number[][] = [], tops: number[][] = [];
    const run = new Array<number>(n).fill(0);
    for (let i = 0; i < series.length; i++) {
      bottoms.push([...run]);
      for (let j = 0; j < n; j++) run[j] += maps[i].get(allTimes[j]) ?? 0;
      tops.push([...run]);
    }
    return { bottoms, tops, vMax: Math.max(...run, 1) };
  });

  const hasData = $derived(series.some(s => s.points.length > 0));

  function tx(t: number) { return ((t - tMin) / tRange) * IW; }
  function ty(v: number) { return IH - (v / stacked.vMax) * IH; }
  function polyPts(topArr: number[], botArr: number[]) {
    const fwd = allTimes.map((t, j) => `${tx(t).toFixed(1)},${ty(topArr[j]).toFixed(1)}`);
    const rev = allTimes.map((t, j) => `${tx(t).toFixed(1)},${ty(botArr[j]).toFixed(1)}`).reverse();
    return [...fwd, ...rev].join(' ');
  }
  function fmtVal(v: number) {
    if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
    if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K';
    return Number.isInteger(v) ? String(v) : v.toFixed(1);
  }
  function fmtRelTime(ms: number) {
    const s = ms / 1000;
    return s >= 60 ? (s / 60).toFixed(1) + 'm' : s.toFixed(0) + 's';
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
  let tooltipX = $state(0);
  let tooltipY = $state(0);
  let tooltipGranularity = $state<'detail' | 'broad'>('detail');

  function snapTime(t: number): number | null {
    if (!allTimes.length) return null;
    return allTimes.reduce((n, x) => Math.abs(x - t) < Math.abs(n - t) ? x : n);
  }

  function onMouseMove(e: MouseEvent) {
    if (!svgEl || !wrapperEl) return;
    const svgRect = svgEl.getBoundingClientRect();
    const wRect = wrapperEl.getBoundingClientRect();
    const vbX = ((e.clientX - svgRect.left) / svgRect.width) * W;
    const chartX = vbX - ML;
    if (chartX < 0 || chartX > IW) { hoveredTime = null; return; }
    hoveredTime = snapTime(tMin + (chartX / IW) * tRange);
    const wx = e.clientX - wRect.left;
    const wy = e.clientY - wRect.top;
    tooltipX = wx < wRect.width * 0.55 ? wx + 16 : wx - 224;
    tooltipY = Math.max(40, wy - 20);
  }

  const crosshairX = $derived(hoveredTime !== null ? tx(hoveredTime) : null);

  const tooltipRows = $derived.by(() => {
    if (hoveredTime === null) return [];
    if (rawRows.length > 0) {
      const atTime = rawRows.filter(r => r.t === hoveredTime);
      const total = atTime.reduce((s, r) => s + r.v, 0);
      if (tooltipGranularity === 'detail') {
        // When typeKey === eventKey (e.g. session state chart), just show typeKey
        return atTime
          .map(r => ({
            color: r.color,
            label: r.typeKey === r.eventKey ? r.typeKey : `${r.typeKey}:${r.eventKey}`,
            v: r.v,
            pct: total > 0 ? Math.round(r.v / total * 100) : 0
          }))
          .sort((a, b) => b.v - a.v);
      } else {
        // Broad: aggregate by type, use series color so it matches chart polygon
        const byType = new Map<string, { color: string; v: number }>();
        for (const r of atTime) {
          const seriesColor = seriesColorMap[r.typeKey] ?? r.color;
          const ex = byType.get(r.typeKey);
          if (ex) ex.v += r.v; else byType.set(r.typeKey, { color: seriesColor, v: r.v });
        }
        return [...byType.entries()]
          .map(([typeKey, { color, v }]) => ({ color, label: typeKey, v, pct: total > 0 ? Math.round(v / total * 100) : 0 }))
          .sort((a, b) => b.v - a.v);
      }
    } else {
      // Fallback: use series directly
      const total = series.reduce((s, sr) => s + (sr.points.find(p => p.t === hoveredTime)?.v ?? 0), 0);
      return series.map(sr => {
        const v = sr.points.find(p => p.t === hoveredTime)?.v ?? 0;
        return { color: sr.color, label: sr.label, v, pct: total > 0 ? Math.round(v / total * 100) : 0 };
      }).sort((a, b) => b.v - a.v);
    }
  });

  const hoveredTotal = $derived(tooltipRows.reduce((s, r) => s + r.v, 0));
</script>

<div class="chart-wrap" bind:this={wrapperEl}>
  <div class="chart-header">
    <span class="chart-title">{title}</span>
    <span class="chart-legend">
      {#each series as s}
        <span class="leg-item"><span class="leg-dot" style="background:{s.color}"></span>{s.label}</span>
      {/each}
    </span>
    {#if rawRows.length > 0 && showDetailToggle}
      <div class="gran-toggle">
        <button class:active={tooltipGranularity === 'detail'} onclick={() => tooltipGranularity = 'detail'}>Detail</button>
        <button class:active={tooltipGranularity === 'broad'} onclick={() => tooltipGranularity = 'broad'}>Broad</button>
      </div>
    {/if}
  </div>

  {#if !hasData}
    <div class="no-data">No data</div>
  {:else}
    <svg bind:this={svgEl} role="img" aria-label={title} width="100%" viewBox="0 0 {W} {H}" preserveAspectRatio="none"
         style="display:block;cursor:crosshair"
         onmousemove={onMouseMove} onmouseleave={() => hoveredTime = null}>
      <g transform="translate({ML},{MT})">
        <!-- Grid + Y axis -->
        {#each [0, 0.25, 0.5, 0.75, 1] as f}
          {@const yp = IH - f * IH}
          <line x1="0" y1={yp} x2={IW} y2={yp} stroke="#eee" stroke-width="1" />
          <text x="-6" y={yp} text-anchor="end" dominant-baseline="middle" font-size="10" fill="#999">{fmtVal(f * stacked.vMax)}</text>
        {/each}
        <line x1="0" y1="0" x2="0" y2={IH} stroke="#ddd" />
        <line x1="0" y1={IH} x2={IW} y2={IH} stroke="#ddd" />
        <!-- X axis labels -->
        {#each [0, 0.25, 0.5, 0.75, 1] as f}
          <text x={f * IW} y={IH + 14} text-anchor="middle" font-size="10" fill="#999">{fmtRelTime(f * tRange)}</text>
        {/each}
        <!-- Stacked polygons -->
        {#each series as s, i}
          {#if stacked.bottoms.length && stacked.tops.length}
            <polygon
              points={polyPts(stacked.tops[i], stacked.bottoms[i])}
              fill={s.color}
              fill-opacity={hoveredTime !== null ? 0.6 : 0.8}
              stroke={s.color}
              stroke-width="0.5"
            />
          {/if}
        {/each}
        <!-- Markers -->
        {#each markers as m}
          {@const xp = tx(m.t)}
          <line x1={xp} y1="0" x2={xp} y2={IH} stroke={m.color ?? '#aaa'} stroke-width="1" stroke-dasharray="4,3" />
          <text x={xp + 3} y="8" font-size="9" fill={m.color ?? '#999'}>{m.label}</text>
        {/each}
        <!-- Crosshair + dots -->
        {#if crosshairX !== null}
          <line x1={crosshairX} y1="0" x2={crosshairX} y2={IH}
                stroke="#555" stroke-width="1" stroke-dasharray="3,2" pointer-events="none" />
          {#if stacked.tops.length}
            {@const j = allTimes.indexOf(hoveredTime!)}
            {#if j >= 0}
              {#each series as s, i}
                <circle cx={crosshairX} cy={ty(stacked.tops[i][j])} r="3.5"
                        fill={s.color} stroke="#fff" stroke-width="1.5" pointer-events="none" />
              {/each}
            {/if}
          {/if}
        {/if}
      </g>
    </svg>

    <!-- Tooltip -->
    {#if hoveredTime !== null && tooltipRows.length > 0}
      <div class="tooltip" style="left:{tooltipX}px;top:{tooltipY}px">
        <div class="tt-time">{fmtTimestamp(hoveredTime)}</div>
        <div class="tt-total">Total: <strong>{hoveredTotal}</strong> active sessions</div>
        <div class="tt-divider"></div>
        {#each tooltipRows as row}
          <div class="tt-row" class:tt-zero={row.v === 0}>
            <span class="tt-dot" style="background:{row.color}"></span>
            <span class="tt-label">{row.label}</span>
            <span class="tt-nums">
              <span class="tt-val">{row.v}</span>
              <span class="tt-pct">{row.pct}%</span>
            </span>
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
  .leg-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
  .no-data { font-size: 12px; color: #aaa; padding: 20px 0; text-align: center; }

  .gran-toggle { display: flex; border: 1px solid #e0e0e0; border-radius: 4px; overflow: hidden; margin-left: auto; flex-shrink: 0; }
  .gran-toggle button { background: none; border: none; padding: 2px 9px; font-size: 11px; cursor: pointer; color: #666; }
  .gran-toggle button:hover { background: #f5f5f5; }
  .gran-toggle button.active { background: #0066cc; color: #fff; }

  .tooltip {
    position: absolute; z-index: 20; pointer-events: none;
    background: #1e1f2e; color: #e0e0e0;
    border: 1px solid #3a3b50; border-radius: 7px;
    padding: 9px 11px; font-size: 11px;
    min-width: 170px; max-width: 250px;
    box-shadow: 0 6px 20px rgba(0,0,0,0.35);
  }
  .tt-time { font-size: 11px; font-weight: 600; color: #9ca3af; white-space: nowrap; }
  .tt-total { font-size: 10px; color: #6b7280; margin: 2px 0 4px; }
  .tt-total strong { color: #e0e0e0; }
  .tt-divider { height: 1px; background: #3a3b50; margin-bottom: 5px; }
  .tt-row { display: flex; align-items: center; gap: 5px; padding: 1.5px 0; }
  .tt-row.tt-zero { opacity: 0.35; }
  .tt-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
  .tt-label { font-size: 11px; flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .tt-nums { display: flex; gap: 6px; align-items: baseline; flex-shrink: 0; }
  .tt-val { font-size: 11px; font-variant-numeric: tabular-nums; min-width: 18px; text-align: right; }
  .tt-pct { font-size: 10px; color: #9ca3af; font-variant-numeric: tabular-nums; min-width: 30px; text-align: right; }
</style>
