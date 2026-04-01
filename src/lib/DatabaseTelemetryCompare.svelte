<script lang="ts">
  import { fetchRunTelemetry } from '$lib/telemetry/api';
  import { formatValue } from '$lib/telemetry/format';
  import TelemetryCompareSection from '$lib/telemetry/TelemetryCompareSection.svelte';
  import type { RunTelemetry, TelemetryCard, TelemetryPhase, TelemetrySection } from '$lib/telemetry/types';

  interface CompareRun {
    id: number;
    label: string;
    color: string;
  }

  interface HeroCompareCard {
    key: string;
    label: string;
    kind: TelemetryCard['kind'];
    infoText?: string;
    values: Record<number, TelemetryCard['value']>;
  }

  interface SectionCompareGroup {
    key: string;
    label: string;
    sections: Record<number, TelemetrySection>;
  }

  let {
    runs = [],
    active = false
  }: {
    runs: CompareRun[];
    active?: boolean;
  } = $props();

  const PHASES: TelemetryPhase[] = ['pre', 'bench', 'post'];
  const DEFAULT_PHASES: TelemetryPhase[] = ['bench'];

  let telemetryByRunId = $state<Record<number, RunTelemetry>>({});
  let loading = $state(false);
  let error = $state('');
  let selectedPhases = $state<TelemetryPhase[]>([...DEFAULT_PHASES]);
  let requestSeq = 0;

  const runIdsKey = $derived(runs.map((run) => run.id).join(','));
  const phaseKey = $derived(selectedPhases.join(','));
  const availablePhases = $derived.by(() => {
    const available = new Set<TelemetryPhase>();
    for (const telemetry of Object.values(telemetryByRunId)) {
      for (const phase of telemetry.availablePhases) available.add(phase);
    }
    return available;
  });

  function getRunTelemetry(runId: number): RunTelemetry | null {
    return telemetryByRunId[runId] ?? null;
  }

  function fallbackSection(key: string, label: string): TelemetrySection {
    return {
      key,
      label,
      status: 'no_data',
      reason: 'No telemetry data available for this run and phase selection.',
      summary: [],
      chartTitle: '',
      chartSeries: [],
      tableTitle: '',
      tableColumns: [],
      tableRows: []
    };
  }

  async function loadTelemetry() {
    if (!runs.length) {
      telemetryByRunId = {};
      error = '';
      loading = false;
      return;
    }

    const seq = ++requestSeq;
    loading = true;
    error = '';
    try {
      const entries = await Promise.all(
        runs.map(async (run) => [run.id, await fetchRunTelemetry(run.id, selectedPhases)] as const)
      );
      if (seq !== requestSeq) return;
      telemetryByRunId = Object.fromEntries(entries);
    } catch (err) {
      if (seq !== requestSeq) return;
      error = err instanceof Error ? err.message : String(err);
    } finally {
      if (seq === requestSeq) loading = false;
    }
  }

  function togglePhase(phase: TelemetryPhase) {
    if (availablePhases.size > 0 && !availablePhases.has(phase)) return;
    if (selectedPhases.includes(phase)) {
      if (selectedPhases.length === 1) return;
      selectedPhases = selectedPhases.filter((item) => item !== phase);
    } else {
      selectedPhases = [...selectedPhases, phase];
    }
  }

  const heroCompareCards = $derived.by((): HeroCompareCard[] => {
    const firstTelemetry = runs.map((run) => getRunTelemetry(run.id)).find(Boolean);
    if (!firstTelemetry) return [];
    return firstTelemetry.heroCards.map((card) => ({
      key: card.key,
      label: card.label,
      kind: card.kind,
      infoText: card.infoText,
      values: Object.fromEntries(
        runs.map((run) => [
          run.id,
          getRunTelemetry(run.id)?.heroCards.find((heroCard) => heroCard.key === card.key)?.value ?? null
        ])
      )
    }));
  });

  const sectionGroups = $derived.by((): SectionCompareGroup[] => {
    const firstTelemetry = runs.map((run) => getRunTelemetry(run.id)).find(Boolean);
    if (!firstTelemetry) return [];
    return firstTelemetry.sections.map((section) => ({
      key: section.key,
      label: section.label,
      sections: Object.fromEntries(
        runs.map((run) => [
          run.id,
          getRunTelemetry(run.id)?.sections.find((entry) => entry.key === section.key) ?? fallbackSection(section.key, section.label)
        ])
      )
    }));
  });

  $effect(() => {
    if (!active) return;
    runIdsKey;
    phaseKey;
    void loadTelemetry();
  });
</script>

<div class="telemetry-compare-shell">
  <div class="card compare-toolbar-card">
    <div class="compare-toolbar">
      <div>
        <h3 style="margin:0">Database Telemetry</h3>
        <div class="compare-subtitle">Compare database internals section-by-section across the selected runs.</div>
      </div>
      <div class="phase-filter">
        <span class="phase-label">Phases</span>
        {#each PHASES as phase}
          <button
            class="phase-chip"
            class:active={selectedPhases.includes(phase)}
            disabled={availablePhases.size > 0 && !availablePhases.has(phase)}
            onclick={() => togglePhase(phase)}
          >{phase}</button>
        {/each}
      </div>
    </div>

    <div class="run-badge-row">
      {#each runs as run}
        <span class="run-badge" style={`--run-color:${run.color}`}>
          <span class="run-badge-dot"></span>
          {run.label}
        </span>
      {/each}
    </div>
  </div>

  {#if loading && Object.keys(telemetryByRunId).length === 0}
    <div class="card telemetry-empty">Loading telemetry comparison...</div>
  {:else if error}
    <div class="card telemetry-empty telemetry-error">{error}</div>
  {:else}
    {#if heroCompareCards.length > 0}
      <div class="hero-compare-grid">
        {#each heroCompareCards as card}
          <div class="hero-compare-card">
            <div class="hero-compare-label">{card.label}</div>
            <div class="hero-compare-values">
              {#each runs as run}
                <div class="hero-compare-row">
                  <span class="hero-run-label" style={`color:${run.color}`}>{run.label}</span>
                  <strong>{formatValue(card.values[run.id], card.kind)}</strong>
                </div>
              {/each}
            </div>
          </div>
        {/each}
      </div>
    {/if}

    <div class="section-compare-list">
      {#each sectionGroups as group}
        <section class="card compare-section-card">
          <TelemetryCompareSection
            label={group.label}
            {runs}
            sectionsByRun={group.sections}
          />
        </section>
      {/each}
    </div>
  {/if}
</div>

<style>
  .telemetry-compare-shell {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .compare-toolbar-card {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .compare-toolbar {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    align-items: flex-start;
    flex-wrap: wrap;
  }

  .compare-subtitle {
    margin-top: 4px;
    color: #666;
    font-size: 12px;
  }

  .phase-filter {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }

  .phase-label {
    font-size: 12px;
    color: #666;
    font-weight: 600;
    text-transform: uppercase;
  }

  .phase-chip {
    border: 1px solid #d9d9d9;
    background: #fff;
    color: #666;
    border-radius: 999px;
    padding: 4px 10px;
    font-size: 12px;
    cursor: pointer;
  }

  .phase-chip.active {
    background: #0066cc;
    border-color: #0066cc;
    color: #fff;
  }

  .phase-chip:disabled {
    cursor: not-allowed;
    opacity: 0.45;
  }

  .run-badge-row {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  .run-badge {
    --run-color: #0066cc;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--run-color) 10%, white);
    border: 1px solid color-mix(in srgb, var(--run-color) 30%, white);
    color: #213247;
    font-size: 12px;
    font-weight: 700;
  }

  .run-badge-dot {
    width: 10px;
    height: 10px;
    border-radius: 999px;
    background: var(--run-color);
  }

  .hero-compare-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
    gap: 10px;
  }

  .hero-compare-card {
    border: 1px solid #e6ebf2;
    border-radius: 12px;
    padding: 12px;
    background: linear-gradient(180deg, #ffffff 0%, #f9fbfd 100%);
  }

  .hero-compare-label {
    font-size: 11px;
    color: #666;
    text-transform: uppercase;
    font-weight: 700;
    margin-bottom: 8px;
  }

  .hero-compare-values {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .hero-compare-row {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    align-items: baseline;
    font-size: 13px;
  }

  .hero-run-label {
    font-weight: 700;
  }

  .section-compare-list {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .compare-section-card {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .telemetry-empty {
    padding: 20px;
    border: 1px dashed #d8d8d8;
    border-radius: 8px;
    text-align: center;
    color: #777;
    font-size: 13px;
  }

  .telemetry-error {
    color: #a11;
  }
</style>
