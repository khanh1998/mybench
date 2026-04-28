<script lang="ts">
  interface ChartSeries { label: string; color: string; points: { t: number; v: number }[]; }

  let {
    series,
    title,
  }: {
    series: ChartSeries[];
    title: string;
  } = $props();

  const ML = 60, MR = 16, MT = 8, MB = 40;
  const W = 520, H = 190;
  const IW = W - ML - MR;
  const IH = H - MT - MB;

  interface BarStat { label: string; color: string; mean: number; min: number; max: number; }

  const bars = $derived.by((): BarStat[] => {
    return series
      .map((s) => {
        if (!s.points.length) return null;
        const vals = s.points.map((p) => p.v);
        const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
        const min = Math.min(...vals);
        const max = Math.max(...vals);
        return { label: s.label, color: s.color, mean, min, max };
      })
      .filter((b): b is BarStat => b !== null);
  });

  const vMax = $derived(bars.length ? Math.max(...bars.map((b) => b.max)) : 1);
  const vRange = $derived(vMax || 1);

  function by(v: number) { return IH - (v / vRange) * IH; }

  function fmtVal(v: number) {
    if (Math.abs(v) >= 1e9) return (v / 1e9).toFixed(1) + 'G';
    if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(1) + 'M';
    if (Math.abs(v) >= 1e3) return (v / 1e3).toFixed(1) + 'K';
    return Number.isInteger(v) ? String(v) : v.toFixed(2);
  }

  function truncLabel(s: string, maxChars: number): string {
    return s.length > maxChars ? s.slice(0, maxChars - 1) + '…' : s;
  }

  const barWidth = $derived(bars.length ? Math.min(48, Math.max(14, (IW - (bars.length - 1) * 8) / bars.length)) : 48);
  const totalBarsWidth = $derived(bars.length * barWidth + Math.max(0, bars.length - 1) * 8);
  const barsStartX = $derived((IW - totalBarsWidth) / 2);

  function barX(i: number) { return barsStartX + i * (barWidth + 8); }

  let hoveredIdx = $state<number | null>(null);
</script>

<div class="chart-wrap">
  <div class="chart-header">
    <span class="chart-title">{title}</span>
  </div>

  {#if bars.length === 0}
    <div class="no-data">No data</div>
  {:else}
    <svg role="img" aria-label={title} width="100%" viewBox="0 0 {W} {H}" preserveAspectRatio="none" style="display:block">
      <g transform="translate({ML},{MT})">
        <!-- Grid + Y axis -->
        {#each [0, 0.25, 0.5, 0.75, 1] as f}
          {@const yp = IH - f * IH}
          {@const val = f * vRange}
          <line x1="0" y1={yp} x2={IW} y2={yp} stroke="#eee" stroke-width="1" />
          <text x="-6" y={yp} text-anchor="end" dominant-baseline="middle" font-size="10" fill="#999">{fmtVal(val)}</text>
        {/each}
        <line x1="0" y1="0" x2="0" y2={IH} stroke="#ddd" />
        <line x1="0" y1={IH} x2={IW} y2={IH} stroke="#ddd" />

        <!-- Bars -->
        {#each bars as bar, i}
          {@const x = barX(i)}
          {@const meanY = by(bar.mean)}
          {@const minY = by(bar.min)}
          {@const maxY = by(bar.max)}
          {@const isHovered = hoveredIdx === i}
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <g
            onmouseenter={() => { hoveredIdx = i; }}
            onmouseleave={() => { hoveredIdx = null; }}
          >
            <!-- Bar body -->
            <rect
              x={x}
              y={meanY}
              width={barWidth}
              height={IH - meanY}
              fill={bar.color}
              opacity={hoveredIdx !== null && !isHovered ? 0.35 : 0.85}
              rx="3"
            />
            <!-- Min-max error bar -->
            {#if bar.max > bar.min}
              {@const cx = x + barWidth / 2}
              <line x1={cx} y1={maxY} x2={cx} y2={minY} stroke={bar.color} stroke-width="1.5" opacity="0.7" />
              <line x1={cx - 4} y1={maxY} x2={cx + 4} y2={maxY} stroke={bar.color} stroke-width="1.5" opacity="0.7" />
              <line x1={cx - 4} y1={minY} x2={cx + 4} y2={minY} stroke={bar.color} stroke-width="1.5" opacity="0.7" />
            {/if}
            <!-- Mean label on hover -->
            {#if isHovered}
              <text
                x={x + barWidth / 2}
                y={meanY - 5}
                text-anchor="middle"
                font-size="10"
                font-weight="700"
                fill={bar.color}
              >{fmtVal(bar.mean)}</text>
            {/if}
          </g>
          <!-- X axis label -->
          <text
            x={x + barWidth / 2}
            y={IH + 14}
            text-anchor="middle"
            font-size="9"
            fill={isHovered ? '#333' : '#888'}
            font-weight={isHovered ? '700' : '400'}
          >{truncLabel(bar.label, barWidth > 36 ? 10 : 6)}</text>
        {/each}
      </g>
    </svg>

    <!-- Hover tooltip -->
    {#if hoveredIdx !== null}
      {@const bar = bars[hoveredIdx]}
      <div class="tooltip">
        <div class="tt-label">{bar.label}</div>
        <div class="tt-row"><span class="tt-key">Avg</span><span class="tt-val">{fmtVal(bar.mean)}</span></div>
        <div class="tt-row"><span class="tt-key">Max</span><span class="tt-val">{fmtVal(bar.max)}</span></div>
        <div class="tt-row"><span class="tt-key">Min</span><span class="tt-val">{fmtVal(bar.min)}</span></div>
      </div>
    {/if}
  {/if}
</div>

<style>
  .chart-wrap { border: 1px solid #e8e8e8; border-radius: 6px; padding: 10px 12px; background: #fff; position: relative; }
  .chart-header { display: flex; align-items: baseline; gap: 12px; margin-bottom: 6px; }
  .chart-title { font-size: 12px; font-weight: 700; color: #333; font-family: monospace; }
  .no-data { font-size: 12px; color: #aaa; padding: 20px 0; text-align: center; }

  .tooltip {
    position: absolute;
    top: 10px; right: 12px;
    z-index: 20; pointer-events: none;
    background: #1e1f2e; color: #e0e0e0;
    border: 1px solid #3a3b50; border-radius: 7px;
    padding: 8px 10px; font-size: 11px;
    min-width: 110px;
    box-shadow: 0 6px 20px rgba(0,0,0,0.35);
  }
  .tt-label { font-weight: 700; color: #fff; margin-bottom: 5px; }
  .tt-row { display: flex; justify-content: space-between; gap: 10px; padding: 1px 0; }
  .tt-key { color: #9ca3af; }
  .tt-val { font-variant-numeric: tabular-nums; }
</style>
