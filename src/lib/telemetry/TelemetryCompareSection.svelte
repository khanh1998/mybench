<script lang="ts">
  import LineChart from '$lib/LineChart.svelte';
  import BarChart from '$lib/BarChart.svelte';
  import { formatValue } from '$lib/telemetry/format';
  import type { TelemetryChartMetric, TelemetrySection, TelemetrySeries, TelemetryValueKind } from '$lib/telemetry/types';

  interface CompareRun {
    id: number;
    label: string;
    color: string;
  }

  interface ProcessInfo {
    pid: number;
    processName: string;
  }

  interface ProcessCompareOption {
    key: string;
    label: string;
    type: 'all' | 'client' | 'internal' | 'internal_process';
  }

  interface SummaryCompareRow {
    key: string;
    label: string;
    kind: TelemetryValueKind;
    values: Record<number, unknown>;
  }

  let {
    label,
    runs,
    sectionsByRun
  }: {
    label: string;
    runs: CompareRun[];
    sectionsByRun: Record<number, TelemetrySection>;
  } = $props();

  let selectedMetricKey = $state<string | null>(null);
  let selectedMetricGroup = $state<string | null>(null);
  let selectedMetricEntity = $state<string | null>(null);
  let selectedSeriesLabel = $state<string | null>(null);
  let selectedValueView = $state<'rate' | 'raw' | 'avg'>('rate');
  let selectedProcessKey = $state<string | null>(null);
  let selectedProcessMetricType = $state<ProcessMetricTypeKey>('cpu');

  const PROCESS_METRIC_TYPES = [
    { key: 'cpu',         label: 'CPU' },
    { key: 'faults',      label: 'Faults' },
    { key: 'mem',         label: 'Mem' },
    { key: 'io_bytes',    label: 'I/O Bytes' },
    { key: 'io_chars',    label: 'I/O Chars' },
    { key: 'io_syscalls', label: 'I/O Calls' },
    { key: 'sched',       label: 'Sched Time' },
    { key: 'timeslices',  label: 'Timeslices' },
    { key: 'ctx',         label: 'Ctx Switches' },
    { key: 'threads',     label: 'Threads' },
    { key: 'fds',         label: 'FDs' },
  ] as const;
  type ProcessMetricTypeKey = typeof PROCESS_METRIC_TYPES[number]['key'];

  function alignSeriesToFirstPoint(points: { t: number; v: number }[]) {
    if (!points.length) return points;
    const start = points[0].t;
    return points.map((point) => ({
      ...point,
      t: point.t - start
    }));
  }

  const firstSection = $derived.by(() => {
    const sections = runs.map((run) => sectionsByRun[run.id]).filter((section): section is TelemetrySection => !!section);
    return sections.find((section) => section.status === 'ok') ?? sections[0] ?? null;
  });
  const isHostProcessesSection = $derived(firstSection?.key === 'host_processes');

  const allMetricOptions = $derived(firstSection?.chartMetrics ?? []);
  const metricGroups = $derived.by(() => {
    const groups: string[] = [];
    for (const metric of allMetricOptions) {
      const group = metric.group ?? 'Metrics';
      if (!groups.includes(group)) groups.push(group);
    }
    return groups;
  });
  const activeMetricGroup = $derived(selectedMetricGroup ?? metricGroups[0] ?? null);
  const groupedMetricOptions = $derived.by((): TelemetryChartMetric[] => {
    if (metricGroups.length <= 1) return allMetricOptions;
    return allMetricOptions.filter((metric) => (metric.group ?? 'Metrics') === activeMetricGroup);
  });
  const metricEntities = $derived.by(() => {
    const entities: string[] = [];
    for (const metric of groupedMetricOptions) {
      if (!metric.entity) continue;
      if (!entities.includes(metric.entity)) entities.push(metric.entity);
    }
    return entities;
  });
  const activeMetricEntity = $derived(selectedMetricEntity ?? metricEntities[0] ?? null);
  const entitySelectorLabel = $derived(
    activeMetricGroup === 'Block Devices'
      ? 'Device'
      : activeMetricGroup === 'Network'
        ? 'Interface'
        : activeMetricGroup === 'CPU Sched'
          ? 'CPU'
          : 'Target'
  );
  const metricOptions = $derived.by((): TelemetryChartMetric[] => {
    if (metricEntities.length === 0) return groupedMetricOptions;
    return groupedMetricOptions.filter((metric) => metric.entity === activeMetricEntity);
  });

  const activeMetric = $derived.by((): TelemetryChartMetric | null => {
    if (!metricOptions.length) return null;
    const key = selectedMetricKey ?? firstSection?.defaultChartMetricKey ?? metricOptions[0].key;
    return metricOptions.find((metric) => metric.key === key) ?? metricOptions[0];
  });

  function processesForSection(section: TelemetrySection | null | undefined): ProcessInfo[] {
    if (!section || section.status !== 'ok') return [];
    const seen = new Set<number>();
    const list: ProcessInfo[] = [];
    for (const row of section.tableRows) {
      const pid = Number(row.pid);
      if (!pid || seen.has(pid)) continue;
      seen.add(pid);
      list.push({
        pid,
        processName: String(row.processName ?? row.comm ?? `pid:${pid}`),
      });
    }
    return list;
  }

  function clientGroupKey(processName: string): string {
    return processName.replace(/\s*\(.*\)$/, '').trim();
  }

  function pidsForProcessSelection(section: TelemetrySection | null | undefined, processKey: string | null): number[] {
    const processes = processesForSection(section);
    if (!processKey) return [];
    if (processKey === '__all__') return processes.map((process) => process.pid);
    if (processKey === '__internals__') return processes.filter((process) => !process.processName.includes('/')).map((process) => process.pid);
    if (processKey.startsWith('internal:')) {
      const processName = processKey.slice('internal:'.length);
      return processes
        .filter((process) => !process.processName.includes('/') && process.processName === processName)
        .map((process) => process.pid);
    }
    return processes
      .filter((process) => process.processName.includes('/') && clientGroupKey(process.processName) === processKey)
      .map((process) => process.pid);
  }

  function hasProcessMetric(section: TelemetrySection | null | undefined, pids: number[], typeKey: ProcessMetricTypeKey): boolean {
    if (!section || section.status !== 'ok') return false;
    return pids.some((pid) => !!(section.chartMetrics ?? []).find((metric) => metric.key === `pid_${pid}_${typeKey}`));
  }

  function getAggregatedProcessMetric(section: TelemetrySection | null | undefined, pids: number[], typeKey: ProcessMetricTypeKey): TelemetryChartMetric | null {
    if (!section || section.status !== 'ok') return null;
    const metrics = pids
      .map((pid) => (section.chartMetrics ?? []).find((metric) => metric.key === `pid_${pid}_${typeKey}`) ?? null)
      .filter((metric): metric is TelemetryChartMetric => metric !== null);
    if (metrics.length === 0) return null;
    if (metrics.length === 1) return metrics[0];
    return {
      ...metrics[0],
      label: PROCESS_METRIC_TYPES.find((type) => type.key === typeKey)?.label ?? metrics[0].label,
      title: PROCESS_METRIC_TYPES.find((type) => type.key === typeKey)?.label ?? metrics[0].title,
      series: sumSeriesArrays(metrics.map((metric) => metric.series)),
      rawSeries: metrics[0].rawSeries?.length
        ? sumSeriesArrays(metrics.map((metric) => metric.rawSeries ?? []))
        : undefined,
    };
  }

  function sumSeriesArrays(seriesArrays: TelemetrySeries[][]): TelemetrySeries[] {
    const labels = [...new Set(seriesArrays.flatMap((seriesArray) => seriesArray.map((series) => series.label)))];
    return labels.map((label) => {
      const matching = seriesArrays
        .map((seriesArray) => seriesArray.find((series) => series.label === label))
        .filter((series): series is TelemetrySeries => !!series);
      const allTs = [...new Set(matching.flatMap((series) => series.points.map((point) => point.t)))].sort((a, b) => a - b);
      return {
        ...matching[0],
        points: allTs.map((t) => ({
          t,
          v: matching.reduce((sum, series) => sum + (series.points.find((point) => point.t === t)?.v ?? 0), 0),
        })),
      };
    });
  }

  const processOptions = $derived.by((): ProcessCompareOption[] => {
    if (!isHostProcessesSection) return [];

    const clients = new Set<string>();
    const internals = new Set<string>();
    let hasAny = false;
    let hasInternals = false;

    for (const run of runs) {
      const section = sectionsByRun[run.id];
      for (const process of processesForSection(section)) {
        hasAny = true;
        if (process.processName.includes('/')) {
          clients.add(clientGroupKey(process.processName));
        } else {
          hasInternals = true;
          internals.add(process.processName);
        }
      }
    }

    const options: ProcessCompareOption[] = [];
    if (hasAny) options.push({ key: '__all__', label: 'All processes (aggregated)', type: 'all' });
    for (const key of [...clients].sort((a, b) => a.localeCompare(b))) {
      options.push({ key, label: `${key} (aggregated)`, type: 'client' });
    }
    if (hasInternals) options.push({ key: '__internals__', label: 'Postgres internals (aggregated)', type: 'internal' });
    for (const name of [...internals].sort((a, b) => a.localeCompare(b))) {
      options.push({ key: `internal:${name}`, label: name, type: 'internal_process' });
    }
    return options;
  });

  const activeProcessOption = $derived(processOptions.find((option) => option.key === selectedProcessKey) ?? processOptions[0] ?? null);
  const allProcessOption = $derived(processOptions.find((option) => option.type === 'all') ?? null);
  const clientProcessOptions = $derived(processOptions.filter((option) => option.type === 'client'));
  const internalProcessGroupOption = $derived(processOptions.find((option) => option.type === 'internal') ?? null);
  const internalProcessOptions = $derived(processOptions.filter((option) => option.type === 'internal_process'));
  const processMetricOptions = $derived.by(() => {
    if (!activeProcessOption) return [];
    return PROCESS_METRIC_TYPES.filter((type) => runs.some((run) => {
      const section = sectionsByRun[run.id];
      const pids = pidsForProcessSelection(section, activeProcessOption.key);
      return hasProcessMetric(section, pids, type.key);
    }));
  });
  const activeProcessMetricType = $derived(
    processMetricOptions.find((type) => type.key === selectedProcessMetricType) ?? processMetricOptions[0] ?? null
  );
  const activeProcessMetric = $derived.by((): TelemetryChartMetric | null => {
    if (!activeProcessOption || !activeProcessMetricType || !firstSection) return null;
    return getAggregatedProcessMetric(
      firstSection,
      pidsForProcessSelection(firstSection, activeProcessOption.key),
      activeProcessMetricType.key
    );
  });
  const activeProcessMetricHasRaw = $derived.by(() => {
    if (!activeProcessOption || !activeProcessMetricType) return false;
    return runs.some((run) => {
      const section = sectionsByRun[run.id];
      const pids = pidsForProcessSelection(section, activeProcessOption.key);
      return !!getAggregatedProcessMetric(section, pids, activeProcessMetricType.key)?.rawSeries?.length;
    });
  });

  const activeMetricHasRaw = $derived(isHostProcessesSection ? activeProcessMetricHasRaw : !!activeMetric?.rawSeries?.length);
  const activeValueView = $derived(
    selectedValueView === 'avg' ? 'avg'
    : activeMetricHasRaw ? selectedValueView
    : 'rate'
  );

  function metricSeriesForView(metric: TelemetryChartMetric | null | undefined, forceRate = false) {
    if (!metric) return [];
    if (!forceRate && activeValueView === 'raw') return metric.rawSeries ?? [];
    return metric.series;
  }

  function findComparableMetric(section: TelemetrySection, reference: TelemetryChartMetric | null): TelemetryChartMetric | null {
    const metrics = section.chartMetrics ?? [];
    if (!reference) return metrics[0] ?? null;
    return metrics.find((metric) => metric.key === reference.key)
      ?? metrics.find((metric) =>
        metric.label === reference.label
        && (metric.group ?? 'Metrics') === (reference.group ?? 'Metrics')
        && (metric.entity ?? '') === (reference.entity ?? '')
      )
      ?? null;
  }

  const seriesOptions = $derived.by(() => {
    const labels = new Set<string>();

    for (const run of runs) {
      const section = sectionsByRun[run.id];
      if (!section || section.status !== 'ok') continue;

      if (isHostProcessesSection) {
        if (!activeProcessOption || !activeProcessMetricType) continue;
        const pids = pidsForProcessSelection(section, activeProcessOption.key);
        const runMetric = getAggregatedProcessMetric(section, pids, activeProcessMetricType.key);
        for (const series of metricSeriesForView(runMetric)) labels.add(series.label);
      } else if (activeMetric) {
        const runMetric = findComparableMetric(section, activeMetric);
        for (const series of metricSeriesForView(runMetric)) labels.add(series.label);
      } else {
        for (const series of section.chartSeries) labels.add(series.label);
      }
    }

    return [...labels];
  });

  const summaryRows = $derived.by((): SummaryCompareRow[] => {
    if (isHostProcessesSection) {
      const processKey = activeProcessOption?.key ?? null;

      function sumField(section: TelemetrySection | null | undefined, field: string): number {
        if (!section || section.status !== 'ok') return 0;
        const activePids = new Set(pidsForProcessSelection(section, processKey));
        return section.tableRows
          .filter((row) => activePids.has(Number(row.pid)))
          .reduce((sum, row) => sum + (Number(row[field]) || 0), 0);
      }

      function pidCount(section: TelemetrySection | null | undefined): number {
        return pidsForProcessSelection(section, processKey).length;
      }

      function valuesFor(getValue: (section: TelemetrySection | null | undefined) => unknown): Record<number, unknown> {
        return Object.fromEntries(runs.map((run) => [run.id, getValue(sectionsByRun[run.id])]));
      }

      return [
        { key: 'processes', label: 'Processes', kind: 'count', values: valuesFor((section) => pidCount(section)) },
        { key: 'rss', label: 'RSS', kind: 'bytes', values: valuesFor((section) => sumField(section, 'vm_rss_kb') * 1024) },
        { key: 'swap', label: 'Swap', kind: 'bytes', values: valuesFor((section) => sumField(section, 'vm_swap_kb') * 1024) },
        { key: 'threads', label: 'Threads', kind: 'count', values: valuesFor((section) => sumField(section, 'threads')) },
        { key: 'fds', label: 'FDs', kind: 'count', values: valuesFor((section) => sumField(section, 'fd_count')) },
        { key: 'cpu_jiffies', label: 'CPU Jiffies', kind: 'count', values: valuesFor((section) => sumField(section, 'cpu_jiffies_delta')) },
        { key: 'major_faults', label: 'Major Faults', kind: 'count', values: valuesFor((section) => sumField(section, 'major_faults_delta')) },
        { key: 'sched_wait', label: 'Sched Wait', kind: 'duration_ms', values: valuesFor((section) => sumField(section, 'sched_wait_ms_delta')) },
      ];
    }

    const cards = firstSection?.summary ?? [];
    return cards.map((card) => ({
      key: card.key,
      label: card.label,
      kind: card.kind,
      values: Object.fromEntries(
        runs.map((run) => [
          run.id,
          sectionsByRun[run.id]?.summary.find((entry) => entry.key === card.key)?.value ?? null
        ])
      )
    }));
  });

  const mergedSeries = $derived.by(() => {
    if (!selectedSeriesLabel) return [];

    return runs
      .map((run) => {
        const section = sectionsByRun[run.id];
        if (!section || section.status !== 'ok') return null;

        const sourceSeries = (() => {
          if (isHostProcessesSection) {
            if (!activeProcessOption || !activeProcessMetricType) return null;
            const pids = pidsForProcessSelection(section, activeProcessOption.key);
            return metricSeriesForView(getAggregatedProcessMetric(section, pids, activeProcessMetricType.key))
              .find((series) => series.label === selectedSeriesLabel) ?? null;
          }
          return activeMetric
            ? metricSeriesForView(findComparableMetric(section, activeMetric)).find((series) => series.label === selectedSeriesLabel) ?? null
            : section.chartSeries.find((series) => series.label === selectedSeriesLabel) ?? null;
        })();

        if (!sourceSeries) return null;
        return {
          label: run.label,
          color: run.color,
          points: alignSeriesToFirstPoint(sourceSeries.points)
        };
      })
      .filter((series): series is { label: string; color: string; points: { t: number; v: number }[] } => series !== null);
  });

  const chartTitle = $derived.by(() => {
    if (isHostProcessesSection) {
      const processLabel = activeProcessOption?.label.replace(/\s*\(aggregated\)$/, '') ?? 'Processes';
      const metricLabel = activeProcessMetricType?.label ?? 'Metric';
      const viewSuffix = activeValueView === 'avg' ? ' · Avg'
        : activeMetricHasRaw ? ` · ${activeValueView === 'raw' ? 'Raw' : 'Rate/s'}`
        : '';
      if (selectedSeriesLabel) return `${label} — ${processLabel} · ${metricLabel}${viewSuffix} · ${selectedSeriesLabel}`;
      return `${label} — ${processLabel} · ${metricLabel}${viewSuffix}`;
    }
    const entity = activeMetric?.entity ? ` · ${activeMetric.entity}` : '';
    const viewSuffix = activeValueView === 'avg' ? ' · Avg'
      : activeMetricHasRaw ? ` · ${activeValueView === 'raw' ? 'Raw' : 'Rate/s'}`
      : '';
    if (activeMetric && selectedSeriesLabel) return `${label} — ${activeMetric.label}${entity}${viewSuffix} · ${selectedSeriesLabel}`;
    if (selectedSeriesLabel) return `${label} — ${selectedSeriesLabel}`;
    return label;
  });

  $effect(() => {
    if (!metricGroups.length) {
      selectedMetricGroup = null;
      return;
    }
    if (selectedMetricGroup && metricGroups.includes(selectedMetricGroup)) return;
    selectedMetricGroup = metricGroups[0];
  });

  $effect(() => {
    if (!metricEntities.length) {
      selectedMetricEntity = null;
      return;
    }
    if (selectedMetricEntity && metricEntities.includes(selectedMetricEntity)) return;
    selectedMetricEntity = metricEntities[0];
  });

  $effect(() => {
    if (!metricOptions.length) {
      selectedMetricKey = null;
      return;
    }
    if (selectedMetricKey && metricOptions.some((metric) => metric.key === selectedMetricKey)) return;
    selectedMetricKey = metricOptions.some((metric) => metric.key === firstSection?.defaultChartMetricKey)
      ? (firstSection?.defaultChartMetricKey ?? metricOptions[0].key)
      : metricOptions[0].key;
  });

  $effect(() => {
    if (!activeMetricHasRaw && selectedValueView === 'raw') selectedValueView = 'rate';
  });

  $effect(() => {
    if (!isHostProcessesSection) {
      selectedProcessKey = null;
      return;
    }
    if (!processOptions.length) {
      selectedProcessKey = null;
      return;
    }
    if (selectedProcessKey && processOptions.some((option) => option.key === selectedProcessKey)) return;
    selectedProcessKey = processOptions[0].key;
  });

  $effect(() => {
    if (!isHostProcessesSection) return;
    if (!processMetricOptions.length) return;
    if (processMetricOptions.some((option) => option.key === selectedProcessMetricType)) return;
    selectedProcessMetricType = processMetricOptions[0].key;
  });

  $effect(() => {
    if (!seriesOptions.length) {
      selectedSeriesLabel = null;
      return;
    }
    if (selectedSeriesLabel && seriesOptions.includes(selectedSeriesLabel)) return;
    selectedSeriesLabel = seriesOptions[0];
  });
</script>

<section class="compare-section-shell">
  <div class="section-header">
    <h4>{label}</h4>
    <span class="compare-section-note">{runs.length} runs</span>
  </div>

  {#if summaryRows.length > 0}
    <div class="summary-compare-grid">
      {#each summaryRows as row}
        <div class="summary-compare-card">
          <div class="summary-compare-label">{row.label}</div>
          <div class="summary-compare-values">
            {#each runs as run}
              <div class="summary-compare-row">
                <span class="summary-run-label" style={`color:${run.color}`}>{run.label}</span>
                <strong>{formatValue(row.values[run.id], row.kind)}</strong>
              </div>
            {/each}
          </div>
        </div>
      {/each}
    </div>
  {/if}

  {#if isHostProcessesSection ? (processOptions.length > 0 || seriesOptions.length > 1) : (metricOptions.length > 0 || seriesOptions.length > 1)}
    {#if !isHostProcessesSection && metricGroups.length > 1}
      <div class="chart-group-tabs" aria-label="Metric categories">
        {#each metricGroups as group}
          <button
            type="button"
            class="chart-group-tab"
            class:active={(selectedMetricGroup ?? metricGroups[0]) === group}
            onclick={() => {
              selectedMetricGroup = group;
              selectedMetricEntity = null;
              selectedMetricKey = null;
            }}
          >{group}</button>
        {/each}
      </div>
    {/if}

    <div class="chart-controls">
      {#if isHostProcessesSection}
        {#if processOptions.length > 0}
          <label>
            Process
            <select bind:value={selectedProcessKey}>
              {#if allProcessOption}
                <option value={allProcessOption.key}>{allProcessOption.label}</option>
              {/if}
              {#each clientProcessOptions as option}
                <optgroup label={option.key}>
                  <option value={option.key}>All matching connections (aggregated)</option>
                </optgroup>
              {/each}
              {#if internalProcessGroupOption || internalProcessOptions.length > 0}
                <optgroup label="Postgres internals">
                  {#if internalProcessGroupOption}
                    <option value={internalProcessGroupOption.key}>All internals (aggregated)</option>
                  {/if}
                  {#each internalProcessOptions as option}
                    <option value={option.key}>{option.label}</option>
                  {/each}
                </optgroup>
              {/if}
            </select>
          </label>
        {/if}

        {#if processMetricOptions.length > 0}
          <label>
            Metric
            <select bind:value={selectedProcessMetricType}>
              {#each processMetricOptions as metric}
                <option value={metric.key}>{metric.label}</option>
              {/each}
            </select>
          </label>
        {/if}
      {:else if metricEntities.length > 0}
        <label>
          {entitySelectorLabel}
          <select
            bind:value={selectedMetricEntity}
            onchange={() => selectedMetricKey = null}
          >
            {#each metricEntities as entity}
              <option value={entity}>{entity}</option>
            {/each}
          </select>
        </label>
      {/if}

      {#if !isHostProcessesSection && metricOptions.length > 0}
        <label>
          Metric
          <select bind:value={selectedMetricKey}>
            {#each metricOptions as metric}
              <option value={metric.key}>{metric.label}</option>
            {/each}
          </select>
        </label>
      {/if}

      <div class="value-view-control" aria-label="Metric value view">
        <span class="value-view-label">View</span>
        <div class="value-view-toggle">
          <button
            type="button"
            class:active={activeValueView === 'rate'}
            onclick={() => selectedValueView = 'rate'}
          >Rate/s</button>
          {#if activeMetricHasRaw}
            <button
              type="button"
              class:active={activeValueView === 'raw'}
              onclick={() => selectedValueView = 'raw'}
            >Raw</button>
          {/if}
          <button
            type="button"
            class:active={activeValueView === 'avg'}
            onclick={() => selectedValueView = 'avg'}
          >Avg</button>
        </div>
      </div>

      {#if seriesOptions.length > 1}
        <label>
          Series
          <select bind:value={selectedSeriesLabel}>
            {#each seriesOptions as seriesLabel}
              <option value={seriesLabel}>{seriesLabel}</option>
            {/each}
          </select>
        </label>
      {/if}
    </div>
  {/if}

  {#if activeValueView !== 'avg'}
    <div class="alignment-note">Lines are aligned to each run&apos;s first selected telemetry sample.</div>
  {/if}

  {#if mergedSeries.length > 0}
    {#if activeValueView === 'avg'}
      <BarChart title={chartTitle} series={mergedSeries} />
    {:else}
      <LineChart
        title={chartTitle}
        series={mergedSeries}
        showAllSeriesByDefault={true}
      />
    {/if}
  {:else}
    <div class="chart-empty">No overlapping telemetry series available for the current selection.</div>
  {/if}
</section>

<style>
  .compare-section-shell {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .section-header {
    display: flex;
    justify-content: space-between;
    gap: 10px;
    align-items: baseline;
    flex-wrap: wrap;
  }

  .section-header h4 {
    margin: 0;
  }

  .compare-section-note {
    color: #777;
    font-size: 12px;
  }

  .summary-compare-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 10px;
  }

  .summary-compare-card {
    border: 1px solid #e6ebf2;
    border-radius: 12px;
    padding: 12px;
    background: linear-gradient(180deg, #ffffff 0%, #f9fbfd 100%);
  }

  .summary-compare-label {
    font-size: 11px;
    color: #666;
    text-transform: uppercase;
    font-weight: 700;
    margin-bottom: 8px;
  }

  .summary-compare-values {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .summary-compare-row {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    align-items: baseline;
    font-size: 13px;
  }

  .summary-run-label {
    font-weight: 700;
  }

  .chart-group-tabs {
    display: flex;
    gap: 2px;
    border-bottom: 1px solid #e5e7eb;
    overflow-x: auto;
  }

  .chart-group-tab {
    background: transparent;
    border: 0;
    border-bottom: 2px solid transparent;
    color: #64748b;
    cursor: pointer;
    font-size: 12px;
    font-weight: 700;
    padding: 6px 10px;
    white-space: nowrap;
  }

  .chart-group-tab:hover {
    color: #1f2937;
    background: #f8fafc;
  }

  .chart-group-tab.active {
    color: #0066cc;
    border-bottom-color: #0066cc;
  }

  .chart-controls {
    display: flex;
    gap: 12px;
    flex-wrap: wrap;
  }

  .chart-controls label {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    font-weight: 600;
    color: #445065;
  }

  .chart-controls select {
    min-width: 180px;
    max-width: 320px;
  }

  .value-view-control {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }

  .value-view-label {
    color: #64748b;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0;
    text-transform: uppercase;
  }

  .value-view-toggle {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    border: 1px solid #d7dee8;
    border-radius: 8px;
    background: #f1f5f9;
    padding: 2px;
  }

  .value-view-toggle button {
    min-width: 58px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: #64748b;
    cursor: pointer;
    font-size: 12px;
    font-weight: 700;
    padding: 5px 10px;
  }

  .value-view-toggle button:hover {
    color: #0066cc;
  }

  .value-view-toggle button.active {
    background: #fff;
    color: #0066cc;
    box-shadow: 0 1px 2px rgba(15, 23, 42, 0.12);
  }

  .chart-empty {
    padding: 20px;
    border: 1px dashed #d8d8d8;
    border-radius: 8px;
    text-align: center;
    color: #777;
    font-size: 13px;
  }

  .alignment-note {
    font-size: 12px;
    color: #6b7280;
  }

  @media (max-width: 720px) {
    .summary-compare-grid {
      grid-template-columns: 1fr;
    }
  }
</style>
