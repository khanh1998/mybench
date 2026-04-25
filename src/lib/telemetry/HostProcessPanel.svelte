<script lang="ts">
  import LineChart from '$lib/LineChart.svelte';
  import type { TelemetrySection, TelemetryMarker, TelemetryChartMetric } from '$lib/telemetry/types';

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
  interface ProcessInfo { pid: number; processName: string; cmdline: string; }

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
      });
    }
    return list;
  });

  const METRIC_TYPES = [
    { key: 'cpu',   label: 'CPU'  },
    { key: 'mem',   label: 'Mem'  },
    { key: 'io',    label: 'I/O'  },
    { key: 'sched', label: 'Sched'},
  ] as const;
  type MetricTypeKey = typeof METRIC_TYPES[number]['key'];

  let selectedPid  = $state<number | null>(null);
  let selectedType = $state<MetricTypeKey>('cpu');

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
  const selectedProcess = $derived(processes.find(p => p.pid === selectedPid) ?? null);
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
    </div>

    <!-- Full cmdline as a subtle hint below the toolbar -->
    {#if selectedProcess?.cmdline}
      <div class="cmdline-hint" title={selectedProcess.cmdline}>{selectedProcess.cmdline}</div>
    {/if}

    <!-- Chart -->
    {#if activeMetric}
      <LineChart
        title={activeMetric.title}
        series={activeMetric.series}
        {markers}
        {originMs}
        showAllSeriesByDefault={true}
      />
    {:else}
      <div class="no-data">No {selectedType.toUpperCase()} data for this process.</div>
    {/if}

    <!-- Summary cards (peak RSS per process) -->
    {#if section.summary.length > 0}
      <div class="summary-row">
        {#each section.summary as card}
          <div class="summary-chip" title="Peak resident set size (pages)">
            <span class="summary-label">{card.label}</span>
            <span class="summary-value">{typeof card.value === 'number' ? card.value.toLocaleString() : card.value} pg</span>
          </div>
        {/each}
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

  .cmdline-hint {
    font-size: 11px;
    color: #888;
    font-family: ui-monospace, monospace;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    padding: 0 2px;
  }

  .no-data {
    padding: 20px;
    border: 1px dashed #d8d8d8;
    border-radius: 8px;
    text-align: center;
    color: #777;
    font-size: 13px;
  }

  .summary-row {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  .summary-chip {
    display: flex;
    align-items: center;
    gap: 6px;
    background: #f5f5f5;
    border: 1px solid #e0e0e0;
    border-radius: 6px;
    padding: 4px 10px;
    font-size: 11px;
  }
  .summary-label { color: #666; font-weight: 600; }
  .summary-value { color: #222; font-variant-numeric: tabular-nums; font-family: ui-monospace, monospace; }
</style>
