<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';

  interface Server {
    id: number; name: string; host: string; port: number; username: string; password: string; ssl: number;
    rds_instance_id: string; aws_region: string; enhanced_monitoring: number;
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

  // ── EC2 Servers ──────────────────────────────────────────────────────────────
  interface Ec2Server {
    id: number; name: string; host: string; user: string; port: number;
    private_key: string; remote_dir: string; log_dir: string;
  }

  let ec2Servers: Ec2Server[] = $state([]);
  let ec2Editing: Partial<Ec2Server> | null = $state(null);
  let ec2IsNew = $state(false);
  interface Ec2TestResult {
    ok: boolean;
    ssh: { ok: boolean; error?: string };
    binary?: { ok: boolean; version?: string; path?: string; error?: string };
    iam?: { ok: boolean; role?: string; error?: string };
  }
  let ec2TestResult = $state<Ec2TestResult | null>(null);
  let ec2Testing = $state(false);
  let ec2Saving = $state(false);

  async function loadEc2() {
    const res = await fetch('/api/ec2');
    ec2Servers = await res.json();
  }

  async function handleKeyFileUpload(e: Event) {
    const file = (e.currentTarget as HTMLInputElement).files?.[0];
    if (!file || !ec2Editing) return;
    ec2Editing.private_key = await file.text();
  }

  function startNewEc2() {
    ec2Editing = { name: '', host: '', user: 'ec2-user', port: 22, private_key: '', remote_dir: '~/mybench-bench', log_dir: '/tmp/mybench-logs' };
    ec2IsNew = true;
    ec2TestResult = null;
  }

  function startEditEc2(s: Ec2Server) {
    ec2Editing = { ...s };
    ec2IsNew = false;
    ec2TestResult = null;
  }

  async function saveEc2() {
    if (!ec2Editing) return;
    ec2Saving = true;
    if (ec2IsNew) {
      await fetch('/api/ec2', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ec2Editing)
      });
    } else {
      await fetch(`/api/ec2/${ec2Editing.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ec2Editing)
      });
    }
    ec2Editing = null;
    ec2Saving = false;
    await loadEc2();
  }

  async function delEc2(id: number) {
    if (!confirm('Delete this EC2 server?')) return;
    await fetch(`/api/ec2/${id}`, { method: 'DELETE' });
    await loadEc2();
  }

  async function testEc2() {
    if (!ec2Editing) return;
    ec2Testing = true;
    ec2TestResult = null;
    const res = await fetch('/api/ec2/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        host: ec2Editing.host,
        user: ec2Editing.user,
        port: ec2Editing.port,
        private_key: ec2Editing.private_key,
        remote_dir: ec2Editing.remote_dir,
        log_dir: ec2Editing.log_dir
      })
    });
    ec2TestResult = await res.json();
    ec2Testing = false;
  }

  async function load() {
    const res = await fetch('/api/connections');
    servers = await res.json();
  }

  function startNew() {
    editing = { name: '', host: 'localhost', port: 5432, username: 'postgres', password: '', ssl: 0, rds_instance_id: '', aws_region: '', enhanced_monitoring: 0 };
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
    if (!editing) return;
    testMsg = 'Testing…';
    testOk = null;
    let res: Response;
    if (isNew) {
      // Test without a saved ID — uses body-based endpoint
      res = await fetch('/api/connections/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...editing, database: testDb })
      });
    } else {
      // Test saved server — also discovers/updates pg_stat table selections
      res = await fetch(`/api/connections/${editing.id}/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ database: testDb })
      });
    }
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

  onMount(() => { load(); loadEc2(); });
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
    {#if editing.host?.includes('.rds.amazonaws.com')}
    <div class="row" style="margin-top:4px">
      <div class="form-group" style="flex:1">
        <label for="conn-rds-id">RDS Instance ID <span style="font-weight:normal;color:#888">(auto-detected)</span></label>
        <input id="conn-rds-id" bind:value={editing.rds_instance_id} placeholder="my-db-instance" />
      </div>
      <div class="form-group" style="flex:1">
        <label for="conn-aws-region">AWS Region <span style="font-weight:normal;color:#888">(auto-detected)</span></label>
        <input id="conn-aws-region" bind:value={editing.aws_region} placeholder="ap-southeast-2" />
      </div>
      <div class="form-group" style="flex:0; justify-content:flex-end; padding-top:20px">
        <label style="display:flex; align-items:center; gap:6px; font-weight:normal; cursor:pointer; white-space:nowrap">
          <input
            type="checkbox"
            style="width:auto"
            checked={!!editing.enhanced_monitoring}
            onchange={(e) => { if (editing) editing.enhanced_monitoring = (e.currentTarget as HTMLInputElement).checked ? 1 : 0; }}
          />
          Enhanced Monitoring
        </label>
      </div>
    </div>
    {/if}
    <div class="row">
      <button class="primary" onclick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
      <button onclick={() => { editing = null; testMsg = ''; testOk = null; }}>Cancel</button>
      <span style="margin-left:8px; font-size:12px; color:#666">Test with DB:</span>
      <input bind:value={testDb} style="width:150px" placeholder="postgres" />
      <button onclick={test}>Test Connection</button>
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

<!-- EC2 Servers -->
<div class="row" style="margin-top:32px; margin-bottom:12px">
  <h2>EC2 Servers</h2>
  <span class="spacer"></span>
  <button class="primary" onclick={startNewEc2}>+ Add EC2 Server</button>
</div>

{#if ec2Editing}
  <div class="card">
    <h3>{ec2IsNew ? 'New EC2 Server' : 'Edit EC2 Server'}</h3>
    <div class="row">
      <div class="form-group" style="flex:2">
        <label for="ec2-name">Name</label>
        <input id="ec2-name" bind:value={ec2Editing.name} placeholder="My EC2 instance" />
      </div>
      <div class="form-group" style="flex:3">
        <label for="ec2-host">Host</label>
        <input id="ec2-host" bind:value={ec2Editing.host} placeholder="ec2-1-2-3-4.compute.amazonaws.com" />
      </div>
      <div class="form-group" style="flex:1">
        <label for="ec2-port">Port</label>
        <input id="ec2-port" type="number" bind:value={ec2Editing.port} />
      </div>
    </div>
    <div class="row">
      <div class="form-group" style="flex:1">
        <label for="ec2-user">SSH User</label>
        <input id="ec2-user" bind:value={ec2Editing.user} placeholder="ec2-user" />
      </div>
    </div>
    <div class="form-group">
      <div style="display:flex; align-items:center; gap:8px; margin-bottom:4px">
        <label for="ec2-key" style="margin:0">Private Key</label>
        <label class="upload-btn" title="Upload key file from disk">
          📂 Upload key file
          <input type="file" style="display:none" onchange={handleKeyFileUpload} />
        </label>
        {#if ec2Editing.private_key}
          <span style="color:#2a7; font-size:12px">✓ key loaded ({ec2Editing.private_key.split('\n').length} lines)</span>
        {/if}
      </div>
      <textarea
        id="ec2-key"
        bind:value={ec2Editing.private_key}
        placeholder="-----BEGIN OPENSSH PRIVATE KEY-----&#10;...&#10;-----END OPENSSH PRIVATE KEY-----"
        rows="5"
        style="font-family:monospace; font-size:11px; resize:vertical"
      ></textarea>
    </div>
    <div class="row">
      <div class="form-group" style="flex:1">
        <label for="ec2-remote-dir">Remote Dir</label>
        <input id="ec2-remote-dir" bind:value={ec2Editing.remote_dir} placeholder="~/mybench-bench" />
      </div>
      <div class="form-group" style="flex:1">
        <label for="ec2-log-dir">Log Dir</label>
        <input id="ec2-log-dir" bind:value={ec2Editing.log_dir} placeholder="/tmp/mybench-logs" />
      </div>
    </div>
    <div class="row">
      <button class="primary" onclick={saveEc2} disabled={ec2Saving}>{ec2Saving ? 'Saving…' : 'Save'}</button>
      <button onclick={() => { ec2Editing = null; ec2TestResult = null; }}>Cancel</button>
      <button onclick={testEc2} disabled={ec2Testing || !ec2Editing?.host || !ec2Editing?.private_key} style="margin-left:8px">
        {ec2Testing ? 'Testing…' : 'Test Connection'}
      </button>
    </div>
    {#if ec2TestResult}
      <div class="ec2-test-results">
        <div class="ec2-check" class:ok={ec2TestResult.ssh.ok} class:fail={!ec2TestResult.ssh.ok}>
          {ec2TestResult.ssh.ok ? '✓' : '✗'} SSH connection
          {#if !ec2TestResult.ssh.ok}<span class="check-detail">{ec2TestResult.ssh.error}</span>{/if}
        </div>
        {#if ec2TestResult.binary}
          <div class="ec2-check" class:ok={ec2TestResult.binary.ok} class:fail={!ec2TestResult.binary.ok}>
            {ec2TestResult.binary.ok ? '✓' : '✗'} mybench-runner
            {#if ec2TestResult.binary.ok}
              <span class="check-detail">{ec2TestResult.binary.version} at {ec2TestResult.binary.path}</span>
            {:else}
              <span class="check-detail">{ec2TestResult.binary.error}</span>
            {/if}
          </div>
        {/if}
        {#if ec2TestResult.iam}
          <div class="ec2-check" class:ok={ec2TestResult.iam.ok} class:warn={!ec2TestResult.iam.ok}>
            {ec2TestResult.iam.ok ? '✓' : '⚠'} IAM instance profile
            {#if ec2TestResult.iam.ok}
              <span class="check-detail">role: {ec2TestResult.iam.role}</span>
            {:else}
              <span class="check-detail">{ec2TestResult.iam.error}</span>
            {/if}
          </div>
        {/if}
      </div>
    {/if}
  </div>
{/if}

{#if ec2Servers.length === 0 && !ec2Editing}
  <p style="color:#666">No EC2 servers yet.</p>
{/if}

{#each ec2Servers as s}
  <div class="card">
    <div class="row">
      <div>
        <strong>{s.name}</strong>
        <span style="color:#666; font-size:12px; margin-left:8px">{s.user}@{s.host}:{s.port}</span>
      </div>
      <span class="spacer"></span>
      <button onclick={() => startEditEc2(s)}>Edit</button>
      <button class="danger" onclick={() => delEc2(s.id)}>Delete</button>
    </div>
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
  .upload-btn {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px;
    font-size: 12px;
    font-weight: normal;
    background: #f0f0f0;
    border: 1px solid #ccc;
    border-radius: 4px;
    cursor: pointer;
    white-space: nowrap;
  }
  .upload-btn:hover { background: #e4e4e4; }
  .ec2-test-results { margin-top: 10px; display: flex; flex-direction: column; gap: 4px; }
  .ec2-check { font-size: 13px; display: flex; align-items: baseline; gap: 6px; }
  .ec2-check.ok { color: #1a7a3a; }
  .ec2-check.fail { color: #c0392b; }
  .ec2-check.warn { color: #b8860b; }
  .check-detail { color: #666; font-size: 12px; }
</style>
