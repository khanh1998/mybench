<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import BenchmarkCompareContent from '$lib/BenchmarkCompareContent.svelte';
  import type { CompareRunInfo } from '$lib/compare/types';
  import { fmtTs } from '$lib/utils';
  import type { PageData } from './$types';

  interface DecisionDesign {
    id: number;
    name: string;
  }

  interface DesignGroup extends DecisionDesign {
    runs: CompareRunInfo[];
  }

  let { data }: { data: PageData } = $props();

  const decisionId = $derived(Number($page.params.id));
  const designs = $derived((data.designs ?? []) as DecisionDesign[]);
  const rawRuns = $derived((data.runs ?? []) as CompareRunInfo[]);
  const allRuns = $derived(
    rawRuns.map((run) => ({
      ...run,
      compare_label: run.design_name ?? run.name ?? `Run #${run.id}`,
      compare_short_label: run.design_name ?? `Design ${run.design_id ?? ''}`.trim()
    }))
  );

  const designGroups = $derived.by(
    (): DesignGroup[] =>
      designs
        .map((design) => ({
          ...design,
          runs: allRuns.filter((run) => run.design_id === design.id)
        }))
        .filter((design) => design.runs.length > 0)
  );

  let selectedDesignA = $state<number | null>(null);
  let selectedDesignB = $state<number | null>(null);
  let selectedRunA = $state<number | null>(null);
  let selectedRunB = $state<number | null>(null);

  function getDesignGroup(designId: number | null): DesignGroup | undefined {
    if (designId === null) return undefined;
    return designGroups.find((design) => design.id === designId);
  }

  function getRunForId(runId: number | null): CompareRunInfo | undefined {
    if (runId === null) return undefined;
    return allRuns.find((run) => run.id === runId);
  }

  function syncUrl() {
    const url = new URL($page.url);

    const values: Record<string, number | null> = {
      designA: selectedDesignA,
      runA: selectedRunA,
      designB: selectedDesignB,
      runB: selectedRunB
    };

    for (const [key, value] of Object.entries(values)) {
      if (value) {
        url.searchParams.set(key, String(value));
      } else {
        url.searchParams.delete(key);
      }
    }

    goto(url.toString(), { replaceState: true, noScroll: true, keepFocus: true });
  }

  function assignDefaultSelections() {
    const [first, second] = designGroups;
    selectedDesignA = first?.id ?? null;
    selectedRunA = first?.runs[0]?.id ?? null;
    selectedDesignB = second?.id ?? null;
    selectedRunB = second?.runs[0]?.id ?? null;
  }

  function initFromUrl() {
    const params = $page.url.searchParams;
    const designA = Number(params.get('designA'));
    const designB = Number(params.get('designB'));
    const runA = Number(params.get('runA'));
    const runB = Number(params.get('runB'));

    if (!params.toString()) {
      assignDefaultSelections();
      return;
    }

    const groupA = designGroups.find((design) => design.id === designA);
    const groupB = designGroups.find((design) => design.id === designB && design.id !== designA);

    selectedDesignA = groupA?.id ?? null;
    selectedRunA = groupA?.runs.find((run) => run.id === runA)?.id ?? groupA?.runs[0]?.id ?? null;

    selectedDesignB = groupB?.id ?? null;
    selectedRunB = groupB?.runs.find((run) => run.id === runB)?.id ?? groupB?.runs[0]?.id ?? null;

    if (!selectedDesignA && !selectedDesignB) {
      assignDefaultSelections();
    }
  }

  function handleDesignChange(slot: 'A' | 'B', nextDesignId: number | null) {
    const designId = nextDesignId && Number.isFinite(nextDesignId) ? nextDesignId : null;
    const group = getDesignGroup(designId);
    const nextRunId = group?.runs[0]?.id ?? null;

    if (slot === 'A') {
      selectedDesignA = designId;
      selectedRunA = nextRunId;
    } else {
      selectedDesignB = designId;
      selectedRunB = nextRunId;
    }

    syncUrl();
  }

  function handleRunChange(slot: 'A' | 'B', nextRunId: number | null) {
    const runId = nextRunId && Number.isFinite(nextRunId) ? nextRunId : null;
    if (slot === 'A') {
      selectedRunA = runId;
    } else {
      selectedRunB = runId;
    }
    syncUrl();
  }

  function clearSelection() {
    selectedDesignA = null;
    selectedRunA = null;
    selectedDesignB = null;
    selectedRunB = null;
    syncUrl();
  }

  const selectedRunIds = $derived(
    [selectedRunA, selectedRunB]
      .filter((runId): runId is number => runId !== null)
      .filter((runId, index, values) => values.indexOf(runId) === index)
  );

  const canCompare = $derived(designGroups.length >= 2);
</script>

<div class="row page-header">
  <a href="/decisions/{decisionId}" class="back-link">← {(data.decision as { name: string } | null)?.name ?? 'Decision'}</a>
  <h1>Compare Designs</h1>
</div>

<div class="card">
  <div class="row section-header">
    <h3 style="margin:0">Select Runs to Compare</h3>
    <span class="section-note">Choose one run from each design</span>
    {#if selectedRunA || selectedRunB}
      <button onclick={clearSelection} class="clear-btn">Clear</button>
    {/if}
  </div>

  {#if designGroups.length === 0}
    <p class="empty-copy">No completed runs for this decision yet.</p>
  {:else}
    <div class="selector-grid">
      <section class="selector-card">
        <div class="selector-title">Design A</div>
        <div class="selector-field">
          <label for="design-a">Design</label>
          <select
            id="design-a"
            value={selectedDesignA ?? ''}
            onchange={(e) => handleDesignChange('A', Number((e.currentTarget as HTMLSelectElement).value) || null)}
          >
            <option value="">Select design</option>
            {#each designGroups as design}
              <option value={design.id} disabled={selectedDesignB === design.id}>{design.name}</option>
            {/each}
          </select>
        </div>
        <div class="selector-field">
          <label for="run-a">Run</label>
          <select
            id="run-a"
            disabled={!selectedDesignA}
            value={selectedRunA ?? ''}
            onchange={(e) => handleRunChange('A', Number((e.currentTarget as HTMLSelectElement).value) || null)}
          >
            <option value="">Select run</option>
            {#each getDesignGroup(selectedDesignA)?.runs ?? [] as run}
              <option value={run.id}>{run.name || `Run #${run.id}`} · {fmtTs(run.started_at)}</option>
            {/each}
          </select>
        </div>
      </section>

      <section class="selector-card">
        <div class="selector-title">Design B</div>
        <div class="selector-field">
          <label for="design-b">Design</label>
          <select
            id="design-b"
            value={selectedDesignB ?? ''}
            onchange={(e) => handleDesignChange('B', Number((e.currentTarget as HTMLSelectElement).value) || null)}
          >
            <option value="">Select design</option>
            {#each designGroups as design}
              <option value={design.id} disabled={selectedDesignA === design.id}>{design.name}</option>
            {/each}
          </select>
        </div>
        <div class="selector-field">
          <label for="run-b">Run</label>
          <select
            id="run-b"
            disabled={!selectedDesignB}
            value={selectedRunB ?? ''}
            onchange={(e) => handleRunChange('B', Number((e.currentTarget as HTMLSelectElement).value) || null)}
          >
            <option value="">Select run</option>
            {#each getDesignGroup(selectedDesignB)?.runs ?? [] as run}
              <option value={run.id}>{run.name || `Run #${run.id}`} · {fmtTs(run.started_at)}</option>
            {/each}
          </select>
        </div>
      </section>
    </div>
  {/if}
</div>

<BenchmarkCompareContent
  allRuns={allRuns}
  {selectedRunIds}
  {canCompare}
  insufficientMessage="This decision needs at least 2 designs with completed runs to compare."
  selectionPrompt="Choose one run for each design above to begin comparing."
/>

<style>
  .page-header {
    margin-bottom: 16px;
    align-items: center;
    gap: 8px;
  }

  .page-header h1 {
    margin: 0;
  }

  .back-link {
    color: #0066cc;
    text-decoration: none;
  }

  .section-header {
    margin-bottom: 12px;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }

  .section-note {
    font-size: 12px;
    color: #888;
  }

  .clear-btn {
    margin-left: auto;
    font-size: 12px;
  }

  .selector-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 12px;
  }

  .selector-card {
    border: 1px solid #e8edf3;
    border-radius: 12px;
    padding: 14px;
    background: linear-gradient(180deg, #ffffff 0%, #fbfcfe 100%);
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .selector-title {
    font-size: 13px;
    font-weight: 700;
    color: #213247;
  }

  .selector-field {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .selector-field label {
    font-size: 12px;
    font-weight: 600;
    color: #516072;
  }

  .empty-copy {
    color: #999;
    font-size: 13px;
  }

  @media (max-width: 860px) {
    .selector-grid {
      grid-template-columns: 1fr;
    }

    .clear-btn {
      margin-left: 0;
    }
  }
</style>
