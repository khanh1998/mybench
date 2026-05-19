<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';

  const id = $derived(Number($page.params.id));
  let decision: {id: number; name: string; description: string} | null = $state(null);
  let designs: {id: number; name: string; description: string; database: string; server_id: number}[] = $state([]);
  let runs: Record<number, {id:number; status:string; tps:number|null; latency_avg_ms:number|null; started_at:string}[]> = $state({});
  let servers: {id:number; name:string; private_host?:string; vpc?:string}[] = $state([]);
  let ec2Servers: {id:number; name:string; host:string; user:string; port:number; vpc?:string}[] = $state([]);

  // New design form
  let newName = $state('');
  let newDesc = $state('');
  let newServerId = $state<number|null>(null);
  let newDatabase = $state('');
  let formError = $state('');
  let showForm = $state(false);

  type QuickTool = 'pgbench' | 'sysbench';
  type QuickParam = { position: number; name: string; value: string };
  const PGBENCH_TESTS = [
    { value: 'tpcb-like', label: 'TPC-B (tpcb-like)' },
    { value: 'simple-update', label: 'Simple Update (simple-update)' },
    { value: 'select-only', label: 'Select Only (select-only)' }
  ];
  const SYSBENCH_TESTS = [
    { value: 'oltp_read_write', label: 'Read/Write (oltp_read_write)' },
    { value: 'oltp_read_only', label: 'Read Only (oltp_read_only)' },
    { value: 'oltp_write_only', label: 'Write Only (oltp_write_only)' },
    { value: 'oltp_point_select', label: 'Point Select (oltp_point_select)' },
    { value: 'oltp_update_index', label: 'Update Index (oltp_update_index)' },
    { value: 'oltp_update_non_index', label: 'Update Non-Index (oltp_update_non_index)' }
  ];
  let showQuickModal = $state(false);
  let quickCreating = $state(false);
  let quickError = $state('');
  let quickTool = $state<QuickTool>('pgbench');
  let quickPgbenchTest = $state('tpcb-like');
  let quickSysbenchTest = $state('oltp_read_write');
  let quickScale = $state(10);
  let quickClients = $state(10);
  let quickPgThreads = $state(2);
  let quickPgDuration = $state(60);
  let quickTables = $state(10);
  let quickTableSize = $state(100000);
  let quickSysThreads = $state(4);
  let quickSysDuration = $state(60);
  let quickName = $state('');
  let quickDesc = $state('');
  let quickServerId = $state<number|null>(null);
  let quickDatabase = $state('');

  // Tab state
  type DecisionTab = 'designs' | 'parameters';
  let activeTab = $state<DecisionTab>('designs');

  // Decision params state
  let decisionParams = $state<{id:number; decision_id:number; position:number; name:string; value:string}[]>([]);
  let decisionParamsDirty = $state<{position:number; name:string; value:string}[]>([]);
  let decisionParamsSaving = $state(false);

  // Decision profiles state
  let decisionProfiles = $state<{id:number; decision_id:number; name:string; values:{param_name:string;value:string}[]}[]>([]);
  let showDecisionProfileForm = $state(false);
  let editingDecisionProfileId = $state<number|null>(null);
  let decisionProfileFormName = $state('');
  let decisionProfileFormValues = $state<{param_name:string;value:string}[]>([]);
  let decisionProfileSaving = $state(false);

  // Suite modal state
  interface SuiteDesignEntry {
    design_id: number;
    design_name: string;
    database: string;
    enabled: boolean;
  }
  let showSuiteModal = $state(false);
  let startingSuite = $state(false);
  let suiteName = $state('');
  let suiteDelay = $state(0);
  let suiteServerId = $state<number|null>(null);
  let suiteEc2ServerId = $state<number|null>(null);
  let suiteDatabase = $state('');
  let suiteSnapshotInterval = $state(30);
  let suiteUsePrivateIp = $state(false);
  let suiteDesigns = $state<SuiteDesignEntry[]>([]);
  let suiteDecisionProfileIds = $state<number[]>([]);
  let suiteAvailableDecisionProfiles = $state<{id:number; name:string}[]>([]);
  let suiteLoadingProfiles = $state(false);

  const suitePrivateIpApplicable = $derived((() => {
    const srv = servers.find(s => s.id === suiteServerId);
    const runner = ec2Servers.find(s => s.id === suiteEc2ServerId);
    return !!(srv?.private_host && srv.vpc && runner?.vpc && srv.vpc === runner.vpc);
  })());

  const suiteEnabledDesigns = $derived(suiteDesigns.filter(d => d.enabled));

  async function openSuiteModal() {
    suiteLoadingProfiles = true;
    suiteName = '';
    suiteDelay = 0;
    suiteServerId = null;
    suiteEc2ServerId = null;
    suiteDatabase = '';
    suiteSnapshotInterval = 30;
    suiteUsePrivateIp = false;
    showSuiteModal = true;

    const DEFAULT_PROFILE = { id: 0, name: 'Default' };
    const dprRes = await fetch(`/api/decisions/${id}/profiles`);
    const customProfiles: {id:number; name:string}[] = await dprRes.json();
    suiteAvailableDecisionProfiles = [DEFAULT_PROFILE, ...customProfiles];
    suiteDecisionProfileIds = customProfiles.length > 0 ? customProfiles.map(p => p.id) : [DEFAULT_PROFILE.id];

    suiteDesigns = designs.map(d => ({
      design_id: d.id,
      design_name: d.name,
      database: d.database,
      enabled: true,
    }));
    suiteLoadingProfiles = false;
  }

  function moveSuiteDecisionProfile(idx: number, dir: -1 | 1) {
    const arr = [...suiteDecisionProfileIds];
    const target = idx + dir;
    if (target < 0 || target >= arr.length) return;
    [arr[idx], arr[target]] = [arr[target], arr[idx]];
    suiteDecisionProfileIds = arr;
  }

  function removeSuiteDecisionProfile(idx: number) {
    suiteDecisionProfileIds = suiteDecisionProfileIds.filter((_, i) => i !== idx);
  }

  function addSuiteDecisionProfile(profileId: number) {
    if (!suiteDecisionProfileIds.includes(profileId)) {
      suiteDecisionProfileIds = [...suiteDecisionProfileIds, profileId];
    }
  }

  async function startSuite() {
    if (suiteEnabledDesigns.length === 0 || suiteDecisionProfileIds.length === 0) return;
    showSuiteModal = false;
    startingSuite = true;
    const body: Record<string, unknown> = {
      decision_id: id,
      designs: suiteEnabledDesigns.map(d => ({ design_id: d.design_id, decision_profile_ids: suiteDecisionProfileIds })),
      delay_seconds: suiteDelay,
      name: suiteName || undefined,
      server_id: suiteServerId,
      database: suiteDatabase || undefined,
      snapshot_interval_seconds: suiteSnapshotInterval,
    };
    body.ec2_server_id = suiteEc2ServerId;
    if (suiteUsePrivateIp) body.use_private_ip = true;
    const res = await fetch('/api/suites', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const { suite_id } = await res.json();
    startingSuite = false;
    goto(`/decisions/${id}/suites/${suite_id}`);
  }

  // Decision params CRUD
  function addDecisionParam() {
    decisionParamsDirty = [...decisionParamsDirty, { position: decisionParamsDirty.length, name: '', value: '' }];
  }

  function removeDecisionParam(idx: number) {
    decisionParamsDirty = decisionParamsDirty.filter((_, i) => i !== idx);
  }

  async function saveDecisionParams() {
    decisionParamsSaving = true;
    const res = await fetch(`/api/decisions/${id}/params`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ params: decisionParamsDirty.map((p, i) => ({ position: i, name: p.name, value: p.value })) })
    });
    decisionParams = await res.json();
    decisionParamsDirty = decisionParams.map(p => ({ position: p.position, name: p.name, value: p.value }));
    decisionParamsSaving = false;
  }

  // Decision profiles CRUD
  function openDecisionProfileForm(profile?: {id:number; name:string; values:{param_name:string;value:string}[]}) {
    if (profile) {
      editingDecisionProfileId = profile.id;
      decisionProfileFormName = profile.name;
      decisionProfileFormValues = decisionParamsDirty.map(p => ({
        param_name: p.name,
        value: profile.values.find(v => v.param_name === p.name)?.value ?? ''
      }));
    } else {
      editingDecisionProfileId = null;
      decisionProfileFormName = '';
      decisionProfileFormValues = decisionParamsDirty.map(p => ({ param_name: p.name, value: '' }));
    }
    showDecisionProfileForm = true;
  }

  async function saveDecisionProfile() {
    if (!decisionProfileFormName.trim()) return;
    decisionProfileSaving = true;
    const values = decisionProfileFormValues.filter(v => v.value !== '');
    if (editingDecisionProfileId) {
      await fetch(`/api/decisions/${id}/profiles/${editingDecisionProfileId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: decisionProfileFormName, values })
      });
    } else {
      await fetch(`/api/decisions/${id}/profiles`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: decisionProfileFormName, values })
      });
    }
    const r = await fetch(`/api/decisions/${id}/profiles`);
    decisionProfiles = await r.json();
    showDecisionProfileForm = false;
    decisionProfileSaving = false;
  }

  async function deleteDecisionProfile(profileId: number) {
    if (!confirm('Delete this profile?')) return;
    await fetch(`/api/decisions/${id}/profiles/${profileId}`, { method: 'DELETE' });
    decisionProfiles = decisionProfiles.filter(p => p.id !== profileId);
  }

  async function load() {
    const [dRes, dsRes, sRes, ec2Res, dpRes, dprRes] = await Promise.all([
      fetch(`/api/decisions/${id}`),
      fetch(`/api/designs?decision_id=${id}`),
      fetch('/api/connections'),
      fetch('/api/ec2'),
      fetch(`/api/decisions/${id}/params`),
      fetch(`/api/decisions/${id}/profiles`)
    ]);
    decision = await dRes.json();
    designs = await dsRes.json();
    servers = await sRes.json();
    ec2Servers = await ec2Res.json();
    decisionParams = await dpRes.json();
    decisionProfiles = await dprRes.json();
    decisionParamsDirty = decisionParams.map(p => ({ position: p.position, name: p.name, value: p.value }));

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

  function openQuickModal() {
    quickTool = 'pgbench';
    quickPgbenchTest = 'tpcb-like';
    quickSysbenchTest = 'oltp_read_write';
    quickScale = 10;
    quickClients = 10;
    quickPgThreads = 2;
    quickPgDuration = 60;
    quickTables = 10;
    quickTableSize = 100000;
    quickSysThreads = 4;
    quickSysDuration = 60;
    quickName = 'pgbench tpcb-like';
    quickDesc = '';
    quickServerId = null;
    quickDatabase = '';
    quickError = '';
    showQuickModal = true;
  }

  function setQuickTool(tool: QuickTool) {
    quickTool = tool;
    quickName = tool === 'pgbench' ? `pgbench ${quickPgbenchTest}` : `sysbench ${quickSysbenchTest}`;
  }

  function setQuickPgbenchTest(test: string) {
    quickPgbenchTest = test;
    if (quickTool === 'pgbench') quickName = `pgbench ${test}`;
  }

  function setQuickSysbenchTest(test: string) {
    quickSysbenchTest = test;
    if (quickTool === 'sysbench') quickName = `sysbench ${test}`;
  }

  function quickParams(): QuickParam[] {
    if (quickTool === 'pgbench') {
      return [
        { position: 0, name: 'SCALE', value: String(quickScale) },
        { position: 1, name: 'CLIENTS', value: String(quickClients) },
        { position: 2, name: 'THREADS', value: String(quickPgThreads) },
        { position: 3, name: 'DURATION', value: String(quickPgDuration) }
      ];
    }
    return [
      { position: 0, name: 'TABLES', value: String(quickTables) },
      { position: 1, name: 'TABLE_SIZE', value: String(quickTableSize) },
      { position: 2, name: 'THREADS', value: String(quickSysThreads) },
      { position: 3, name: 'DURATION', value: String(quickSysDuration) }
    ];
  }

  function quickSteps() {
    if (quickTool === 'pgbench') {
      return [
        { type: 'pgbench', name: 'Initialize', position: 0, pgbench_options: '-i -s {{SCALE}}', enabled: 1 },
        { type: 'pgbench', name: 'Benchmark', position: 1, pgbench_options: `-c {{CLIENTS}} -j {{THREADS}} -T {{DURATION}} -b ${quickPgbenchTest}`, enabled: 1 }
      ];
    }
    return [
      { type: 'sysbench', name: 'Prepare', position: 0, pgbench_options: 'oltp_common prepare --tables={{TABLES}} --table-size={{TABLE_SIZE}}', enabled: 1 },
      { type: 'sysbench', name: 'Benchmark', position: 1, pgbench_options: `${quickSysbenchTest} run --tables={{TABLES}} --table-size={{TABLE_SIZE}} --threads={{THREADS}} --time={{DURATION}}`, enabled: 1 },
      { type: 'sysbench', name: 'Cleanup', position: 2, pgbench_options: 'oltp_common cleanup --tables={{TABLES}} --table-size={{TABLE_SIZE}}', enabled: 1 }
    ];
  }

  async function createQuickBenchmark() {
    if (!quickName.trim()) { quickError = 'Name is required'; return; }
    quickCreating = true;
    quickError = '';
    try {
      const createRes = await fetch('/api/designs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          decision_id: id,
          name: quickName,
          description: quickDesc,
          server_id: quickServerId,
          database: quickDatabase,
          skip_default_steps: true
        })
      });
      if (!createRes.ok) throw new Error('Could not create design');
      const created = await createRes.json();
      const updateRes = await fetch(`/api/designs/${created.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...created,
          name: quickName,
          description: quickDesc,
          server_id: quickServerId,
          database: quickDatabase,
          steps: quickSteps(),
          params: quickParams()
        })
      });
      if (!updateRes.ok) throw new Error('Could not configure design');
      showQuickModal = false;
      goto(`/designs/${created.id}`);
    } catch (err) {
      quickError = err instanceof Error ? err.message : 'Could not create quick benchmark';
      quickCreating = false;
    }
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
    <button onclick={openSuiteModal} disabled={startingSuite || designs.length === 0} title="Run all designs sequentially with profile series">
      {startingSuite ? 'Starting…' : '⊞ Run Suite'}
    </button>
    <button class="danger" onclick={deleteDecision}>Delete</button>
  </div>

  <div class="tab-bar">
    <button class:tab-active={activeTab === 'designs'} onclick={() => activeTab = 'designs'}>Designs</button>
    <button class:tab-active={activeTab === 'parameters'} onclick={() => activeTab = 'parameters'}>
      Parameters{#if decisionParams.length > 0} <span class="tab-badge">{decisionParams.length}</span>{/if}
    </button>
  </div>

  {#if activeTab === 'designs'}
  <div class="row" style="margin-bottom: 12px;">
    <h2>Designs</h2>
    <span class="spacer"></span>
    <button onclick={openQuickModal}>⚡ Quick Benchmark</button>
    <button class="primary" onclick={() => showForm = !showForm}>+ New Design</button>
  </div>

  {#if showQuickModal}
    <div
      class="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="quick-modal-title"
      tabindex="-1"
      onclick={(e) => { if (e.currentTarget === e.target) showQuickModal = false; }}
      onkeydown={(e) => { if (e.key === 'Escape') showQuickModal = false; }}
    >
      <div class="modal quick-modal">
        <h3 id="quick-modal-title" style="margin:0 0 16px">Quick Benchmark</h3>

        <fieldset class="modal-fieldset">
          <legend>Tool</legend>
          <div class="quick-choice-row">
            <label class={quickTool === 'pgbench' ? 'quick-choice-active' : ''}>
              <input type="radio" name="quick-tool" checked={quickTool === 'pgbench'} onchange={() => setQuickTool('pgbench')} />
              pgbench
            </label>
            <label class={quickTool === 'sysbench' ? 'quick-choice-active' : ''}>
              <input type="radio" name="quick-tool" checked={quickTool === 'sysbench'} onchange={() => setQuickTool('sysbench')} />
              sysbench
            </label>
          </div>
        </fieldset>

        <div class="form-group">
          <label for="quick-test">Test</label>
          {#if quickTool === 'pgbench'}
            <select id="quick-test" value={quickPgbenchTest} onchange={(e) => setQuickPgbenchTest((e.currentTarget as HTMLSelectElement).value)}>
              {#each PGBENCH_TESTS as test}
                <option value={test.value}>{test.label}</option>
              {/each}
            </select>
          {:else}
            <select id="quick-test" value={quickSysbenchTest} onchange={(e) => setQuickSysbenchTest((e.currentTarget as HTMLSelectElement).value)}>
              {#each SYSBENCH_TESTS as test}
                <option value={test.value}>{test.label}</option>
              {/each}
            </select>
          {/if}
        </div>

        <div class="quick-grid">
          {#if quickTool === 'pgbench'}
            <div class="form-group">
              <label for="quick-scale">Scale Factor</label>
              <input id="quick-scale" type="number" bind:value={quickScale} min="1" />
            </div>
            <div class="form-group">
              <label for="quick-clients">Clients</label>
              <input id="quick-clients" type="number" bind:value={quickClients} min="1" />
            </div>
            <div class="form-group">
              <label for="quick-pg-threads">Threads</label>
              <input id="quick-pg-threads" type="number" bind:value={quickPgThreads} min="1" />
            </div>
            <div class="form-group">
              <label for="quick-pg-duration">Duration seconds</label>
              <input id="quick-pg-duration" type="number" bind:value={quickPgDuration} min="1" />
            </div>
          {:else}
            <div class="form-group">
              <label for="quick-tables">Tables</label>
              <input id="quick-tables" type="number" bind:value={quickTables} min="1" />
            </div>
            <div class="form-group">
              <label for="quick-table-size">Table size</label>
              <input id="quick-table-size" type="number" bind:value={quickTableSize} min="1" />
            </div>
            <div class="form-group">
              <label for="quick-sys-threads">Threads</label>
              <input id="quick-sys-threads" type="number" bind:value={quickSysThreads} min="1" />
            </div>
            <div class="form-group">
              <label for="quick-sys-duration">Duration seconds</label>
              <input id="quick-sys-duration" type="number" bind:value={quickSysDuration} min="1" />
            </div>
          {/if}
        </div>

        <div class="form-group">
          <label for="quick-name">Name</label>
          <input id="quick-name" bind:value={quickName} />
        </div>
        <div class="form-group">
          <label for="quick-desc">Description</label>
          <textarea id="quick-desc" bind:value={quickDesc} rows="2"></textarea>
        </div>
        <div class="quick-grid">
          <div class="form-group">
            <label for="quick-server">PostgreSQL Server</label>
            <select id="quick-server" bind:value={quickServerId}>
              <option value={null}>-- select server --</option>
              {#each servers as s}
                <option value={s.id}>{s.name}</option>
              {/each}
            </select>
          </div>
          <div class="form-group">
            <label for="quick-db">Database</label>
            <input id="quick-db" bind:value={quickDatabase} placeholder="my_benchmark_db" />
          </div>
        </div>

        {#if quickError}<p class="error">{quickError}</p>{/if}
        <div class="modal-actions">
          <button onclick={() => showQuickModal = false}>Cancel</button>
          <button class="primary" onclick={createQuickBenchmark} disabled={quickCreating || !quickName.trim()}>
            {quickCreating ? 'Creating...' : 'Create Benchmark'}
          </button>
        </div>
      </div>
    </div>
  {/if}

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

  <!-- Suite modal -->
  {#if showSuiteModal}
    <div
      class="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="suite-modal-title"
      tabindex="-1"
      onclick={(e) => { if (e.currentTarget === e.target) showSuiteModal = false; }}
      onkeydown={(e) => { if (e.key === 'Escape') showSuiteModal = false; }}
    >
      <div class="modal">
        <h3 id="suite-modal-title" style="margin:0 0 16px">Configure Suite</h3>

        <div class="form-group">
          <label for="suite-name">Suite name <span style="color:#aaa;font-weight:400">(optional)</span></label>
          <input id="suite-name" bind:value={suiteName} placeholder="e.g. full scale sweep" />
        </div>

        <div class="form-group">
          <label for="suite-delay">Delay between runs (seconds)</label>
          <input id="suite-delay" type="number" bind:value={suiteDelay} min="0" max="3600" />
        </div>

        <div class="form-group">
          <label for="suite-ec2">VPS Server</label>
          <select id="suite-ec2" bind:value={suiteEc2ServerId}>
            <option value={null}>— select VPS server —</option>
            {#each ec2Servers as s}
              <option value={s.id}>{s.name} ({s.user}@{s.host}:{s.port})</option>
            {/each}
          </select>
          {#if ec2Servers.length === 0}<p style="font-size:12px; color:#aaa; margin:4px 0 0">No VPS servers configured — add one in Settings.</p>{/if}
        </div>
        {#if suitePrivateIpApplicable || (suiteEc2ServerId && servers.find(s => s.id === suiteServerId)?.private_host)}
          <div class="form-group">
            <label style="display:flex; align-items:center; gap:8px; font-weight:normal; cursor:pointer">
              <input type="checkbox" style="width:auto" checked={suiteUsePrivateIp}
                onchange={(e) => { suiteUsePrivateIp = (e.currentTarget as HTMLInputElement).checked; }} />
              Use private network (VPC)
            </label>
          </div>
        {/if}

        <div class="form-group">
          <label for="suite-server">PostgreSQL Server</label>
          <select id="suite-server" bind:value={suiteServerId}>
            <option value={null}>— use each design's default —</option>
            {#each servers as s}
              <option value={s.id}>{s.name}</option>
            {/each}
          </select>
        </div>

        <div class="form-group">
          <label for="suite-db">Database</label>
          <input id="suite-db" bind:value={suiteDatabase} placeholder="— use each design's own database —" />
        </div>

        <div class="form-group">
          <label for="suite-snap">Snapshot interval (s)</label>
          <input id="suite-snap" type="number" bind:value={suiteSnapshotInterval} min="5" max="300" />
        </div>

        <div class="form-group">
          <div class="group-label">Profiles <span style="color:#aaa; font-weight:400; font-size:11px">(run order — applied to all designs)</span></div>
          {#if suiteLoadingProfiles}
            <p style="color:#999; font-size:12px">Loading…</p>
          {:else if suiteAvailableDecisionProfiles.length === 0}
            <p style="color:#f38ba8; font-size:12px">No decision-level profiles defined. Go to the Parameters tab to add profiles.</p>
          {:else}
            <div class="suite-profiles-block">
              {#each suiteDecisionProfileIds as pid, pi}
                {@const prof = suiteAvailableDecisionProfiles.find(p => p.id === pid)}
                {#if prof}
                  <div class="series-profile-row">
                    <span class="series-profile-num">{pi + 1}</span>
                    <span class="series-profile-name">{prof.name}</span>
                    <div class="series-profile-controls">
                      <button type="button" onclick={() => moveSuiteDecisionProfile(pi, -1)} disabled={pi === 0} class="icon-btn">↑</button>
                      <button type="button" onclick={() => moveSuiteDecisionProfile(pi, 1)} disabled={pi === suiteDecisionProfileIds.length - 1} class="icon-btn">↓</button>
                      <button type="button" onclick={() => removeSuiteDecisionProfile(pi)} class="icon-btn danger-icon">✕</button>
                    </div>
                  </div>
                {/if}
              {/each}
              {#if suiteDecisionProfileIds.length < suiteAvailableDecisionProfiles.length}
                <div class="series-add-profile">
                  <select onchange={(e) => { const v = Number((e.currentTarget as HTMLSelectElement).value); if (v !== undefined) addSuiteDecisionProfile(v); (e.currentTarget as HTMLSelectElement).value = ''; }}>
                    <option value="">+ Add profile…</option>
                    {#each suiteAvailableDecisionProfiles.filter(p => !suiteDecisionProfileIds.includes(p.id)) as p}
                      <option value={p.id}>{p.name}</option>
                    {/each}
                  </select>
                </div>
              {/if}
              {#if suiteDecisionProfileIds.length === 0}
                <p style="color:#f38ba8; font-size:12px; margin:6px 0 0">Add at least one profile</p>
              {/if}
            </div>
          {/if}
        </div>

        <div class="form-group">
          <div class="group-label">Designs</div>
          {#if suiteLoadingProfiles}
            <p style="color:#999; font-size:12px">Loading…</p>
          {:else}
            <div class="suite-designs-list">
              {#each suiteDesigns as entry, di}
                <div class="suite-design-block" class:suite-design-disabled={!entry.enabled}>
                  <div class="suite-design-header">
                    <label style="display:flex; align-items:center; gap:8px; font-weight:600; cursor:pointer; margin:0">
                      <input type="checkbox" style="width:auto"
                        checked={entry.enabled}
                        onchange={(e) => { suiteDesigns[di] = { ...entry, enabled: (e.currentTarget as HTMLInputElement).checked }; }} />
                      {entry.design_name}
                    </label>
                  </div>
                </div>
              {/each}
            </div>
            {#if suiteEnabledDesigns.length === 0}
              <p style="color:#dc3545; font-size:12px; margin:6px 0 0">Enable at least one design</p>
            {/if}
          {/if}
        </div>

        <div class="modal-actions">
          <button onclick={() => showSuiteModal = false}>Cancel</button>
          <button class="primary" onclick={startSuite}
            disabled={suiteLoadingProfiles || suiteEnabledDesigns.length === 0 || suiteDecisionProfileIds.length === 0 || !suiteEc2ServerId}>
            ⊞ Start Suite
          </button>
        </div>
      </div>
    </div>
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
  {/if}<!-- end designs tab -->

  {#if activeTab === 'parameters'}
  <div class="params-tab">
    <div class="params-section">
      <div class="row" style="margin-bottom:8px">
        <h3 style="margin:0">Parameters</h3>
        <span class="spacer"></span>
        <button class="primary" onclick={addDecisionParam}>+ Add</button>
      </div>
      {#if decisionParamsDirty.length === 0}
        <p style="color:#888; font-size:13px">No parameters yet. Add shared parameters that all designs will inherit.</p>
      {:else}
        <div class="params-list">
          {#each decisionParamsDirty as param, i}
            <div class="param-row">
              <input class="param-name-input" bind:value={param.name} placeholder="NAME" />
              <input class="param-value-input" bind:value={param.value} placeholder="default value" />
              <button class="icon-btn danger-icon" onclick={() => removeDecisionParam(i)}>✕</button>
            </div>
          {/each}
        </div>
      {/if}
      <div style="margin-top:12px">
        <button class="primary" onclick={saveDecisionParams} disabled={decisionParamsSaving}>
          {decisionParamsSaving ? 'Saving…' : 'Save Parameters'}
        </button>
      </div>
    </div>

    {#if decisionParamsDirty.length > 0}
    <div class="params-section" style="margin-top:20px">
      <div class="row" style="margin-bottom:8px">
        <h3 style="margin:0">Profiles</h3>
        <span class="spacer"></span>
        <button onclick={() => openDecisionProfileForm()}>+ Add Profile</button>
      </div>
      <p style="color:#888; font-size:12px; margin:0 0 10px">Profiles override parameter values for specific run scenarios (e.g. "small", "large"). Used when running suites.</p>
      {#if decisionProfiles.length === 0}
        <p style="color:#888; font-size:13px">No profiles yet.</p>
      {:else}
        <div class="profiles-list">
          {#each decisionProfiles as prof}
            <div class="profile-item">
              <div class="profile-item-header">
                <span class="profile-name">{prof.name}</span>
                <div class="profile-actions">
                  <button class="icon-btn" onclick={() => openDecisionProfileForm(prof)}>✎</button>
                  <button class="icon-btn danger-icon" onclick={() => deleteDecisionProfile(prof.id)}>✕</button>
                </div>
              </div>
              {#if prof.values.length > 0}
                <div class="profile-values">
                  {#each prof.values as v}
                    <span class="profile-pill">{v.param_name}={v.value}</span>
                  {/each}
                </div>
              {:else}
                <p style="font-size:11px; color:#aaa; margin:4px 0 0">No overrides</p>
              {/if}
            </div>
          {/each}
        </div>
      {/if}
    </div>
    {/if}
  </div>
  {/if}<!-- end parameters tab -->

  <!-- Decision profile form modal -->
  {#if showDecisionProfileForm}
    <div
      class="modal-backdrop"
      role="dialog"
      aria-modal="true"
      tabindex="-1"
      onclick={(e) => { if (e.currentTarget === e.target) showDecisionProfileForm = false; }}
      onkeydown={(e) => { if (e.key === 'Escape') showDecisionProfileForm = false; }}
    >
      <div class="modal">
        <h3 style="margin:0 0 16px">{editingDecisionProfileId ? 'Edit Profile' : 'New Profile'}</h3>
        <div class="form-group">
          <label for="dp-form-name">Profile name</label>
          <input id="dp-form-name" bind:value={decisionProfileFormName} placeholder="e.g. small, large" />
        </div>
        {#if decisionProfileFormValues.length > 0}
          <div class="form-group">
            <div class="group-label">Parameter overrides</div>
            {#each decisionProfileFormValues as fv}
              <div class="param-row" style="margin-bottom:6px">
                <span class="param-name-label">{fv.param_name}</span>
                <input bind:value={fv.value} placeholder="override value (blank = use default)" />
              </div>
            {/each}
          </div>
        {/if}
        <div class="modal-actions">
          <button onclick={() => showDecisionProfileForm = false}>Cancel</button>
          <button class="primary" onclick={saveDecisionProfile} disabled={decisionProfileSaving || !decisionProfileFormName.trim()}>
            {decisionProfileSaving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  {/if}

{:else}
  <p>Loading...</p>
{/if}

<style>
  .btn-link { text-decoration: none; }
  .design-card { transition: box-shadow 0.15s; }
  .design-card:hover { box-shadow: 0 2px 8px rgba(0,0,0,0.1); }

  .tab-bar { display: flex; gap: 4px; border-bottom: 1px solid #e0e0e0; margin-bottom: 16px; }
  .tab-bar button { background: none; border: none; border-bottom: 2px solid transparent; padding: 8px 16px; font-size: 13px; font-weight: 500; color: #666; cursor: pointer; margin-bottom: -1px; border-radius: 0; }
  .tab-bar button:hover { color: #333; }
  .tab-bar button.tab-active { color: #0066cc; border-bottom-color: #0066cc; }
  .tab-badge { background: #0066cc; color: #fff; border-radius: 10px; padding: 1px 6px; font-size: 10px; font-weight: 700; margin-left: 4px; }

  .params-tab { max-width: 640px; }
  .params-list { display: flex; flex-direction: column; gap: 6px; margin-bottom: 8px; }
  .param-row { display: flex; align-items: center; gap: 8px; }
  .param-name-input { width: 180px; font-family: monospace; font-size: 13px; }
  .param-value-input { flex: 1; font-size: 13px; }
  .param-name-label { width: 180px; font-family: monospace; font-size: 13px; color: #555; flex-shrink: 0; }

  .profiles-list { display: flex; flex-direction: column; gap: 8px; }
  .profile-item { border: 1px solid #e0e0e0; border-radius: 6px; padding: 10px 12px; }
  .profile-item-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
  .profile-name { font-weight: 600; font-size: 13px; }
  .profile-actions { display: flex; gap: 4px; }
  .profile-values { display: flex; flex-wrap: wrap; gap: 4px; }
  .profile-pill { background: #e8f0fe; color: #1a56db; border-radius: 4px; padding: 2px 8px; font-size: 11px; font-family: monospace; }

  .suite-profiles-block { border: 1px solid #e0e0e0; border-radius: 6px; overflow: hidden; }

  .modal-backdrop {
    position: fixed; inset: 0; background: rgba(0,0,0,0.5);
    display: flex; align-items: center; justify-content: center; z-index: 1000;
  }
  .modal {
    background: #fff; border-radius: 8px; padding: 24px; width: 520px;
    box-shadow: 0 8px 32px rgba(0,0,0,0.2); max-height: 90vh; overflow-y: auto;
  }
  .modal .form-group { margin-bottom: 14px; }
  .modal .form-group label { display: block; font-size: 12px; font-weight: 600; color: #555; margin-bottom: 4px; }
  .modal .form-group .group-label { display: block; font-size: 12px; font-weight: 600; color: #555; margin-bottom: 4px; }
  .modal .form-group input, .modal .form-group select { width: 100%; box-sizing: border-box; }
  .modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 20px; }
  .modal-fieldset { border: 0; padding: 0; margin: 0 0 14px; min-width: 0; }
  .modal-fieldset legend { font-size: 12px; font-weight: 600; color: #555; margin-bottom: 4px; padding: 0; }
  .disabled { opacity: 0.5; }
  .quick-modal { width: 620px; }
  .quick-choice-row { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .quick-choice-row label {
    display: flex;
    align-items: center;
    gap: 8px;
    border: 1px solid #ddd;
    border-radius: 6px;
    padding: 10px 12px;
    cursor: pointer;
    font-size: 13px;
    font-weight: 600;
  }
  .quick-choice-row label.quick-choice-active {
    border-color: #0066cc;
    background: #eef6ff;
    color: #0055aa;
  }
  .quick-choice-row input { width: auto; }
  .quick-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 12px;
  }
  .modal textarea { width: 100%; box-sizing: border-box; }

  .suite-designs-list { display: flex; flex-direction: column; gap: 8px; }
  .suite-design-block { border: 1px solid #e0e0e0; border-radius: 6px; overflow: hidden; }
  .suite-design-block.suite-design-disabled { opacity: 0.6; }
  .suite-design-header { padding: 8px 10px; background: #f8f8f8; border-bottom: 1px solid #e0e0e0; display: flex; align-items: center; }
  .suite-design-block.suite-design-disabled .suite-design-header { border-bottom: none; }

  .series-profile-row { display: flex; align-items: center; gap: 8px; padding: 5px 10px; border-bottom: 1px solid #f0f0f0; background: #fafafa; }
  .series-profile-row:last-child { border-bottom: none; }
  .series-profile-num { font-size: 11px; color: #aaa; width: 16px; text-align: right; flex-shrink: 0; }
  .series-profile-name { flex: 1; font-size: 13px; color: #333; }
  .series-profile-controls { display: flex; gap: 4px; }
  .series-add-profile { padding: 6px 10px; background: #f5f5f5; }
  .series-add-profile select { font-size: 12px; padding: 3px 6px; border: 1px solid #ddd; border-radius: 3px; background: white; color: #555; width: auto; }
  .icon-btn { padding: 1px 5px; font-size: 11px; background: transparent; border: 1px solid #ccc; border-radius: 3px; cursor: pointer; }
  .icon-btn:hover:not(:disabled) { background: #e8e8e8; }
  .icon-btn:disabled { opacity: 0.3; cursor: default; }
  .danger-icon:hover:not(:disabled) { background: #f8d7da; border-color: #f5c6cb; color: #721c24; }
</style>
