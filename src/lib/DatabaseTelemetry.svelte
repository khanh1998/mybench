<script lang="ts">
  import { fetchRunTelemetry } from '$lib/telemetry/api';
  import TelemetrySectionPanel from '$lib/telemetry/TelemetrySectionPanel.svelte';
  import TelemetryValueCard from '$lib/telemetry/TelemetryValueCard.svelte';
  import type { RunTelemetry, TelemetryPhase } from '$lib/telemetry/types';

  let {
    runId,
    active = false,
    title = 'Database Telemetry',
    includeSectionKeys = null,
    excludeSectionKeys = null,
    showHeroCards = true
  }: {
    runId: number;
    active?: boolean;
    title?: string;
    includeSectionKeys?: string[] | null;
    excludeSectionKeys?: string[] | null;
    showHeroCards?: boolean;
  } = $props();

  const PHASES: TelemetryPhase[] = ['pre', 'bench', 'post'];
  const DEFAULT_PHASES: TelemetryPhase[] = ['bench'];

  let telemetry = $state<RunTelemetry | null>(null);
  let loading = $state(false);
  let error = $state('');
  let selectedPhases = $state<TelemetryPhase[]>([...DEFAULT_PHASES]);
  let requestSeq = 0;

  const phaseKey = $derived(`${runId}:${selectedPhases.join(',')}`);
  const originMs = $derived(telemetry ? new Date(telemetry.originTs).getTime() : null);
  const visibleSections = $derived.by(() => {
    if (!telemetry) return [];

    return telemetry.sections.filter((section) => {
      if (includeSectionKeys && !includeSectionKeys.includes(section.key)) return false;
      if (excludeSectionKeys && excludeSectionKeys.includes(section.key)) return false;
      return true;
    });
  });

  async function loadTelemetry() {
    const seq = ++requestSeq;
    loading = true;
    error = '';
    try {
      const nextTelemetry = await fetchRunTelemetry(runId, selectedPhases);
      if (seq !== requestSeq) return;
      telemetry = nextTelemetry;
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

  $effect(() => {
    if (!active) return;
    phaseKey;
    void loadTelemetry();
  });
</script>

<div class="card telemetry-card">
  <div class="telemetry-toolbar">
    <div>
      <h3 style="margin:0">{title}</h3>
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
    {#if showHeroCards}
      <div class="hero-grid">
        {#each telemetry.heroCards as card}
          <TelemetryValueCard {card} variant="hero" />
        {/each}
      </div>
    {/if}

    <div class="section-list">
      {#each visibleSections as section}
        <TelemetrySectionPanel
          {section}
          markers={telemetry.markers}
          {originMs}
        />
      {/each}
    </div>
  {/if}
</div>

<style>
  .telemetry-card {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .telemetry-toolbar {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    align-items: flex-start;
    flex-wrap: wrap;
  }

  .telemetry-subtitle {
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

  .hero-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
    gap: 10px;
  }

  .section-list {
    display: flex;
    flex-direction: column;
    gap: 16px;
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
