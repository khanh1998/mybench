<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';

  let decisions: {id: number; name: string; description: string}[] = $state([]);
  let name = $state('');
  let description = $state('');
  let error = $state('');
  let loading = $state(true);

  async function load() {
    const res = await fetch('/api/decisions');
    decisions = await res.json();
    loading = false;
  }

  async function create() {
    if (!name.trim()) { error = 'Name is required'; return; }
    const res = await fetch('/api/decisions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, description })
    });
    const d = await res.json();
    name = '';
    description = '';
    error = '';
    goto(`/decisions/${d.id}`);
  }

  onMount(load);
</script>

<div class="row" style="margin-bottom: 16px;">
  <h1>Decisions</h1>
</div>

<div class="card" style="margin-bottom: 20px;">
  <h3>New Decision</h3>
  <div class="form-group">
    <label for="dec-name">Name</label>
    <input id="dec-name" bind:value={name} placeholder="e.g. 'Best indexing strategy for orders table'" />
  </div>
  <div class="form-group">
    <label for="dec-desc">Description</label>
    <textarea id="dec-desc" bind:value={description} rows="2" placeholder="What problem are you solving?"></textarea>
  </div>
  {#if error}<p class="error">{error}</p>{/if}
  <button class="primary" onclick={create}>Create Decision</button>
</div>

{#if loading}
  <p>Loading...</p>
{:else if decisions.length === 0}
  <p style="color:#666">No decisions yet. Create one above.</p>
{:else}
  {#each decisions as d}
    <div class="card" style="cursor:pointer;" role="button" tabindex="0"
      onclick={() => goto(`/decisions/${d.id}`)}
      onkeydown={(e) => e.key === 'Enter' && goto(`/decisions/${d.id}`)}>
      <h3 style="color:#0066cc">{d.name}</h3>
      {#if d.description}<p style="color:#666; margin: 4px 0 0;">{d.description}</p>{/if}
    </div>
  {/each}
{/if}
