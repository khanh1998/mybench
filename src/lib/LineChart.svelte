<script lang="ts">
  interface ChartPoint { t: number; v: number; }
  interface ChartSeries { label: string; color: string; points: ChartPoint[]; }

  interface Marker { t: number; label: string; color?: string; }
  let { series, title, markers = [] }: { series: ChartSeries[]; title: string; markers?: Marker[] } = $props();

  const ML = 60, MR = 20, MT = 8, MB = 28;
  const W = 520, H = 190;
  const IW = W - ML - MR;
  const IH = H - MT - MB;

  const allPts = $derived(series.flatMap(s => s.points));
  const markerTs = $derived(markers.map(m => m.t).filter(t => !isNaN(t)));
  const tMin = $derived(allPts.length ? Math.min(...allPts.map(p => p.t), ...markerTs) : 0);
  const tMax = $derived(allPts.length ? Math.max(...allPts.map(p => p.t), ...markerTs) : 1);
  const vMin = $derived(allPts.length ? Math.min(...allPts.map(p => p.v)) : 0);
  const vMax = $derived(allPts.length ? Math.max(...allPts.map(p => p.v)) : 1);
  const tRange = $derived(tMax - tMin || 1);
  const vRange = $derived(vMax - vMin || 1);

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
  {#if allPts.length === 0}
    <div class="no-data">No data</div>
  {:else}
    <svg width="100%" viewBox="0 0 {W} {H}" preserveAspectRatio="none" style="display:block">
      <g transform="translate({ML},{MT})">
        <!-- grid + y axis labels -->
        {#each [0, 0.25, 0.5, 0.75, 1] as f}
          {@const yp = IH - f * IH}
          {@const val = vMin + f * vRange}
          <line x1="0" y1={yp} x2={IW} y2={yp} stroke="#eee" stroke-width="1" />
          <text x="-6" y={yp} text-anchor="end" dominant-baseline="middle" font-size="10" fill="#999">{fmtVal(val)}</text>
        {/each}
        <!-- y axis line -->
        <line x1="0" y1="0" x2="0" y2={IH} stroke="#ddd" />
        <!-- x axis line + labels -->
        <line x1="0" y1={IH} x2={IW} y2={IH} stroke="#ddd" />
        {#each [0, 0.25, 0.5, 0.75, 1] as f}
          {@const xp = f * IW}
          {@const relMs = f * tRange}
          <text x={xp} y={IH + 14} text-anchor="middle" font-size="10" fill="#999">{fmtTime(relMs)}</text>
        {/each}
        <!-- markers -->
        {#each markers as m}
          {@const xp = tx(m.t)}
          <line x1={xp} y1="0" x2={xp} y2={IH} stroke={m.color ?? '#aaa'} stroke-width="1" stroke-dasharray="4,3" />
          <text x={xp + 3} y="8" font-size="9" fill={m.color ?? '#999'}>{m.label}</text>
        {/each}
        <!-- series -->
        {#each series as s}
          {#if s.points.length > 1}
            <polyline points={pts(s.points)} fill="none" stroke={s.color} stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
          {/if}
          {#each s.points as p}
            <circle cx={tx(p.t)} cy={ty(p.v)} r="2.5" fill={s.color} />
          {/each}
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
