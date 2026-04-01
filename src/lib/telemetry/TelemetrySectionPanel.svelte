<script lang="ts">
  import LineChart from '$lib/LineChart.svelte';
  import { formatValue } from '$lib/telemetry/format';
  import TelemetryValueCard from '$lib/telemetry/TelemetryValueCard.svelte';
  import type { TelemetryMarker, TelemetrySection, TelemetryValueKind } from '$lib/telemetry/types';

  let {
    section,
    markers = [],
    originMs = null,
    runLabel = '',
    accentColor = '',
    showTitle = true
  }: {
    section: TelemetrySection;
    markers?: TelemetryMarker[];
    originMs?: number | null;
    runLabel?: string;
    accentColor?: string;
    showTitle?: boolean;
  } = $props();

  let selectedChartMetricKey = $state<string | null>(null);

  const activeChartMetric = $derived.by(() => {
    if (!section.chartMetrics?.length) return null;
    const selected =
      selectedChartMetricKey ?? section.defaultChartMetricKey ?? section.chartMetrics[0].key;
    return section.chartMetrics.find((metric) => metric.key === selected) ?? section.chartMetrics[0];
  });

  $effect(() => {
    const metrics = section.chartMetrics ?? [];
    if (!metrics.length) {
      selectedChartMetricKey = null;
      return;
    }
    if (selectedChartMetricKey && metrics.some((metric) => metric.key === selectedChartMetricKey)) return;
    selectedChartMetricKey = section.defaultChartMetricKey ?? metrics[0].key;
  });
</script>

<section class="telemetry-section-panel" style={accentColor ? `--accent:${accentColor}` : ''}>
  <div class="section-header">
    <div>
      {#if showTitle}
        <h4 style="margin:0">{section.label}</h4>
      {/if}
      {#if runLabel}
        <div class="run-label-row">
          <span class="run-label-dot"></span>
          <span class="run-label-text">{runLabel}</span>
        </div>
      {/if}
      {#if section.reason && section.status !== 'ok'}
        <div class="section-reason">{section.reason}</div>
      {/if}
    </div>
    <span class="section-status {section.status}">{section.status.replace('_', ' ')}</span>
  </div>

  {#if section.status === 'ok'}
    <div class="summary-grid">
      {#each section.summary as card}
        <TelemetryValueCard {card} variant="summary" />
      {/each}
    </div>

    {#if section.chartMetrics && section.chartMetrics.length > 0}
      <div class="chart-metric-toolbar">
        <span class="chart-metric-label">Metric</span>
        <div class="chart-metric-list">
          {#each section.chartMetrics as metric}
            <button
              type="button"
              class="chart-metric-chip"
              class:active={activeChartMetric?.key === metric.key}
              onclick={() => selectedChartMetricKey = metric.key}
            >{metric.label}</button>
          {/each}
        </div>
      </div>
    {/if}

    <LineChart
      title={activeChartMetric?.title ?? section.chartTitle}
      series={activeChartMetric?.series ?? section.chartSeries}
      {markers}
      {originMs}
      showAllSeriesByDefault={!!activeChartMetric}
    />

    {#if section.tableRows.length > 0}
      <div class="table-block">
        <div class="table-title">{section.tableTitle}</div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                {#each section.tableColumns as column}
                  <th>{column.label}</th>
                {/each}
              </tr>
            </thead>
            <tbody>
              {#each section.tableRows as row}
                <tr>
                  {#each section.tableColumns as column}
                    <td class:mono={column.kind !== 'text' && column.kind !== 'flag'}>
                      {formatValue(
                        row[column.key],
                        column.key === 'value'
                          ? ((row.value_kind as TelemetryValueKind | undefined) ?? column.kind ?? 'text')
                          : (column.kind ?? 'text')
                      )}
                    </td>
                  {/each}
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      </div>
    {/if}
  {/if}
</section>

<style>
  .telemetry-section-panel {
    --accent: #0f172a;
    border: 1px solid #e8edf3;
    border-radius: 12px;
    padding: 14px;
    background: linear-gradient(180deg, #ffffff 0%, #fbfcfe 100%);
    display: flex;
    flex-direction: column;
    gap: 12px;
    min-width: 0;
  }

  .section-header {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    align-items: flex-start;
    flex-wrap: wrap;
  }

  .run-label-row {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    margin-top: 4px;
    font-size: 13px;
    font-weight: 700;
    color: #213247;
  }

  .run-label-dot {
    width: 10px;
    height: 10px;
    border-radius: 999px;
    background: var(--accent);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 18%, white);
  }

  .run-label-text {
    color: color-mix(in srgb, var(--accent) 82%, #1f2937);
  }

  .section-status {
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    border-radius: 999px;
    padding: 3px 8px;
  }

  .section-status.ok {
    background: #e8f7f1;
    color: #0b6b50;
  }

  .section-status.no_data {
    background: #fff4e5;
    color: #9a4d00;
  }

  .section-status.unsupported {
    background: #f2f2f2;
    color: #666;
  }

  .section-reason {
    margin-top: 4px;
    color: #777;
    font-size: 12px;
  }

  .summary-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: 8px;
  }

  .chart-metric-toolbar {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
  }

  .chart-metric-label {
    font-size: 11px;
    color: #666;
    font-weight: 700;
    text-transform: uppercase;
  }

  .chart-metric-list {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }

  .chart-metric-chip {
    border: 1px solid #d9d9d9;
    background: #fff;
    color: #666;
    border-radius: 999px;
    padding: 4px 10px;
    font-size: 12px;
    cursor: pointer;
  }

  .chart-metric-chip.active {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
  }

  .table-block {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .table-title {
    font-size: 12px;
    font-weight: 700;
    color: #444;
    text-transform: uppercase;
  }

  .table-wrap {
    overflow-x: auto;
    max-height: 280px;
    overflow-y: auto;
  }

  .mono {
    font-family: monospace;
  }

  @media (max-width: 720px) {
    .telemetry-section-panel {
      padding: 12px;
    }
  }
</style>
