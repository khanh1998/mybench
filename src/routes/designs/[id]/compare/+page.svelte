<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import BenchmarkCompareContent from '$lib/BenchmarkCompareContent.svelte';
  import type { CompareRunInfo } from '$lib/compare/types';
  import { fmtTs } from '$lib/utils';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  const designId = $derived(Number($page.params.id));

  interface SeriesInfo { id: number; name: string; }
  const allRuns = $derived((data.runs ?? []) as (CompareRunInfo & { series_id: number | null })[]);
  const seriesList = $derived((data.seriesList ?? []) as SeriesInfo[]);
  let seriesFilter = $state<'all' | 'none' | number>('all');
  const visibleRuns = $derived(
    seriesFilter === 'all' ? allRuns :
    seriesFilter === 'none' ? allRuns.filter(r => r.series_id == null) :
    allRuns.filter(r => r.series_id === seriesFilter)
  );
  let selectedRunIds: number[] = $state([]);

  function initFromUrl() {
    const param = $page.url.searchParams.get('runs');
    if (!param) return;
    const ids = param
      .split(',')
      .map(Number)
      .filter((id, index, values) => index === values.indexOf(id))
      .filter((id) => id > 0 && allRuns.some((run) => run.id === id));
    selectedRunIds = ids;
  }

  function syncUrl() {
    const url = new URL($page.url);
    if (selectedRunIds.length > 0) {
      url.searchParams.set('runs', selectedRunIds.join(','));
    } else {
      url.searchParams.delete('runs');
    }
    goto(url.toString(), { replaceState: true, noScroll: true, keepFocus: true });
  }

  function toggleRun(runId: number) {
    if (selectedRunIds.includes(runId)) {
      selectedRunIds = selectedRunIds.filter((id) => id !== runId);
    } else {
      selectedRunIds = [...selectedRunIds, runId];
    }
    syncUrl();
  }

  function clearSelection() {
    selectedRunIds = [];
    syncUrl();
  }

  onMount(() => {
    initFromUrl();
  });
</script>

<div class="row page-header">
  <a href="/designs/{designId}" class="back-link">← {(data.design as { name: string } | null)?.name ?? 'Design'}</a>
  <h1>Compare Runs</h1>
</div>

<div class="card">
  <div class="row section-header">
    <h3 style="margin:0">Select Runs to Compare</h3>
    <span class="section-note">Select completed runs to compare</span>
    {#if seriesList.length > 0}
      <select class="series-filter-select" bind:value={seriesFilter}
        onchange={() => { selectedRunIds = []; syncUrl(); }}>
        <option value="all">All runs</option>
        <option value="none">No series</option>
        {#each seriesList as s}
          <option value={s.id}>Series: {s.name || '#' + s.id}</option>
        {/each}
      </select>
    {/if}
    {#if selectedRunIds.length > 0}
      <button onclick={clearSelection} class="clear-btn">Clear</button>
    {/if}
  </div>

  {#if visibleRuns.length === 0}
    <p class="empty-copy">{allRuns.length === 0 ? 'No completed runs for this design yet.' : 'No runs match the current filter.'}</p>
  {:else}
    <div class="run-list">
      {#each visibleRuns as run}
        {@const colorIdx = selectedRunIds.indexOf(run.id)}
        {@const selected = colorIdx >= 0}
        {@const disabled = false}
        <label
          class="run-chip"
          class:selected
          class:disabled
          style={selected ? `border-color:${['#0066cc', '#e6531d', '#00996b', '#9b36b7', '#cc8800'][colorIdx % 5]};background:${['#0066cc', '#e6531d', '#00996b', '#9b36b7', '#cc8800'][colorIdx % 5]}18` : ''}
        >
          <input type="checkbox" checked={selected} {disabled} onchange={() => toggleRun(run.id)} />
          <span class="run-chip-id" style={selected ? `color:${['#0066cc', '#e6531d', '#00996b', '#9b36b7', '#cc8800'][colorIdx % 5]};font-weight:700` : ''}>
            {run.name || '#' + run.id}
          </span>
          {#if run.profile_name}
            <span class="run-chip-profile">{run.profile_name}</span>
          {/if}
          {#if run.tps !== null}
            <span class="run-chip-tps">{run.tps.toFixed(1)} TPS</span>
          {/if}
          <span class="run-chip-date">{fmtTs(run.started_at)}</span>
        </label>
      {/each}
    </div>
  {/if}
</div>

<BenchmarkCompareContent
  {allRuns}
  {selectedRunIds}
  canCompare={allRuns.length >= 2}
  insufficientMessage="This design needs at least 2 completed runs to compare. Run the benchmark a few more times with different settings or parameter profiles."
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

  .series-filter-select {
    font-size: 12px;
    padding: 3px 8px;
    border: 1px solid #ddd;
    border-radius: 4px;
    color: #555;
  }

  .clear-btn {
    margin-left: auto;
    font-size: 12px;
  }

  .run-list {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: flex-start;
  }

  .run-chip {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    flex-wrap: nowrap;
    white-space: nowrap;
    padding: 8px 12px;
    border: 1.5px solid #e0e0e0;
    border-radius: 999px;
    cursor: pointer;
    font-size: 13px;
    transition: border-color 0.1s, background 0.1s;
    max-width: 100%;
  }

  .run-chip:hover:not(.disabled) {
    border-color: #0066cc;
    background: #f0f6ff;
  }

  .run-chip.selected {
    font-weight: 500;
  }

  .run-chip.disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  .run-chip input {
    width: auto;
    cursor: pointer;
    margin: 0;
  }

  .run-chip-id {
    font-size: 13px;
  }

  .run-chip-profile {
    font-size: 11px;
    background: #e8f0ff;
    color: #0055aa;
    padding: 1px 6px;
    border-radius: 8px;
  }

  .run-chip-tps {
    font-size: 11px;
    color: #00996b;
    font-weight: 600;
  }

  .run-chip-date {
    font-size: 11px;
    color: #999;
    font-family: monospace;
  }

  .empty-copy {
    color: #999;
    font-size: 13px;
  }

  @media (max-width: 980px) {
    .clear-btn {
      margin-left: 0;
    }
  }

  @media (max-width: 720px) {
    .run-chip {
      width: 100%;
      justify-content: space-between;
    }
  }
</style>
