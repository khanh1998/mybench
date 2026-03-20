<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';

  interface Server {
    id: number; name: string; host: string; port: number; username: string; password: string; ssl: number;
  }
  interface TableSel { table_name: string; enabled: number; }

  let servers: Server[] = $state([]);
  let editing: Partial<Server> | null = $state(null);
  let isNew = $state(false);
  let testMsg = $state('');
  let testOk = $state<boolean|null>(null);
  let testDb = $state('postgres');
  let selectedServer = $state<number|null>(null);
  let tables: TableSel[] = $state([]);
  let saving = $state(false);

  async function load() {
    const res = await fetch('/api/connections');
    servers = await res.json();
  }

  function startNew() {
    editing = { name: '', host: 'localhost', port: 5432, username: 'postgres', password: '', ssl: 0 };
    isNew = true;
    testMsg = '';
    testOk = null;
  }

  function startEdit(s: Server) {
    editing = { ...s };
    isNew = false;
    testMsg = '';
    testOk = null;
  }

  async function save() {
    if (!editing) return;
    saving = true;
    if (isNew) {
      await fetch('/api/connections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(editing)
      });
    } else {
      await fetch(`/api/connections/${editing.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(editing)
      });
    }
    editing = null;
    saving = false;
    await load();
  }

  async function del(id: number) {
    if (!confirm('Delete this connection?')) return;
    await fetch(`/api/connections/${id}`, { method: 'DELETE' });
    await load();
  }

  async function test() {
    if (!editing?.id) { testMsg = 'Save first, then test.'; return; }
    testMsg = 'Testing…';
    testOk = null;
    const res = await fetch(`/api/connections/${editing.id}/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ database: testDb })
    });
    const data = await res.json();
    testOk = data.ok;
    testMsg = data.ok ? `✓ Connected: ${data.version?.slice(0,50)}` : `✗ ${data.error}`;
  }

  async function loadTables(serverId: number) {
    selectedServer = serverId;
    const res = await fetch(`/api/connections/${serverId}/tables`);
    tables = await res.json();
  }

  async function saveTables() {
    if (!selectedServer) return;
    await fetch(`/api/connections/${selectedServer}/tables`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(tables)
    });
    testMsg = 'Table selections saved.';
  }

  onMount(load);
</script>

<h1>Settings</h1>

<div class="row" style="margin-bottom:12px">
  <h2>PostgreSQL Connections</h2>
  <span class="spacer"></span>
  <button class="primary" onclick={startNew}>+ Add Connection</button>
</div>

{#if editing}
  <div class="card">
    <h3>{isNew ? 'New Connection' : 'Edit Connection'}</h3>
    <div class="row">
      <div class="form-group" style="flex:2">
        <label for="conn-name">Name</label>
        <input id="conn-name" bind:value={editing.name} placeholder="My local PG" />
      </div>
      <div class="form-group" style="flex:3">
        <label for="conn-host">Host</label>
        <input id="conn-host" bind:value={editing.host} placeholder="localhost" />
      </div>
      <div class="form-group" style="flex:1">
        <label for="conn-port">Port</label>
        <input id="conn-port" type="number" bind:value={editing.port} />
      </div>
    </div>
    <div class="row">
      <div class="form-group" style="flex:1">
        <label for="conn-user">Username</label>
        <input id="conn-user" bind:value={editing.username} placeholder="postgres" />
      </div>
      <div class="form-group" style="flex:1">
        <label for="conn-pass">Password</label>
        <input id="conn-pass" type="password" bind:value={editing.password} />
      </div>
      <div class="form-group" style="flex:0; justify-content:flex-end; padding-top:20px">
        <label style="display:flex; align-items:center; gap:6px; font-weight:normal; cursor:pointer; white-space:nowrap">
          <input
            type="checkbox"
            style="width:auto"
            checked={!!editing.ssl}
            onchange={(e) => { if (editing) editing.ssl = (e.currentTarget as HTMLInputElement).checked ? 1 : 0; }}
          />
          SSL
        </label>
      </div>
    </div>
    <div class="row">
      <button class="primary" onclick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
      <button onclick={() => editing = null}>Cancel</button>
      {#if !isNew}
        <span style="margin-left:8px; font-size:12px; color:#666">Test with DB:</span>
        <input bind:value={testDb} style="width:150px" placeholder="postgres" />
        <button onclick={test}>Test Connection</button>
      {/if}
    </div>
    {#if testMsg}
      <p class:success={testOk === true} class:error={testOk === false} style="margin-top:8px">{testMsg}</p>
    {/if}
  </div>
{/if}

{#if servers.length === 0 && !editing}
  <p style="color:#666">No connections yet.</p>
{/if}

{#each servers as s}
  <div class="card">
    <div class="row">
      <div>
        <strong>{s.name}</strong>
        <span style="color:#666; font-size:12px; margin-left:8px">{s.username}@{s.host}:{s.port}{s.ssl ? ' · SSL' : ''}</span>
      </div>
      <span class="spacer"></span>
      <button onclick={() => loadTables(s.id)}>pg_stat tables</button>
      <button onclick={() => startEdit(s)}>Edit</button>
      <button class="danger" onclick={() => del(s.id)}>Delete</button>
    </div>

    {#if selectedServer === s.id && tables.length > 0}
      <div style="margin-top:12px">
        <h4 style="margin-bottom:8px">pg_stat Table Selections</h4>
        <p style="color:#666; font-size:12px; margin-bottom:8px">
          Uncheck tables you don't want to snapshot. Greyed tables may not exist in your PG version.
        </p>
        <div class="tables-grid">
          {#each tables as t}
            <label class="table-toggle">
              <input type="checkbox" checked={!!t.enabled} onchange={(e) => t.enabled = (e.currentTarget as HTMLInputElement).checked ? 1 : 0} />
              {t.table_name}
            </label>
          {/each}
        </div>
        <div style="margin-top:10px">
          <button class="primary" onclick={saveTables}>Save Selections</button>
          <button onclick={() => selectedServer = null} style="margin-left:8px">Close</button>
        </div>
      </div>
    {/if}
  </div>
{/each}

<style>
  .tables-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
    gap: 6px;
  }
  .table-toggle {
    font-size: 12px;
    font-weight: normal;
    display: flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
  }
  .table-toggle input { width: auto; }
  h4 { margin: 0 0 8px; }
</style>
