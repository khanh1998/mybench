<script lang="ts">
  import LoadAnalysis from '$lib/LoadAnalysis.svelte';
  import DatabaseTelemetryCompare from '$lib/DatabaseTelemetryCompare.svelte';
  import type { CompareRunInfo } from '$lib/compare/types';

  interface RunParam {
    name: string;
    value: string;
  }

  interface ParamRow {
    name: string;
    values: (string | null)[];
    hasDiff: boolean;
  }

  interface SummaryContextRow {
    label: string;
    values: (string | null)[];
  }

  let {
    allRuns = [],
    selectedRunIds = [],
    canCompare = true,
    insufficientMessage = 'This view needs at least 2 completed runs to compare.',
    selectionPrompt = 'Select at least 2 runs above to begin comparing.'
  }: {
    allRuns: CompareRunInfo[];
    selectedRunIds: number[];
    canCompare?: boolean;
    insufficientMessage?: string;
    selectionPrompt?: string;
  } = $props();

  const COLORS = ['#0066cc', '#e6531d', '#00996b', '#9b36b7', '#cc8800'];
  const SUMMARY_METRICS = [
    { key: 'tps' as const, label: 'TPS', decimals: 2, higherBetter: true },
    { key: 'latency_avg_ms' as const, label: 'Avg Latency (ms)', decimals: 3, higherBetter: false },
    { key: 'latency_stddev_ms' as const, label: 'Latency StdDev (ms)', decimals: 3, higherBetter: false },
    { key: 'transactions' as const, label: 'Transactions', decimals: 0, higherBetter: true }
  ];

  let activeCompareTab = $state<'load' | 'telemetry' | 'cloudwatch'>('load');

  function getRunForId(runId: number): CompareRunInfo | undefined {
    return allRuns.find((run) => run.id === runId);
  }

  function getRunLabel(runId: number, short = false): string {
    const run = getRunForId(runId);
    if (!run) return `Run #${runId}`;
    if (short) return run.compare_short_label ?? run.compare_label ?? run.name ?? `Run #${run.id}`;
    return run.compare_label ?? run.compare_short_label ?? run.name ?? `Run #${run.id}`;
  }

  function parseRunParams(run: CompareRunInfo | undefined): RunParam[] {
    if (!run?.run_params) return [];
    try {
      return JSON.parse(run.run_params) as RunParam[];
    } catch {
      return [];
    }
  }

  function getRunParamValue(run: CompareRunInfo | undefined, names: string[]): string | null {
    const params = parseRunParams(run);
    const match = params.find((param) => names.includes(param.name));
    return match?.value ?? null;
  }

  function formatOptionalNumber(value: number | null | undefined, suffix = ''): string | null {
    if (value == null || !Number.isFinite(value)) return null;
    return `${value.toLocaleString()}${suffix}`;
  }

  function formatOptionalMilliseconds(value: number | null | undefined): string | null {
    if (value == null || !Number.isFinite(value)) return null;
    return `${value.toFixed(3)} ms`;
  }

  function durationSecondsBetween(start: string | null, end: string | null): number | null {
    if (!start || !end) return null;
    const startMs = new Date(start).getTime();
    const endMs = new Date(end).getTime();
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return null;
    return Math.round((endMs - startMs) / 1000);
  }

  function formatDuration(seconds: number | null): string | null {
    if (seconds === null || !Number.isFinite(seconds)) return null;
    if (seconds < 60) return `${seconds}s`;
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remainingSeconds = seconds % 60;
    if (hours > 0) return `${hours}h ${minutes}m ${remainingSeconds}s`;
    if (remainingSeconds === 0) return `${minutes}m`;
    return `${minutes}m ${remainingSeconds}s`;
  }

  const selectedRuns = $derived(
    selectedRunIds
      .map((runId, index) => {
        const run = getRunForId(runId);
        if (!run) return null;
        return {
          id: runId,
          label: getRunLabel(runId, true),
          color: COLORS[index % COLORS.length],
          bench_started_at: run.bench_started_at,
          post_started_at: run.post_started_at
        };
      })
      .filter(
        (run): run is { id: number; label: string; color: string; bench_started_at: string | null; post_started_at: string | null } =>
          run !== null
      )
  );

  const paramDiffRows = $derived((): ParamRow[] => {
    if (selectedRunIds.length === 0) return [];
    const runs = selectedRunIds.map((id) => getRunForId(id));
    const parsedParams = runs.map((run) => parseRunParams(run));
    const paramNames = new Set<string>();

    for (const params of parsedParams) {
      for (const param of params) paramNames.add(param.name);
    }

    const rows: ParamRow[] = [];
    const profileValues = runs.map((run) => run?.profile_name || null);
    rows.push({
      name: 'Profile',
      values: profileValues,
      hasDiff: profileValues.some((value) => value !== profileValues[0])
    });

    for (const name of paramNames) {
      const values = parsedParams.map((params) => params.find((param) => param.name === name)?.value ?? null);
      rows.push({
        name,
        values,
        hasDiff: values.some((value) => value !== values[0])
      });
    }

    return rows;
  });

  const hasParamDiff = $derived(paramDiffRows().some((row) => row.hasDiff));

  const summaryContextRows = $derived((): SummaryContextRow[] => {
    const runs = selectedRunIds.map((id) => getRunForId(id));
    const rows: SummaryContextRow[] = [
      {
        label: 'Benchmark window',
        values: runs.map((run) => formatDuration(durationSecondsBetween(run?.bench_started_at ?? null, run?.post_started_at ?? null)))
      },
      {
        label: 'Total runtime',
        values: runs.map((run) => formatDuration(durationSecondsBetween(run?.started_at ?? null, run?.finished_at ?? null)))
      },
      {
        label: 'Transaction type',
        values: runs.map((run) => run?.transaction_type ?? null)
      },
      {
        label: 'Scaling factor',
        values: runs.map((run) => formatOptionalNumber(run?.scaling_factor))
      },
      {
        label: 'Query mode',
        values: runs.map((run) => run?.query_mode ?? null)
      },
      {
        label: 'Duration',
        values: runs.map((run) => {
          if (run?.duration_secs != null) return `${run.duration_secs.toLocaleString()}s`;
          const value = getRunParamValue(run, ['TIME', 'DURATION', 'DURATION_SECS']);
          return value ? `${value}s` : null;
        })
      },
      {
        label: 'Connections',
        values: runs.map((run) => formatOptionalNumber(run?.number_of_clients) ?? getRunParamValue(run, ['CONNECTION', 'CONNECTIONS', 'CLIENTS', 'NUM_CLIENTS']))
      },
      {
        label: 'Threads',
        values: runs.map((run) => formatOptionalNumber(run?.number_of_threads) ?? getRunParamValue(run, ['THREAD', 'THREADS', 'JOBS']))
      },
      {
        label: 'Maximum tries',
        values: runs.map((run) => formatOptionalNumber(run?.maximum_tries))
      },
      {
        label: 'Initial connection time',
        values: runs.map((run) => formatOptionalMilliseconds(run?.initial_connection_time_ms))
      }
    ];

    return rows.filter((row) => row.values.some((value) => value !== null && value !== ''));
  });

  $effect(() => {
    if (selectedRunIds.length < 2) activeCompareTab = 'load';
  });
</script>

{#if selectedRunIds.length >= 2}
  <div class="compare-top-grid">
    <div class="card">
      <h3>pgbench Summary</h3>
      <div class="table-wrap">
        <table class="summary-table">
          <thead>
            <tr>
              <th>Metric</th>
              {#each selectedRunIds as runId, index}
                <th style="color:{COLORS[index % COLORS.length]}">{getRunLabel(runId, true)}</th>
              {/each}
              <th>Best</th>
            </tr>
          </thead>
          <tbody>
            {#each SUMMARY_METRICS as metric}
              {@const numVals = selectedRunIds.map((runId) => {
                const run = getRunForId(runId);
                const value = run?.[metric.key] ?? null;
                return value !== null ? Number(value) : null;
              })}
              {@const valid = numVals.filter((value): value is number => value !== null)}
              {@const bestVal = valid.length === 0 ? null : metric.higherBetter ? Math.max(...valid) : Math.min(...valid)}
              {@const baselineVal = numVals[0]}
              <tr>
                <td class="metric-label">{metric.label}</td>
                {#each numVals as value, index}
                  {@const isBest = value !== null && value === bestVal && valid.length >= 2}
                  <td class:winner-cell={isBest}>
                    {#if value !== null}
                      <span class:winner-value={isBest}>
                        {metric.decimals === 0 ? value.toFixed(0) : value.toFixed(metric.decimals)}
                      </span>
                      {#if index > 0 && baselineVal !== null && baselineVal !== 0}
                        {@const delta = ((value - baselineVal) / Math.abs(baselineVal)) * 100}
                        {@const isGood = metric.higherBetter ? delta > 0 : delta < 0}
                        <span class="inline-delta" class:positive={isGood} class:negative={!isGood && delta !== 0}>
                          {delta > 0 ? '+' : ''}{delta.toFixed(1)}%
                        </span>
                      {/if}
                    {:else}
                      <span class="missing-value">—</span>
                    {/if}
                  </td>
                {/each}
                <td>
                  {#if bestVal !== null && valid.length >= 2}
                    {@const bestIdx = numVals.findIndex((value) => value === bestVal)}
                    {#if bestIdx >= 0}
                      <span
                        class="winner-badge"
                        style="border-color:{COLORS[bestIdx % COLORS.length]};color:{COLORS[bestIdx % COLORS.length]}"
                      >
                        ▲ {getRunLabel(selectedRunIds[bestIdx], true)}
                      </span>
                    {/if}
                  {/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>

      {#if summaryContextRows().length > 0}
        <div class="summary-extra">
          <div class="summary-extra-title">Run context</div>
          <div class="table-wrap">
            <table class="summary-context-table">
              <thead>
                <tr>
                  <th>Info</th>
                  {#each selectedRunIds as runId, index}
                    <th style="color:{COLORS[index % COLORS.length]}">{getRunLabel(runId, true)}</th>
                  {/each}
                </tr>
              </thead>
              <tbody>
                {#each summaryContextRows() as row}
                  <tr>
                    <td class="metric-label">{row.label}</td>
                    {#each row.values as value}
                      <td>{value ?? '—'}</td>
                    {/each}
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        </div>
      {/if}
    </div>

    {#if paramDiffRows().length > 0}
      <div class="card">
        <div class="row section-header compact">
          <h3 style="margin:0">Parameters</h3>
          {#if !hasParamDiff}
            <span class="section-note">No parameter changes between selected runs</span>
          {:else}
            <span class="section-note warn">Highlighted cells differ from the first selected run</span>
          {/if}
        </div>
        <div class="table-wrap">
          <table class="params-table">
            <thead>
              <tr>
                <th>Parameter</th>
                {#each selectedRunIds as runId, index}
                  <th style="color:{COLORS[index % COLORS.length]}">{getRunLabel(runId, true)}</th>
                {/each}
              </tr>
            </thead>
            <tbody>
              {#each paramDiffRows() as row}
                <tr>
                  <td class="param-name">{row.name}</td>
                  {#each row.values as value, index}
                    <td class:param-diff={index > 0 && value !== row.values[0]}>
                      {#if value !== null && value !== ''}
                        {value}
                      {:else}
                        <span class="missing-value">—</span>
                      {/if}
                    </td>
                  {/each}
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      </div>
    {/if}
  </div>

  <div class="run-tabs">
    <button class="tab-btn" class:active={activeCompareTab === 'load'} onclick={() => activeCompareTab = 'load'}>
      Load Analysis
    </button>
    <button
      class="tab-btn"
      class:active={activeCompareTab === 'telemetry'}
      onclick={() => activeCompareTab = 'telemetry'}
    >
      Database Telemetry
    </button>
    <button
      class="tab-btn"
      class:active={activeCompareTab === 'cloudwatch'}
      onclick={() => activeCompareTab = 'cloudwatch'}
    >
      CloudWatch
    </button>
  </div>

  {#if activeCompareTab === 'load'}
    <div class="card">
      <LoadAnalysis runs={selectedRuns} showPhaseFilter={true} />
    </div>
  {:else if activeCompareTab === 'telemetry'}
    <DatabaseTelemetryCompare
      runs={selectedRuns}
      active={activeCompareTab === 'telemetry'}
      excludeSectionKeys={['cloudwatch']}
    />
  {:else if activeCompareTab === 'cloudwatch'}
    <DatabaseTelemetryCompare
      runs={selectedRuns}
      active={activeCompareTab === 'cloudwatch'}
      title="CloudWatch"
      subtitle="Compare CloudWatch and Enhanced Monitoring telemetry across the selected runs."
      includeSectionKeys={['cloudwatch']}
      showHeroCards={false}
      showInsightSummary={false}
    />
  {/if}
{:else if !canCompare}
  <div class="card empty-state">
    {insufficientMessage}
  </div>
{:else}
  <div class="card empty-state">
    {selectionPrompt}
  </div>
{/if}

<style>
  .section-header {
    margin-bottom: 12px;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }

  .section-header.compact {
    margin-bottom: 10px;
  }

  .section-note {
    font-size: 12px;
    color: #888;
  }

  .section-note.warn {
    color: #885500;
  }

  .compare-top-grid {
    display: flex;
    flex-direction: column;
    gap: 12px;
    margin-top: 12px;
    margin-bottom: 12px;
  }

  .summary-table,
  .summary-context-table,
  .params-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
  }

  .summary-table th,
  .summary-context-table th,
  .params-table th {
    text-align: left;
    padding: 6px 10px;
    border-bottom: 2px solid #eee;
    font-size: 12px;
  }

  .summary-table td,
  .summary-context-table td,
  .params-table td {
    padding: 7px 10px;
    border-bottom: 1px solid #f5f5f5;
  }

  .summary-context-table td,
  .params-table td {
    font-family: monospace;
    font-size: 12px;
  }

  .metric-label {
    font-weight: 600;
    color: #444;
    white-space: nowrap;
    font-family: inherit;
  }

  .winner-cell {
    background: #f0fff8;
  }

  .winner-value {
    font-weight: 700;
    color: #00774f;
  }

  .inline-delta {
    font-size: 11px;
    font-weight: 600;
    margin-left: 5px;
  }

  .inline-delta.positive {
    color: #00996b;
  }

  .inline-delta.negative {
    color: #cc3333;
  }

  .winner-badge {
    font-size: 11px;
    font-weight: 700;
    padding: 1px 8px;
    border-radius: 10px;
    border: 1.5px solid;
  }

  .summary-extra {
    margin-top: 14px;
    padding-top: 14px;
    border-top: 1px solid #efefef;
  }

  .summary-extra-title {
    font-size: 12px;
    font-weight: 700;
    color: #666;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    margin-bottom: 8px;
  }

  .param-name {
    font-family: monospace;
    font-weight: 600;
    color: #444;
    font-size: 12px;
    white-space: nowrap;
  }

  .param-diff {
    background: #fff8e8;
    color: #885500;
    font-weight: 600;
  }

  .missing-value {
    color: #bbb;
  }

  .run-tabs {
    display: flex;
    gap: 2px;
    margin-bottom: 16px;
    border-bottom: 2px solid #e8e8e8;
  }

  .tab-btn {
    background: none;
    border: none;
    padding: 8px 16px;
    font-size: 13px;
    font-weight: 600;
    color: #888;
    cursor: pointer;
    border-bottom: 2px solid transparent;
    margin-bottom: -2px;
    border-radius: 4px 4px 0 0;
    transition: color 0.15s;
  }

  .tab-btn:hover {
    color: #333;
    background: #f5f5f5;
  }

  .tab-btn.active {
    color: #0066cc;
    border-bottom-color: #0066cc;
  }

  .table-wrap {
    overflow-x: auto;
    max-height: 360px;
    overflow-y: auto;
  }

  .empty-state {
    color: #999;
    font-size: 13px;
    text-align: center;
    padding: 32px;
  }

  @media (max-width: 720px) {
    .run-tabs {
      overflow-x: auto;
    }
  }
</style>
