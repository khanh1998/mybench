<script lang="ts">
  import LineChart from '$lib/LineChart.svelte';
  import { formatValue } from '$lib/telemetry/format';
  import type { TelemetrySection, TelemetryMarker, TelemetryChartMetric, TelemetrySeries, TelemetryTableColumn } from '$lib/telemetry/types';

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

  interface ProcessGroup {
    key: string;
    label: string;
    pids: number[];
    type: 'all' | 'client' | 'internal';
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

  let selectedKey = $state<string | null>(null);
  let selectedType = $state<MetricTypeKey>('cpu');
  let tableExpanded = $state(false);
  let selectedValueView = $state<'rate' | 'raw'>('rate');

  const groups = $derived.by((): ProcessGroup[] => {
    const clientMap = new Map<string, number[]>();
    const internalPids: number[] = [];

    for (const p of processes) {
      if (p.processName.includes('/')) {
        const key = p.processName.replace(/\s*\(.*\)$/, '').trim();
        if (!clientMap.has(key)) clientMap.set(key, []);
        clientMap.get(key)!.push(p.pid);
      } else {
        internalPids.push(p.pid);
      }
    }

    const result: ProcessGroup[] = [];
    for (const [key, pids] of clientMap) {
      const n = pids.length;
      result.push({
        key,
        label: `${key} (${n} connection${n > 1 ? 's' : ''})`,
        pids,
        type: 'client',
      });
    }
    if (internalPids.length > 0) {
      result.push({
        key: '__internals__',
        label: `Postgres internals (${internalPids.length})`,
        pids: internalPids,
        type: 'internal',
      });
    }
    return result;
  });

  const allProcessGroup = $derived.by((): ProcessGroup | null => {
    if (processes.length <= 1) return null;
    return {
      key: '__all__',
      label: `All processes (${processes.length})`,
      pids: processes.map(p => p.pid),
      type: 'all',
    };
  });

  // Auto-select first process or group on load.
  $effect(() => {
    if (selectedKey !== null) return;
    if (groups.length > 0) {
      selectedKey = groups[0].pids.length > 1 ? `g:${groups[0].key}` : `p:${groups[0].pids[0]}`;
    } else if (processes.length > 0) {
      selectedKey = `p:${processes[0].pid}`;
    }
  });

  const selectedPidOrGroup = $derived.by(() => {
    if (!selectedKey) return null;
    if (selectedKey.startsWith('p:')) return { kind: 'pid' as const, pid: Number(selectedKey.slice(2)) };
    if (selectedKey.startsWith('g:')) return { kind: 'group' as const, groupKey: selectedKey.slice(2) };
    return null;
  });

  const activePids = $derived.by((): number[] => {
    if (!selectedPidOrGroup) return [];
    if (selectedPidOrGroup.kind === 'pid') return [selectedPidOrGroup.pid];
    if (selectedPidOrGroup.groupKey === allProcessGroup?.key) return allProcessGroup.pids;
    const group = groups.find(g => g.key === selectedPidOrGroup.groupKey);
    return group?.pids ?? [];
  });

  // When selection changes, pick the first available metric type for the active PID set.
  $effect(() => {
    if (activePids.length === 0) return;
    const available = METRIC_TYPES.filter(t => hasMetricForPids(activePids, t.key));
    if (available.length > 0 && !hasMetricForPids(activePids, selectedType)) {
      selectedType = available[0].key;
    }
  });

  function hasMetricForPids(pids: number[], typeKey: MetricTypeKey): boolean {
    return pids.some(pid => !!(section.chartMetrics ?? []).find(m => m.key === `pid_${pid}_${typeKey}`));
  }

  function getAggregatedMetric(pids: number[], typeKey: MetricTypeKey): TelemetryChartMetric | null {
    const metrics = pids
      .map(pid => (section.chartMetrics ?? []).find(m => m.key === `pid_${pid}_${typeKey}`) ?? null)
      .filter((m): m is TelemetryChartMetric => m !== null);
    if (metrics.length === 0) return null;
    if (metrics.length === 1) return metrics[0];
    return {
      ...metrics[0],
      series: sumSeriesArrays(metrics.map(m => m.series)),
      rawSeries: metrics[0].rawSeries?.length
        ? sumSeriesArrays(metrics.map(m => m.rawSeries ?? []))
        : undefined,
    };
  }

  function sumSeriesArrays(seriesArrays: TelemetrySeries[][]): TelemetrySeries[] {
    const labels = [...new Set(seriesArrays.flatMap(arr => arr.map(s => s.label)))];
    return labels.map(label => {
      const matching = seriesArrays
        .map(arr => arr.find(s => s.label === label))
        .filter((s): s is TelemetrySeries => !!s);
      const allTs = [...new Set(matching.flatMap(s => s.points.map(p => p.t)))].sort((a, b) => a - b);
      return {
        ...matching[0],
        points: allTs.map(t => ({
          t,
          v: matching.reduce((sum, s) => sum + (s.points.find(p => p.t === t)?.v ?? 0), 0),
        })),
      };
    });
  }

  const activeMetric = $derived(getAggregatedMetric(activePids, selectedType));
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
  const selectedProcess = $derived(activePids.length === 1 ? processes.find(p => p.pid === activePids[0]) ?? null : null);
  const detailColumns = $derived(section.tableColumns.filter((column) => column.key !== 'cmdline'));
  const selectedSummaryItems = $derived.by(() => {
    if (activePids.length === 0) return [];

    if (activePids.length === 1) {
      const process = processes.find(p => p.pid === activePids[0]);
      if (!process) return [];
      return [
        { label: 'State', value: process.row.state, kind: 'text' },
        { label: 'Current Wait', value: process.row.wchan, kind: 'text' },
        { label: 'Top Wait', value: process.row.top_wchan, kind: 'text' },
        { label: 'RSS', value: kbToBytes(process.row.vm_rss_kb), kind: 'bytes' },
        { label: 'Peak RSS', value: kbToBytes(process.row.peak_vm_rss_kb), kind: 'bytes' },
        { label: 'Swap', value: kbToBytes(process.row.vm_swap_kb), kind: 'bytes' },
        { label: 'Threads', value: process.row.threads, kind: 'count' },
        { label: 'FDs', value: process.row.fd_count, kind: 'count' },
        { label: 'CPU Jiffies', value: process.row.cpu_jiffies_delta, kind: 'count' },
        { label: 'Major Faults', value: process.row.major_faults_delta, kind: 'count' },
        { label: 'Sched Wait', value: process.row.sched_wait_ms_delta, kind: 'duration_ms' },
      ] as const;
    }

    const rows = activePids
      .map(pid => section.tableRows.find(r => Number(r.pid) === pid))
      .filter((r): r is Record<string, unknown> => !!r);

    function sumField(field: string): number {
      return rows.reduce((sum, row) => sum + (Number(row[field]) || 0), 0);
    }

    return [
      { label: 'Processes', value: activePids.length, kind: 'count' },
      { label: 'RSS', value: kbToBytes(sumField('vm_rss_kb')), kind: 'bytes' },
      { label: 'Swap', value: kbToBytes(sumField('vm_swap_kb')), kind: 'bytes' },
      { label: 'Threads', value: sumField('threads'), kind: 'count' },
      { label: 'FDs', value: sumField('fd_count'), kind: 'count' },
      { label: 'CPU Jiffies', value: sumField('cpu_jiffies_delta'), kind: 'count' },
      { label: 'Major Faults', value: sumField('major_faults_delta'), kind: 'count' },
      { label: 'Sched Wait', value: sumField('sched_wait_ms_delta'), kind: 'duration_ms' },
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
      <div class="process-selector-row">
        <select
          class="process-select"
          value={selectedKey}
          onchange={(e) => { selectedKey = (e.target as HTMLSelectElement).value; }}
        >
          {#if allProcessGroup}
            <option value={`g:${allProcessGroup.key}`}>All {allProcessGroup.pids.length} processes (aggregated)</option>
          {/if}
          {#each groups as group}
            <optgroup label={group.label}>
              {#if group.pids.length > 1}
                <option value={`g:${group.key}`}>
                  {group.type === 'internal' ? 'All internals (aggregated)' : `All ${group.pids.length} (aggregated)`}
                </option>
              {/if}
              {#each group.pids as pid}
                {@const p = processes.find(pr => pr.pid === pid)}
                <option value={`p:${pid}`}>{p?.processName ?? `pid:${pid}`} — PID {pid}</option>
              {/each}
            </optgroup>
          {/each}
          {#if groups.length === 0}
            {#each processes as p}
              <option value={`p:${p.pid}`}>{p.processName} — PID {p.pid}</option>
            {/each}
          {/if}
        </select>
      </div>

      <div class="metric-pills">
        {#each METRIC_TYPES as t}
          {@const available = hasMetricForPids(activePids, t.key)}
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
    {#if activePids.length === 1}
      {@const sp = processes.find(p => p.pid === activePids[0])}
      {#if sp?.cmdline}
        <div class="cmdline-hint" title={sp.cmdline}>{sp.cmdline}</div>
      {/if}
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

    {#if activePids.length === 1 && selectedWaitChannels.length > 0}
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
      <div class="no-data">No {selectedType.toUpperCase()} data for this selection.</div>
    {/if}

    {#if section.tableRows.length > 0}
      <div class="table-block">
        <div class="table-header">
          <div>
            <div class="table-title">{section.tableTitle}</div>
            <div class="table-subtitle">{section.tableRows.length} PostgreSQL processes by observed activity</div>
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
                  <tr class:selected={activePids.includes(Number(row.pid))}>
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
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    gap: 8px 10px;
  }

  .process-selector-row {
    grid-column: 1 / -1;
    display: flex;
    align-items: center;
    min-width: 0;
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
    grid-column: 1;
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
    grid-column: 2;
    justify-self: end;
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
