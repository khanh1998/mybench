<script lang="ts">
  import { onMount } from 'svelte';
  import CodeEditor from '$lib/CodeEditor.svelte';

  interface Metric {
    id: number; name: string; category: string; description: string;
    sql: string; is_builtin: number; higher_is_better: number; position: number;
  }

  const CATEGORIES = ['Cache & I/O', 'Access Patterns', 'Write Efficiency', 'Checkpoint & BGWriter', 'Vacuum Health', 'Concurrency', 'Custom'];

  let metrics: Metric[] = $state([]);
  let loading = $state(true);
  let editingMetric = $state<Partial<Metric> & { isNew?: boolean } | null>(null);
  let formError = $state('');
  let saving = $state(false);

  const metricsByCategory = $derived(() => {
    const map: Record<string, Metric[]> = {};
    for (const m of metrics) (map[m.category] ??= []).push(m);
    return map;
  });

  async function load() {
    const res = await fetch('/api/metrics');
    metrics = await res.json();
    loading = false;
  }

  function openAdd() {
    editingMetric = { name: '', category: 'Custom', description: '', sql: 'SELECT _collected_at FROM snap_pg_stat_database WHERE _run_id = ?', higher_is_better: 1, isNew: true };
    formError = '';
  }

  function openEdit(m: Metric) {
    editingMetric = { ...m };
    formError = '';
  }

  async function save() {
    if (!editingMetric) return;
    if (!editingMetric.name?.trim() || !editingMetric.sql?.trim()) {
      formError = 'Name and SQL are required.'; return;
    }
    saving = true;
    formError = '';
    if (editingMetric.isNew) {
      const res = await fetch('/api/metrics', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(editingMetric)
      });
      if (!res.ok) { formError = (await res.json()).message ?? 'Error'; saving = false; return; }
      const m = await res.json();
      metrics = [...metrics, m];
    } else {
      const res = await fetch(`/api/metrics/${editingMetric.id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(editingMetric)
      });
      if (!res.ok) { formError = (await res.json()).message ?? 'Error'; saving = false; return; }
      const m = await res.json();
      metrics = metrics.map(x => x.id === m.id ? m : x);
    }
    saving = false;
    editingMetric = null;
  }

  async function deleteMetric(m: Metric) {
    if (!confirm(`Delete "${m.name}"?`)) return;
    await fetch(`/api/metrics/${m.id}`, { method: 'DELETE' });
    metrics = metrics.filter(x => x.id !== m.id);
  }

  onMount(load);
</script>

<div class="row" style="margin-bottom:20px;align-items:baseline">
  <h1>Metric Library</h1>
  <span class="spacer"></span>
  <button class="primary" onclick={openAdd}>+ New metric</button>
</div>

<p style="color:#666;font-size:13px;margin-bottom:20px">
  These are reusable metric templates. When adding metrics to a compare screen, you can pull from this library and customize them without affecting these templates.
</p>

{#if loading}
  <p>Loading…</p>
{:else if metrics.length === 0}
  <div class="card" style="text-align:center;color:#999;padding:32px">No metrics in library yet. Click "New metric" to add one.</div>
{:else}
  {#each CATEGORIES as category}
    {@const catMetrics = metricsByCategory()[category] ?? []}
    {#if catMetrics.length > 0}
      <div class="cat-section">
        <div class="cat-header">{category} <span class="cat-count">{catMetrics.length}</span></div>
        {#each catMetrics as m}
          <div class="metric-row card">
            <div class="metric-main">
              <div class="metric-name">
                {m.name}
                {#if m.is_builtin}<span class="builtin-tag">built-in</span>{/if}
              </div>
              {#if m.description}<div class="metric-desc">{m.description}</div>{/if}
              <div class="metric-meta">
                <span class="meta-tag">{m.higher_is_better ? '↑ higher is better' : '↓ lower is better'}</span>
              </div>
            </div>
            <div class="metric-actions">
              <button onclick={() => openEdit(m)}>Edit</button>
              <button class="danger" onclick={() => deleteMetric(m)}>Delete</button>
            </div>
          </div>
        {/each}
      </div>
    {/if}
  {/each}
{/if}

<!-- Modal -->
{#if editingMetric}
  <div class="modal-backdrop" role="dialog" aria-modal="true" tabindex="-1"
    onclick={(e) => { if (e.target === e.currentTarget) editingMetric = null; }}
    onkeydown={(e) => { if (e.key === 'Escape') editingMetric = null; }}>
    <div class="modal">
      <div class="modal-header">
        <h3>{editingMetric.isNew ? 'New Metric' : 'Edit Metric'}</h3>
        <button class="modal-close" onclick={() => editingMetric = null}>✕</button>
      </div>

      <div class="row" style="gap:8px;flex-wrap:wrap;margin-bottom:10px">
        <div class="form-group" style="flex:2;min-width:160px">
          <label for="l-name">Name</label>
          <input id="l-name" bind:value={editingMetric.name} placeholder="Buffer hit ratio" />
        </div>
        <div class="form-group" style="flex:1;min-width:130px">
          <label for="l-cat">Category</label>
          <select id="l-cat" bind:value={editingMetric.category}>
            {#each CATEGORIES as c}<option>{c}</option>{/each}
          </select>
        </div>
        <div class="form-group" style="flex:0;min-width:160px">
          <label for="l-hib">Direction</label>
          <select id="l-hib" bind:value={editingMetric.higher_is_better}>
            <option value={1}>Higher is better</option>
            <option value={0}>Lower is better</option>
          </select>
        </div>
      </div>
      <div class="form-group" style="margin-bottom:10px">
        <label for="l-desc">Description</label>
        <input id="l-desc" bind:value={editingMetric.description} placeholder="What this metric shows…" />
      </div>
      <div class="form-group" style="margin-bottom:12px">
        <span class="form-label">SQL <span style="color:#999;font-size:11px">(use ? for _run_id, queries snap_* tables)</span></span>
        <div class="editor-wrap">
          <CodeEditor bind:value={editingMetric.sql!} />
        </div>
      </div>
      {#if formError}<p class="error" style="margin-bottom:8px">{formError}</p>{/if}
      <div class="row" style="gap:8px">
        <button class="primary" onclick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
        <button onclick={() => editingMetric = null}>Cancel</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .cat-section { margin-bottom: 20px; }
  .cat-header { font-size: 12px; font-weight: 700; color: #555; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 8px; display: flex; align-items: center; gap: 8px; }
  .cat-count { font-size: 11px; font-weight: normal; color: #999; background: #f0f0f0; padding: 1px 6px; border-radius: 10px; text-transform: none; letter-spacing: 0; }
  .metric-row { display: flex; align-items: flex-start; gap: 12px; margin-bottom: 8px; }
  .metric-main { flex: 1; }
  .metric-name { font-weight: 600; font-size: 13px; display: flex; align-items: center; gap: 6px; margin-bottom: 2px; }
  .metric-desc { font-size: 12px; color: #666; margin-bottom: 4px; }
  .metric-meta { display: flex; gap: 6px; flex-wrap: wrap; }
  .meta-tag { font-size: 11px; color: #888; background: #f5f5f5; padding: 1px 6px; border-radius: 3px; }
  .builtin-tag { font-size: 10px; background: #f0f4ff; color: #4466cc; padding: 1px 6px; border-radius: 10px; border: 1px solid #c8d4ff; }
  .metric-actions { display: flex; gap: 6px; flex-shrink: 0; }

  .modal-backdrop {
    position: fixed; inset: 0; background: rgba(0,0,0,0.45);
    display: flex; align-items: center; justify-content: center; z-index: 1000;
  }
  .modal {
    background: #fff; border-radius: 8px; padding: 24px; width: 700px; max-width: 95vw;
    max-height: 92vh; overflow-y: auto; box-shadow: 0 8px 40px rgba(0,0,0,0.22);
  }
  .modal-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
  .modal-header h3 { margin: 0; font-size: 15px; }
  .modal-close { background: none; border: none; font-size: 16px; cursor: pointer; color: #888; padding: 2px 6px; border-radius: 4px; }
  .modal-close:hover { background: #f0f0f0; color: #333; }
  .editor-wrap { position: relative; height: 200px; border-radius: 4px; overflow: hidden; }
  .form-label { display: block; font-weight: 600; margin-bottom: 4px; font-size: 12px; color: #555; }
</style>
