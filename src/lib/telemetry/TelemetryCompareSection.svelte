<script lang="ts">
  import LineChart from '$lib/LineChart.svelte';
  import BarChart from '$lib/BarChart.svelte';
  import { formatValue } from '$lib/telemetry/format';
  import type { TelemetryChartMetric, TelemetrySection } from '$lib/telemetry/types';

  interface CompareRun {
    id: number;
    label: string;
    color: string;
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

  const activeMetricHasRaw = $derived(!!activeMetric?.rawSeries?.length);
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

      if (activeMetric) {
        const runMetric = findComparableMetric(section, activeMetric);
        for (const series of metricSeriesForView(runMetric)) labels.add(series.label);
      } else {
        for (const series of section.chartSeries) labels.add(series.label);
      }
    }

    return [...labels];
  });

  const summaryRows = $derived.by(() => {
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

        const sourceSeries = activeMetric
          ? metricSeriesForView(findComparableMetric(section, activeMetric)).find((series) => series.label === selectedSeriesLabel)
          : section.chartSeries.find((series) => series.label === selectedSeriesLabel);

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

  {#if metricOptions.length > 0 || seriesOptions.length > 1}
    {#if metricGroups.length > 1}
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
      {#if metricEntities.length > 0}
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

      {#if metricOptions.length > 0}
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
