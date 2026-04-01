<script lang="ts">
  import LineChart from '$lib/LineChart.svelte';
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
  let selectedSeriesLabel = $state<string | null>(null);

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

  const metricOptions = $derived(firstSection?.chartMetrics ?? []);
  const isGrouped = $derived(metricOptions.length > 0);

  const activeMetric = $derived.by((): TelemetryChartMetric | null => {
    if (!metricOptions.length) return null;
    const key = selectedMetricKey ?? firstSection?.defaultChartMetricKey ?? metricOptions[0].key;
    return metricOptions.find((metric) => metric.key === key) ?? metricOptions[0];
  });

  const seriesOptions = $derived.by(() => {
    const labels = new Set<string>();

    for (const run of runs) {
      const section = sectionsByRun[run.id];
      if (!section || section.status !== 'ok') continue;

      if (activeMetric) {
        const runMetric =
          section.chartMetrics?.find((metric) => metric.key === activeMetric.key) ??
          section.chartMetrics?.[0];
        for (const series of runMetric?.series ?? []) labels.add(series.label);
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
          ? (section.chartMetrics?.find((metric) => metric.key === activeMetric.key) ?? section.chartMetrics?.[0])?.series.find(
              (series) => series.label === selectedSeriesLabel
            )
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
    if (activeMetric && selectedSeriesLabel) return `${label} — ${activeMetric.label} · ${selectedSeriesLabel}`;
    if (selectedSeriesLabel) return `${label} — ${selectedSeriesLabel}`;
    return label;
  });

  $effect(() => {
    if (!metricOptions.length) {
      selectedMetricKey = null;
      return;
    }
    if (selectedMetricKey && metricOptions.some((metric) => metric.key === selectedMetricKey)) return;
    selectedMetricKey = firstSection?.defaultChartMetricKey ?? metricOptions[0].key;
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
    <div class="chart-controls">
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

      {#if seriesOptions.length > 1}
        <label>
          {isGrouped ? 'Group' : 'Series'}
          <select bind:value={selectedSeriesLabel}>
            {#each seriesOptions as seriesLabel}
              <option value={seriesLabel}>{seriesLabel}</option>
            {/each}
          </select>
        </label>
      {/if}
    </div>
  {/if}

  <div class="alignment-note">Lines are aligned to each run&apos;s first selected telemetry sample.</div>

  {#if mergedSeries.length > 0}
    <LineChart
      title={chartTitle}
      series={mergedSeries}
      showAllSeriesByDefault={true}
    />
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
