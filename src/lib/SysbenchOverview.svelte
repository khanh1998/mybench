<script lang="ts">
  import LineChart from '$lib/LineChart.svelte';
  import { parseSysbenchProgress } from '$lib/sysbench-progress';
  import { parseSysbenchFinalOutput } from '$lib/sysbench-results';

  interface StepResult {
    step_id: number; name: string; type: string; status: string;
    stdout: string; stderr: string; command: string; processed_script: string;
    pgbench_summary_json: string; pgbench_scripts_json: string;
    sysbench_summary_json: string;
  }

  let { steps }: { steps: StepResult[] } = $props();

  function getOutput(step: Pick<StepResult, 'stdout' | 'stderr'>): string {
    return [step.stdout ?? '', step.stderr ?? ''].filter(p => p.trim().length > 0).join('\n');
  }

  const stepSections = $derived.by(() =>
    steps.map(step => {
      const output = getOutput(step);
      const summary = parseSysbenchFinalOutput(output);
      const progressPoints = parseSysbenchProgress(output);
      const hasSummary = Object.values(summary).some(v => v != null);
      return { step_id: step.step_id, step_name: step.name, summary, progressPoints, hasSummary, luaScript: step.processed_script ?? '' };
    })
  );

  const progressData = $derived.by(() => {
    const section = stepSections.find(s => s.progressPoints.length >= 2);
    if (!section) return null;
    const { progressPoints: pts, step_name } = section;
    const interval = (pts[1].elapsedSec - pts[0].elapsedSec) || 1;
    const totalErrors = pts.reduce((acc, p) => acc + p.errors, 0);
    const allP95Zero = pts.every(p => p.latP95Ms === 0);
    const hasRwo = pts.some(p => p.reads > 0 || p.writes > 0 || p.others > 0);
    return {
      step_name, interval, totalErrors,
      tpsSeries: [{ label: 'TPS', color: '#0066cc', points: pts.map(p => ({ t: p.elapsedSec * 1000, v: p.tps })) }],
      qpsSeries: [{ label: 'QPS', color: '#2eaa62', points: pts.map(p => ({ t: p.elapsedSec * 1000, v: p.qps })) }],
      latSeries: allP95Zero ? [] : [{ label: 'p95 Latency (ms)', color: '#e6531d', points: pts.map(p => ({ t: p.elapsedSec * 1000, v: p.latP95Ms })) }],
      rwoSeries: hasRwo ? [
        { label: 'Read', color: '#0066cc', points: pts.map(p => ({ t: p.elapsedSec * 1000, v: p.reads })) },
        { label: 'Write', color: '#e6531d', points: pts.map(p => ({ t: p.elapsedSec * 1000, v: p.writes })) },
        { label: 'Other', color: '#9b36b7', points: pts.map(p => ({ t: p.elapsedSec * 1000, v: p.others })) },
      ] : [],
      errSeries: totalErrors > 0 ? [{ label: 'Errors/s', color: '#cc0000', points: pts.map(p => ({ t: p.elapsedSec * 1000, v: p.errors })) }] : []
    };
  });

  let expandedScript = $state<number | null>(null);
  function toggleScript(id: number) { expandedScript = expandedScript === id ? null : id; }
</script>

{#each stepSections as section}
  {#if section.hasSummary}
    <div class="card">
      <div class="section-header">
        <div>
          <h3>sysbench Summary</h3>
          {#if stepSections.length > 1}<p class="step-label">{section.step_name}</p>{/if}
        </div>
      </div>
      <div class="details-grid">
        {#if section.summary.threads != null}
          <div class="detail-item">
            <div class="detail-label">Threads</div>
            <div class="detail-value">{section.summary.threads}</div>
          </div>
        {/if}
        {#if section.summary.total_time_secs != null}
          <div class="detail-item">
            <div class="detail-label">Duration</div>
            <div class="detail-value">{section.summary.total_time_secs.toFixed(1)} s</div>
          </div>
        {/if}
        {#if section.summary.total_events != null}
          <div class="detail-item">
            <div class="detail-label">Total Events</div>
            <div class="detail-value">{section.summary.total_events.toLocaleString()}</div>
          </div>
        {/if}
        {#if section.summary.errors != null && section.summary.errors > 0}
          <div class="detail-item">
            <div class="detail-label">Errors</div>
            <div class="detail-value error">{section.summary.errors.toLocaleString()}</div>
          </div>
        {/if}
        {#if section.summary.latency_min_ms != null}
          <div class="detail-item">
            <div class="detail-label">Latency Min</div>
            <div class="detail-value">{section.summary.latency_min_ms.toFixed(2)} ms</div>
          </div>
        {/if}
        {#if section.summary.latency_avg_ms != null}
          <div class="detail-item">
            <div class="detail-label">Latency Avg</div>
            <div class="detail-value">{section.summary.latency_avg_ms.toFixed(2)} ms</div>
          </div>
        {/if}
        {#if section.summary.latency_p95_ms != null}
          <div class="detail-item">
            <div class="detail-label">Latency p95</div>
            <div class="detail-value">{section.summary.latency_p95_ms.toFixed(2)} ms</div>
          </div>
        {/if}
        {#if section.summary.latency_max_ms != null}
          <div class="detail-item">
            <div class="detail-label">Latency Max</div>
            <div class="detail-value">{section.summary.latency_max_ms.toFixed(2)} ms</div>
          </div>
        {/if}
        {#if section.summary.tps != null}
          <div class="detail-item">
            <div class="detail-label">Avg TPS</div>
            <div class="detail-value">{section.summary.tps.toFixed(2)}</div>
          </div>
        {/if}
        {#if section.summary.qps != null}
          <div class="detail-item">
            <div class="detail-label">Avg QPS</div>
            <div class="detail-value">{section.summary.qps.toFixed(2)}</div>
          </div>
        {/if}
        {#if section.summary.transactions != null}
          <div class="detail-item">
            <div class="detail-label">Total Transactions</div>
            <div class="detail-value">{section.summary.transactions.toLocaleString()}</div>
          </div>
        {/if}
        {#if section.summary.queries_total != null}
          <div class="detail-item">
            <div class="detail-label">Total Queries</div>
            <div class="detail-value">{section.summary.queries_total.toLocaleString()}</div>
          </div>
        {/if}
        {#if section.summary.queries_read != null || section.summary.queries_write != null || section.summary.queries_other != null}
          <div class="detail-item">
            <div class="detail-label">R / W / Other</div>
            <div class="detail-value">{section.summary.queries_read ?? 0} / {section.summary.queries_write ?? 0} / {section.summary.queries_other ?? 0}</div>
          </div>
        {/if}
        {#if section.summary.rows_per_sec != null}
          <div class="detail-item">
            <div class="detail-label">Rows/sec</div>
            <div class="detail-value">{section.summary.rows_per_sec.toFixed(2)}</div>
          </div>
        {/if}
      </div>
    </div>
  {/if}
{/each}

{#if progressData}
  {@const pd = progressData}
  <div class="card">
    <div class="chart-header">
      <div>
        <h3>Throughput &amp; Latency Over Time</h3>
        <p class="chart-subtitle">Per {pd.interval}s interval{stepSections.length > 1 ? ` — ${pd.step_name}` : ''}</p>
      </div>
      {#if pd.totalErrors > 0}
        <span class="error-badge">{pd.totalErrors.toLocaleString()} errors</span>
      {/if}
    </div>
    <div class="chart-grid">
      <div>
        <div class="chart-label">TPS</div>
        <LineChart series={pd.tpsSeries} title="TPS over time" originMs={0} showAllSeriesByDefault={true} />
      </div>
      <div>
        <div class="chart-label">QPS</div>
        <LineChart series={pd.qpsSeries} title="QPS over time" originMs={0} showAllSeriesByDefault={true} />
      </div>
      {#if pd.latSeries.length > 0}
        <div>
          <div class="chart-label">p95 Latency (ms)</div>
          <LineChart series={pd.latSeries} title="p95 latency over time" originMs={0} showAllSeriesByDefault={true} />
        </div>
      {/if}
      {#if pd.rwoSeries.length > 0}
        <div>
          <div class="chart-label">Queries/s (R / W / Other)</div>
          <LineChart series={pd.rwoSeries} title="Read/write/other over time" originMs={0} showAllSeriesByDefault={true} />
        </div>
      {/if}
      {#if pd.errSeries.length > 0}
        <div>
          <div class="chart-label">Errors/s</div>
          <LineChart series={pd.errSeries} title="Errors per second" originMs={0} showAllSeriesByDefault={true} />
        </div>
      {/if}
    </div>
  </div>
{/if}

{#each stepSections as section}
  {#if section.luaScript}
    <div class="card">
      <div class="section-header">
        <div>
          <h3>Lua Script</h3>
          {#if stepSections.length > 1}<p class="step-label">{section.step_name}</p>{/if}
        </div>
        <button class="expand-btn" onclick={() => toggleScript(section.step_id)}>
          {expandedScript === section.step_id ? '▲ hide' : '▼ show'}
        </button>
      </div>
      {#if expandedScript === section.step_id}
        <pre class="lua-pre">{section.luaScript}</pre>
      {/if}
    </div>
  {/if}
{/each}

<style>
  .card { background: #fff; border: 1px solid #e0e0e0; border-radius: 8px; padding: 16px 18px; margin-bottom: 12px; }
  .section-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 10px; }
  h3 { margin: 0 0 2px; font-size: 15px; }
  .step-label { margin: 0; color: #666; font-size: 12px; }
  .details-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 14px 18px; }
  .detail-item { min-width: 0; }
  .detail-label { font-size: 11px; color: #666; font-weight: 600; text-transform: uppercase; margin-bottom: 4px; }
  .detail-value { font-size: 16px; font-weight: 600; color: #222; }
  .detail-value.error { color: #a00; }
  .chart-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 14px; flex-wrap: wrap; }
  .chart-subtitle { margin: 0; color: #666; font-size: 12px; }
  .chart-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px; }
  .chart-label { font-size: 11px; font-weight: 700; color: #666; text-transform: uppercase; margin-bottom: 6px; letter-spacing: 0.04em; }
  .error-badge { background: #fff0f0; border: 1px solid #f5c0c0; color: #a00; font-size: 12px; font-weight: 700; padding: 4px 10px; border-radius: 999px; white-space: nowrap; }
  .expand-btn { font-size: 11px; padding: 2px 6px; background: none; border: 1px solid #ccc; border-radius: 3px; cursor: pointer; color: #555; }
  .expand-btn:hover { background: #f0f0f0; }
  .lua-pre { margin: 0; font-size: 12px; white-space: pre-wrap; word-break: break-all; background: #1e1e1e; color: #d4d4d4; padding: 10px; border-radius: 4px; max-height: 400px; overflow-y: auto; }
</style>
