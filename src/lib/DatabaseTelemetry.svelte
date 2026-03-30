<script lang="ts">
  import LineChart from '$lib/LineChart.svelte';

  type TelemetryPhase = 'pre' | 'bench' | 'post';
  type TelemetryValueKind = 'count' | 'bytes' | 'percent' | 'duration_ms' | 'tps' | 'text' | 'flag';

  interface TelemetryCard {
    key: string;
    label: string;
    kind: TelemetryValueKind;
    value: number | string | boolean | null;
  }

  interface TelemetryTableColumn {
    key: string;
    label: string;
    kind?: TelemetryValueKind;
  }

  interface TelemetrySeriesPoint {
    t: number;
    v: number;
  }

  interface TelemetrySeries {
    label: string;
    color: string;
    points: TelemetrySeriesPoint[];
  }

  interface TelemetryMarker {
    t: number;
    label: string;
    color?: string;
  }

  interface TelemetrySection {
    key: string;
    label: string;
    status: 'ok' | 'no_data' | 'unsupported';
    reason?: string;
    summary: TelemetryCard[];
    chartTitle: string;
    chartSeries: TelemetrySeries[];
    tableTitle: string;
    tableColumns: TelemetryTableColumn[];
    tableRows: Record<string, unknown>[];
  }

  interface RunTelemetry {
    runId: number;
    database: string;
    originTs: string;
    availablePhases: TelemetryPhase[];
    selectedPhases: TelemetryPhase[];
    markers: TelemetryMarker[];
    heroCards: TelemetryCard[];
    sections: TelemetrySection[];
  }

  let {
    runId,
    active = false
  }: {
    runId: number;
    active?: boolean;
  } = $props();

  const PHASES: TelemetryPhase[] = ['pre', 'bench', 'post'];

  let telemetry = $state<RunTelemetry | null>(null);
  let loading = $state(false);
  let error = $state('');
  let selectedPhases = $state<TelemetryPhase[]>([...PHASES]);
  let requestSeq = 0;
  const phaseKey = $derived(selectedPhases.join(','));

  async function loadTelemetry() {
    const seq = ++requestSeq;
    loading = true;
    error = '';
    try {
      const params = new URLSearchParams();
      params.set('phases', selectedPhases.join(','));
      const res = await fetch(`/api/runs/${runId}/telemetry?${params.toString()}`);
      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.message ?? `HTTP ${res.status}`);
      }
      if (seq !== requestSeq) return;
      telemetry = json as RunTelemetry;
    } catch (err) {
      if (seq !== requestSeq) return;
      error = err instanceof Error ? err.message : String(err);
    } finally {
      if (seq === requestSeq) loading = false;
    }
  }

  function togglePhase(phase: TelemetryPhase) {
    if (telemetry && !telemetry.availablePhases.includes(phase)) return;
    if (selectedPhases.includes(phase)) {
      if (selectedPhases.length === 1) return;
      selectedPhases = selectedPhases.filter((item) => item !== phase);
    } else {
      selectedPhases = [...selectedPhases, phase];
    }
  }

  function formatNumber(value: number, maxFractionDigits = 2): string {
    return value.toLocaleString(undefined, {
      minimumFractionDigits: Number.isInteger(value) ? 0 : Math.min(1, maxFractionDigits),
      maximumFractionDigits: maxFractionDigits
    });
  }

  function formatBytes(value: number): string {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let current = value;
    let unit = 0;
    while (Math.abs(current) >= 1024 && unit < units.length - 1) {
      current /= 1024;
      unit++;
    }
    const digits = Math.abs(current) >= 10 || unit === 0 ? 0 : 1;
    return `${current.toFixed(digits)} ${units[unit]}`;
  }

  function formatDurationMs(value: number): string {
    if (Math.abs(value) >= 1000) return `${(value / 1000).toFixed(2)} s`;
    return `${formatNumber(value, 1)} ms`;
  }

  function formatValue(value: unknown, kind: TelemetryValueKind = 'text'): string {
    if (value === null || value === undefined || value === '') return '—';
    if (kind === 'flag') return value ? 'yes' : 'no';
    if (kind === 'text') return String(value);
    const numeric = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(numeric)) return String(value);
    if (kind === 'bytes') return formatBytes(numeric);
    if (kind === 'percent') return `${(numeric * 100).toFixed(1)}%`;
    if (kind === 'duration_ms') return formatDurationMs(numeric);
    if (kind === 'tps') return `${formatNumber(numeric, 2)} TPS`;
    return formatNumber(numeric, 2);
  }

  const originMs = $derived(telemetry ? new Date(telemetry.originTs).getTime() : null);

  $effect(() => {
    if (!active) return;
    phaseKey;
    void loadTelemetry();
  });
</script>

<div class="card telemetry-card">
  <div class="telemetry-toolbar">
    <div>
      <h3 style="margin:0">Database Telemetry</h3>
      {#if telemetry?.database}
        <div class="telemetry-subtitle">Database: <code>{telemetry.database}</code></div>
      {/if}
    </div>
    <div class="phase-filter">
      <span class="phase-label">Phases</span>
      {#each PHASES as phase}
        {@const available = telemetry ? telemetry.availablePhases.includes(phase) : true}
        <button
          class="phase-chip"
          class:active={selectedPhases.includes(phase)}
          disabled={!available}
          onclick={() => togglePhase(phase)}
        >{phase}</button>
      {/each}
    </div>
  </div>

  {#if loading && !telemetry}
    <div class="telemetry-empty">Loading telemetry...</div>
  {:else if error}
    <div class="telemetry-empty telemetry-error">{error}</div>
  {:else if telemetry}
    <div class="hero-grid">
      {#each telemetry.heroCards as card}
        <div class="hero-card">
          <div class="hero-label">{card.label}</div>
          <div class="hero-value">{formatValue(card.value, card.kind)}</div>
        </div>
      {/each}
    </div>

    <div class="section-list">
      {#each telemetry.sections as section}
        <section class="telemetry-section">
          <div class="section-header">
            <div>
              <h4 style="margin:0">{section.label}</h4>
              {#if section.reason && section.status !== 'ok'}
                <div class="section-reason">{section.reason}</div>
              {/if}
            </div>
            <span class="section-status {section.status}">{section.status.replace('_', ' ')}</span>
          </div>

          {#if section.status === 'ok'}
            <div class="summary-grid">
              {#each section.summary as card}
                <div class="summary-card">
                  <div class="summary-label">{card.label}</div>
                  <div class="summary-value">{formatValue(card.value, card.kind)}</div>
                </div>
              {/each}
            </div>

            <LineChart
              title={section.chartTitle}
              series={section.chartSeries}
              markers={telemetry.markers}
              originMs={originMs}
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
      {/each}
    </div>
  {/if}
</div>

<style>
  .telemetry-card { display: flex; flex-direction: column; gap: 16px; }
  .telemetry-toolbar {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    align-items: flex-start;
    flex-wrap: wrap;
  }
  .telemetry-subtitle { margin-top: 4px; color: #666; font-size: 12px; }
  .phase-filter { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .phase-label { font-size: 12px; color: #666; font-weight: 600; text-transform: uppercase; }
  .phase-chip {
    border: 1px solid #d9d9d9;
    background: #fff;
    color: #666;
    border-radius: 999px;
    padding: 4px 10px;
    font-size: 12px;
    cursor: pointer;
  }
  .phase-chip.active { background: #0066cc; border-color: #0066cc; color: #fff; }
  .phase-chip:disabled { cursor: not-allowed; opacity: 0.45; }
  .hero-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
    gap: 10px;
  }
  .hero-card, .summary-card {
    border: 1px solid #ececec;
    border-radius: 8px;
    padding: 10px 12px;
    background: #fafafa;
  }
  .hero-label, .summary-label {
    font-size: 11px;
    color: #666;
    text-transform: uppercase;
    font-weight: 700;
    margin-bottom: 4px;
  }
  .hero-value { font-size: 18px; font-weight: 700; color: #222; }
  .summary-value { font-size: 14px; font-weight: 700; color: #222; }
  .section-list { display: flex; flex-direction: column; gap: 16px; }
  .telemetry-section {
    border-top: 1px solid #efefef;
    padding-top: 16px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .section-header {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    align-items: flex-start;
    flex-wrap: wrap;
  }
  .section-status {
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    border-radius: 999px;
    padding: 3px 8px;
  }
  .section-status.ok { background: #e8f7f1; color: #0b6b50; }
  .section-status.no_data { background: #fff4e5; color: #9a4d00; }
  .section-status.unsupported { background: #f2f2f2; color: #666; }
  .section-reason { margin-top: 4px; color: #777; font-size: 12px; }
  .summary-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    gap: 8px;
  }
  .table-block { display: flex; flex-direction: column; gap: 8px; }
  .table-title { font-size: 12px; font-weight: 700; color: #444; text-transform: uppercase; }
  .mono { font-family: monospace; }
  .telemetry-empty {
    padding: 20px;
    border: 1px dashed #d8d8d8;
    border-radius: 8px;
    text-align: center;
    color: #777;
    font-size: 13px;
  }
  .telemetry-error { color: #a11; }
</style>
