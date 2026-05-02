<script lang="ts">
  import LineChart from '$lib/LineChart.svelte';
  import BarChart from '$lib/BarChart.svelte';
  import { formatValue } from '$lib/telemetry/format';
  import TelemetryValueCard from '$lib/telemetry/TelemetryValueCard.svelte';
  import type { TelemetryChartMetric, TelemetryMarker, TelemetrySection, TelemetryTableSnapshot, TelemetryValueKind } from '$lib/telemetry/types';

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
  let selectedChartMetricGroup = $state<string | null>(null);
  let selectedChartMetricEntity = $state<string | null>(null);
  let selectedCategory = $state<'all' | 'raw' | 'derived'>('all');
  let tableExpanded = $state(false);
  let selectedTableTime = $state<number | null>(null);
  let lastSectionKey = $state('');
  let selectedValueView = $state<'rate' | 'raw' | 'avg'>('rate');
  let showAllEntries = $state(false);

  const chartMetricGroups = $derived.by(() => {
    const groups: string[] = [];
    for (const metric of section.chartMetrics ?? []) {
      const group = metric.group ?? 'Metrics';
      if (!groups.includes(group)) groups.push(group);
    }
    return groups;
  });

  const activeChartMetricGroup = $derived(selectedChartMetricGroup ?? chartMetricGroups[0] ?? null);

  const groupedChartMetrics = $derived.by((): TelemetryChartMetric[] => {
    const metrics = section.chartMetrics ?? [];
    if (chartMetricGroups.length <= 1) return metrics;
    return metrics.filter((metric) => (metric.group ?? 'Metrics') === activeChartMetricGroup);
  });

  const chartMetricEntities = $derived.by(() => {
    const entities: string[] = [];
    for (const metric of groupedChartMetrics) {
      if (!metric.entity) continue;
      if (!entities.includes(metric.entity)) entities.push(metric.entity);
    }
    return entities;
  });

  const activeChartMetricEntity = $derived(selectedChartMetricEntity ?? chartMetricEntities[0] ?? null);

  const entitySelectorLabel = $derived(
    activeChartMetricGroup === 'Block Devices'
      ? 'Device'
      : activeChartMetricGroup === 'Network'
        ? 'Interface'
        : 'Target'
  );

  const hasCategories = $derived(
    (section.chartMetrics ?? []).some((m) => m.category === 'raw') &&
    (section.chartMetrics ?? []).some((m) => m.category === 'derived')
  );

  const visibleChartMetrics = $derived.by((): TelemetryChartMetric[] => {
    let metrics = chartMetricEntities.length === 0
      ? groupedChartMetrics
      : groupedChartMetrics.filter((metric) => metric.entity === activeChartMetricEntity);
    if (selectedCategory !== 'all') {
      metrics = metrics.filter((m) => m.category === selectedCategory || !m.category);
    }
    return metrics;
  });

  const activeChartMetric = $derived.by(() => {
    if (!visibleChartMetrics.length) return null;
    const selected =
      selectedChartMetricKey ?? section.defaultChartMetricKey ?? visibleChartMetrics[0].key;
    return visibleChartMetrics.find((metric) => metric.key === selected) ?? visibleChartMetrics[0];
  });
  const activeMetricHasRaw = $derived(!!activeChartMetric?.rawSeries?.length);
  const activeMetricHasMore = $derived(!!activeChartMetric?.allSeries?.length);
  const activeValueView = $derived(
    selectedValueView === 'avg' ? 'avg'
    : activeMetricHasRaw ? selectedValueView
    : 'rate'
  );
  const activeChartSeries = $derived.by(() => {
    if (!activeChartMetric) return section.chartSeries;
    if (activeValueView === 'raw') {
      if (showAllEntries && activeChartMetric.allRawSeries?.length) return activeChartMetric.allRawSeries;
      return activeChartMetric.rawSeries ?? [];
    }
    if (showAllEntries && activeChartMetric.allSeries?.length) return activeChartMetric.allSeries;
    return activeChartMetric.series;
  });
  const activeChartTitle = $derived.by(() => {
    const title = activeChartMetric?.title ?? section.chartTitle;
    if (activeValueView === 'avg') return `${title} · Avg`;
    if (!activeMetricHasRaw) return title;
    return `${title} · ${activeValueView === 'raw' ? 'Raw delta' : 'Rate/s'}`;
  });

  const tableSnapshots = $derived(section.tableSnapshots ?? []);
  const latestTableSnapshot = $derived(tableSnapshots.length > 0 ? tableSnapshots[tableSnapshots.length - 1] : null);
  const displayedTableSnapshot = $derived.by(() => {
    if (tableSnapshots.length === 0) return null;
    if (selectedTableTime !== null) {
      return tableSnapshots.find((snapshot) => snapshot.t === selectedTableTime) ?? latestTableSnapshot;
    }
    return latestTableSnapshot;
  });
  const displayedTableRows = $derived(displayedTableSnapshot?.rows ?? section.tableRows);

  $effect(() => {
    const metrics = visibleChartMetrics;
    if (!metrics.length) {
      selectedChartMetricKey = null;
      return;
    }
    if (selectedChartMetricKey && metrics.some((metric) => metric.key === selectedChartMetricKey)) return;
    selectedChartMetricKey = metrics.some((metric) => metric.key === section.defaultChartMetricKey)
      ? (section.defaultChartMetricKey ?? metrics[0].key)
      : metrics[0].key;
  });

  $effect(() => {
    if (chartMetricGroups.length === 0) {
      selectedChartMetricGroup = null;
      return;
    }
    if (selectedChartMetricGroup && chartMetricGroups.includes(selectedChartMetricGroup)) return;
    selectedChartMetricGroup = chartMetricGroups[0];
  });

  $effect(() => {
    if (chartMetricEntities.length === 0) {
      selectedChartMetricEntity = null;
      return;
    }
    if (selectedChartMetricEntity && chartMetricEntities.includes(selectedChartMetricEntity)) return;
    selectedChartMetricEntity = chartMetricEntities[0];
  });

  $effect(() => {
    if (lastSectionKey === section.key) return;
    lastSectionKey = section.key;
    tableExpanded = false;
    selectedChartMetricGroup = null;
    selectedChartMetricEntity = null;
    selectedCategory = 'all';
    showAllEntries = false;
  });

  $effect(() => {
    if (tableSnapshots.length === 0) {
      selectedTableTime = null;
      return;
    }
    if (selectedTableTime !== null && tableSnapshots.some((snapshot) => snapshot.t === selectedTableTime)) return;
    selectedTableTime = latestTableSnapshot?.t ?? null;
  });

  $effect(() => {
    if (!activeMetricHasRaw && selectedValueView === 'raw') selectedValueView = 'rate';
  });

  function findNearestSnapshot(time: number): TelemetryTableSnapshot | null {
    if (tableSnapshots.length === 0) return null;
    return tableSnapshots.reduce((nearest, snapshot) =>
      Math.abs(snapshot.t - time) < Math.abs(nearest.t - time) ? snapshot : nearest
    );
  }

  function handleChartHoverTime(time: number | null) {
    if (time === null) return;
    const snapshot = findNearestSnapshot(time);
    if (snapshot) selectedTableTime = snapshot.t;
  }

  function formatSnapshotTime(t: number): string {
    if (originMs != null) {
      return new Date(originMs + t).toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
      });
    }

    const seconds = Math.round(t / 1000);
    if (seconds < 60) return `+${seconds}s`;
    return `+${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  }
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

    {#if chartMetricGroups.length > 1}
      <div class="chart-group-tabs" aria-label="Metric sections">
        {#each chartMetricGroups as group}
          <button
            type="button"
            class="chart-group-tab"
            class:active={(selectedChartMetricGroup ?? chartMetricGroups[0]) === group}
            onclick={() => {
              selectedChartMetricGroup = group;
              selectedChartMetricEntity = null;
              selectedChartMetricKey = null;
            }}
          >{group}</button>
        {/each}
      </div>
    {/if}

    {#if hasCategories}
      <div class="category-toggle" aria-label="Metric category">
        <button
          type="button"
          class:active={selectedCategory === 'all'}
          onclick={() => { selectedCategory = 'all'; selectedChartMetricKey = null; }}
        >All</button>
        <button
          type="button"
          class:active={selectedCategory === 'raw'}
          onclick={() => { selectedCategory = 'raw'; selectedChartMetricKey = null; }}
        >Raw</button>
        <button
          type="button"
          class:active={selectedCategory === 'derived'}
          onclick={() => { selectedCategory = 'derived'; selectedChartMetricKey = null; }}
        >Derived</button>
      </div>
    {/if}

    {#if visibleChartMetrics.length > 0}
      <div class="chart-metric-toolbar">
        {#if chartMetricEntities.length > 0}
          <label class="chart-entity-select-label">
            <span>{entitySelectorLabel}</span>
            <select
              class="chart-entity-select"
              value={activeChartMetricEntity ?? ''}
              onchange={(event) => {
                selectedChartMetricEntity = event.currentTarget.value;
                selectedChartMetricKey = null;
              }}
            >
              {#each chartMetricEntities as entity}
                <option value={entity}>{entity}</option>
              {/each}
            </select>
          </label>
        {/if}
        <span class="chart-metric-label">Metric</span>
        <div class="chart-metric-list">
          {#each visibleChartMetrics as metric}
            <button
              type="button"
              class="chart-metric-chip"
              class:active={activeChartMetric?.key === metric.key}
              onclick={() => selectedChartMetricKey = metric.key}
            >{metric.label}</button>
          {/each}
        </div>
        {#if activeMetricHasMore}
          <div class="entries-toggle" aria-label="Entries scope">
            <button
              type="button"
              class:active={!showAllEntries}
              onclick={() => showAllEntries = false}
            >Top 5</button>
            <button
              type="button"
              class:active={showAllEntries}
              onclick={() => showAllEntries = true}
            >Active</button>
          </div>
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
      </div>
    {/if}

    {#if activeValueView === 'avg'}
      <BarChart
        title={activeChartTitle}
        series={activeChartSeries}
      />
    {:else}
      <LineChart
        title={activeChartTitle}
        series={activeChartSeries}
        {markers}
        {originMs}
        showAllSeriesByDefault={!!activeChartMetric}
        onHoverTimeChange={handleChartHoverTime}
      />
    {/if}

    {#if displayedTableRows.length > 0}
      <div class="table-block">
        <div class="table-header">
          <div>
            <div class="table-title">{section.tableTitle}</div>
            <div class="table-subtitle">
              {#if displayedTableSnapshot}
                Snapshot: {formatSnapshotTime(displayedTableSnapshot.t)}
              {:else}
                Final snapshot
              {/if}
            </div>
          </div>
          <button
            type="button"
            class="table-toggle"
            aria-expanded={tableExpanded}
            onclick={() => tableExpanded = !tableExpanded}
          >
            {tableExpanded ? 'Hide table' : 'Show table'}
          </button>
        </div>

        {#if tableExpanded}
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
                {#each displayedTableRows as row}
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
        {/if}
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
    color: var(--accent);
    border-bottom-color: var(--accent);
  }

  .entries-toggle {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    border: 1px solid #d7dee8;
    border-radius: 8px;
    background: #f1f5f9;
    padding: 2px;
    align-self: flex-start;
  }

  .entries-toggle button {
    min-width: 44px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: #64748b;
    cursor: pointer;
    font-size: 12px;
    font-weight: 700;
    padding: 5px 10px;
  }

  .entries-toggle button:hover {
    color: var(--accent);
  }

  .entries-toggle button.active {
    background: #fff;
    color: var(--accent);
    box-shadow: 0 1px 2px rgba(15, 23, 42, 0.12);
  }

  .category-toggle {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    border: 1px solid #d7dee8;
    border-radius: 8px;
    background: #f1f5f9;
    padding: 2px;
    align-self: flex-start;
  }

  .category-toggle button {
    min-width: 60px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: #64748b;
    cursor: pointer;
    font-size: 12px;
    font-weight: 700;
    padding: 5px 10px;
  }

  .category-toggle button:hover {
    color: var(--accent);
  }

  .category-toggle button.active {
    background: #fff;
    color: var(--accent);
    box-shadow: 0 1px 2px rgba(15, 23, 42, 0.12);
  }

  .chart-metric-toolbar {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
  }

  .chart-entity-select-label {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    color: #666;
    font-weight: 700;
    text-transform: uppercase;
  }

  .chart-entity-select {
    min-width: 108px;
    border: 1px solid #d1d5db;
    border-radius: 6px;
    background: #fff;
    color: #1f2937;
    font-size: 12px;
    font-weight: 600;
    padding: 4px 28px 4px 8px;
    text-transform: none;
  }

  .chart-entity-select:focus {
    outline: 2px solid color-mix(in srgb, var(--accent) 28%, transparent);
    border-color: var(--accent);
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

  .value-view-control {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin-left: 4px;
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
    color: var(--accent);
  }

  .value-view-toggle button.active {
    background: #fff;
    color: var(--accent);
    box-shadow: 0 1px 2px rgba(15, 23, 42, 0.12);
  }

  .table-block {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .table-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
  }

  .table-title {
    font-size: 12px;
    font-weight: 700;
    color: #444;
    text-transform: uppercase;
  }

  .table-subtitle {
    margin-top: 2px;
    font-size: 12px;
    color: #6b7280;
  }

  .table-toggle {
    border: 1px solid #d9d9d9;
    background: #fff;
    color: #444;
    border-radius: 999px;
    padding: 5px 12px;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
  }

  .table-toggle:hover {
    border-color: var(--accent);
    color: var(--accent);
  }

  .table-wrap {
    overflow-x: auto;
    max-height: 280px;
    overflow-y: auto;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
  }

  th, td {
    padding: 6px 8px;
    border-bottom: 1px solid #eee;
    text-align: left;
    vertical-align: top;
  }

  th {
    position: sticky;
    top: 0;
    background: #fff;
    z-index: 1;
    font-weight: 700;
    color: #555;
  }

  td.mono {
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  }

  @media (max-width: 720px) {
    .telemetry-section-panel {
      padding: 12px;
    }
  }
</style>
