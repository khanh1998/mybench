<script lang="ts">
  interface ChartSeries { label: string; color: string; points: { t: number; v: number }[]; }
  interface Marker { t: number; label: string; color?: string; }
  interface ReferenceLine { value: number; label: string; color?: string; }
  interface RawRow { t: number; typeKey: string; eventKey: string; color: string; v: number; }
  interface LegendItem { label: string; color: string; }

  let {
    series,
    rawRows = [],
    title,
    markers = [],
    referenceLines = [],
    originMs = null,
    showDetailToggle = true,
    granularity = undefined,
    valueLabel = 'active sessions',
    hiddenLabels = [],
    onToggleLabel = null,
  }: {
    series: ChartSeries[];
    rawRows?: RawRow[];
    title: string;
    markers?: Marker[];
    referenceLines?: ReferenceLine[];
    originMs?: number | null;
    showDetailToggle?: boolean;
    granularity?: 'detail' | 'broad';
    valueLabel?: string;
    hiddenLabels?: string[];
    onToggleLabel?: ((label: string) => void) | null;
  } = $props();

  // Map typeKey → series color so broad-mode tooltip matches chart polygons
  const seriesColorMap = $derived(
    Object.fromEntries(series.map(s => [s.label, s.color]))
  );

  // Declared early so detailSeries / activeSeries can reference it
  let tooltipGranularity = $state<'detail' | 'broad'>('detail');

  // When granularity is controlled externally, use it; otherwise use internal state
  const effectiveGranularity = $derived(granularity ?? tooltipGranularity);

  // Per-event series derived from rawRows (used in detail mode)
  const detailSeries = $derived.by((): ChartSeries[] => {
    if (!rawRows.length) return series;
    const map = new Map<string, { label: string; color: string; pts: Map<number, number> }>();
    for (const r of rawRows) {
      const key = r.typeKey === r.eventKey ? r.typeKey : `${r.typeKey}:${r.eventKey}`;
      if (!map.has(key)) map.set(key, { label: key, color: r.color, pts: new Map() });
      const entry = map.get(key)!;
      entry.pts.set(r.t, (entry.pts.get(r.t) ?? 0) + r.v);
    }
    return [...map.values()].map(v => ({
      label: v.label, color: v.color,
      points: [...v.pts.entries()].map(([t, v]) => ({ t, v }))
    }));
  });

  // Which series to render: detail mode uses per-event series, broad mode uses aggregated series
  const activeSeries = $derived(
    effectiveGranularity === 'detail' && rawRows.length > 0 ? detailSeries : series
  );
  const legendItems = $derived.by((): LegendItem[] => {
    const seen = new Set<string>();
    const items: LegendItem[] = [];
    for (const s of activeSeries) {
      if (seen.has(s.label)) continue;
      seen.add(s.label);
      items.push({ label: s.label, color: s.color });
    }
    return items;
  });
  function isLabelVisible(label: string) {
    return !hiddenLabels.includes(label);
  }
  function rawRowLabel(row: RawRow) {
    return row.typeKey === row.eventKey ? row.typeKey : `${row.typeKey}:${row.eventKey}`;
  }
  const visibleSeries = $derived(activeSeries.filter(s => isLabelVisible(s.label)));

  const ML = 60, MR = 20, MT = 8, MB = 28;
  const W = 520, H = 190;
  const IW = W - ML - MR;
  const IH = H - MT - MB;

  const allTimes = $derived.by(() => {
    const s = new Set<number>();
    for (const sr of visibleSeries) for (const p of sr.points) s.add(p.t);
    for (const m of markers) if (!isNaN(m.t)) s.add(m.t);
    return [...s].sort((a, b) => a - b);
  });

  const tMin = $derived(allTimes.length ? allTimes[0] : 0);
  const tMax = $derived(allTimes.length ? allTimes[allTimes.length - 1] : 1);
  const tRange = $derived(tMax - tMin || 1);

  const stacked = $derived.by(() => {
    if (!visibleSeries.length || !allTimes.length) return { bottoms: [] as number[][], tops: [] as number[][], vMax: 1 };
    const maps = visibleSeries.map(s => new Map(s.points.map(p => [p.t, p.v])));
    const n = allTimes.length;
    const bottoms: number[][] = [], tops: number[][] = [];
    const run = new Array<number>(n).fill(0);
    for (let i = 0; i < visibleSeries.length; i++) {
      bottoms.push([...run]);
      for (let j = 0; j < n; j++) run[j] += maps[i].get(allTimes[j]) ?? 0;
      tops.push([...run]);
    }
    const lineMax = Math.max(...referenceLines.map((line) => line.value).filter((value) => Number.isFinite(value) && value > 0), 1);
    return { bottoms, tops, vMax: Math.max(...run, lineMax, 1) };
  });

  const hasData = $derived(visibleSeries.some(s => s.points.length > 0));

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
      const atTime = rawRows.filter(r => r.t === hoveredTime && isLabelVisible(rawRowLabel(r)));
      const total = atTime.reduce((s, r) => s + r.v, 0);
      if (effectiveGranularity === 'detail') {
        // When typeKey === eventKey (e.g. session state chart), just show typeKey
        return atTime
          .map(r => ({
            color: r.color,
            label: rawRowLabel(r),
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
      // Fallback: use visibleSeries directly
      const total = visibleSeries.reduce((s, sr) => s + (sr.points.find(p => p.t === hoveredTime)?.v ?? 0), 0);
      return visibleSeries.map(sr => {
        const v = sr.points.find(p => p.t === hoveredTime)?.v ?? 0;
        return { color: sr.color, label: sr.label, v, pct: total > 0 ? Math.round(v / total * 100) : 0 };
      }).sort((a, b) => b.v - a.v);
    }
  });

  const hoveredTotal = $derived(tooltipRows.reduce((s, r) => s + r.v, 0));

  let headerCopied = $state<'json' | 'markdown' | null>(null);
  let headerCopyTimer: ReturnType<typeof setTimeout> | null = null;

  function markHeaderCopied(kind: 'json' | 'markdown') {
    headerCopied = kind;
    if (headerCopyTimer) clearTimeout(headerCopyTimer);
    headerCopyTimer = setTimeout(() => { headerCopied = null; }, 1600);
  }

  function markdownCell(value: string | number | null): string {
    if (value === null) return '';
    if (typeof value === 'number') return Number.isFinite(value) ? String(+value.toFixed(4)) : '';
    return value.replace(/\|/g, '\\|').replace(/\n/g, '<br>');
  }

  function markdownTable(headers: string[], rows: (string | number | null)[][]): string {
    return [
      `| ${headers.map(markdownCell).join(' | ')} |`,
      `| ${headers.map(() => '---').join(' | ')} |`,
      ...rows.map((row) => `| ${row.map(markdownCell).join(' | ')} |`)
    ].join('\n');
  }

  function colorToRgba(color: string, alpha: number): string {
    if (color.startsWith('#')) {
      const r = parseInt(color.slice(1, 3), 16);
      const g = parseInt(color.slice(3, 5), 16);
      const b = parseInt(color.slice(5, 7), 16);
      return `rgba(${r},${g},${b},${alpha})`;
    }
    const hsl = color.match(/hsl\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%/);
    if (hsl) {
      const h = +hsl[1], s = +hsl[2] / 100, l = +hsl[3] / 100;
      const c = (1 - Math.abs(2 * l - 1)) * s;
      const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
      const m = l - c / 2;
      const seg = h < 60 ? [c,x,0] : h < 120 ? [x,c,0] : h < 180 ? [0,c,x] : h < 240 ? [0,x,c] : h < 300 ? [x,0,c] : [c,0,x];
      const [r, g, b] = seg.map(v => Math.round((v + m) * 255));
      return `rgba(${r},${g},${b},${alpha})`;
    }
    return color;
  }

  function copyChartJson() {
    const times = allTimes;
    const config = {
      type: 'line',
      data: {
        labels: times.map(t => +(t / 1000).toFixed(1)),
        datasets: visibleSeries.map((s, i) => ({
          label: s.label,
          data: times.map((_, j) => {
            const v = (stacked.tops[i]?.[j] ?? 0) - (stacked.bottoms[i]?.[j] ?? 0);
            return +v.toFixed(4);
          }),
          backgroundColor: colorToRgba(s.color, 0.7),
          borderColor: colorToRgba(s.color, 1),
          fill: true,
          tension: 0.2,
          pointRadius: 0,
        }))
      },
      options: {
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: { title: { display: true, text: 'time (s)' } },
          y: { stacked: true }
        }
      }
    };
    navigator.clipboard.writeText(JSON.stringify(config, null, 2));
    markHeaderCopied('json');
  }

  function copyMarkdownTable() {
    const rows = allTimes.map((time, j) => [
      +(time / 1000).toFixed(1),
      ...visibleSeries.map((_, i) => (stacked.tops[i]?.[j] ?? 0) - (stacked.bottoms[i]?.[j] ?? 0))
    ]);
    navigator.clipboard.writeText(markdownTable(['time_s', ...visibleSeries.map((s) => s.label)], rows));
    markHeaderCopied('markdown');
  }
</script>

<div class="chart-wrap" bind:this={wrapperEl}>
  <div class="chart-header">
    <span class="chart-title">{title}</span>
    <span class="chart-legend">
      {#each legendItems as s}
        {#if onToggleLabel}
          <button
            type="button"
            class="leg-item leg-button"
            class:leg-off={!isLabelVisible(s.label)}
            aria-pressed={isLabelVisible(s.label)}
            onclick={() => onToggleLabel?.(s.label)}
          >
            <span class="leg-dot" style="background:{s.color}"></span>{s.label}
          </button>
        {:else}
          <span class="leg-item"><span class="leg-dot" style="background:{s.color}"></span>{s.label}</span>
        {/if}
      {/each}
    </span>
    <div class="header-right">
      {#if rawRows.length > 0 && showDetailToggle && granularity === undefined}
        <div class="gran-toggle">
          <button class:active={tooltipGranularity === 'detail'} onclick={() => tooltipGranularity = 'detail'}>Detail</button>
          <button class:active={tooltipGranularity === 'broad'} onclick={() => tooltipGranularity = 'broad'}>Broad</button>
        </div>
      {/if}
      <div class="copy-group" aria-label="Copy chart data">
        <button type="button" class="copy-btn" class:copied={headerCopied === 'json'} title="Copy as Chart.js JSON" onclick={copyChartJson}>
          {#if headerCopied === 'json'}
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 0 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0z"/></svg>
          {:else}
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Z"/><path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z"/></svg>
          {/if}
          JSON
        </button>
        <button type="button" class="copy-btn" class:copied={headerCopied === 'markdown'} title="Copy as Markdown table" onclick={copyMarkdownTable}>MD</button>
      </div>
    </div>
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
        {#each visibleSeries as s, i}
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
        <!-- Reference lines -->
        {#each referenceLines as line}
          {#if Number.isFinite(line.value) && line.value >= 0}
            {@const yp = ty(line.value)}
            <line x1="0" y1={yp} x2={IW} y2={yp} stroke={line.color ?? '#111827'} stroke-width="1.2" stroke-dasharray="6,4" />
            <text x={IW - 4} y={Math.max(9, yp - 4)} text-anchor="end" font-size="9" fill={line.color ?? '#111827'}>{line.label}</text>
          {/if}
        {/each}
        <!-- Crosshair + dots -->
        {#if crosshairX !== null}
          <line x1={crosshairX} y1="0" x2={crosshairX} y2={IH}
                stroke="#555" stroke-width="1" stroke-dasharray="3,2" pointer-events="none" />
          {#if stacked.tops.length}
            {@const j = allTimes.indexOf(hoveredTime!)}
            {#if j >= 0}
              {#each visibleSeries as s, i}
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
        <div class="tt-total">Total: <strong>{hoveredTotal}</strong> {valueLabel}</div>
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
  .leg-button { border: none; background: transparent; padding: 0; cursor: pointer; font: inherit; }
  .leg-button:hover { color: #111; }
  .leg-button.leg-off { color: #aaa; text-decoration: line-through; }
  .leg-button.leg-off .leg-dot { opacity: 0.28; }
  .leg-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
  .no-data { font-size: 12px; color: #aaa; padding: 20px 0; text-align: center; }

  .header-right { display: flex; align-items: center; gap: 6px; margin-left: auto; flex-shrink: 0; }
  .gran-toggle { display: flex; border: 1px solid #e0e0e0; border-radius: 4px; overflow: hidden; }
  .copy-group { display: inline-flex; flex-shrink: 0; }
  .copy-btn {
    display: inline-flex; align-items: center; gap: 4px;
    font-size: 11px; color: #888;
    background: none; border: 1px solid #e3e3e3;
    padding: 2px 7px; cursor: pointer; line-height: 1.4; min-height: 22px; flex-shrink: 0;
  }
  .copy-btn:first-child { border-radius: 4px 0 0 4px; }
  .copy-btn:last-child { border-left: 0; border-radius: 0 4px 4px 0; }
  .copy-btn:hover { color: #333; border-color: #bbb; background: #f7f7f7; }
  .copy-btn.copied { color: #16a34a; border-color: #86efac; background: #f0fdf4; }
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
