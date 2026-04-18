<script lang="ts">
  import LineChart from '$lib/LineChart.svelte';
  import { parsePgbenchProgress } from '$lib/pgbench-progress';
  import {
    parsePgbenchFinalOutput,
    parseProcessedPgbenchScripts,
    type PgbenchScriptResult,
    type PgbenchStepSummary
  } from '$lib/pgbench-results';

  interface StepResult {
    step_id: number; name: string; type: string; status: string;
    stdout: string; stderr: string; command: string; processed_script: string;
    pgbench_summary_json: string; pgbench_scripts_json: string;
  }

  let { steps }: { steps: StepResult[] } = $props();

  interface StepSection {
    step_id: number;
    step_name: string;
    summary: PgbenchStepSummary | null;
    scripts: PgbenchScriptResult[];
    snapshotUnavailable: boolean;
  }
  interface DetailSection {
    step_id: number;
    step_name: string;
    details: { label: string; value: string }[];
  }

  function parseJson<T>(value: string | null | undefined): T | null {
    if (!value?.trim()) return null;
    try { return JSON.parse(value) as T; } catch { return null; }
  }

  function getOutput(step: Pick<StepResult, 'stdout' | 'stderr'>): string {
    return [step.stdout ?? '', step.stderr ?? ''].filter(p => p.trim().length > 0).join('\n');
  }

  function mergeSummary(stored: PgbenchStepSummary | null, parsed: PgbenchStepSummary | null): PgbenchStepSummary | null {
    if (!stored && !parsed) return null;
    const s: PgbenchStepSummary = {
      tps: stored?.tps ?? parsed?.tps ?? null,
      latency_avg_ms: stored?.latency_avg_ms ?? parsed?.latency_avg_ms ?? null,
      latency_stddev_ms: stored?.latency_stddev_ms ?? parsed?.latency_stddev_ms ?? null,
      transactions: stored?.transactions ?? parsed?.transactions ?? null,
      failed_transactions: stored?.failed_transactions ?? parsed?.failed_transactions ?? null,
      transaction_type: stored?.transaction_type ?? parsed?.transaction_type ?? null,
      scaling_factor: stored?.scaling_factor ?? parsed?.scaling_factor ?? null,
      query_mode: stored?.query_mode ?? parsed?.query_mode ?? null,
      number_of_clients: stored?.number_of_clients ?? parsed?.number_of_clients ?? null,
      number_of_threads: stored?.number_of_threads ?? parsed?.number_of_threads ?? null,
      maximum_tries: stored?.maximum_tries ?? parsed?.maximum_tries ?? null,
      duration_secs: stored?.duration_secs ?? parsed?.duration_secs ?? null,
      initial_connection_time_ms: stored?.initial_connection_time_ms ?? parsed?.initial_connection_time_ms ?? null
    };
    if (Object.values(s).every(v => v == null)) return null;
    return s;
  }

  function mergeScripts(
    stored: PgbenchScriptResult[] | null,
    parsed: PgbenchScriptResult[],
    step: StepResult
  ): PgbenchScriptResult[] {
    const snapshotScripts = parseProcessedPgbenchScripts(step.processed_script);
    const fallback: PgbenchScriptResult[] = [];
    const maxFb = Math.max(parsed.length, snapshotScripts.length);
    for (let i = 0; i < maxFb; i++) {
      const p = parsed.find(x => x.position === i);
      const sn = snapshotScripts.find(x => x.position === i);
      if (!p && !sn) continue;
      fallback.push({ position: i, name: sn?.name ?? p?.name ?? `Script ${i + 1}`, weight: sn?.weight ?? p?.weight ?? null, script: sn?.script ?? '', tps: p?.tps ?? null, latency_avg_ms: p?.latency_avg_ms ?? null, latency_stddev_ms: p?.latency_stddev_ms ?? null, transactions: p?.transactions ?? null, failed_transactions: p?.failed_transactions ?? null });
    }
    if (!stored || stored.length === 0) return fallback;
    const merged: PgbenchScriptResult[] = [];
    const maxM = Math.max(stored.length, parsed.length);
    for (let i = 0; i < maxM; i++) {
      const st = stored.find(x => x.position === i);
      const p = parsed.find(x => x.position === i);
      if (!st && !p) continue;
      merged.push({ position: i, name: st?.name ?? p?.name ?? `Script ${i + 1}`, weight: st?.weight ?? p?.weight ?? null, script: st?.script ?? '', tps: p?.tps ?? st?.tps ?? null, latency_avg_ms: p?.latency_avg_ms ?? st?.latency_avg_ms ?? null, latency_stddev_ms: p?.latency_stddev_ms ?? st?.latency_stddev_ms ?? null, transactions: p?.transactions ?? st?.transactions ?? null, failed_transactions: p?.failed_transactions ?? st?.failed_transactions ?? null });
    }
    return merged;
  }

  function getDetailEntries(summary: PgbenchStepSummary | null): { label: string; value: string }[] {
    if (!summary) return [];
    const d: { label: string; value: string }[] = [];
    if (summary.transaction_type) d.push({ label: 'Transaction Type', value: summary.transaction_type });
    if (summary.scaling_factor != null) d.push({ label: 'Scaling Factor', value: String(summary.scaling_factor) });
    if (summary.query_mode) d.push({ label: 'Query Mode', value: summary.query_mode });
    if (summary.number_of_clients != null) d.push({ label: 'Clients', value: summary.number_of_clients.toLocaleString() });
    if (summary.number_of_threads != null) d.push({ label: 'Threads', value: summary.number_of_threads.toLocaleString() });
    if (summary.maximum_tries != null) d.push({ label: 'Maximum Tries', value: summary.maximum_tries.toLocaleString() });
    if (summary.duration_secs != null) d.push({ label: 'Duration', value: `${summary.duration_secs.toLocaleString()} s` });
    if (summary.initial_connection_time_ms != null) d.push({ label: 'Initial Connection Time', value: `${summary.initial_connection_time_ms.toFixed(3)} ms` });
    return d;
  }

  const stepSections = $derived.by((): StepSection[] =>
    steps.map(step => {
      const stored = parseJson<PgbenchStepSummary>(step.pgbench_summary_json);
      const storedScripts = parseJson<PgbenchScriptResult[]>(step.pgbench_scripts_json);
      const parsed = parsePgbenchFinalOutput(getOutput(step));
      const scripts = mergeScripts(storedScripts, parsed.scripts, step);
      const summary = mergeSummary(stored, parsed.summary);
      return { step_id: step.step_id, step_name: step.name, summary, scripts, snapshotUnavailable: scripts.length > 0 && scripts.every(s => !s.script.trim()) };
    })
  );

  const detailSections = $derived.by((): DetailSection[] =>
    stepSections.map(s => ({ step_id: s.step_id, step_name: s.step_name, details: getDetailEntries(s.summary) })).filter(s => s.details.length > 0)
  );

  const scriptSections = $derived(stepSections.filter(s => s.scripts.length > 0));

  const progressData = $derived.by(() => {
    const step = steps.find(s => s.stdout);
    if (!step) return null;
    const points = parsePgbenchProgress(step.stdout);
    if (points.length < 2) return null;
    const interval = Math.round(points[1].elapsedSec - points[0].elapsedSec) || 5;
    const totalFailed = points.reduce((acc, p) => acc + p.failed, 0);
    return {
      points, interval, totalFailed,
      tpsSeries: [{ label: 'TPS', color: '#0066cc', points: points.map(p => ({ t: p.elapsedSec * 1000, v: p.tps })) }],
      latSeries: [{ label: 'Avg Latency (ms)', color: '#e6531d', points: points.map(p => ({ t: p.elapsedSec * 1000, v: p.latAvgMs })) }],
      stddevSeries: [{ label: 'Latency Stddev (ms)', color: '#9b36b7', points: points.map(p => ({ t: p.elapsedSec * 1000, v: p.latStddevMs })) }],
      failedSeries: totalFailed > 0 ? [{ label: 'Failed', color: '#cc0000', points: points.map(p => ({ t: p.elapsedSec * 1000, v: p.failed })) }] : []
    };
  });

  let expandedScript = $state<string | null>(null);
  function toggleScript(key: string) { expandedScript = expandedScript === key ? null : key; }
</script>

{#each detailSections as section}
  <div class="card">
    <div class="section-header">
      <div>
        <h3>pgbench Details</h3>
        {#if detailSections.length > 1}<p class="step-label">{section.step_name}</p>{/if}
      </div>
    </div>
    <div class="details-grid">
      {#each section.details as d}
        <div class="detail-item">
          <div class="detail-label">{d.label}</div>
          <div class="detail-value">{d.value}</div>
        </div>
      {/each}
    </div>
  </div>
{/each}

{#if progressData}
  {@const pd = progressData}
  <div class="card">
    <div class="chart-header">
      <div>
        <h3>Throughput &amp; Latency Over Time</h3>
        <p class="chart-subtitle">Per {pd.interval}s interval — a stable flat line means healthy sustained throughput.</p>
      </div>
      {#if pd.totalFailed > 0}
        <span class="failed-badge">{pd.totalFailed.toLocaleString()} failed txns</span>
      {/if}
    </div>
    <div class="chart-grid">
      <div>
        <div class="chart-label">TPS</div>
        <LineChart series={pd.tpsSeries} title="TPS over time" originMs={0} showAllSeriesByDefault={true} />
      </div>
      <div>
        <div class="chart-label">Avg Latency (ms)</div>
        <LineChart series={pd.latSeries} title="Avg latency over time" originMs={0} showAllSeriesByDefault={true} />
      </div>
      <div>
        <div class="chart-label">Latency Stddev (ms)</div>
        <LineChart series={pd.stddevSeries} title="Latency stddev over time" originMs={0} showAllSeriesByDefault={true} />
      </div>
      {#if pd.failedSeries.length > 0}
        <div>
          <div class="chart-label">Failed Transactions</div>
          <LineChart series={pd.failedSeries} title="Failed transactions over time" originMs={0} showAllSeriesByDefault={true} />
        </div>
      {/if}
    </div>
  </div>
{/if}

{#each scriptSections as section}
  <div class="card">
    <div class="section-header">
      <div>
        <h3>Benchmark Scripts</h3>
        <p class="step-label">{section.step_name}</p>
      </div>
    </div>
    {#if section.snapshotUnavailable}
      <div class="note">Script snapshot unavailable for this run.</div>
    {/if}
    <table class="scripts-table">
      <thead>
        <tr>
          <th>Script</th><th>Weight</th><th>Transactions</th>
          <th>TPS</th><th>Avg Latency</th><th>Stddev</th><th></th>
        </tr>
      </thead>
      <tbody>
        {#each section.scripts as script}
          {@const key = `${section.step_id}:${script.position}`}
          <tr>
            <td>{script.name}</td>
            <td>{script.weight ?? '—'}</td>
            <td>{script.transactions?.toLocaleString() ?? '—'}</td>
            <td>{script.tps?.toFixed(3) ?? '—'}</td>
            <td>{script.latency_avg_ms?.toFixed(3) ?? '—'} ms</td>
            <td>{script.latency_stddev_ms?.toFixed(3) ?? '—'} ms</td>
            <td>
              {#if script.script}
                <button class="expand-btn" onclick={() => toggleScript(key)}>
                  {expandedScript === key ? '▲' : '▼'} script
                </button>
              {/if}
            </td>
          </tr>
          {#if expandedScript === key && script.script}
            <tr class="detail-row">
              <td colspan="7">
                <div class="detail-block">
                  <div class="detail-row-label">Script Snapshot</div>
                  <pre class="detail-pre">{script.script}</pre>
                </div>
              </td>
            </tr>
          {/if}
        {/each}
      </tbody>
    </table>
  </div>
{/each}

<style>
  .card { background: #fff; border: 1px solid #e0e0e0; border-radius: 8px; padding: 16px 18px; margin-bottom: 12px; }
  .section-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 10px; }
  h3 { margin: 0 0 2px; font-size: 15px; }
  .step-label { margin: 0; color: #666; font-size: 12px; }
  .details-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 14px 18px; }
  .detail-item { min-width: 0; }
  .detail-label { font-size: 11px; color: #666; font-weight: 600; text-transform: uppercase; margin-bottom: 4px; }
  .detail-value { font-size: 16px; font-weight: 600; color: #222; word-break: break-word; }
  .chart-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 14px; flex-wrap: wrap; }
  .chart-subtitle { margin: 0; color: #666; font-size: 12px; }
  .chart-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px; }
  .chart-label { font-size: 11px; font-weight: 700; color: #666; text-transform: uppercase; margin-bottom: 6px; letter-spacing: 0.04em; }
  .failed-badge { background: #fff0f0; border: 1px solid #f5c0c0; color: #a00; font-size: 12px; font-weight: 700; padding: 4px 10px; border-radius: 999px; white-space: nowrap; }
  .note { margin-bottom: 10px; padding: 8px 10px; border-radius: 6px; background: #fff6df; border: 1px solid #f2d58c; color: #8a5a00; font-size: 12px; }
  .scripts-table th:last-child, .scripts-table td:last-child { width: 1%; white-space: nowrap; }
  .expand-btn { font-size: 11px; padding: 2px 6px; background: none; border: 1px solid #ccc; border-radius: 3px; cursor: pointer; color: #555; }
  .expand-btn:hover { background: #f0f0f0; }
  .detail-row td { padding: 0 !important; }
  .detail-block { padding: 8px 12px; background: #f8f8f8; border-top: 1px solid #eee; }
  .detail-row-label { font-size: 10px; font-weight: 700; color: #888; text-transform: uppercase; margin-bottom: 4px; }
  .detail-pre { margin: 0; font-size: 12px; white-space: pre-wrap; word-break: break-all; background: #1e1e1e; color: #d4d4d4; padding: 8px; border-radius: 4px; max-height: 200px; overflow-y: auto; }
</style>
