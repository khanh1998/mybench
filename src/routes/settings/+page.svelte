<script lang="ts">
  import { onMount } from 'svelte';

  interface Server {
    id: number; name: string; host: string; port: number; username: string; password: string; ssl: number;
    ssh_enabled: number; ssh_host: string | null; ssh_port: number; ssh_user: string | null; ssh_private_key: string | null;
    private_host: string; vpc: string; spec: string; pg_config: string;
  }

  let activeTab = $state<'db-servers' | 'runners'>('db-servers');

  let servers: Server[] = $state([]);
  let editing: Partial<Server> | null = $state(null);
  let isNew = $state(false);
  let testMsg = $state('');
  let testOk = $state<boolean|null>(null);
  let testDb = $state('postgres');
  let saving = $state(false);
  let sshTesting = $state(false);
  let sshTestResult = $state<{ ok: boolean; tools?: string[]; error?: string } | null>(null);

  // ── EC2 Servers ──────────────────────────────────────────────────────────────
  interface Ec2Server {
    id: number; name: string; host: string; user: string; port: number;
    private_key: string; remote_dir: string; log_dir: string; cli_log_dir: string; vpc: string; spec: string;
  }

  let ec2Servers: Ec2Server[] = $state([]);
  const knownVpcs = $derived(
    [...servers.map(s => s.vpc), ...ec2Servers.map(s => s.vpc)].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i)
  );
  let ec2Editing: Partial<Ec2Server> | null = $state(null);
  let ec2IsNew = $state(false);
  interface Ec2TestResult {
    ok: boolean;
    ssh: { ok: boolean; error?: string };
    binary?: { ok: boolean; version?: string; path?: string; error?: string };
    pgbench?: { ok: boolean; version?: string; error?: string };
    sysbench?: { ok: boolean; version?: string; error?: string };
  }
  let ec2TestResult = $state<Ec2TestResult | null>(null);
  let ec2Testing = $state(false);
  let ec2Saving = $state(false);
  let ec2Installing = $state<string | null>(null);
  let ec2InstallOutput = $state<string>('');
  let ec2InstallOutputEl = $state<HTMLPreElement | null>(null);
  let ec2DetectingSpec = $state(false);
  let pgDetectingSpec = $state(false);

  async function detectEc2Spec() {
    if (!ec2Editing?.host || !ec2Editing?.private_key) return;
    ec2DetectingSpec = true;
    try {
      const res = await fetch('/api/onboard/detect-spec', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ host: ec2Editing.host, user: ec2Editing.user, private_key: ec2Editing.private_key })
      });
      const data = await res.json();
      if (data.ok && data.spec && ec2Editing) ec2Editing.spec = data.spec;
    } finally {
      ec2DetectingSpec = false;
    }
  }

  async function detectPgSpec() {
    if (!editing?.ssh_user || !editing?.ssh_private_key) return;
    const host = editing.ssh_host || editing.host;
    if (!host) return;
    pgDetectingSpec = true;
    try {
      const res = await fetch('/api/onboard/detect-spec', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ host, user: editing.ssh_user, private_key: editing.ssh_private_key })
      });
      const data = await res.json();
      if (data.ok && data.spec && editing) editing.spec = data.spec;
    } finally {
      pgDetectingSpec = false;
    }
  }

  async function installTool(tool: string) {
    if (!ec2Editing) return;
    ec2Installing = tool;
    ec2InstallOutput = '';

    const res = await fetch('/api/ec2/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        host: ec2Editing.host,
        user: ec2Editing.user,
        port: ec2Editing.port,
        private_key: ec2Editing.private_key,
        remote_dir: ec2Editing.remote_dir,
        log_dir: ec2Editing.log_dir,
        tool
      })
    });

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split('\n\n');
      buf = parts.pop() ?? '';
      for (const part of parts) {
        const dataLine = part.split('\n').find(l => l.startsWith('data: '));
        if (!dataLine) continue;
        try {
          const data = JSON.parse(dataLine.slice(6));
          if (data.line !== undefined) {
            ec2InstallOutput += data.line + '\n';
            if (ec2InstallOutputEl) ec2InstallOutputEl.scrollTop = ec2InstallOutputEl.scrollHeight;
          }
          if (data.done) {
            ec2Installing = null;
            if (data.ok) {
              ec2InstallOutput += '\n✓ Installation complete. Running test...\n';
              await testEc2();
            } else {
              ec2InstallOutput += `\n✗ Installation failed${data.error ? ': ' + data.error : ''}\n`;
            }
          }
        } catch { /* ignore parse errors */ }
      }
    }
  }

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
    ec2Editing = { name: '', host: '', user: 'ec2-user', port: 22, private_key: '', remote_dir: '~/mybench-bench', log_dir: '/tmp/mybench-logs', cli_log_dir: '/tmp/gocli-logs', vpc: '', spec: '' };
    ec2IsNew = true;
    ec2TestResult = null;
    ec2InstallOutput = '';
  }

  function startEditEc2(s: Ec2Server) {
    ec2Editing = { ...s };
    ec2IsNew = false;
    ec2TestResult = null;
    ec2InstallOutput = '';
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
    if (!confirm('Delete this VPS server?')) return;
    await fetch(`/api/ec2/${id}`, { method: 'DELETE' });
    await loadEc2();
  }

  async function testEc2() {
    if (!ec2Editing) return;
    ec2Testing = true;
    ec2TestResult = null;
    ec2InstallOutput = '';
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
    editing = { name: '', host: 'localhost', port: 5432, username: 'postgres', password: '', ssl: 0, ssh_enabled: 0, ssh_host: null, ssh_port: 22, ssh_user: null, ssh_private_key: null, private_host: '', vpc: '', spec: '', pg_config: '' };
    isNew = true;
    testMsg = '';
    testOk = null;
    sshTestResult = null;
  }

  function startEdit(s: Server) {
    editing = { ...s };
    isNew = false;
    testMsg = '';
    testOk = null;
    sshTestResult = null;
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
      res = await fetch('/api/connections/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...editing, database: testDb })
      });
    } else {
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

  async function testSsh() {
    if (!editing || !editing.id) return;
    sshTesting = true;
    sshTestResult = null;
    const res = await fetch(`/api/connections/${editing.id}/test-ssh`, { method: 'POST' });
    sshTestResult = await res.json();
    sshTesting = false;
  }

  async function handleSshKeyFileUpload(e: Event) {
    const file = (e.currentTarget as HTMLInputElement).files?.[0];
    if (!file || !editing) return;
    editing.ssh_private_key = await file.text();
  }

  function serverTypeBadge(s: Server): string {
    if (s.ssh_enabled) return 'SSH';
    return 'Local';
  }

  onMount(() => { load(); loadEc2(); });
</script>

<datalist id="vpc-list">
  {#each knownVpcs as v}
    <option value={v}>{v}</option>
  {/each}
</datalist>

<h1>Settings</h1>

<div class="run-tabs" style="margin-bottom: 20px">
  <button class="tab-btn" class:active={activeTab === 'db-servers'} onclick={() => activeTab = 'db-servers'}>Database Servers</button>
  <button class="tab-btn" class:active={activeTab === 'runners'} onclick={() => activeTab = 'runners'}>Benchmark Runners</button>
</div>

<!-- ── Database Servers Tab ──────────────────────────────────────────────── -->
{#if activeTab === 'db-servers'}

<div class="row" style="margin-bottom:12px">
  <h2>Database Servers</h2>
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
    <div class="row" style="margin-top:4px">
      <div class="form-group" style="flex:3">
        <label for="conn-private-host">Private / VPC Host <span style="font-weight:normal;color:#888">(optional — internal IP for runner→PG traffic)</span></label>
        <input id="conn-private-host" bind:value={editing.private_host} placeholder="10.0.0.5 or pg.internal" />
      </div>
      <div class="form-group" style="flex:2">
        <label for="conn-vpc">VPC <span style="font-weight:normal;color:#888">(optional)</span></label>
        <input id="conn-vpc" list="vpc-list" bind:value={editing.vpc} placeholder="default-sgp1" />
      </div>
    </div>

    <div class="row" style="margin-top:4px">
      <div class="form-group" style="flex:1">
        <div style="display:flex; align-items:center; gap:8px; margin-bottom:4px">
          <label for="conn-spec" style="margin:0">Instance spec <span style="font-weight:normal;color:#888">(optional)</span></label>
          {#if editing.ssh_enabled && editing.ssh_user && editing.ssh_private_key}
            <button
              type="button"
              onclick={detectPgSpec}
              disabled={pgDetectingSpec}
              style="font-size:11px; padding:2px 8px"
            >{pgDetectingSpec ? 'Detecting…' : 'Auto-detect'}</button>
          {/if}
        </div>
        <input id="conn-spec" bind:value={editing.spec} placeholder="8 vCPU (Intel Xeon Platinum 8168 @ 2.70GHz), 32 GB RAM, 500 GB SSD" />
      </div>
    </div>
    <div class="form-group" style="margin-top:4px">
      <label for="conn-pg-config">PostgreSQL config notes <span style="font-weight:normal;color:#888">(optional — freeform, e.g. max_connections = 200)</span></label>
      <textarea
        id="conn-pg-config"
        bind:value={editing.pg_config}
        placeholder="max_connections = 200&#10;shared_buffers = 4GB&#10;work_mem = 64MB"
        rows="3"
        style="font-family:monospace; font-size:12px; resize:vertical"
      ></textarea>
    </div>

    <!-- OS Metrics via SSH -->
    <div class="ssh-section">
      <label class="ssh-toggle-label">
        <input
          type="checkbox"
          style="width:auto"
          checked={!!editing.ssh_enabled}
          onchange={(e) => { if (editing) editing.ssh_enabled = (e.currentTarget as HTMLInputElement).checked ? 1 : 0; }}
        />
        <strong>OS Metrics via SSH</strong>
        <span style="font-weight:normal; color:#888; font-size:12px">— collect CPU, memory, disk, and network metrics during benchmarks</span>
      </label>
      {#if editing.ssh_enabled}
      <div class="row" style="margin-top:8px">
        <div class="form-group" style="flex:3">
          <label for="ssh-host">SSH Host <span style="font-weight:normal;color:#888">(optional, defaults to PG host)</span></label>
          <input id="ssh-host" bind:value={editing.ssh_host} placeholder={editing.host || 'same as PG host'} />
        </div>
        <div class="form-group" style="flex:1">
          <label for="ssh-port">SSH Port</label>
          <input id="ssh-port" type="number" bind:value={editing.ssh_port} />
        </div>
        <div class="form-group" style="flex:2">
          <label for="ssh-user">SSH User</label>
          <input id="ssh-user" bind:value={editing.ssh_user} placeholder="ubuntu" />
        </div>
      </div>
      <div class="form-group">
        <div style="display:flex; align-items:center; gap:8px; margin-bottom:4px">
          <label for="ssh-key" style="margin:0">Private Key</label>
          <label class="upload-btn" title="Upload key file from disk">
            📂 Upload key file
            <input type="file" style="display:none" onchange={handleSshKeyFileUpload} />
          </label>
          {#if editing.ssh_private_key}
            <span style="color:#2a7; font-size:12px">✓ key loaded ({editing.ssh_private_key.split('\n').length} lines)</span>
          {/if}
        </div>
        <textarea
          id="ssh-key"
          bind:value={editing.ssh_private_key}
          placeholder="-----BEGIN OPENSSH PRIVATE KEY-----&#10;...&#10;-----END OPENSSH PRIVATE KEY-----"
          rows="4"
          style="font-family:monospace; font-size:11px; resize:vertical"
        ></textarea>
      </div>
      {#if !isNew}
      <div style="margin-top:4px">
        <button onclick={testSsh} disabled={sshTesting || !editing.ssh_user || !editing.ssh_private_key}>
          {sshTesting ? 'Testing SSH…' : 'Test SSH'}
        </button>
        {#if sshTestResult}
          {#if sshTestResult.ok}
            <span class="ssh-ok">✓ Connected — tools: {sshTestResult.tools?.join(', ')}</span>
          {:else}
            <span class="ssh-fail">✗ {sshTestResult.error}</span>
          {/if}
        {/if}
      </div>
      {/if}
      {/if}
    </div>

    <div class="row" style="margin-top:12px">
      <button class="primary" onclick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
      <button onclick={() => { editing = null; testMsg = ''; testOk = null; sshTestResult = null; }}>Cancel</button>
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
        <span class="type-badge type-badge--{serverTypeBadge(s).toLowerCase()}">{serverTypeBadge(s)}</span>
        <span style="color:#666; font-size:12px; margin-left:8px">{s.username}@{s.host}:{s.port}{s.ssl ? ' · SSL' : ''}</span>
      </div>
      <span class="spacer"></span>
      <button onclick={() => startEdit(s)}>Edit</button>
      <button class="danger" onclick={() => del(s.id)}>Delete</button>
    </div>
  </div>
{/each}

{/if}

<!-- ── Benchmark Runners Tab ─────────────────────────────────────────────── -->
{#if activeTab === 'runners'}

<div class="row" style="margin-bottom:12px">
  <h2>Benchmark Runners</h2>
  <span class="spacer"></span>
  <button class="primary" onclick={startNewEc2}>+ Add VPS Server</button>
</div>

{#if ec2Editing}
  <div class="card">
    <h3>{ec2IsNew ? 'New VPS Server' : 'Edit VPS Server'}</h3>
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
      <div class="form-group" style="flex:1">
        <label for="ec2-vpc">VPC <span style="font-weight:normal;color:#888">(optional)</span></label>
        <input id="ec2-vpc" list="vpc-list" bind:value={ec2Editing.vpc} placeholder="default-sgp1" />
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
      <div class="form-group" style="flex:1">
        <label for="ec2-cli-log-dir">CLI Log Dir</label>
        <input id="ec2-cli-log-dir" bind:value={ec2Editing.cli_log_dir} placeholder="/tmp/gocli-logs" />
      </div>
    </div>
    <div class="form-group" style="margin-top:4px">
      <div style="display:flex; align-items:center; gap:8px; margin-bottom:4px">
        <label for="ec2-spec" style="margin:0">Instance spec <span style="font-weight:normal;color:#888">(optional)</span></label>
        <button
          type="button"
          onclick={detectEc2Spec}
          disabled={ec2DetectingSpec || !ec2Editing?.host || !ec2Editing?.private_key}
          style="font-size:11px; padding:2px 8px"
        >{ec2DetectingSpec ? 'Detecting…' : 'Auto-detect'}</button>
      </div>
      <input id="ec2-spec" bind:value={ec2Editing.spec} placeholder="4 vCPU (Intel Xeon Platinum 8168 @ 2.70GHz), 8 GB RAM, 50 GB SSD" />
    </div>
    <div class="row">
      <button class="primary" onclick={saveEc2} disabled={ec2Saving}>{ec2Saving ? 'Saving…' : 'Save'}</button>
      <button onclick={() => { ec2Editing = null; ec2TestResult = null; ec2InstallOutput = ''; }}>Cancel</button>
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
              <button class="install-btn" disabled={ec2Installing !== null} onclick={() => installTool('mybench-runner')}>
                {ec2Installing === 'mybench-runner' ? 'Installing…' : 'Install from source'}
              </button>
            {/if}
          </div>
        {/if}
        {#if ec2TestResult.pgbench}
          <div class="ec2-check" class:ok={ec2TestResult.pgbench.ok} class:fail={!ec2TestResult.pgbench.ok}>
            {ec2TestResult.pgbench.ok ? '✓' : '✗'} pgbench
            {#if ec2TestResult.pgbench.ok}
              <span class="check-detail">{ec2TestResult.pgbench.version}</span>
            {:else}
              <span class="check-detail">{ec2TestResult.pgbench.error}</span>
              <button class="install-btn" disabled={ec2Installing !== null} onclick={() => installTool('pgbench')}>
                {ec2Installing === 'pgbench' ? 'Installing…' : 'Install'}
              </button>
            {/if}
          </div>
        {/if}
        {#if ec2TestResult.sysbench}
          <div class="ec2-check" class:ok={ec2TestResult.sysbench.ok} class:fail={!ec2TestResult.sysbench.ok}>
            {ec2TestResult.sysbench.ok ? '✓' : '✗'} sysbench
            {#if ec2TestResult.sysbench.ok}
              <span class="check-detail">{ec2TestResult.sysbench.version}</span>
            {:else}
              <span class="check-detail">{ec2TestResult.sysbench.error}</span>
              <button class="install-btn" disabled={ec2Installing !== null} onclick={() => installTool('sysbench')}>
                {ec2Installing === 'sysbench' ? 'Installing…' : 'Install'}
              </button>
            {/if}
          </div>
        {/if}
      </div>
    {/if}
    {#if ec2InstallOutput}
      <pre class="install-log" bind:this={ec2InstallOutputEl}>{ec2InstallOutput}</pre>
    {/if}
  </div>
{/if}

{#if ec2Servers.length === 0 && !ec2Editing}
  <p style="color:#666">No VPS servers yet.</p>
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

{/if}

<style>
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
  .ec2-check { font-size: 13px; display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; }
  .ec2-check.ok { color: #1a7a3a; }
  .ec2-check.fail { color: #c0392b; }
  .ec2-check.warn { color: #b8860b; }
  .check-detail { color: #666; font-size: 12px; }
  .install-btn { font-size: 11px; padding: 1px 8px; background: #0066cc; color: #fff; border: none; border-radius: 3px; cursor: pointer; }
  .install-btn:hover:not(:disabled) { background: #0055aa; }
  .install-btn:disabled { background: #aaa; cursor: not-allowed; }
  .install-log { margin-top: 10px; font-size: 11px; background: #1e1e1e; color: #d4d4d4; padding: 10px; border-radius: 4px; max-height: 300px; overflow-y: auto; white-space: pre-wrap; word-break: break-all; }

  .ssh-section {
    border-top: 1px solid #e8e8e8;
    margin-top: 12px;
    padding-top: 12px;
  }
  .ssh-toggle-label {
    display: flex;
    align-items: center;
    gap: 8px;
    cursor: pointer;
    font-weight: normal;
  }
  .ssh-ok { color: #1a7a3a; font-size: 13px; margin-left: 10px; }
  .ssh-fail { color: #c0392b; font-size: 13px; margin-left: 10px; }

  .type-badge {
    display: inline-block;
    font-size: 10px;
    font-weight: 600;
    padding: 1px 6px;
    border-radius: 3px;
    margin-left: 6px;
    vertical-align: middle;
    letter-spacing: 0.03em;
    text-transform: uppercase;
  }
  .type-badge--rds { background: #fff0d9; color: #a05000; border: 1px solid #f0c070; }
  .type-badge--ssh { background: #e8f5e9; color: #1a7a3a; border: 1px solid #a5d6a7; }
  .type-badge--local { background: #f0f0f0; color: #666; border: 1px solid #ccc; }
</style>
