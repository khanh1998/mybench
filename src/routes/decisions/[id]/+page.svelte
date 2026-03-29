<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';

  const id = $derived(Number($page.params.id));
  let decision: {id: number; name: string; description: string} | null = $state(null);
  let designs: {id: number; name: string; description: string; database: string; server_id: number}[] = $state([]);
  let runs: Record<number, {id:number; status:string; tps:number|null; latency_avg_ms:number|null; started_at:string}[]> = $state({});
  let servers: {id:number; name:string}[] = $state([]);

  // New design form
  let newName = $state('');
  let newDesc = $state('');
  let newServerId = $state<number|null>(null);
  let newDatabase = $state('');
  let formError = $state('');
  let showForm = $state(false);

  async function load() {
    const [dRes, dsRes, sRes] = await Promise.all([
      fetch(`/api/decisions/${id}`),
      fetch(`/api/designs?decision_id=${id}`),
      fetch('/api/connections')
    ]);
    decision = await dRes.json();
    designs = await dsRes.json();
    servers = await sRes.json();

    // Load latest run for each design
    for (const design of designs) {
      const rRes = await fetch(`/api/runs?design_id=${design.id}`);
      const r = await rRes.json();
      runs[design.id] = r.slice(0, 3);
    }
  }

  async function createDesign() {
    if (!newName.trim()) { formError = 'Name is required'; return; }
    const res = await fetch('/api/designs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        decision_id: id,
        name: newName,
        description: newDesc,
        server_id: newServerId,
        database: newDatabase
      })
    });
    const d = await res.json();
    showForm = false;
    newName = ''; newDesc = ''; newDatabase = ''; formError = '';
    goto(`/designs/${d.id}`);
  }

  async function deleteDecision() {
    if (!confirm('Delete this decision and all its designs?')) return;
    await fetch(`/api/decisions/${id}`, { method: 'DELETE' });
    goto('/decisions');
  }

  onMount(load);
</script>

{#if decision}
  <div class="row" style="margin-bottom: 16px;">
    <div>
      <h1>{decision.name}</h1>
      {#if decision.description}<p style="color:#666; margin:4px 0 0">{decision.description}</p>{/if}
    </div>
    <span class="spacer"></span>
    <a href="/decisions/{id}/compare" class="btn-link">
      <button>Compare Designs</button>
    </a>
    <button class="danger" onclick={deleteDecision}>Delete</button>
  </div>

  <div class="row" style="margin-bottom: 12px;">
    <h2>Designs</h2>
    <span class="spacer"></span>
    <button class="primary" onclick={() => showForm = !showForm}>+ New Design</button>
  </div>

  {#if showForm}
    <div class="card">
      <h3>New Design</h3>
      <div class="form-group">
        <label for="nd-name">Name</label>
        <input id="nd-name" bind:value={newName} placeholder="e.g. 'B-tree index on order_date'" />
      </div>
      <div class="form-group">
        <label for="nd-desc">Description</label>
        <textarea id="nd-desc" bind:value={newDesc} rows="2" placeholder="Describe this design approach"></textarea>
      </div>
      <div class="row">
        <div class="form-group" style="flex:1">
          <label for="nd-server">PostgreSQL Server</label>
          <select id="nd-server" bind:value={newServerId}>
            <option value={null}>-- select server --</option>
            {#each servers as s}
              <option value={s.id}>{s.name}</option>
            {/each}
          </select>
        </div>
        <div class="form-group" style="flex:1">
          <label for="nd-db">Database</label>
          <input id="nd-db" bind:value={newDatabase} placeholder="my_benchmark_db" />
        </div>
      </div>
      {#if formError}<p class="error">{formError}</p>{/if}
      <div class="row">
        <button class="primary" onclick={createDesign}>Create Design</button>
        <button onclick={() => showForm = false}>Cancel</button>
      </div>
    </div>
  {/if}

  {#if designs.length === 0 && !showForm}
    <p style="color:#666">No designs yet. Create one above.</p>
  {/if}

  {#each designs as design}
    <div class="card design-card">
      <div class="row">
        <div>
          <div style="display:flex; align-items:center; gap:8px">
            <a href="/designs/{design.id}" style="text-decoration:none; color:#0066cc; font-weight:600; font-size:15px">{design.name}</a>
            <a href="/api/designs/{design.id}/export" download style="text-decoration:none; font-size:11px; color:#666; border:1px solid #ccc; padding:1px 7px; border-radius:4px; white-space:nowrap" title="Export plan JSON">↓ Export Plan</a>
          </div>
          {#if design.description}<p style="color:#666; margin:2px 0 0; font-size:12px">{design.description}</p>{/if}
          <p style="color:#999; font-size:11px; margin:4px 0 0">DB: {design.database || '—'}</p>
        </div>
        <span class="spacer"></span>
        <div style="text-align:right">
          {#if runs[design.id]?.length > 0}
            {@const latest = runs[design.id][0]}
            <span class="badge badge-{latest.status}">{latest.status}</span>
            {#if latest.tps !== null}
              <div style="font-size:12px; color:#333; margin-top:4px">
                TPS: <strong>{latest.tps?.toFixed(1)}</strong>
                · Latency: <strong>{latest.latency_avg_ms?.toFixed(2)}ms</strong>
              </div>
            {/if}
          {:else}
            <span style="color:#999; font-size:12px">No runs yet</span>
          {/if}
        </div>
      </div>
    </div>
  {/each}
{:else}
  <p>Loading...</p>
{/if}

<style>
  .btn-link { text-decoration: none; }
  .design-card { transition: box-shadow 0.15s; }
  .design-card:hover { box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
</style>
