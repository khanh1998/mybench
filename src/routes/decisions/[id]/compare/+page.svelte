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

  interface Slot {
    designId: number | null;
    runId: number | null;
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

  let slots = $state<Slot[]>([
    { designId: null, runId: null },
    { designId: null, runId: null }
  ]);

  function getDesignGroup(designId: number | null): DesignGroup | undefined {
    if (designId === null) return undefined;
    return designGroups.find((d) => d.id === designId);
  }

  function syncUrl() {
    const url = new URL($page.url);
    const runIds = slots.map((s) => s.runId ?? 0).join(',');
    const hasAny = slots.some((s) => s.runId !== null);
    if (hasAny) {
      url.searchParams.set('runs', runIds);
    } else {
      url.searchParams.delete('runs');
    }
    goto(url.toString(), { replaceState: true, noScroll: true, keepFocus: true });
  }

  function assignDefaultSelections() {
    if (designGroups.length >= 2) {
      const [first, second] = designGroups;
      slots = [
        { designId: first.id, runId: first.runs[0]?.id ?? null },
        { designId: second.id, runId: second.runs[0]?.id ?? null }
      ];
    } else if (designGroups.length === 1 && designGroups[0].runs.length >= 2) {
      const group = designGroups[0];
      slots = [
        { designId: group.id, runId: group.runs[0].id },
        { designId: group.id, runId: group.runs[1].id }
      ];
    } else {
      const group = designGroups[0];
      slots = [
        { designId: group?.id ?? null, runId: group?.runs[0]?.id ?? null },
        { designId: null, runId: null }
      ];
    }
  }

  function initFromUrl() {
    const params = $page.url.searchParams;
    const runsParam = params.get('runs');

    if (!runsParam) {
      assignDefaultSelections();
      return;
    }

    const runIds = runsParam.split(',').map(Number);
    const newSlots: Slot[] = runIds.map((runId) => {
      if (!runId) return { designId: null, runId: null };
      const run = allRuns.find((r) => r.id === runId);
      return { designId: run?.design_id ?? null, runId: run ? runId : null };
    });

    while (newSlots.length < 2) {
      newSlots.push({ designId: null, runId: null });
    }

    slots = newSlots;
  }

  function handleDesignChange(index: number, designId: number | null) {
    const group = getDesignGroup(designId);
    slots[index] = { designId, runId: group?.runs[0]?.id ?? null };
    syncUrl();
  }

  function handleRunChange(index: number, runId: number | null) {
    slots[index] = { ...slots[index], runId };
    syncUrl();
  }

  function addSlot() {
    slots = [...slots, { designId: null, runId: null }];
    syncUrl();
  }

  function removeSlot(index: number) {
    slots = slots.filter((_, i) => i !== index);
    syncUrl();
  }

  function clearSelection() {
    slots = [
      { designId: null, runId: null },
      { designId: null, runId: null }
    ];
    syncUrl();
  }

  const selectedRunIds = $derived(
    slots
      .map((s) => s.runId)
      .filter((id): id is number => id !== null)
      .filter((id, index, arr) => arr.indexOf(id) === index)
  );

  const canCompare = $derived(allRuns.length >= 2);

  onMount(() => {
    initFromUrl();
  });
</script>

<div class="row page-header">
  <a href="/decisions/{decisionId}" class="back-link">← {(data.decision as { name: string } | null)?.name ?? 'Decision'}</a>
  <h1>Compare Designs</h1>
</div>

<div class="card">
  <div class="row section-header">
    <h3 style="margin:0">Select Runs to Compare</h3>
    <span class="section-note">Select runs to compare — the same design can appear in multiple slots with different runs</span>
    {#if slots.some((s) => s.runId)}
      <button onclick={clearSelection} class="clear-btn">Clear</button>
    {/if}
  </div>

  {#if designGroups.length === 0}
    <p class="empty-copy">No completed runs for this decision yet.</p>
  {:else}
    <div class="selector-grid">
      {#each slots as slot, index}
        <section class="selector-card">
          <div class="selector-card-header">
            <div class="selector-title">Run {index + 1}</div>
            {#if slots.length > 2}
              <button class="remove-slot-btn" onclick={() => removeSlot(index)}>Remove</button>
            {/if}
          </div>
          <div class="selector-field">
            <label for="design-{index}">Design</label>
            <select
              id="design-{index}"
              value={slot.designId ?? ''}
              onchange={(e) => handleDesignChange(index, Number((e.currentTarget as HTMLSelectElement).value) || null)}
            >
              <option value="">Select design</option>
              {#each designGroups as design}
                <option value={design.id}>{design.name}</option>
              {/each}
            </select>
          </div>
          <div class="selector-field">
            <label for="run-{index}">Run</label>
            <select
              id="run-{index}"
              disabled={!slot.designId}
              value={slot.runId ?? ''}
              onchange={(e) => handleRunChange(index, Number((e.currentTarget as HTMLSelectElement).value) || null)}
            >
              <option value="">Select run</option>
              {#each getDesignGroup(slot.designId)?.runs ?? [] as run}
                <option
                  value={run.id}
                  disabled={selectedRunIds.includes(run.id) && slot.runId !== run.id}
                >
                  {run.name || `Run #${run.id}`} · {fmtTs(run.started_at)}
                </option>
              {/each}
            </select>
          </div>
        </section>
      {/each}
    </div>
    <div class="add-slot-row">
      <button class="add-slot-btn" onclick={addSlot}>+ Add run</button>
    </div>
  {/if}
</div>

<BenchmarkCompareContent
  allRuns={allRuns}
  {selectedRunIds}
  {canCompare}
  insufficientMessage="This decision needs at least 2 completed runs to compare."
  selectionPrompt="Select at least 2 runs above to begin comparing."
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
    grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
    gap: 12px;
    margin-bottom: 12px;
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

  .selector-card-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .selector-title {
    font-size: 13px;
    font-weight: 700;
    color: #213247;
  }

  .remove-slot-btn {
    font-size: 11px;
    font-weight: 600;
    color: #cc3333;
    background: none;
    border: 1px solid #f0c0c0;
    border-radius: 4px;
    padding: 2px 8px;
    cursor: pointer;
  }

  .remove-slot-btn:hover {
    background: #fff0f0;
    border-color: #e09090;
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

  .selector-field select {
    width: 100%;
  }

  .add-slot-row {
    margin-top: 4px;
  }

  .add-slot-btn {
    font-size: 12px;
    font-weight: 600;
    color: #0066cc;
    background: #f0f6ff;
    border: 1px solid #c0d8f5;
    border-radius: 6px;
    padding: 6px 14px;
    cursor: pointer;
  }

  .add-slot-btn:hover {
    background: #dceeff;
    border-color: #99c0ee;
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
