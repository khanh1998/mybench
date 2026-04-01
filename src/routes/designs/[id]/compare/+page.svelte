<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import LoadAnalysis from '$lib/LoadAnalysis.svelte';
  import DatabaseTelemetryCompare from '$lib/DatabaseTelemetryCompare.svelte';
  import { fmtTs } from '$lib/utils';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  const designId = $derived(Number($page.params.id));

  interface RunInfo {
    id: number;
    name: string;
    status: string;
    tps: number | null;
    latency_avg_ms: number | null;
    latency_stddev_ms: number | null;
    transactions: number | null;
    profile_name: string;
    run_params: string;
    started_at: string;
    bench_started_at: string | null;
    post_started_at: string | null;
    finished_at: string | null;
  }

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

  const COLORS = ['#0066cc', '#e6531d', '#00996b', '#9b36b7', '#cc8800'];
  const MAX_RUNS = 4;
  const SUMMARY_METRICS = [
    { key: 'tps' as const, label: 'TPS', decimals: 2, higherBetter: true },
    { key: 'latency_avg_ms' as const, label: 'Avg Latency (ms)', decimals: 3, higherBetter: false },
    { key: 'latency_stddev_ms' as const, label: 'Latency StdDev (ms)', decimals: 3, higherBetter: false },
    { key: 'transactions' as const, label: 'Transactions', decimals: 0, higherBetter: true }
  ];

  const allRuns = $derived((data.runs ?? []) as RunInfo[]);
  let selectedRunIds: number[] = $state([]);
  let activeCompareTab = $state<'load' | 'telemetry'>('load');

  function getRunForId(runId: number): RunInfo | undefined {
    return allRuns.find((run) => run.id === runId);
  }

  function getRunLabel(runId: number): string {
    const run = getRunForId(runId);
    if (!run) return `Run #${runId}`;
    return run.name || `Run #${run.id}`;
  }

  function parseRunParams(run: RunInfo | undefined): RunParam[] {
    if (!run?.run_params) return [];
    try {
      return JSON.parse(run.run_params) as RunParam[];
    } catch {
      return [];
    }
  }

  function getRunParamValue(run: RunInfo | undefined, names: string[]): string | null {
    const params = parseRunParams(run);
    const match = params.find((param) => names.includes(param.name));
    return match?.value ?? null;
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

  function initFromUrl() {
    const param = $page.url.searchParams.get('runs');
    if (!param) return;
    const ids = param
      .split(',')
      .map(Number)
      .filter((id) => id > 0 && allRuns.some((run) => run.id === id));
    selectedRunIds = ids.slice(0, MAX_RUNS);
  }

  function syncUrl() {
    const url = new URL($page.url);
    if (selectedRunIds.length > 0) {
      url.searchParams.set('runs', selectedRunIds.join(','));
    } else {
      url.searchParams.delete('runs');
    }
    goto(url.toString(), { replaceState: true, noScroll: true, keepFocus: true });
  }

  function toggleRun(runId: number) {
    if (selectedRunIds.includes(runId)) {
      selectedRunIds = selectedRunIds.filter((id) => id !== runId);
    } else if (selectedRunIds.length < MAX_RUNS) {
      selectedRunIds = [...selectedRunIds, runId];
    }
    syncUrl();
  }

  function clearSelection() {
    selectedRunIds = [];
    syncUrl();
  }

  const selectedRuns = $derived(
    selectedRunIds
      .map((runId, index) => {
        const run = getRunForId(runId);
        if (!run) return null;
        return {
          id: runId,
          label: run.name || `Run #${runId}`,
          color: COLORS[index % COLORS.length],
          bench_started_at: run.bench_started_at,
          post_started_at: run.post_started_at
        };
      })
      .filter((run): run is { id: number; label: string; color: string; bench_started_at: string | null; post_started_at: string | null } => run !== null)
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
        label: 'Configured time',
        values: runs.map((run) => {
          const value = getRunParamValue(run, ['TIME', 'DURATION', 'DURATION_SECS']);
          return value ? `${value}s` : null;
        })
      },
      {
        label: 'Connections',
        values: runs.map((run) => getRunParamValue(run, ['CONNECTION', 'CONNECTIONS', 'CLIENTS', 'NUM_CLIENTS']))
      },
      {
        label: 'Threads',
        values: runs.map((run) => getRunParamValue(run, ['THREAD', 'THREADS', 'JOBS']))
      }
    ];

    return rows.filter((row) => row.values.some((value) => value !== null && value !== ''));
  });

  $effect(() => {
    if (selectedRunIds.length === 0) {
      activeCompareTab = 'load';
    }
  });

  onMount(() => {
    initFromUrl();
  });
</script>

<div class="row page-header">
  <a href="/designs/{designId}" class="back-link">← {(data.design as { name: string } | null)?.name ?? 'Design'}</a>
  <h1>Compare Runs</h1>
</div>

<div class="card">
  <div class="row section-header">
    <h3 style="margin:0">Select Runs to Compare</h3>
    <span class="section-note">Select 2–{MAX_RUNS} completed runs</span>
    {#if selectedRunIds.length > 0}
      <button onclick={clearSelection} class="clear-btn">Clear</button>
    {/if}
  </div>

  {#if allRuns.length === 0}
    <p class="empty-copy">No completed runs for this design yet.</p>
  {:else}
    <div class="run-list">
      {#each allRuns as run}
        {@const colorIdx = selectedRunIds.indexOf(run.id)}
        {@const selected = colorIdx >= 0}
        {@const disabled = !selected && selectedRunIds.length >= MAX_RUNS}
        <label
          class="run-chip"
          class:selected
          class:disabled
          style={selected ? `border-color:${COLORS[colorIdx]};background:${COLORS[colorIdx]}18` : ''}
        >
          <input type="checkbox" checked={selected} {disabled} onchange={() => toggleRun(run.id)} />
          <span class="run-chip-id" style={selected ? `color:${COLORS[colorIdx]};font-weight:700` : ''}>
            {run.name || '#' + run.id}
          </span>
          {#if run.profile_name}
            <span class="run-chip-profile">{run.profile_name}</span>
          {/if}
          {#if run.tps !== null}
            <span class="run-chip-tps">{run.tps.toFixed(1)} TPS</span>
          {/if}
          <span class="run-chip-date">{fmtTs(run.started_at)}</span>
        </label>
      {/each}
    </div>
  {/if}
</div>

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
                <th style="color:{COLORS[index % COLORS.length]}">{getRunLabel(runId)}</th>
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
                        ▲ {getRunLabel(selectedRunIds[bestIdx])}
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
                    <th style="color:{COLORS[index % COLORS.length]}">{getRunLabel(runId)}</th>
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
            <span class="section-note warn">Highlighted cells differ from the first run</span>
          {/if}
        </div>
        <div class="table-wrap">
          <table class="params-table">
            <thead>
              <tr>
                <th>Parameter</th>
                {#each selectedRunIds as runId, index}
                  <th style="color:{COLORS[index % COLORS.length]}">{getRunLabel(runId)}</th>
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
  </div>

  {#if activeCompareTab === 'load'}
    <div class="card">
      <LoadAnalysis runs={selectedRuns} showPhaseFilter={true} />
    </div>
  {:else}
    <DatabaseTelemetryCompare runs={selectedRuns} active={activeCompareTab === 'telemetry'} />
  {/if}
{:else if allRuns.length < 2}
  <div class="card empty-state">
    This design needs at least 2 completed runs to compare. Run the benchmark a few more times with different settings or parameter profiles.
  </div>
{:else}
  <div class="card empty-state">
    Select at least 2 runs above to begin comparing.
  </div>
{/if}

<style>
  .page-header {
    margin-bottom: 16px;
    align-items: center;
    gap: 8px;
  }

  .page-header h1 {
    margin: 0;
  }

  .back-link {
    color: #0066cc;
    text-decoration: none;
  }

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

  .clear-btn {
    margin-left: auto;
    font-size: 12px;
  }

  .run-list {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: flex-start;
  }

  .run-chip {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    flex-wrap: nowrap;
    white-space: nowrap;
    padding: 8px 12px;
    border: 1.5px solid #e0e0e0;
    border-radius: 999px;
    cursor: pointer;
    font-size: 13px;
    transition: border-color 0.1s, background 0.1s;
    max-width: 100%;
  }

  .run-chip:hover:not(.disabled) {
    border-color: #0066cc;
    background: #f0f6ff;
  }

  .run-chip.selected {
    font-weight: 500;
  }

  .run-chip.disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  .run-chip input {
    width: auto;
    cursor: pointer;
    margin: 0;
  }

  .run-chip-id {
    font-size: 13px;
  }

  .run-chip-profile {
    font-size: 11px;
    background: #e8f0ff;
    color: #0055aa;
    padding: 1px 6px;
    border-radius: 8px;
  }

  .run-chip-tps {
    font-size: 11px;
    color: #00996b;
    font-weight: 600;
  }

  .run-chip-date {
    font-size: 11px;
    color: #999;
    font-family: monospace;
  }

  .compare-top-grid {
    display: grid;
    grid-template-columns: minmax(0, 1.35fr) minmax(320px, 0.95fr);
    gap: 12px;
    align-items: start;
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

  .empty-copy,
  .empty-state {
    color: #999;
    font-size: 13px;
  }

  .empty-state {
    text-align: center;
    padding: 32px;
  }

  @media (max-width: 980px) {
    .compare-top-grid {
      grid-template-columns: 1fr;
    }

    .clear-btn {
      margin-left: 0;
    }
  }

  @media (max-width: 720px) {
    .run-chip {
      width: 100%;
      justify-content: space-between;
    }

    .run-tabs {
      overflow-x: auto;
    }
  }
</style>
