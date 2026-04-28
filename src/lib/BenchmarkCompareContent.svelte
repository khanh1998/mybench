<script lang="ts">
  import LoadAnalysis from '$lib/LoadAnalysis.svelte';
  import DatabaseTelemetryCompare from '$lib/DatabaseTelemetryCompare.svelte';
  import { RUN_COMPARE_COLORS } from '$lib/compare/colors';
  import type { CompareRunInfo, CompareStepPerf } from '$lib/compare/types';

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

  interface PerfMetricOption {
    key: string;
    eventName: string;
    kind: 'raw' | 'per_tx';
    label: string;
  }

  interface PerfCompareRow {
    stepKey: string;
    stepLabel: string;
    values: (number | null)[];
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

  const COLORS = RUN_COMPARE_COLORS;
  const PGBENCH_SUMMARY_METRICS = [
    { key: 'tps' as const, label: 'TPS', decimals: 2, higherBetter: true },
    { key: 'latency_avg_ms' as const, label: 'Avg Latency (ms)', decimals: 3, higherBetter: false },
    { key: 'latency_stddev_ms' as const, label: 'Latency StdDev (ms)', decimals: 3, higherBetter: false },
    { key: 'transactions' as const, label: 'Transactions', decimals: 0, higherBetter: true }
  ];
  const SYSBENCH_SUMMARY_METRICS = [
    { key: 'tps' as const, label: 'TPS', decimals: 2, higherBetter: true },
    { key: 'qps' as const, label: 'QPS', decimals: 2, higherBetter: true },
    { key: 'latency_avg_ms' as const, label: 'Avg Latency (ms)', decimals: 2, higherBetter: false },
    { key: 'latency_p95_ms' as const, label: 'p95 Latency (ms)', decimals: 2, higherBetter: false },
    { key: 'transactions' as const, label: 'Transactions', decimals: 0, higherBetter: true }
  ];

  let activeCompareTab = $state<'summary' | 'load' | 'telemetry' | 'cloudwatch' | 'perf' | 'host_metrics'>('summary');
  let hostMetricsTab = $state<'system' | 'processes'>('system');
  let selectedPerfMetric = $state('');
  let selectedSummaryMetricKey = $state('');

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

  function formatMetric(value: number | null | undefined, digits = 3): string {
    if (value == null || !Number.isFinite(value)) return '—';
    return value.toLocaleString(undefined, { maximumFractionDigits: digits });
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
          post_started_at: run.post_started_at,
          host_config: run.host_config ?? null
        };
      })
      .filter(
        (run): run is { id: number; label: string; color: string; bench_started_at: string | null; post_started_at: string | null; host_config: string | null } =>
          run !== null
      )
  );

  const selectedRunsWithPerf = $derived(
    selectedRunIds
      .map((runId, index) => {
        const run = getRunForId(runId);
        if (!run) return null;
        return {
          run,
          label: getRunLabel(runId, true),
          color: COLORS[index % COLORS.length],
          perf: run.perf ?? []
        };
      })
      .filter((entry): entry is { run: CompareRunInfo; label: string; color: string; perf: CompareStepPerf[] } => entry !== null)
  );

  const hasPerfData = $derived(selectedRunsWithPerf.some((entry) => entry.perf.length > 0));

  const perfMetricOptions = $derived((): PerfMetricOption[] => {
    const eventNames = new Set<string>();
    const perTxnNames = new Set<string>();
    for (const entry of selectedRunsWithPerf) {
      for (const perf of entry.perf) {
        for (const event of perf.events) {
          eventNames.add(event.event_name);
          if (event.per_transaction !== null) perTxnNames.add(event.event_name);
        }
      }
    }
    const options: PerfMetricOption[] = [];
    for (const name of [...eventNames].sort()) {
      options.push({ key: `raw:${name}`, eventName: name, kind: 'raw', label: `${name} (raw)` });
      if (perTxnNames.has(name)) {
        options.push({ key: `per_tx:${name}`, eventName: name, kind: 'per_tx', label: `${name}/tx` });
      }
    }
    return options;
  });

  const selectedPerfOption = $derived(
    perfMetricOptions().find((option) => option.key === selectedPerfMetric) ?? perfMetricOptions()[0] ?? null
  );

  const perfCompareRows = $derived((): PerfCompareRow[] => {
    const option = selectedPerfOption;
    if (!option) return [];
    const stepKeys = new Set<string>();
    const labels = new Map<string, string>();
    for (const entry of selectedRunsWithPerf) {
      for (const perf of entry.perf) {
        const key = `${perf.step_type ?? 'step'}:${perf.step_name ?? perf.step_id}`;
        stepKeys.add(key);
        labels.set(key, perf.step_name ?? `Step ${perf.step_id}`);
      }
    }
    return [...stepKeys].map((stepKey) => ({
      stepKey,
      stepLabel: labels.get(stepKey) ?? stepKey,
      values: selectedRunsWithPerf.map((entry) => {
        const perf = entry.perf.find((item) => `${item.step_type ?? 'step'}:${item.step_name ?? item.step_id}` === stepKey);
        const event = perf?.events.find((item) => item.event_name === option.eventName);
        return option.kind === 'raw' ? (event?.counter_value ?? null) : (event?.per_transaction ?? null);
      })
    })).filter((row) => row.values.some((value) => value !== null));
  });

  $effect(() => {
    const options = perfMetricOptions();
    if (options.length === 0) {
      selectedPerfMetric = '';
      return;
    }
    if (!options.some((option) => option.key === selectedPerfMetric)) {
      selectedPerfMetric = options.find((option) => option.key === 'per_tx:context-switches')?.key ?? options[0].key;
    }
  });

  const perfChartBounds = $derived(() => {
    const values = perfCompareRows().flatMap((row) => row.values).filter((value): value is number => value !== null);
    const max = values.length ? Math.max(...values) : 1;
    return { max: max > 0 ? max : 1 };
  });

  function perfPointX(index: number): number {
    const count = Math.max(selectedRunsWithPerf.length, 1);
    if (count === 1) return 60;
    return 60 + (index / (count - 1)) * 640;
  }

  function perfPointY(value: number): number {
    return 230 - (value / perfChartBounds().max) * 190;
  }

  function perfPolyline(row: PerfCompareRow): string {
    return row.values
      .map((value, index) => value === null ? null : `${perfPointX(index).toFixed(1)},${perfPointY(value).toFixed(1)}`)
      .filter((point): point is string => point !== null)
      .join(' ');
  }

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
    const isSysbench = benchType() === 'sysbench';
    const rows: SummaryContextRow[] = [
      {
        label: 'Benchmark window',
        values: runs.map((run) => formatDuration(durationSecondsBetween(run?.bench_started_at ?? null, run?.post_started_at ?? null)))
      },
      {
        label: 'Total runtime',
        values: runs.map((run) => formatDuration(durationSecondsBetween(run?.started_at ?? null, run?.finished_at ?? null)))
      },
      ...(isSysbench ? [
        {
          label: 'Threads',
          values: runs.map((run) => formatOptionalNumber(run?.sysbench_threads) ?? getRunParamValue(run, ['THREADS', 'THREAD', 'NUM_THREADS']))
        },
        {
          label: 'Duration',
          values: runs.map((run) => {
            if (run?.sysbench_total_time_secs != null) return `${run.sysbench_total_time_secs.toFixed(1)}s`;
            const value = getRunParamValue(run, ['TIME', 'DURATION', 'DURATION_SECS']);
            return value ? `${value}s` : null;
          })
        },
        {
          label: 'Total events',
          values: runs.map((run) => formatOptionalNumber(run?.sysbench_total_events))
        },
        {
          label: 'Errors',
          values: runs.map((run) => (run?.sysbench_errors != null && run.sysbench_errors > 0) ? run.sysbench_errors.toLocaleString() : null)
        }
      ] : [
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
      ])
    ];

    return rows.filter((row) => row.values.some((value) => value !== null && value !== ''));
  });

  const benchType = $derived((): 'pgbench' | 'sysbench' | 'mixed' | null => {
    const types = new Set(
      selectedRunIds.map((id) => getRunForId(id)?.bench_type).filter((t): t is 'pgbench' | 'sysbench' => t === 'pgbench' || t === 'sysbench')
    );
    if (types.size === 0) return null;
    if (types.size === 1) return [...types][0];
    return 'mixed';
  });

  const activeSummaryMetrics = $derived(
    benchType() === 'sysbench' ? SYSBENCH_SUMMARY_METRICS : PGBENCH_SUMMARY_METRICS
  );

  const summaryTitle = $derived(
    benchType() === 'sysbench' ? 'sysbench Summary' : 'pgbench Summary'
  );

  const selectedSummaryMetric = $derived(
    activeSummaryMetrics.find((m) => m.key === selectedSummaryMetricKey) ?? activeSummaryMetrics[0] ?? null
  );

  const summaryChartValues = $derived((): { runId: number; label: string; color: string; value: number | null }[] => {
    const metric = selectedSummaryMetric;
    if (!metric) return [];
    return selectedRunIds.map((runId, index) => {
      const run = getRunForId(runId);
      const raw = run?.[metric.key] ?? null;
      return {
        runId,
        label: getRunLabel(runId, true),
        color: COLORS[index % COLORS.length],
        value: raw !== null ? Number(raw) : null
      };
    });
  });

  $effect(() => {
    const metrics = activeSummaryMetrics;
    if (!metrics.some((m) => m.key === selectedSummaryMetricKey)) {
      selectedSummaryMetricKey = metrics[0]?.key ?? '';
    }
  });

  $effect(() => {
    if (selectedRunIds.length < 2) activeCompareTab = 'summary';
  });
</script>

{#if selectedRunIds.length >= 2}
  <div class="run-tabs">
    <button class="tab-btn" class:active={activeCompareTab === 'summary'} onclick={() => activeCompareTab = 'summary'}>
      Summary &amp; Params
    </button>
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
    <button
      class="tab-btn"
      class:active={activeCompareTab === 'perf'}
      onclick={() => activeCompareTab = 'perf'}
    >
      Perf
    </button>
    <button
      class="tab-btn"
      class:active={activeCompareTab === 'host_metrics'}
      onclick={() => activeCompareTab = 'host_metrics'}
    >
      Host Metrics
    </button>
  </div>

  {#if activeCompareTab === 'summary'}
    {@const chartVals = summaryChartValues()}
    {@const chartValid = chartVals.filter((d): d is typeof d & { value: number } => d.value !== null)}
    {@const chartMax = chartValid.length ? Math.max(...chartValid.map((d) => d.value)) : 1}
    {@const barWidth = 40}
    {@const barGap = 24}
    {@const chartPadL = 60}
    {@const chartPadR = 20}
    {@const chartPadT = 20}
    {@const chartPadB = 48}
    {@const chartH = 220}
    {@const totalW = chartPadL + chartVals.length * (barWidth + barGap) - barGap + chartPadR}
    {@const plotH = chartH - chartPadT - chartPadB}

    <div class="card summary-tab-card">
      <div class="row section-header compact">
        <h3 style="margin:0">{summaryTitle}</h3>
      </div>

      <div class="summary-metric-pills">
        {#each activeSummaryMetrics as metric}
          <button
            class="metric-pill"
            class:active={selectedSummaryMetric?.key === metric.key}
            onclick={() => selectedSummaryMetricKey = metric.key}
          >{metric.label}</button>
        {/each}
      </div>

      {#if chartValid.length > 0 && selectedSummaryMetric}
        <div class="summary-chart-shell">
          <svg
            class="summary-bar-chart"
            viewBox="0 0 {totalW} {chartH}"
            width={totalW}
            height={chartH}
            role="img"
            aria-label="Summary metric bar chart"
          >
            {#each [0, 0.25, 0.5, 0.75, 1] as tick}
              {@const y = chartPadT + plotH - tick * plotH}
              <line x1={chartPadL} y1={y} x2={totalW - chartPadR} y2={y} stroke={tick === 0 ? '#ccc' : '#f0f0f0'} stroke-width="1" />
              <text x={chartPadL - 6} y={y + 4} text-anchor="end" font-size="10" fill="#999">
                {(chartMax * tick).toLocaleString(undefined, { maximumFractionDigits: selectedSummaryMetric.decimals })}
              </text>
            {/each}
            {#each chartVals as d, i}
              {@const x = chartPadL + i * (barWidth + barGap)}
              {@const barH = d.value !== null && chartMax > 0 ? (d.value / chartMax) * plotH : 0}
              {@const barY = chartPadT + plotH - barH}
              {#if d.value !== null}
                <rect x={x} y={barY} width={barWidth} height={barH} fill={d.color} rx="3" opacity="0.85" />
                <text x={x + barWidth / 2} y={barY - 5} text-anchor="middle" font-size="10" fill={d.color} font-weight="600">
                  {d.value.toLocaleString(undefined, { maximumFractionDigits: selectedSummaryMetric.decimals })}
                </text>
              {:else}
                <text x={x + barWidth / 2} y={chartPadT + plotH / 2} text-anchor="middle" font-size="10" fill="#bbb">—</text>
              {/if}
              <text x={x + barWidth / 2} y={chartH - chartPadB + 16} text-anchor="middle" font-size="10" fill={d.color} font-weight="600">
                {d.label}
              </text>
            {/each}
          </svg>
        </div>
      {/if}

      <div class="table-wrap">
        <table class="summary-table">
          <thead>
            <tr>
              <th>Metric</th>
              {#each selectedRunIds as runId, index}
                <th style="color:{COLORS[index % COLORS.length]}">{getRunLabel(runId, true)}</th>
              {/each}
            </tr>
          </thead>
          <tbody>
            {#each activeSummaryMetrics as metric}
              {@const numVals = selectedRunIds.map((runId) => {
                const run = getRunForId(runId);
                const value = run?.[metric.key] ?? null;
                return value !== null ? Number(value) : null;
              })}
              {@const valid = numVals.filter((value): value is number => value !== null)}
              {@const bestVal = valid.length === 0 ? null : metric.higherBetter ? Math.max(...valid) : Math.min(...valid)}
              <tr>
                <td class="metric-label">{metric.label}</td>
                {#each numVals as value}
                  {@const isBest = value !== null && value === bestVal && valid.length >= 2}
                  <td class:winner-cell={isBest}>
                    {#if value !== null}
                      <span class:winner-value={isBest}>
                        {metric.decimals === 0 ? value.toFixed(0) : value.toFixed(metric.decimals)}
                      </span>
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
  {:else if activeCompareTab === 'load'}
    <div class="card">
      <LoadAnalysis runs={selectedRuns} showPhaseFilter={true} />
    </div>
  {:else if activeCompareTab === 'telemetry'}
    <DatabaseTelemetryCompare
      runs={selectedRuns}
      active={activeCompareTab === 'telemetry'}
      excludeSectionKeys={['cloudwatch', 'host_system', 'host_processes']}
    />
  {:else if activeCompareTab === 'cloudwatch'}
    <DatabaseTelemetryCompare
      runs={selectedRuns}
      active={activeCompareTab === 'cloudwatch'}
      title="CloudWatch"
      subtitle="Compare AWS CloudWatch telemetry across the selected runs."
      includeSectionKeys={['cloudwatch']}
      showHeroCards={false}
      showInsightSummary={false}
    />
  {:else if activeCompareTab === 'perf'}
    {#if hasPerfData}
      <section class="card perf-compare-panel">
        <div class="row section-header compact">
          <div>
            <h3 style="margin:0">Perf Compare</h3>
            <span class="section-note">Pick a raw counter or normalized metric, then compare values across selected runs.</span>
          </div>
          <label class="perf-metric-picker">
            Metric
            <select bind:value={selectedPerfMetric}>
              {#each perfMetricOptions() as option}
                <option value={option.key}>{option.label}</option>
              {/each}
            </select>
          </label>
        </div>

        {#if selectedPerfOption && perfCompareRows().length > 0}
          <div class="perf-chart-shell">
            <svg class="perf-compare-chart" viewBox="0 0 760 280" role="img" aria-label="Perf metric comparison chart">
              <line x1="60" y1="230" x2="720" y2="230" stroke="#ddd" />
              <line x1="60" y1="40" x2="60" y2="230" stroke="#ddd" />
              {#each [0, 0.25, 0.5, 0.75, 1] as tick}
                {@const y = 230 - tick * 190}
                <line x1="60" y1={y} x2="720" y2={y} stroke="#f1f1f1" />
                <text x="52" y={y + 4} text-anchor="end" font-size="10" fill="#777">{formatMetric(perfChartBounds().max * tick, 2)}</text>
              {/each}
              {#each selectedRunsWithPerf as entry, index}
                {@const x = perfPointX(index)}
                <line x1={x} y1="230" x2={x} y2="236" stroke="#bbb" />
                <text x={x} y="252" text-anchor="middle" font-size="10" fill={entry.color}>{entry.label}</text>
              {/each}
              {#each perfCompareRows() as row, rowIndex}
                {@const color = COLORS[rowIndex % COLORS.length]}
                {#if row.values.filter((value) => value !== null).length > 1}
                  <polyline
                    points={perfPolyline(row)}
                    fill="none"
                    stroke={color}
                    stroke-width="2"
                    stroke-linejoin="round"
                    stroke-linecap="round"
                  />
                {/if}
                {#each row.values as value, index}
                  {#if value !== null}
                    <circle cx={perfPointX(index)} cy={perfPointY(value)} r="4" fill={color} />
                  {/if}
                {/each}
              {/each}
            </svg>
          </div>

          <div class="perf-legend">
            {#each perfCompareRows() as row, rowIndex}
              <span><i style="background:{COLORS[rowIndex % COLORS.length]}"></i>{row.stepLabel}</span>
            {/each}
          </div>

          <div class="table-wrap">
            <table class="perf-compare-table">
              <thead>
                <tr>
                  <th>Step</th>
                  {#each selectedRunsWithPerf as entry}
                    <th style="color:{entry.color}">{entry.label}</th>
                  {/each}
                  <th>Best</th>
                </tr>
              </thead>
              <tbody>
                {#each perfCompareRows() as row}
                  {@const validValues = row.values.filter((value): value is number => value !== null)}
                  {@const bestValue = validValues.length ? Math.min(...validValues) : null}
                  <tr>
                    <td class="metric-label">{row.stepLabel}</td>
                    {#each row.values as value}
                      <td>{formatMetric(value)}</td>
                    {/each}
                    <td>
                      {#if bestValue !== null}
                        {@const bestIndex = row.values.findIndex((value) => value === bestValue)}
                        <span
                          class="winner-badge"
                          style="border-color:{COLORS[bestIndex % COLORS.length]};color:{COLORS[bestIndex % COLORS.length]}"
                        >
                          {getRunLabel(selectedRunIds[bestIndex], true)}
                        </span>
                      {/if}
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {:else}
          <div class="empty-state">The selected metric has no comparable values.</div>
        {/if}
      </section>

    {:else}
      <div class="card empty-state">No perf data was collected for the selected runs.</div>
    {/if}
  {:else if activeCompareTab === 'host_metrics'}
    <div class="host-sub-tabs">
      <button
        class="host-sub-btn"
        class:active={hostMetricsTab === 'system'}
        onclick={() => hostMetricsTab = 'system'}
      >System</button>
      <button
        class="host-sub-btn"
        class:active={hostMetricsTab === 'processes'}
        onclick={() => hostMetricsTab = 'processes'}
      >Processes</button>
    </div>
    <DatabaseTelemetryCompare
      runs={selectedRuns}
      active={activeCompareTab === 'host_metrics'}
      title={hostMetricsTab === 'system' ? 'System Metrics' : 'Process Metrics'}
      subtitle={hostMetricsTab === 'system'
        ? 'Compare self-hosted machine CPU, memory, disk, and network telemetry across the selected runs.'
        : 'Compare self-hosted PostgreSQL process telemetry across the selected runs.'}
      includeSectionKeys={hostMetricsTab === 'system' ? ['host_system'] : ['host_processes']}
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

  .host-sub-tabs {
    display: flex;
    gap: 4px;
    margin-bottom: 12px;
  }

  .host-sub-btn {
    background: #f0f4ff;
    border: 1px solid #c8d8f5;
    border-radius: 6px;
    padding: 5px 14px;
    font-size: 12px;
    font-weight: 600;
    color: #3355aa;
    cursor: pointer;
  }

  .host-sub-btn:hover {
    background: #dce8ff;
    border-color: #aabfe8;
  }

  .host-sub-btn.active {
    background: #0066cc;
    border-color: #0055bb;
    color: #fff;
  }

  .summary-tab-card {
    margin-bottom: 12px;
  }

  .summary-metric-pills {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-bottom: 14px;
  }

  .metric-pill {
    padding: 4px 12px;
    border-radius: 999px;
    border: 1.5px solid #c8d8f5;
    background: #f0f4ff;
    color: #3355aa;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.12s, border-color 0.12s;
  }

  .metric-pill:hover {
    background: #dce8ff;
    border-color: #aabfe8;
  }

  .metric-pill.active {
    background: #0066cc;
    border-color: #0055bb;
    color: #fff;
  }

  .summary-chart-shell {
    overflow-x: auto;
    border: 1px solid #eee;
    border-radius: 6px;
    background: #fafafa;
    margin-bottom: 16px;
  }

  .summary-bar-chart {
    display: block;
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
    margin-top: 12px;
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

  .perf-compare-panel {
    margin-bottom: 12px;
  }

  .perf-metric-picker {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-left: auto;
    font-size: 12px;
    font-weight: 600;
    color: #666;
  }

  .perf-metric-picker select {
    min-width: 240px;
    padding: 5px 8px;
    border: 1px solid #d8d8d8;
    border-radius: 5px;
    background: #fff;
  }

  .perf-chart-shell {
    overflow-x: auto;
    border: 1px solid #eee;
    border-radius: 6px;
    background: #fff;
    margin-bottom: 10px;
  }

  .perf-compare-chart {
    display: block;
    min-width: 760px;
    width: 100%;
    height: auto;
  }

  .perf-legend {
    display: flex;
    gap: 12px;
    flex-wrap: wrap;
    margin-bottom: 10px;
    font-size: 12px;
    color: #555;
  }

  .perf-legend span {
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }

  .perf-legend i {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    display: inline-block;
  }

  .perf-compare-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
  }

  .perf-compare-table th,
  .perf-compare-table td {
    text-align: left;
    padding: 6px 10px;
    border-bottom: 1px solid #eee;
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
