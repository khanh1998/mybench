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

  // Suite modal state
  interface SuiteDesignEntry {
    design_id: number;
    design_name: string;
    database: string;
    enabled: boolean;
    profiles: {id: number; name: string}[];
    profile_ids: number[];
  }
  let showSuiteModal = $state(false);
  let startingSuite = $state(false);
  let suiteName = $state('');
  let suiteDelay = $state(0);
  let suiteMode = $state<'local' | 'ec2'>('local');
  let suiteServerId = $state<number|null>(null);
  let suiteEc2ServerId = $state<number|null>(null);
  let suiteDatabase = $state('');
  let suiteSnapshotInterval = $state(30);
  let suiteUsePrivateIp = $state(false);
  let suiteDesigns = $state<SuiteDesignEntry[]>([]);
  let suiteLoadingProfiles = $state(false);

  const suitePrivateIpApplicable = $derived((() => {
    if (suiteMode !== 'ec2') return false;
    const srv = servers.find(s => s.id === suiteServerId);
    const runner = ec2Servers.find(s => s.id === suiteEc2ServerId);
    return !!(srv?.private_host && srv.vpc && runner?.vpc && srv.vpc === runner.vpc);
  })());

  const suiteEnabledDesigns = $derived(suiteDesigns.filter(d => d.enabled && d.profile_ids.length >= 1));

  async function openSuiteModal() {
    suiteLoadingProfiles = true;
    suiteName = '';
    suiteDelay = 0;
    suiteMode = 'local';
    suiteServerId = null;
    suiteEc2ServerId = null;
    suiteDatabase = '';
    suiteSnapshotInterval = 30;
    suiteUsePrivateIp = false;
    showSuiteModal = true;

    const entries: SuiteDesignEntry[] = await Promise.all(designs.map(async (d) => {
      const r = await fetch(`/api/designs/${d.id}/profiles`);
      const profiles: {id: number; name: string}[] = await r.json();
      return {
        design_id: d.id,
        design_name: d.name,
        database: d.database,
        enabled: profiles.length >= 1,
        profiles,
        profile_ids: profiles.map(p => p.id)
      };
    }));
    suiteDesigns = entries;
    suiteLoadingProfiles = false;
  }

  function moveSuiteProfile(designIdx: number, profileIdx: number, dir: -1 | 1) {
    const entry = suiteDesigns[designIdx];
    const arr = [...entry.profile_ids];
    const target = profileIdx + dir;
    if (target < 0 || target >= arr.length) return;
    [arr[profileIdx], arr[target]] = [arr[target], arr[profileIdx]];
    suiteDesigns[designIdx] = { ...entry, profile_ids: arr };
  }

  function removeSuiteProfile(designIdx: number, profileIdx: number) {
    const entry = suiteDesigns[designIdx];
    suiteDesigns[designIdx] = { ...entry, profile_ids: entry.profile_ids.filter((_, i) => i !== profileIdx) };
  }

  function addSuiteProfile(designIdx: number, profileId: number) {
    const entry = suiteDesigns[designIdx];
    if (!entry.profile_ids.includes(profileId)) {
      suiteDesigns[designIdx] = { ...entry, profile_ids: [...entry.profile_ids, profileId] };
    }
  }

  async function startSuite() {
    if (suiteEnabledDesigns.length === 0) return;
    showSuiteModal = false;
    startingSuite = true;
    const body: Record<string, unknown> = {
      decision_id: id,
      designs: suiteEnabledDesigns.map(d => ({ design_id: d.design_id, profile_ids: d.profile_ids })),
      delay_seconds: suiteDelay,
      name: suiteName || undefined,
      server_id: suiteServerId,
      database: suiteDatabase || undefined,
      snapshot_interval_seconds: suiteSnapshotInterval,
    };
    if (suiteMode === 'ec2') {
      body.ec2_server_id = suiteEc2ServerId;
      if (suiteUsePrivateIp) body.use_private_ip = true;
    }
    const res = await fetch('/api/suites', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const { suite_id } = await res.json();
    startingSuite = false;
    goto(`/decisions/${id}/suites/${suite_id}`);
  }

  async function load() {
    const [dRes, dsRes, sRes, ec2Res] = await Promise.all([
      fetch(`/api/decisions/${id}`),
      fetch(`/api/designs?decision_id=${id}`),
      fetch('/api/connections'),
      fetch('/api/ec2')
    ]);
    decision = await dRes.json();
    designs = await dsRes.json();
    servers = await sRes.json();
    ec2Servers = await ec2Res.json();

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
    <button onclick={openSuiteModal} disabled={startingSuite || designs.length === 0} title="Run all designs sequentially with profile series">
      {startingSuite ? 'Starting…' : '⊞ Run Suite'}
    </button>
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

        <fieldset class="form-group modal-fieldset">
          <legend>Run location</legend>
          <div style="display:flex; gap:16px">
            <label style="font-weight:normal; cursor:pointer; display:flex; align-items:center; gap:6px">
              <input type="radio" bind:group={suiteMode} value="local" style="width:auto" />
              Local
            </label>
            <label style="font-weight:normal; cursor:pointer; display:flex; align-items:center; gap:6px" class:disabled={ec2Servers.length === 0}>
              <input type="radio" bind:group={suiteMode} value="ec2" style="width:auto" disabled={ec2Servers.length === 0} />
              EC2{#if ec2Servers.length === 0}<span style="color:#aaa; font-size:11px; margin-left:4px">(none configured)</span>{/if}
            </label>
          </div>
        </fieldset>

        {#if suiteMode === 'ec2'}
          <div class="form-group">
            <label for="suite-ec2">EC2 Server</label>
            <select id="suite-ec2" bind:value={suiteEc2ServerId}>
              <option value={null}>— select EC2 server —</option>
              {#each ec2Servers as s}
                <option value={s.id}>{s.name} ({s.user}@{s.host}:{s.port})</option>
              {/each}
            </select>
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
          <label>Designs & profiles</label>
          {#if suiteLoadingProfiles}
            <p style="color:#999; font-size:12px">Loading profiles…</p>
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
                    {#if entry.profiles.length === 0}
                      <span style="color:#aaa; font-size:11px; margin-left:auto">no profiles</span>
                    {/if}
                  </div>

                  {#if entry.enabled && entry.profiles.length > 0}
                    <div class="suite-profiles-list">
                      {#each entry.profile_ids as pid, pi}
                        {@const prof = entry.profiles.find(p => p.id === pid)}
                        {#if prof}
                          <div class="series-profile-row">
                            <span class="series-profile-num">{pi + 1}</span>
                            <span class="series-profile-name">{prof.name}</span>
                            <div class="series-profile-controls">
                              <button type="button" onclick={() => moveSuiteProfile(di, pi, -1)} disabled={pi === 0} class="icon-btn">↑</button>
                              <button type="button" onclick={() => moveSuiteProfile(di, pi, 1)} disabled={pi === entry.profile_ids.length - 1} class="icon-btn">↓</button>
                              <button type="button" onclick={() => removeSuiteProfile(di, pi)} class="icon-btn danger-icon">✕</button>
                            </div>
                          </div>
                        {/if}
                      {/each}
                      {#if entry.profile_ids.length < entry.profiles.length}
                        <div class="series-add-profile">
                          <select onchange={(e) => { const v = Number((e.currentTarget as HTMLSelectElement).value); if (v) addSuiteProfile(di, v); (e.currentTarget as HTMLSelectElement).value = ''; }}>
                            <option value="">+ Add profile…</option>
                            {#each entry.profiles.filter(p => !entry.profile_ids.includes(p.id)) as p}
                              <option value={p.id}>{p.name}</option>
                            {/each}
                          </select>
                        </div>
                      {/if}
                      {#if entry.profile_ids.length === 0}
                        <div style="padding:6px 10px; color:#f38ba8; font-size:11px">Add at least one profile</div>
                      {/if}
                    </div>
                  {/if}
                </div>
              {/each}
            </div>
            {#if suiteEnabledDesigns.length === 0}
              <p style="color:#dc3545; font-size:12px; margin:6px 0 0">Enable at least one design with profiles</p>
            {/if}
          {/if}
        </div>

        <div class="modal-actions">
          <button onclick={() => showSuiteModal = false}>Cancel</button>
          <button class="primary" onclick={startSuite}
            disabled={suiteLoadingProfiles || suiteEnabledDesigns.length === 0 || (suiteMode === 'ec2' && !suiteEc2ServerId)}>
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
{:else}
  <p>Loading...</p>
{/if}

<style>
  .btn-link { text-decoration: none; }
  .design-card { transition: box-shadow 0.15s; }
  .design-card:hover { box-shadow: 0 2px 8px rgba(0,0,0,0.1); }

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
  .modal .form-group input, .modal .form-group select { width: 100%; box-sizing: border-box; }
  .modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 20px; }
  .modal-fieldset { border: 0; padding: 0; margin: 0 0 14px; min-width: 0; }
  .modal-fieldset legend { font-size: 12px; font-weight: 600; color: #555; margin-bottom: 4px; padding: 0; }
  .disabled { opacity: 0.5; }

  .suite-designs-list { display: flex; flex-direction: column; gap: 8px; }
  .suite-design-block { border: 1px solid #e0e0e0; border-radius: 6px; overflow: hidden; }
  .suite-design-block.suite-design-disabled { opacity: 0.6; }
  .suite-design-header { padding: 8px 10px; background: #f8f8f8; border-bottom: 1px solid #e0e0e0; display: flex; align-items: center; }
  .suite-design-block.suite-design-disabled .suite-design-header { border-bottom: none; }
  .suite-profiles-list { }

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
