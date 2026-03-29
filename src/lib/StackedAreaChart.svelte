<script lang="ts">
  interface ChartSeries { label: string; color: string; points: { t: number; v: number }[]; }
  interface Marker { t: number; label: string; color?: string; }
  let { series, title, markers = [] }: { series: ChartSeries[]; title: string; markers?: Marker[] } = $props();

  const ML = 60, MR = 20, MT = 8, MB = 28;
  const W = 520, H = 190;
  const IW = W - ML - MR;
  const IH = H - MT - MB;

  // Collect all unique timestamps across all series, sorted
  const allTimes = $derived.by(() => {
    const timeSet = new Set<number>();
    for (const s of series) for (const p of s.points) timeSet.add(p.t);
    const markerTs = markers.map(m => m.t).filter(t => !isNaN(t));
    for (const t of markerTs) timeSet.add(t);
    return [...timeSet].sort((a, b) => a - b);
  });

  const tMin = $derived(allTimes.length ? allTimes[0] : 0);
  const tMax = $derived(allTimes.length ? allTimes[allTimes.length - 1] : 1);
  const tRange = $derived(tMax - tMin || 1);

  // Compute stacked layers: bottom[i][j] and top[i][j] for series i at allTimes[j]
  const stacked = $derived.by(() => {
    if (series.length === 0 || allTimes.length === 0) return { bottoms: [] as number[][], tops: [] as number[][], vMax: 1 };

    const valueMaps = series.map(s => new Map(s.points.map(p => [p.t, p.v])));
    const n = allTimes.length;
    const bottoms: number[][] = [];
    const tops: number[][] = [];
    const running = new Array<number>(n).fill(0);

    for (let i = 0; i < series.length; i++) {
      bottoms.push([...running]);
      for (let j = 0; j < n; j++) {
        running[j] += valueMaps[i].get(allTimes[j]) ?? 0;
      }
      tops.push([...running]);
    }

    const vMax = Math.max(...running, 1);
    return { bottoms, tops, vMax };
  });

  const hasData = $derived(series.some(s => s.points.length > 0));

  function tx(t: number) { return ((t - tMin) / tRange) * IW; }
  function ty(v: number) { return IH - (v / stacked.vMax) * IH; }

  function polygonPoints(topArr: number[], bottomArr: number[]): string {
    const fwd = allTimes.map((t, j) => `${tx(t).toFixed(1)},${ty(topArr[j]).toFixed(1)}`);
    const rev = allTimes.map((t, j) => `${tx(t).toFixed(1)},${ty(bottomArr[j]).toFixed(1)}`).reverse();
    return [...fwd, ...rev].join(' ');
  }

  function fmtVal(v: number) {
    if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(1) + 'M';
    if (Math.abs(v) >= 1e3) return (v / 1e3).toFixed(1) + 'K';
    return Number.isInteger(v) ? String(v) : v.toFixed(1);
  }
  function fmtTime(ms: number) {
    const s = ms / 1000;
    if (s >= 60) return (s / 60).toFixed(1) + 'm';
    return s.toFixed(0) + 's';
  }
</script>

<div class="chart-wrap">
  <div class="chart-header">
    <span class="chart-title">{title}</span>
    <span class="chart-legend">
      {#each series as s}
        <span class="leg-item">
          <span class="leg-dot" style="background:{s.color}"></span>
          {s.label}
        </span>
      {/each}
    </span>
  </div>
  {#if !hasData}
    <div class="no-data">No data</div>
  {:else}
    <svg width="100%" viewBox="0 0 {W} {H}" preserveAspectRatio="none" style="display:block">
      <g transform="translate({ML},{MT})">
        <!-- grid + y axis labels -->
        {#each [0, 0.25, 0.5, 0.75, 1] as f}
          {@const yp = IH - f * IH}
          {@const val = f * stacked.vMax}
          <line x1="0" y1={yp} x2={IW} y2={yp} stroke="#eee" stroke-width="1" />
          <text x="-6" y={yp} text-anchor="end" dominant-baseline="middle" font-size="10" fill="#999">{fmtVal(val)}</text>
        {/each}
        <!-- axes -->
        <line x1="0" y1="0" x2="0" y2={IH} stroke="#ddd" />
        <line x1="0" y1={IH} x2={IW} y2={IH} stroke="#ddd" />
        <!-- x axis labels -->
        {#each [0, 0.25, 0.5, 0.75, 1] as f}
          {@const xp = f * IW}
          {@const relMs = f * tRange}
          <text x={xp} y={IH + 14} text-anchor="middle" font-size="10" fill="#999">{fmtTime(relMs)}</text>
        {/each}
        <!-- stacked area layers (bottom to top render order) -->
        {#each series as s, i}
          {#if stacked.bottoms && stacked.tops}
            <polygon
              points={polygonPoints(stacked.tops[i], stacked.bottoms[i])}
              fill={s.color}
              fill-opacity="0.8"
              stroke={s.color}
              stroke-width="0.5"
            />
          {/if}
        {/each}
        <!-- markers -->
        {#each markers as m}
          {@const xp = tx(m.t)}
          <line x1={xp} y1="0" x2={xp} y2={IH} stroke={m.color ?? '#aaa'} stroke-width="1" stroke-dasharray="4,3" />
          <text x={xp + 3} y="8" font-size="9" fill={m.color ?? '#999'}>{m.label}</text>
        {/each}
      </g>
    </svg>
  {/if}
</div>

<style>
  .chart-wrap { border: 1px solid #e8e8e8; border-radius: 6px; padding: 10px 12px; background: #fff; }
  .chart-header { display: flex; align-items: baseline; gap: 12px; margin-bottom: 6px; flex-wrap: wrap; }
  .chart-title { font-size: 12px; font-weight: 700; color: #333; font-family: monospace; }
  .chart-legend { display: flex; gap: 10px; flex-wrap: wrap; }
  .leg-item { display: flex; align-items: center; gap: 4px; font-size: 11px; color: #555; }
  .leg-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
  .no-data { font-size: 12px; color: #aaa; padding: 20px 0; text-align: center; }
</style>
