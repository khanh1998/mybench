<script lang="ts">
  import LineChart from '$lib/LineChart.svelte';
  import { formatValue } from '$lib/telemetry/format';
  import type { TelemetrySection, TelemetryMarker, TelemetryChartMetric, TelemetryTableColumn } from '$lib/telemetry/types';

  let {
    section,
    markers = [],
    originMs = null,
  }: {
    section: TelemetrySection;
    markers?: TelemetryMarker[];
    originMs?: number | null;
  } = $props();

  // --- Derive process list from tableRows (populated by buildHostProcessesSection) ---
  interface ProcessInfo {
    pid: number;
    processName: string;
    cmdline: string;
    row: Record<string, unknown>;
  }

  interface WaitChannelSample {
    value: string;
    count: number;
    percent: number;
  }

  const processes = $derived.by((): ProcessInfo[] => {
    const seen = new Set<number>();
    const list: ProcessInfo[] = [];
    for (const row of section.tableRows) {
      const pid = Number(row.pid);
      if (!pid || seen.has(pid)) continue;
      seen.add(pid);
      list.push({
        pid,
        processName: String(row.processName ?? row.comm ?? `pid:${pid}`),
        cmdline:     String(row.cmdline ?? ''),
        row,
      });
    }
    return list;
  });

  const METRIC_TYPES = [
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
  type MetricTypeKey = typeof METRIC_TYPES[number]['key'];

  let selectedPid  = $state<number | null>(null);
  let selectedType = $state<MetricTypeKey>('cpu');
  let tableExpanded = $state(false);
  let selectedValueView = $state<'rate' | 'raw'>('rate');

  // Auto-select first process on load
  $effect(() => {
    if (selectedPid === null && processes.length > 0) {
      selectedPid = processes[0].pid;
    }
  });

  // When pid changes, pick the first available metric type for that pid
  $effect(() => {
    if (selectedPid === null) return;
    const available = METRIC_TYPES.filter(t => hasMetric(selectedPid!, t.key));
    if (available.length > 0 && !hasMetric(selectedPid, selectedType)) {
      selectedType = available[0].key;
    }
  });

  function hasMetric(pid: number, typeKey: MetricTypeKey): boolean {
    return !!(section.chartMetrics ?? []).find(m => m.key === `pid_${pid}_${typeKey}`);
  }

  function getMetric(pid: number | null, typeKey: MetricTypeKey): TelemetryChartMetric | null {
    if (pid === null) return null;
    return (section.chartMetrics ?? []).find(m => m.key === `pid_${pid}_${typeKey}`) ?? null;
  }

  const activeMetric = $derived(getMetric(selectedPid, selectedType));
  const activeMetricHasRaw = $derived(!!activeMetric?.rawSeries?.length);
  const activeValueView = $derived(activeMetricHasRaw ? selectedValueView : 'rate');
  const activeMetricSeries = $derived.by(() => {
    if (!activeMetric) return [];
    if (activeValueView === 'raw') return activeMetric.rawSeries ?? [];
    return activeMetric.series;
  });
  const activeMetricTitle = $derived.by(() => {
    if (!activeMetric) return '';
    if (!activeMetricHasRaw) return activeMetric.title;
    return `${activeMetric.title} · ${activeValueView === 'raw' ? 'Raw delta' : 'Rate/s'}`;
  });
  const selectedProcess = $derived(processes.find(p => p.pid === selectedPid) ?? null);
  const detailColumns = $derived(section.tableColumns.filter((column) => column.key !== 'cmdline'));
  const selectedSummaryItems = $derived.by(() => {
    if (!selectedProcess) return [];
    return [
      { label: 'State', value: selectedProcess.row.state, kind: 'text' },
      { label: 'Current Wait', value: selectedProcess.row.wchan, kind: 'text' },
      { label: 'Top Wait', value: selectedProcess.row.top_wchan, kind: 'text' },
      { label: 'RSS', value: kbToBytes(selectedProcess.row.vm_rss_kb), kind: 'bytes' },
      { label: 'Peak RSS', value: kbToBytes(selectedProcess.row.peak_vm_rss_kb), kind: 'bytes' },
      { label: 'Swap', value: kbToBytes(selectedProcess.row.vm_swap_kb), kind: 'bytes' },
      { label: 'Threads', value: selectedProcess.row.threads, kind: 'count' },
      { label: 'FDs', value: selectedProcess.row.fd_count, kind: 'count' },
      { label: 'CPU Jiffies', value: selectedProcess.row.cpu_jiffies_delta, kind: 'count' },
      { label: 'Major Faults', value: selectedProcess.row.major_faults_delta, kind: 'count' },
      { label: 'Sched Wait', value: selectedProcess.row.sched_wait_ms_delta, kind: 'duration_ms' },
    ] as const;
  });
  const selectedWaitChannels = $derived(getWaitChannelSamples(selectedProcess?.row.wchan_distribution));

  function kbToBytes(value: unknown): number | null {
    const numeric = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(numeric)) return null;
    return numeric * 1024;
  }

  function cellValue(row: Record<string, unknown>, column: TelemetryTableColumn): unknown {
    if (column.kind === 'bytes' && String(column.key).endsWith('_kb')) {
      return kbToBytes(row[column.key]);
    }
    return row[column.key];
  }

  function getWaitChannelSamples(value: unknown): WaitChannelSample[] {
    if (!Array.isArray(value)) return [];
    return value
      .map((item) => {
        if (!item || typeof item !== 'object') return null;
        const row = item as Record<string, unknown>;
        const label = String(row.value ?? '').trim();
        const count = Number(row.count);
        const percent = Number(row.percent);
        if (!label || !Number.isFinite(count) || count <= 0 || !Number.isFinite(percent)) return null;
        return { value: label, count, percent };
      })
      .filter((item): item is WaitChannelSample => item !== null);
  }

  $effect(() => {
    if (!activeMetricHasRaw && selectedValueView !== 'rate') selectedValueView = 'rate';
  });
</script>

<div class="host-process-panel">
  {#if section.status !== 'ok' || processes.length === 0}
    <div class="no-data">{section.reason ?? 'No process data available.'}</div>
  {:else}
    <!-- Process selector + metric pills in one toolbar row -->
    <div class="process-toolbar">
      <select
        class="process-select"
        value={selectedPid}
        onchange={(e) => { selectedPid = Number((e.target as HTMLSelectElement).value); }}
      >
        {#each processes as p}
          <option value={p.pid}>{p.processName} — PID {p.pid}</option>
        {/each}
      </select>

      <div class="metric-pills">
        {#each METRIC_TYPES as t}
          {@const available = selectedPid !== null && hasMetric(selectedPid, t.key)}
          <button
            type="button"
            class="pill"
            class:active={selectedType === t.key}
            disabled={!available}
            onclick={() => { if (available) selectedType = t.key; }}
            title={available ? `Show ${t.label} chart` : `No ${t.label} data for this process`}
          >{t.label}</button>
        {/each}
      </div>

      {#if activeMetricHasRaw}
        <div class="value-view-control" aria-label="Metric value view">
          <span class="value-view-label">View</span>
          <div class="value-view-toggle">
            <button
              type="button"
              class:active={activeValueView === 'rate'}
              onclick={() => selectedValueView = 'rate'}
            >Rate/s</button>
            <button
              type="button"
              class:active={activeValueView === 'raw'}
              onclick={() => selectedValueView = 'raw'}
            >Raw</button>
          </div>
        </div>
      {/if}
    </div>

    <!-- Full cmdline as a subtle hint below the toolbar -->
    {#if selectedProcess?.cmdline}
      <div class="cmdline-hint" title={selectedProcess.cmdline}>{selectedProcess.cmdline}</div>
    {/if}

    {#if selectedSummaryItems.length > 0}
      <div class="process-summary" aria-label="Selected process summary">
        {#each selectedSummaryItems as item}
          <div class="summary-item">
            <span class="summary-label">{item.label}</span>
            <span class="summary-value">{formatValue(item.value, item.kind)}</span>
          </div>
        {/each}
      </div>
    {/if}

    {#if selectedWaitChannels.length > 0}
      <div class="wchan-block">
        <div class="wchan-title">Wait channel samples</div>
        <div class="wchan-list">
          {#each selectedWaitChannels as sample}
            <div class="wchan-row">
              <div class="wchan-label" title={sample.value}>{sample.value}</div>
              <div class="wchan-track" aria-hidden="true">
                <span style={`width:${Math.max(2, sample.percent * 100)}%`}></span>
              </div>
              <div class="wchan-count">{sample.count}</div>
              <div class="wchan-percent">{formatValue(sample.percent, 'percent')}</div>
            </div>
          {/each}
        </div>
      </div>
    {/if}

    <!-- Chart -->
    {#if activeMetric}
      <LineChart
        title={activeMetricTitle}
        series={activeMetricSeries}
        {markers}
        {originMs}
        showAllSeriesByDefault={true}
      />
    {:else}
      <div class="no-data">No {selectedType.toUpperCase()} data for this process.</div>
    {/if}

    {#if section.tableRows.length > 0}
      <div class="table-block">
        <div class="table-header">
          <div>
            <div class="table-title">{section.tableTitle}</div>
            <div class="table-subtitle">Top {section.tableRows.length} PostgreSQL processes by observed activity</div>
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
                  {#each detailColumns as column}
                    <th>{column.label}</th>
                  {/each}
                </tr>
              </thead>
              <tbody>
                {#each section.tableRows as row}
                  <tr class:selected={Number(row.pid) === selectedPid}>
                    {#each detailColumns as column}
                      <td class:mono={column.kind !== 'text' && column.kind !== 'flag'} title={String(row[column.key] ?? '')}>
                        {formatValue(cellValue(row, column), column.kind ?? 'text')}
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
</div>

<style>
  .host-process-panel {
    border: 1px solid #e8edf3;
    border-radius: 12px;
    padding: 14px;
    background: linear-gradient(180deg, #ffffff 0%, #fbfcfe 100%);
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .process-toolbar {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }

  .process-select {
    flex: 1;
    min-width: 220px;
    max-width: 420px;
    font-size: 13px;
    font-weight: 600;
    color: #1a1a2e;
    background: #f5f8ff;
    border: 1px solid #c8d8f5;
    border-radius: 6px;
    padding: 6px 10px;
    cursor: pointer;
    appearance: auto;
  }
  .process-select:focus { outline: 2px solid #0066cc; outline-offset: 1px; }

  .metric-pills {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }

  .pill {
    border: 1px solid #d9d9d9;
    background: #fff;
    color: #555;
    border-radius: 999px;
    padding: 5px 14px;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.1s, color 0.1s, border-color 0.1s;
  }
  .pill:hover:not(:disabled) { background: #f0f4ff; border-color: #aabfe8; color: #0044bb; }
  .pill.active { background: #0066cc; border-color: #0055bb; color: #fff; }
  .pill:disabled { opacity: 0.35; cursor: not-allowed; }

  .value-view-control {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin-left: auto;
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

  .cmdline-hint {
    font-size: 11px;
    color: #888;
    font-family: ui-monospace, monospace;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    padding: 0 2px;
  }

  .process-summary {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(108px, 1fr));
    gap: 8px;
  }

  .summary-item {
    min-width: 0;
    border: 1px solid #edf0f5;
    border-radius: 6px;
    background: #fff;
    padding: 7px 8px;
  }

  .summary-label {
    display: block;
    font-size: 10px;
    font-weight: 700;
    color: #6b7280;
    text-transform: uppercase;
  }

  .summary-value {
    display: block;
    margin-top: 3px;
    font-size: 13px;
    font-weight: 700;
    color: #172033;
    font-variant-numeric: tabular-nums;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .wchan-block {
    border: 1px solid #edf0f5;
    border-radius: 6px;
    background: #fff;
    padding: 9px 10px;
  }

  .wchan-title {
    font-size: 12px;
    font-weight: 700;
    color: #1f2937;
    margin-bottom: 8px;
  }

  .wchan-list {
    display: grid;
    gap: 6px;
  }

  .wchan-row {
    display: grid;
    grid-template-columns: minmax(100px, 190px) minmax(90px, 1fr) 44px 48px;
    align-items: center;
    gap: 8px;
    font-size: 12px;
  }

  .wchan-label {
    min-width: 0;
    color: #334155;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .wchan-track {
    height: 8px;
    border-radius: 999px;
    background: #edf2f7;
    overflow: hidden;
  }

  .wchan-track span {
    display: block;
    height: 100%;
    border-radius: inherit;
    background: #0066cc;
  }

  .wchan-count,
  .wchan-percent {
    color: #475569;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-variant-numeric: tabular-nums;
    text-align: right;
  }

  .table-block {
    border-top: 1px solid #edf0f5;
    padding-top: 10px;
  }

  .table-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 10px;
  }

  .table-title {
    font-size: 13px;
    font-weight: 700;
    color: #1f2937;
  }

  .table-subtitle {
    margin-top: 2px;
    color: #6b7280;
    font-size: 12px;
  }

  .table-toggle {
    border: 1px solid #d8e0eb;
    background: #fff;
    border-radius: 6px;
    padding: 5px 10px;
    color: #24405f;
    cursor: pointer;
    font-size: 12px;
    font-weight: 700;
  }

  .table-toggle:hover { background: #f5f8fc; }

  .table-wrap {
    margin-top: 8px;
    overflow: auto;
    border: 1px solid #e5e7eb;
    border-radius: 6px;
    max-height: 340px;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
  }

  th, td {
    padding: 7px 8px;
    border-bottom: 1px solid #edf0f5;
    text-align: left;
    white-space: nowrap;
  }

  th {
    position: sticky;
    top: 0;
    z-index: 1;
    background: #f8fafc;
    color: #475569;
    font-size: 11px;
    font-weight: 700;
  }

  tr.selected td { background: #f0f6ff; }

  td.mono {
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-variant-numeric: tabular-nums;
  }

  .no-data {
    padding: 20px;
    border: 1px dashed #d8d8d8;
    border-radius: 8px;
    text-align: center;
    color: #777;
    font-size: 13px;
  }

</style>
