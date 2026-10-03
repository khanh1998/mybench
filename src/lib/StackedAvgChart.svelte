<script lang="ts">
  import { formatCompact as fmtVal } from '$lib/telemetry/format';
  import type { StackBar } from '$lib/telemetry/stack';
  import { markdownTable } from '$lib/utils';

  let {
    title,
    stacks,
  }: {
    title: string;
    stacks: StackBar[];
  } = $props();

  const ML = 60, MR = 16, MT = 16, MB = 40;
  const W = 520, H = 210;
  const IW = W - ML - MR;
  const IH = H - MT - MB;

  let normalize = $state(false);
  let hovered = $state<{ stack: number; segment: number } | null>(null);

  const totals = $derived(stacks.map((stack) => stack.segments.reduce((sum, seg) => sum + seg.mean, 0)));
  const vRange = $derived(normalize ? 100 : (Math.max(0, ...totals) || 1));
  const legend = $derived.by(() => {
    const seen = new Map<string, string>();
    for (const stack of stacks) for (const seg of stack.segments) if (!seen.has(seg.label)) seen.set(seg.label, seg.color);
    return [...seen].map(([label, color]) => ({ label, color }));
  });

  function share(stackIdx: number, value: number): number {
    return totals[stackIdx] > 0 ? (value / totals[stackIdx]) * 100 : 0;
  }
  function shown(stackIdx: number, value: number): number {
    return normalize ? share(stackIdx, value) : value;
  }
  function fmtShown(v: number) {
    return normalize ? `${v.toFixed(1)}%` : fmtVal(v);
  }
  function segmentOf(stack: StackBar, label: string) {
    return stack.segments.find((seg) => seg.label === label) ?? null;
  }
  function truncLabel(s: string, maxChars: number): string {
    return s.length > maxChars ? s.slice(0, maxChars - 1) + '…' : s;
  }

  const GAP = 16;
  const barWidth = $derived(stacks.length ? Math.min(96, Math.max(24, (IW - (stacks.length - 1) * GAP) / stacks.length)) : 96);
  const barsStartX = $derived((IW - (stacks.length * barWidth + Math.max(0, stacks.length - 1) * GAP)) / 2);
  function barX(i: number) { return barsStartX + i * (barWidth + GAP); }

  // Segment rectangles, stacked bottom-up in the order given.
  const rects = $derived(stacks.map((stack, si) => {
    let acc = 0;
    return stack.segments.map((seg, gi) => {
      const v = shown(si, seg.mean);
      const h = (v / vRange) * IH;
      const y = IH - ((acc + v) / vRange) * IH;
      acc += v;
      return { si, gi, seg, y, h };
    });
  }));

  let copied = $state<'json' | 'markdown' | null>(null);
  let copyTimer: ReturnType<typeof setTimeout> | null = null;
  function markCopied(kind: 'json' | 'markdown') {
    copied = kind;
    if (copyTimer) clearTimeout(copyTimer);
    copyTimer = setTimeout(() => { copied = null; }, 1600);
  }

  function copyChartJson() {
    const config = {
      type: 'bar',
      data: {
        labels: stacks.map((stack) => stack.label),
        datasets: legend.map(({ label, color }) => ({
          label,
          data: stacks.map((stack, si) => {
            const seg = segmentOf(stack, label);
            return seg ? +shown(si, seg.mean).toFixed(4) : 0;
          }),
          backgroundColor: color,
          stack: 'avg'
        }))
      },
      options: {
        scales: { x: { stacked: true }, y: { stacked: true, ...(normalize ? { max: 100 } : {}) } },
        plugins: { title: { display: true, text: title } }
      }
    };
    navigator.clipboard.writeText(JSON.stringify(config, null, 2));
    markCopied('json');
  }

  function copyMarkdownTable() {
    const headers: string[] = ['series', ...stacks.flatMap((stack): string[] => stacks.length > 1 ? [`${stack.label} avg`, `${stack.label} %`] : ['avg', '%'])];
    const rows: (string | number)[][] = legend.map(({ label }) => [
      label,
      ...stacks.flatMap((stack, si): (string | number)[] => {
        const seg = segmentOf(stack, label);
        return seg ? [seg.mean, +share(si, seg.mean).toFixed(2)] : ['', ''];
      })
    ]);
    rows.push(['total', ...stacks.flatMap((_, si) => [totals[si], 100])]);
    navigator.clipboard.writeText(markdownTable(headers, rows, title));
    markCopied('markdown');
  }

  const hoveredInfo = $derived.by(() => {
    if (!hovered) return null;
    const seg = stacks[hovered.stack]?.segments[hovered.segment];
    if (!seg) return null;
    return { stack: stacks[hovered.stack].label, seg, pct: share(hovered.stack, seg.mean), total: totals[hovered.stack] };
  });
</script>

<div class="chart-wrap">
  <div class="chart-header">
    <span class="chart-title">{title}</span>
    <div class="header-actions">
      <label class="norm-toggle" title="Show each stack as a share of its own total">
        <input type="checkbox" bind:checked={normalize} /> 100%
      </label>
      <div class="copy-group" aria-label="Copy chart data">
        <button type="button" class="copy-btn" class:copied={copied === 'json'} title="Copy as Chart.js JSON" onclick={copyChartJson}>JSON</button>
        <button type="button" class="copy-btn" class:copied={copied === 'markdown'} title="Copy as Markdown table" onclick={copyMarkdownTable}>MD</button>
      </div>
    </div>
  </div>

  {#if stacks.length === 0 || legend.length === 0}
    <div class="no-data">No data</div>
  {:else}
    <svg role="img" aria-label={title} width="100%" viewBox="0 0 {W} {H}" preserveAspectRatio="none" style="display:block">
      <g transform="translate({ML},{MT})">
        {#each [0, 0.25, 0.5, 0.75, 1] as f}
          {@const yp = IH - f * IH}
          <line x1="0" y1={yp} x2={IW} y2={yp} stroke="#eee" stroke-width="1" />
          <text x="-6" y={yp} text-anchor="end" dominant-baseline="middle" font-size="10" fill="#999">{fmtShown(f * vRange)}</text>
        {/each}
        <line x1="0" y1="0" x2="0" y2={IH} stroke="#ddd" />
        <line x1="0" y1={IH} x2={IW} y2={IH} stroke="#ddd" />

        {#each stacks as stack, si}
          {@const x = barX(si)}
          {#each rects[si] as r}
            {#if r.h > 0}
              <!-- svelte-ignore a11y_no_static_element_interactions -->
              <rect
                x={x}
                y={r.y}
                width={barWidth}
                height={r.h}
                fill={r.seg.color}
                stroke="#fff"
                stroke-width="0.75"
                opacity={hovered && !(hovered.stack === r.si && hovered.segment === r.gi) ? 0.4 : 0.9}
                onmouseenter={() => { hovered = { stack: r.si, segment: r.gi }; }}
                onmouseleave={() => { hovered = null; }}
              />
              {#if r.h >= 13 && barWidth >= 40}
                <text x={x + barWidth / 2} y={r.y + r.h / 2} text-anchor="middle" dominant-baseline="middle" font-size="9" fill="#fff" pointer-events="none">
                  {normalize ? `${shown(si, r.seg.mean).toFixed(0)}%` : fmtVal(r.seg.mean)}
                </text>
              {/if}
            {/if}
          {/each}
          <text x={x + barWidth / 2} y={IH - (normalize ? IH : (totals[si] / vRange) * IH) - 4} text-anchor="middle" font-size="10" font-weight="700" fill="#333">{normalize ? '100%' : fmtVal(totals[si])}</text>
          <text x={x + barWidth / 2} y={IH + 14} text-anchor="middle" font-size="9" fill="#666">{truncLabel(stack.label, barWidth > 60 ? 14 : 8)}</text>
        {/each}
      </g>
    </svg>

    {#if hoveredInfo}
      <div class="tooltip">
        <div class="tt-label"><span class="dot" style="background:{hoveredInfo.seg.color}"></span>{hoveredInfo.seg.label}</div>
        {#if stacks.length > 1}<div class="tt-row"><span class="tt-key">Run</span><span class="tt-val">{hoveredInfo.stack}</span></div>{/if}
        <div class="tt-row"><span class="tt-key">Avg</span><span class="tt-val">{fmtVal(hoveredInfo.seg.mean)}</span></div>
        <div class="tt-row"><span class="tt-key">Share</span><span class="tt-val">{hoveredInfo.pct.toFixed(1)}%</span></div>
        <div class="tt-row"><span class="tt-key">Min</span><span class="tt-val">{fmtVal(hoveredInfo.seg.min)}</span></div>
        <div class="tt-row"><span class="tt-key">Max</span><span class="tt-val">{fmtVal(hoveredInfo.seg.max)}</span></div>
      </div>
    {/if}

    <table class="legend">
      <thead>
        <tr>
          <th></th>
          {#each stacks as stack}<th colspan="2">{stacks.length > 1 ? stack.label : 'Avg · share'}</th>{/each}
        </tr>
      </thead>
      <tbody>
        {#each [...legend].reverse() as item}
          <tr>
            <td class="name"><span class="dot" style="background:{item.color}"></span>{item.label}</td>
            {#each stacks as stack, si}
              {@const seg = segmentOf(stack, item.label)}
              <td class="num">{seg ? fmtVal(seg.mean) : '—'}</td>
              <td class="num dim">{seg ? `${share(si, seg.mean).toFixed(1)}%` : ''}</td>
            {/each}
          </tr>
        {/each}
        <tr class="total">
          <td class="name">Total</td>
          {#each stacks as _, si}
            <td class="num">{fmtVal(totals[si])}</td>
            <td></td>
          {/each}
        </tr>
      </tbody>
    </table>
  {/if}
</div>

<style>
  .chart-wrap { border: 1px solid #e8e8e8; border-radius: 6px; padding: 10px 12px; background: #fff; position: relative; }
  .chart-header { display: flex; align-items: baseline; gap: 12px; margin-bottom: 6px; }
  .chart-title { font-size: 12px; font-weight: 700; color: #333; font-family: monospace; }
  .header-actions { display: inline-flex; align-items: center; gap: 10px; margin-left: auto; flex-shrink: 0; }
  .norm-toggle { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; color: #666; cursor: pointer; }
  .copy-group { display: inline-flex; }
  .copy-btn {
    font-size: 11px; color: #888; background: none; border: 1px solid #e3e3e3;
    padding: 2px 7px; cursor: pointer; line-height: 1.4; min-height: 22px;
  }
  .copy-btn:first-child { border-radius: 4px 0 0 4px; }
  .copy-btn:last-child { border-left: 0; border-radius: 0 4px 4px 0; }
  .copy-btn:hover { color: #333; border-color: #bbb; background: #f7f7f7; }
  .copy-btn.copied { color: #16a34a; border-color: #86efac; background: #f0fdf4; }
  .no-data { font-size: 12px; color: #aaa; padding: 20px 0; text-align: center; }

  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 6px; vertical-align: baseline; }

  .tooltip {
    position: absolute; top: 10px; right: 12px; z-index: 20; pointer-events: none;
    background: #1e1f2e; color: #e0e0e0; border: 1px solid #3a3b50; border-radius: 7px;
    padding: 8px 10px; font-size: 11px; min-width: 120px; box-shadow: 0 6px 20px rgba(0,0,0,0.35);
  }
  .tt-label { font-weight: 700; color: #fff; margin-bottom: 5px; }
  .tt-row { display: flex; justify-content: space-between; gap: 10px; padding: 1px 0; }
  .tt-key { color: #9ca3af; }
  .tt-val { font-variant-numeric: tabular-nums; }

  .legend { border-collapse: collapse; margin: 8px auto 0; font-size: 11px; }
  .legend th { text-align: center; max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; color: #888; padding: 2px 6px; }
  .legend td { padding: 2px 6px; border-top: 1px solid #f1f1f1; }
  .legend .name { color: #333; white-space: nowrap; }
  .legend .num { text-align: right; font-variant-numeric: tabular-nums; font-family: monospace; }
  .legend .dim { color: #999; }
  .legend .total td { font-weight: 700; border-top: 1px solid #ddd; }
</style>
