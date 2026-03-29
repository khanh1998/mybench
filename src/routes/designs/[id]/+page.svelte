<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import CodeEditor from '$lib/CodeEditor.svelte';
  import { validateDesignParams, validateScriptWeights, type ValidationError, type WeightError } from '$lib/params';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  const id = $derived(Number($page.params.id));

  interface PgbenchScript {
    id: number;
    step_id: number;
    position: number;
    name: string;
    weight: number;
    script: string;
  }
  interface Param {
    id: number;
    design_id: number;
    position: number;
    name: string;
    value: string;
  }
  interface Step {
    id: number;
    design_id: number;
    position: number;
    name: string;
    type: 'sql' | 'pgbench' | 'collect';
    script: string;
    pgbench_options: string;
    duration_secs: number;
    no_transaction: number;
    enabled: number;
    pgbench_scripts?: PgbenchScript[];
  }
  interface Design {
    id: number; decision_id: number; name: string; description: string;
    server_id: number|null; database: string; steps: Step[]; params: Param[];
    snapshot_interval_seconds: number;
  }
  interface Server { id: number; name: string; }
  interface Ec2Server { id: number; name: string; host: string; user: string; port: number; }
  interface Run { id: number; status: string; tps: number|null; latency_avg_ms: number|null; started_at: string; profile_name: string; name: string; }
  interface Profile { id: number; design_id: number; name: string; values: { param_name: string; value: string }[]; }

  let design: Design | null = $state(data.design as Design | null);
  let servers: Server[] = $state((data.servers ?? []) as Server[]);
  let ec2Servers: Ec2Server[] = $state((data.ec2Servers ?? []) as Ec2Server[]);
  let runs: Run[] = $state((data.runs ?? []) as Run[]);
  let profiles: Profile[] = $state((data.profiles ?? []) as Profile[]);
  const initialStep = design?.steps?.find(s => s.enabled) ?? design?.steps?.[0] ?? null;
  let selectedStepId = $state<number|null>(initialStep?.id ?? null);
  let selectedScriptIdx = $state(0);
  let saving = $state(false);
  let startingRun = $state(false);
  let msg = $state('');
  let showConfig = $state(false);
  let showValidation = $state(false);
  let showParams = $state(false);
  let showRunModal = $state(false);
  let showImportModal = $state(false);
  let importFile = $state<File | null>(null);
  let importError = $state('');
  let importing = $state(false);

  // Run modal ephemeral state (editable, not persisted)
  let runServer = $state<number|null>(null);
  let runDatabase = $state('');
  let runSnapshotInterval = $state(30);
  let runProfile = $state<number|null>(null);
  let runName = $state('');
  let runMode = $state<'local' | 'ec2'>('local');
  let runEc2ServerId = $state<number|null>(null);

  // Profile management state
  let showProfileForm = $state(false);
  let editingProfileId = $state<number|null>(null);
  let profileFormName = $state('');
  let profileFormValues = $state<{ param_name: string; value: string }[]>([]);

  function openRunModal() {
    if (!design) return;
    if (!isValid) {
      const parts = [];
      if (validationErrors.length > 0) parts.push(`${validationErrors.length} undefined placeholder(s)`);
      if (weightErrors.length > 0) parts.push(`${weightErrors.length} script weight issue(s)`);
      msg = `Cannot run: ${parts.join(', ')}. Check validation.`;
      return;
    }
    runServer = design.server_id;
    runDatabase = design.database;
    runSnapshotInterval = design.snapshot_interval_seconds;
    runProfile = null;
    runName = '';
    runMode = 'local';
    runEc2ServerId = null;
    showRunModal = true;
  }

  function openProfileForm(profile?: Profile) {
    if (profile) {
      editingProfileId = profile.id;
      profileFormName = profile.name;
      profileFormValues = design?.params.map(p => {
        const ov = profile.values.find(v => v.param_name === p.name);
        return { param_name: p.name, value: ov ? ov.value : p.value };
      }) ?? [];
    } else {
      editingProfileId = null;
      profileFormName = '';
      profileFormValues = design?.params.map(p => ({ param_name: p.name, value: p.value })) ?? [];
    }
    showProfileForm = true;
  }

  async function saveProfile() {
    if (!design || !profileFormName.trim()) return;
    const values = profileFormValues.filter(v => v.value !== (design?.params.find(p => p.name === v.param_name)?.value ?? ''));
    if (editingProfileId) {
      await fetch(`/api/designs/${id}/profiles/${editingProfileId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: profileFormName.trim(), values })
      });
      profiles = profiles.map(p => p.id === editingProfileId ? { ...p, name: profileFormName.trim(), values } : p);
    } else {
      const res = await fetch(`/api/designs/${id}/profiles`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: profileFormName.trim(), values })
      });
      const { profile_id } = await res.json();
      profiles = [...profiles, { id: profile_id, design_id: id, name: profileFormName.trim(), values }];
    }
    showProfileForm = false;
  }

  async function deleteProfile(profileId: number) {
    if (!confirm('Delete this profile?')) return;
    await fetch(`/api/designs/${id}/profiles/${profileId}`, { method: 'DELETE' });
    profiles = profiles.filter(p => p.id !== profileId);
  }

  const selectedStep: Step | null = $derived(
    (design as Design | null)?.steps.find((s: Step) => s.id === selectedStepId) ?? null
  );

  const paramNames: string[] = $derived(
    (design as Design | null)?.params?.map((p: Param) => p.name).filter(Boolean) ?? []
  );

  const validationErrors: ValidationError[] = $derived(
    design ? validateDesignParams(design) : []
  );
  const weightErrors: WeightError[] = $derived(
    design ? validateScriptWeights(design) : []
  );
  const isValid = $derived(validationErrors.length === 0 && weightErrors.length === 0);

  async function save() {
    if (!design) return;
    if (!isValid) {
      const lines: string[] = [];
      if (validationErrors.length > 0) {
        lines.push(`${validationErrors.length} undefined placeholder(s):`);
        validationErrors.forEach(e => lines.push(`  {{${e.placeholder}}} in "${e.step} / ${e.script}"`));
      }
      if (weightErrors.length > 0) {
        if (lines.length > 0) lines.push('');
        lines.push(`${weightErrors.length} script weight issue(s):`);
        weightErrors.forEach(e => lines.push(`  "${e.step}": total weight ${e.totalWeight} exceeds 100`));
      }
      lines.push('\nSave anyway?');
      if (!confirm(lines.join('\n'))) return;
    }
    saving = true;
    await fetch(`/api/designs/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(design)
    });
    saving = false;
    msg = 'Saved!';
    setTimeout(() => msg = '', 2000);
  }

  async function startRun() {
    if (!design) return;
    showRunModal = false;
    startingRun = true;
    const body: Record<string, unknown> = {
      design_id: id,
      profile_id: runProfile ?? undefined,
      name: runName || undefined
    };
    if (runMode === 'ec2') {
      body.ec2_server_id = runEc2ServerId;
    } else {
      body.server_id = runServer;
      body.database = runDatabase;
      body.snapshot_interval_seconds = runSnapshotInterval;
    }
    const res = await fetch('/api/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const { run_id } = await res.json();
    startingRun = false;
    goto(`/designs/${id}/runs/${run_id}`);
  }

  function addParam() {
    if (!design) return;
    design.params = [...design.params, { id: -(Date.now()), design_id: id, position: design.params.length, name: '', value: '' }];
  }

  function removeParam(idx: number) {
    if (!design) return;
    design.params = design.params.filter((_, i) => i !== idx).map((p, i) => ({ ...p, position: i }));
  }

  async function deleteRun(runId: number) {
    if (!confirm(`Delete run #${runId}?`)) return;
    await fetch(`/api/runs/${runId}?action=delete`, { method: 'DELETE' });
    runs = runs.filter(r => r.id !== runId);
  }

  async function deleteDesign() {
    if (!design) return;
    if (!confirm('Delete this design and all its runs?')) return;
    await fetch(`/api/designs/${id}`, { method: 'DELETE' });
    goto(`/decisions/${design.decision_id}`);
  }

  function addStep() {
    if (!design) return;
    const pos = design.steps.length;
    const newStep: Step = {
      id: -(Date.now()),
      design_id: id,
      position: pos,
      name: 'New Step',
      type: 'sql',
      script: '',
      pgbench_options: '',
      duration_secs: 0,
      no_transaction: 0,
      enabled: 1,
      pgbench_scripts: []
    };
    design.steps = [...design.steps, newStep];
    selectedStepId = newStep.id;
    selectedScriptIdx = 0;
  }

  function addScript(step: Step) {
    if (!step.pgbench_scripts) step.pgbench_scripts = [];
    const idx = step.pgbench_scripts.length;
    step.pgbench_scripts = [...step.pgbench_scripts, {
      id: -(Date.now()),
      step_id: step.id,
      position: idx,
      name: `script_${idx + 1}`,
      weight: 100,
      script: ''
    }];
    selectedScriptIdx = step.pgbench_scripts.length - 1;
  }

  function removeScript(step: Step, idx: number) {
    if (!step.pgbench_scripts) return;
    step.pgbench_scripts = step.pgbench_scripts.filter((_, i) => i !== idx).map((ps, i) => ({ ...ps, position: i }));
    selectedScriptIdx = Math.min(selectedScriptIdx, Math.max(0, step.pgbench_scripts.length - 1));
  }

  function removeStep(stepId: number) {
    if (!design) return;
    design.steps = design.steps.filter(s => s.id !== stepId).map((s, i) => ({ ...s, position: i }));
    if (selectedStepId === stepId) {
      selectedStepId = design.steps[0]?.id ?? null;
    }
  }

  function moveStep(stepId: number, dir: -1 | 1) {
    if (!design) return;
    const steps = [...design.steps];
    const idx = steps.findIndex(s => s.id === stepId);
    const target = idx + dir;
    if (target < 0 || target >= steps.length) return;
    [steps[idx], steps[target]] = [steps[target], steps[idx]];
    design.steps = steps.map((s, i) => ({ ...s, position: i }));
  }

  async function importRun() {
    if (!importFile || !design) return;
    importError = '';
    importing = true;
    try {
      const text = await importFile.text();
      const parsed = JSON.parse(text);
      const res = await fetch('/api/runs/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ design_id: design.id, result: parsed })
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Import failed' }));
        importError = err.error ?? 'Import failed';
        importing = false;
        return;
      }
      const { run_id } = await res.json();
      importing = false;
      showImportModal = false;
      goto(`/designs/${id}/runs/${run_id}`);
    } catch (e) {
      importError = e instanceof Error ? e.message : 'Import failed';
      importing = false;
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault();
      save();
    }
  }

  onMount(() => {
    window.addEventListener('keydown', handleKeydown);
    return () => window.removeEventListener('keydown', handleKeydown);
  });
</script>

{#if design}
<div class="page-root">
<!-- Top bar -->
<div class="topbar">
  <div class="topbar-left">
    <a href="/decisions/{design.decision_id}" class="back-link">← Decision</a>
    <h1 class="design-title">{design.name}</h1>
    {#if msg}<span class="success" style="font-size:12px">{msg}</span>{/if}
  </div>
  <div class="topbar-right">
    <button onclick={() => showConfig = !showConfig} class:active={showConfig}>⚙ Config</button>
    <button onclick={() => showParams = !showParams} class:active={showParams}>
      {isValid ? '{ }' : '{ }'} Params {#if (design?.params ?? []).length > 0}<span class="param-count">{(design?.params ?? []).length}</span>{/if}
    </button>
    <button
      onclick={() => showValidation = !showValidation}
      class:warn={!isValid}
      class:active={showValidation}
      title="Validation status"
    >{isValid ? '✓ Valid' : `⚠ ${validationErrors.length + weightErrors.length} issue(s)`}</button>
    <button onclick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
    <button class="primary" onclick={openRunModal} disabled={startingRun}>
      {startingRun ? 'Starting…' : '▶ Run'}
    </button>
    <button class="danger" onclick={deleteDesign}>Delete</button>
  </div>
</div>

<!-- Validation panel (collapsible) -->
{#if showValidation && !isValid}
  <div class="validation-panel">
    {#if validationErrors.length > 0}
      <div class="validation-title">⚠ Undefined placeholders:</div>
      {#each validationErrors as e}
        <div class="validation-item">· {e.step} / {e.script}: <code>&#123;&#123;{e.placeholder}&#125;&#125;</code></div>
      {/each}
    {/if}
    {#if weightErrors.length > 0}
      <div class="validation-title" style={validationErrors.length > 0 ? 'margin-top:8px' : ''}>⚠ Script weight exceeds 100:</div>
      {#each weightErrors as e}
        <div class="validation-item">· "{e.step}": total weight <strong>{e.totalWeight}</strong> (max 100)</div>
      {/each}
    {/if}
  </div>
{/if}

<!-- Config panel (collapsible) -->
{#if showConfig}
  <div class="config-panel">
    <div class="config-row">
      <div class="form-group" style="flex:2">
        <label for="design-name">Name</label>
        <input id="design-name" bind:value={design.name} />
      </div>
      <div class="form-group" style="flex:1">
        <label for="design-server">Server</label>
        <select id="design-server" bind:value={design.server_id}>
          <option value={null}>— select server —</option>
          {#each servers as s}
            <option value={s.id}>{s.name}</option>
          {/each}
        </select>
      </div>
      <div class="form-group" style="flex:1">
        <label for="design-db">Database</label>
        <input id="design-db" bind:value={design.database} placeholder="benchmark_db" />
      </div>
    </div>
    <div class="config-row">
      <div class="form-group">
        <label for="design-desc">Description</label>
        <input id="design-desc" bind:value={design.description} />
      </div>
      <div class="form-group" style="flex:0 0 160px">
        <label for="design-snap-interval" title="How often pg_stat_* snapshots are collected during a pgbench run">Snapshot interval (s)</label>
        <input id="design-snap-interval" type="number" bind:value={design.snapshot_interval_seconds} min="5" max="300" />
      </div>
    </div>
  </div>
{/if}

<!-- Run confirmation modal -->
{#if showRunModal && design}
  <div class="modal-backdrop" onclick={() => showRunModal = false}>
    <div class="modal" onclick={(e) => e.stopPropagation()}>
      <h3 style="margin:0 0 16px">Configure Run</h3>

      <div class="form-group">
        <label for="run-name">Run name <span style="color:#aaa;font-weight:400">(optional)</span></label>
        <input id="run-name" bind:value={runName} placeholder="optional name" />
      </div>
      {#if profiles.length > 0}
        <div class="form-group">
          <label for="run-profile">Profile</label>
          <select id="run-profile" bind:value={runProfile}>
            <option value={null}>— no profile —</option>
            {#each profiles as p}
              <option value={p.id}>{p.name}</option>
            {/each}
          </select>
        </div>
      {/if}

      <div class="form-group">
        <label>Run location</label>
        <div style="display:flex; gap:16px">
          <label style="font-weight:normal; cursor:pointer; display:flex; align-items:center; gap:6px">
            <input type="radio" bind:group={runMode} value="local" style="width:auto" />
            Local
          </label>
          <label style="font-weight:normal; cursor:pointer; display:flex; align-items:center; gap:6px" class:disabled={ec2Servers.length === 0}>
            <input type="radio" bind:group={runMode} value="ec2" style="width:auto" disabled={ec2Servers.length === 0} />
            EC2{#if ec2Servers.length === 0}<span style="color:#aaa; font-size:11px; margin-left:4px">(none configured)</span>{/if}
          </label>
        </div>
      </div>

      {#if runMode === 'ec2'}
        <div class="form-group">
          <label for="run-ec2-server">EC2 Server</label>
          <select id="run-ec2-server" bind:value={runEc2ServerId}>
            <option value={null}>— select EC2 server —</option>
            {#each ec2Servers as s}
              <option value={s.id}>{s.name} ({s.user}@{s.host}:{s.port})</option>
            {/each}
          </select>
        </div>
      {:else}
        <div class="form-group">
          <label for="run-server">Server</label>
          <select id="run-server" bind:value={runServer}>
            <option value={null}>— select server —</option>
            {#each servers as s}
              <option value={s.id}>{s.name}</option>
            {/each}
          </select>
        </div>
        <div class="form-group">
          <label for="run-db">Database</label>
          <input id="run-db" bind:value={runDatabase} placeholder="benchmark_db" />
        </div>
        <div class="form-group">
          <label for="run-snap" title="How often pg_stat_* snapshots are collected">Snapshot interval (s)</label>
          <input id="run-snap" type="number" bind:value={runSnapshotInterval} min="5" max="300" />
        </div>
      {/if}

      <!-- pgbench steps summary -->
      {#if design.steps.filter(s => s.enabled && s.type === 'pgbench').length > 0}
        <div class="run-steps-summary">
          <div class="run-steps-label">pgbench steps</div>
          {#each design.steps.filter(s => s.enabled && s.type === 'pgbench') as s}
            <div class="run-step-row">
              <span class="run-step-name">{s.name}</span>
              {#if s.pgbench_options}
                <code class="run-step-opts">{s.pgbench_options}</code>
              {/if}
            </div>
          {/each}
        </div>
      {/if}

      <!-- Benchmark plan timeline -->
      {#if design.steps.filter(s => s.enabled).length > 0}
        <div class="run-timeline">
          {#each design.steps.filter(s => s.enabled) as s, i}
            {#if i > 0}<span class="phase-arrow">→</span>{/if}
            <span class="phase {s.type}">{s.name}{s.type === 'collect' ? ` ${s.duration_secs}s` : ''}</span>
          {/each}
        </div>
      {/if}

      <div class="modal-actions">
        <button onclick={() => showRunModal = false}>Cancel</button>
        <button class="primary" onclick={startRun} disabled={runMode === 'local' ? (!runServer || !runDatabase) : !runEc2ServerId}>▶ Start Run</button>
      </div>
    </div>
  </div>
{/if}

<!-- Import Run modal -->
{#if showImportModal}
  <div class="modal-backdrop" onclick={() => showImportModal = false}>
    <div class="modal" onclick={(e) => e.stopPropagation()}>
      <h3 style="margin:0 0 16px">Import Run Result</h3>
      <div class="form-group">
        <label for="import-file">Result JSON file</label>
        <input
          id="import-file"
          type="file"
          accept=".json"
          onchange={(e) => { importFile = (e.currentTarget as HTMLInputElement).files?.[0] ?? null; }}
        />
      </div>
      {#if importError}
        <div style="color:#dc3545; font-size:13px; margin-bottom:8px">{importError}</div>
      {/if}
      <div class="modal-actions">
        <button onclick={() => showImportModal = false}>Cancel</button>
        <button class="primary" onclick={importRun} disabled={!importFile || importing}>
          {importing ? 'Importing…' : 'Import'}
        </button>
      </div>
    </div>
  </div>
{/if}

<!-- Split pane -->
<div class="split-pane">

  <!-- LEFT: Steps list -->
  <div class="steps-panel">
    <div class="steps-header">
      <span class="steps-title">Steps</span>
      <button onclick={addStep} class="add-btn">+ Add</button>
    </div>
    <div class="steps-list">
      {#each design.steps as step, i (step.id)}
        <div
          class="step-item"
          class:selected={selectedStepId === step.id}
          class:disabled-step={!step.enabled}
          role="button"
          tabindex="0"
          onclick={() => { selectedStepId = step.id; selectedScriptIdx = 0; }}
          onkeydown={(e) => { if (e.key === 'Enter') { selectedStepId = step.id; selectedScriptIdx = 0; } }}
        >
          <div class="step-item-main">
            <span class="step-item-name">{step.name}</span>
            <span class="badge badge-{step.type}">{step.type}</span>
          </div>
          <div class="step-item-controls" role="group">
            <input
              type="checkbox"
              class="toggle-small"
              checked={!!step.enabled}
              title={step.enabled ? 'Enabled' : 'Disabled'}
              onclick={(e) => e.stopPropagation()}
              onchange={(e) => { e.stopPropagation(); step.enabled = (e.currentTarget as HTMLInputElement).checked ? 1 : 0; }}
            />
            <button
              class="icon-btn"
              onclick={(e) => { e.stopPropagation(); moveStep(step.id, -1); }}
              disabled={i === 0}
              title="Move up"
            >↑</button>
            <button
              class="icon-btn"
              onclick={(e) => { e.stopPropagation(); moveStep(step.id, 1); }}
              disabled={i === design.steps.length - 1}
              title="Move down"
            >↓</button>
            <button
              class="icon-btn danger-icon"
              onclick={(e) => { e.stopPropagation(); removeStep(step.id); }}
              title="Delete step"
            >✕</button>
          </div>
        </div>
      {/each}
    </div>

    <!-- Run history -->
    <div class="runs-section">
      <div class="runs-section-header">
        <div class="steps-title">Run History</div>
        <button class="runs-import-btn" title="Import run from result JSON" onclick={() => { importError = ''; importFile = null; showImportModal = true; }}>⬆ Import</button>
      </div>
      {#if runs.length === 0}
        <div style="padding: 8px 12px; font-size:11px; color:#585b70">No runs yet</div>
      {/if}
      {#each runs.slice(0, 8) as r}
        <div class="run-item-row">
          <a href="/designs/{id}/runs/{r.id}" class="run-item">
            <div class="run-item-top">
              <span class="badge badge-{r.status}" style="font-size:10px">{r.status}</span>
              <span class="run-item-id">{r.name || '#' + r.id}</span>
            </div>
            <div class="run-item-bottom">
              {#if r.profile_name}
                <span class="run-profile-tag">{r.profile_name}</span>
              {/if}
              {#if r.tps !== null}
                <span class="run-item-tps">{r.tps.toFixed(1)} TPS</span>
              {/if}
              {#if r.latency_avg_ms !== null}
                <span class="run-item-lat">{r.latency_avg_ms.toFixed(1)}ms</span>
              {/if}
            </div>
          </a>
          <button class="run-delete-btn" title="Delete run" onclick={() => deleteRun(r.id)}>✕</button>
        </div>
      {/each}
    </div>
  </div>

  <!-- RIGHT: Editor -->
  <div class="editor-panel" class:shrunk={showParams}>
    {#if selectedStep}
      <div class="editor-top-bar">
        <input
          class="step-name-edit"
          bind:value={selectedStep.name}
          placeholder="Step name"
        />
        <select bind:value={selectedStep.type} class="type-select">
          <option value="sql">SQL</option>
          <option value="pgbench">pgbench</option>
          <option value="collect">collect</option>
        </select>
        {#if selectedStep.type === 'pgbench'}
          <input
            bind:value={selectedStep.pgbench_options}
            placeholder="-c 10 -T 60 -P 5"
            class="options-input"
            title="pgbench options"
          />
        {:else if selectedStep.type === 'collect'}
          <label class="collect-duration-label">
            Duration
            <input type="number" bind:value={selectedStep.duration_secs} min="0" max="3600" class="collect-duration-input" />
            s
          </label>
        {:else}
          <label class="no-txn-label" title="Run statements outside a transaction block — required for VACUUM, CREATE INDEX CONCURRENTLY, etc.">
            <input
              type="checkbox"
              checked={!!selectedStep.no_transaction}
              onchange={(e) => { selectedStep.no_transaction = (e.currentTarget as HTMLInputElement).checked ? 1 : 0; }}
            />
            No transaction
          </label>
        {/if}
      </div>
      {#if selectedStep.type === 'collect'}
        <div class="collect-info">
          <div class="collect-icon">📊</div>
          <div class="collect-desc">
            Collects pg_stat_* snapshots for <strong>{selectedStep.duration_secs}s</strong>.
            <br>Steps before pgbench → <span class="phase-pill pre">pre</span> phase.
            Steps after pgbench → <span class="phase-pill post">post</span> phase.
          </div>
        </div>
      {:else if selectedStep.type === 'pgbench'}
        {@const scripts = selectedStep.pgbench_scripts ?? []}
        {@const totalWeight = scripts.reduce((s, ps) => s + (ps.weight || 0), 0)}
        <div class="pgbench-split">
          <div class="scripts-panel">
            <div class="scripts-list">
              {#each scripts as ps, i (ps.id)}
                <div
                  class="script-item"
                  class:script-selected={selectedScriptIdx === i}
                  role="button"
                  tabindex="0"
                  onclick={() => selectedScriptIdx = i}
                  onkeydown={(e) => e.key === 'Enter' && (selectedScriptIdx = i)}
                >
                  <div class="script-item-name-row">
                    {#if selectedScriptIdx === i}
                      <input
                        class="script-name-input"
                        value={ps.name}
                        oninput={(e) => { ps.name = (e.currentTarget as HTMLInputElement).value; }}
                        onclick={(e) => e.stopPropagation()}
                        placeholder="script name"
                      />
                    {:else}
                      <span class="script-name-label">{ps.name || 'script'}</span>
                    {/if}
                  </div>
                  <div class="script-item-controls-row">
                    <span class="weight-label">weight</span>
                    <input
                      type="number"
                      class="weight-input"
                      value={ps.weight}
                      oninput={(e) => { ps.weight = parseInt((e.currentTarget as HTMLInputElement).value) || 1; }}
                      onclick={(e) => e.stopPropagation()}
                      min="1"
                    />
                    <button
                      class="icon-btn danger-icon"
                      onclick={(e) => { e.stopPropagation(); removeScript(selectedStep!, i); }}
                      title="Remove script"
                    >✕</button>
                  </div>
                </div>
              {/each}
              <button class="add-script-btn" onclick={() => addScript(selectedStep!)}>+ Add Script</button>
            </div>
            <div class="scripts-total" class:total-exact={totalWeight === 100} class:total-warn={totalWeight !== 100}>
              Total weight: <strong>{totalWeight}</strong>
              {#if totalWeight !== 100}<span class="total-hint">(target: 100)</span>{/if}
            </div>
          </div>
          <div class="editor-wrap">
            {#if (selectedStep.pgbench_scripts ?? []).length > 0}
              {#key `${selectedStep.id}-${selectedScriptIdx}`}
                {@const ps = (selectedStep.pgbench_scripts ?? [])[selectedScriptIdx]}
                {#if ps}
                  <CodeEditor value={ps.script} onchange={(v: string) => { ps.script = v; }} params={paramNames} />
                {/if}
              {/key}
            {:else}
              <div class="editor-empty">Add a script to get started</div>
            {/if}
          </div>
        </div>
      {:else}
        <div class="editor-wrap">
          <CodeEditor bind:value={selectedStep.script} params={paramNames} />
        </div>
      {/if}
    {:else}
      <div class="editor-empty">Select a step to edit</div>
    {/if}
  </div>

  <!-- FAR RIGHT: Params panel -->
  {#if showParams}
    <div class="params-panel">
      <div class="params-panel-header">
        <span class="steps-title">Parameters</span>
        <button onclick={addParam} class="add-btn">+ Add</button>
      </div>
      <div class="params-panel-body">
        {#if design.params.length === 0}
          <div class="params-empty">No parameters yet</div>
        {/if}
        {#each design.params as p, i (p.id)}
          <div class="param-item">
            <input class="param-item-name" bind:value={p.name} placeholder="NAME" spellcheck="false" />
            <input class="param-item-value" bind:value={p.value} placeholder="value" spellcheck="false" />
            <button class="icon-btn danger-icon" onclick={() => removeParam(i)} title="Remove">✕</button>
          </div>
        {/each}

        <!-- Profiles section -->
        {#if design.params.length > 0}
          <div class="profiles-section-header">
            <span class="steps-title" style="font-size:10px">Profiles</span>
            <button class="add-btn" style="font-size:10px" onclick={() => openProfileForm()}>+ Add</button>
          </div>
          {#if profiles.length === 0}
            <div class="params-empty">No profiles yet</div>
          {/if}
          {#each profiles as prof (prof.id)}
            <div class="profile-item">
              <div class="profile-item-header">
                <span class="profile-name">{prof.name}</span>
                <button class="icon-btn" style="font-size:10px" onclick={() => openProfileForm(prof)} title="Edit">✎</button>
                <button class="icon-btn danger-icon" style="font-size:10px" onclick={() => deleteProfile(prof.id)} title="Delete">✕</button>
              </div>
              {#if prof.values.length > 0}
                <div class="profile-values">
                  {#each prof.values as v}
                    <span class="profile-value-pill">{v.param_name}={v.value}</span>
                  {/each}
                </div>
              {/if}
            </div>
          {/each}
        {/if}
      </div>
    </div>
  {/if}

  <!-- Profile form modal -->
  {#if showProfileForm}
    <div class="modal-backdrop" onclick={() => showProfileForm = false}>
      <div class="modal" onclick={(e) => e.stopPropagation()}>
        <h3 style="margin:0 0 16px">{editingProfileId ? 'Edit Profile' : 'Add Profile'}</h3>
        <div class="form-group">
          <label for="profile-name">Profile name</label>
          <input id="profile-name" bind:value={profileFormName} placeholder="e.g. small, medium, large" />
        </div>
        {#if profileFormValues.length > 0}
          <div style="font-size:12px;font-weight:600;color:#555;margin-bottom:8px">Parameter overrides</div>
          {#each profileFormValues as v}
            <div class="form-group" style="margin-bottom:8px;display:flex;align-items:center;gap:8px">
              <label style="width:90px;font-size:12px;margin:0;font-family:monospace;color:#333">{v.param_name}</label>
              <input style="flex:1" bind:value={v.value} placeholder="value" />
            </div>
          {/each}
        {/if}
        <div class="modal-actions">
          <button onclick={() => showProfileForm = false}>Cancel</button>
          <button class="primary" onclick={saveProfile} disabled={!profileFormName.trim()}>Save</button>
        </div>
      </div>
    </div>
  {/if}

</div>

</div> <!-- /page-root -->
{:else}
  <p>Loading...</p>
{/if}

<style>
  .modal-backdrop {
    position: fixed; inset: 0; background: rgba(0,0,0,0.5);
    display: flex; align-items: center; justify-content: center; z-index: 1000;
  }
  .modal {
    background: #fff; border-radius: 8px; padding: 24px; width: 460px;
    box-shadow: 0 8px 32px rgba(0,0,0,0.2); max-height: 90vh; overflow-y: auto;
  }
  .modal .form-group { margin-bottom: 14px; }
  .modal .form-group label { display: block; font-size: 12px; font-weight: 600; color: #555; margin-bottom: 4px; }
  .modal .form-group input, .modal .form-group select { width: 100%; box-sizing: border-box; }
  .modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 20px; }

  /* Phase timeline (config + modal) */
  .phase-timeline, .run-timeline {
    display: flex; align-items: center; flex-wrap: wrap; gap: 4px;
    font-size: 11px; margin-top: 8px;
  }
  .phase-arrow { color: #bbb; }
  .phase { padding: 2px 8px; border-radius: 10px; font-weight: 600; white-space: nowrap; }
  .phase.pre  { background: #e8f4ff; color: #0055aa; }
  .phase.bench, .phase.pgbench { background: #e8fff2; color: #006633; }
  .phase.sql  { background: #f5f5f5; color: #555; }
  .phase.post { background: #fff8e8; color: #885500; }
  .phase.collect { background: #f0e8ff; color: #6600cc; }

  /* Run modal steps summary */
  .run-steps-summary { border: 1px solid #eee; border-radius: 6px; padding: 8px 10px; margin-bottom: 14px; background: #fafafa; }
  .run-steps-label { font-size: 11px; font-weight: 700; color: #888; margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.05em; }
  .run-step-row { display: flex; align-items: baseline; gap: 8px; margin-bottom: 4px; flex-wrap: wrap; }
  .run-step-name { font-size: 12px; font-weight: 600; color: #333; }
  .run-step-opts { font-size: 11px; color: #666; background: #f0f0f0; padding: 1px 5px; border-radius: 3px; word-break: break-all; }
  .run-timeline { border: 1px solid #eee; border-radius: 6px; padding: 8px 10px; margin-bottom: 14px; background: #fafafa; }

  /* Page root: fixed below the nav bar, fills remaining viewport */
  .page-root {
    position: fixed;
    top: 48px; /* navbar height */
    left: 0;
    right: 0;
    bottom: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background: #1e1e1e;
  }

  .topbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 16px;
    background: #fff;
    border-bottom: 1px solid #e0e0e0;
    flex-shrink: 0;
    gap: 12px;
  }
  .topbar-left { display: flex; align-items: center; gap: 12px; min-width: 0; }
  .topbar-right { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
  .back-link { color: #0066cc; text-decoration: none; font-size: 13px; white-space: nowrap; }
  .design-title { font-size: 16px; font-weight: 700; margin: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

  .inline-label {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 12px;
    color: #666;
    font-weight: 600;
    white-space: nowrap;
  }

  button.active { background: #e8f0fe; border-color: #0066cc; color: #0066cc; }
  button.warn { background: #fff3cd; border-color: #f0a500; color: #7a4f00; }
  button.warn.active { background: #ffe08a; }
  a.btn {
    display: inline-flex; align-items: center;
    padding: 4px 10px; font-size: 13px; font-weight: 500;
    border: 1px solid #ccc; border-radius: 4px;
    background: #fff; color: #333;
    text-decoration: none; cursor: pointer;
    white-space: nowrap;
  }
  a.btn:hover { background: #f0f0f0; }

  .validation-panel {
    background: #fff8e1;
    border-bottom: 1px solid #f0c040;
    padding: 8px 16px;
    flex-shrink: 0;
    font-size: 12px;
    color: #5c4300;
  }
  .validation-title { font-weight: 600; margin-bottom: 4px; }
  .validation-item { padding: 1px 0; }
  .validation-item code { font-family: monospace; background: #ffe0804a; padding: 0 3px; border-radius: 2px; }

  .config-panel {
    background: #f8f8f8;
    border-bottom: 1px solid #e0e0e0;
    padding: 12px 16px;
    flex-shrink: 0;
  }
  .config-row { display: flex; gap: 12px; }

  .param-count {
    display: inline-block;
    background: #89b4fa;
    color: #1e1e2e;
    border-radius: 8px;
    font-size: 10px;
    font-weight: 700;
    padding: 0 5px;
    margin-left: 2px;
    line-height: 1.6;
  }

  /* Params right-side panel */
  .params-panel {
    width: 220px;
    flex-shrink: 0;
    background: #1e1e2e;
    color: #cdd6f4;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    border-left: 1px solid #313244;
  }
  .params-panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 12px;
    border-bottom: 1px solid #313244;
    flex-shrink: 0;
  }
  .params-panel-body {
    flex: 1;
    overflow-y: auto;
    padding: 8px 8px;
  }
  .params-empty {
    color: #585b70;
    font-size: 12px;
    padding: 4px 4px;
  }
  .param-item {
    display: flex;
    flex-direction: column;
    gap: 3px;
    margin-bottom: 10px;
    position: relative;
  }
  .param-item-name {
    background: #313244;
    border: 1px solid #45475a;
    color: #cba6f7;
    font-family: monospace;
    font-size: 11px;
    font-weight: 600;
    padding: 3px 6px;
    border-radius: 3px;
    width: 100%;
    box-sizing: border-box;
  }
  .param-item-name:focus { outline: none; border-color: #89b4fa; }
  .param-item-name::placeholder { color: #585b70; font-weight: 400; }
  .param-item-value {
    background: #181825;
    border: 1px solid #313244;
    color: #a6e3a1;
    font-family: monospace;
    font-size: 11px;
    padding: 3px 6px;
    border-radius: 3px;
    width: 100%;
    box-sizing: border-box;
  }
  .param-item-value:focus { outline: none; border-color: #89b4fa; }
  .param-item-value::placeholder { color: #585b70; }
  .param-item .icon-btn {
    position: absolute;
    top: 3px;
    right: 3px;
    padding: 0 4px;
    font-size: 10px;
    line-height: 1.6;
  }

  /* Split pane — fills remaining height after topbar (+config) */
  .split-pane {
    flex: 1;
    display: flex;
    overflow: hidden;
    min-height: 0;
  }

  /* Steps panel */
  .steps-panel {
    width: 264px;
    flex-shrink: 0;
    background: #1e1e2e;
    color: #cdd6f4;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    border-right: 1px solid #313244;
  }
  .steps-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 12px;
    border-bottom: 1px solid #313244;
    flex-shrink: 0;
  }
  .steps-title {
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: #a6adc8;
  }
  .add-btn {
    font-size: 11px;
    padding: 3px 8px;
    background: #313244;
    color: #cdd6f4;
    border: 1px solid #45475a;
    border-radius: 3px;
  }
  .add-btn:hover { background: #45475a; }

  .steps-list {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
  }
  .step-item {
    padding: 8px 12px;
    cursor: pointer;
    border-bottom: 1px solid #1e1e2e;
    transition: background 0.1s;
  }
  .step-item:hover { background: #2a2a3e; }
  .step-item.selected { background: #313244; border-left: 3px solid #89b4fa; }
  .step-item.disabled-step { opacity: 0.5; }
  .step-item-main {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 4px;
  }
  .step-item-name {
    font-size: 13px;
    font-weight: 500;
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: #cdd6f4;
  }
  .step-item-controls {
    display: flex;
    align-items: center;
    gap: 2px;
  }
  .toggle-small { cursor: pointer; width: auto; }
  .icon-btn {
    padding: 1px 5px;
    font-size: 11px;
    background: transparent;
    border: 1px solid #45475a;
    color: #a6adc8;
    border-radius: 3px;
    line-height: 1.4;
  }
  .icon-btn:hover:not(:disabled) { background: #45475a; color: #cdd6f4; }
  .icon-btn:disabled { opacity: 0.3; cursor: default; }
  .danger-icon:hover:not(:disabled) { background: #f38ba8; border-color: #f38ba8; color: #1e1e2e; }

  .runs-section {
    flex-shrink: 0;
    border-top: 1px solid #313244;
    max-height: 280px;
    overflow-y: auto;
  }
  .runs-section-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 12px 4px;
  }
  .runs-import-btn {
    background: none; border: 1px solid #45475a; color: #a6adc8;
    font-size: 10px; padding: 2px 7px; border-radius: 4px; cursor: pointer;
  }
  .runs-import-btn:hover { background: #2a2a3e; color: #cdd6f4; border-color: #89b4fa; }
  .run-item-row { display: flex; align-items: stretch; border-bottom: 1px solid #1e1e2e; }
  .run-item-row:hover .run-delete-btn { opacity: 1; }
  .run-item {
    display: flex;
    flex-direction: column;
    gap: 3px;
    padding: 5px 12px;
    text-decoration: none;
    font-size: 12px;
    color: #a6adc8;
    flex: 1;
    min-width: 0;
  }
  .run-item:hover { background: #2a2a3e; color: #cdd6f4; }
  .run-item-top { display: flex; align-items: center; gap: 6px; min-width: 0; }
  .run-item-bottom { display: flex; align-items: center; gap: 5px; min-width: 0; padding-left: 2px; }
  .run-item-id { font-family: monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; }
  .run-item-tps { color: #a6e3a1; font-size: 11px; white-space: nowrap; }
  .run-item-lat { color: #89dceb; font-size: 11px; white-space: nowrap; }
  .run-profile-tag { background: #4a3f6b; color: #cba6f7; font-size: 10px; padding: 1px 5px; border-radius: 8px; white-space: nowrap; max-width: 80px; overflow: hidden; text-overflow: ellipsis; }
  .run-delete-btn {
    opacity: 0; flex-shrink: 0; padding: 4px 8px;
    background: none; border: none; color: #f38ba8; cursor: pointer; font-size: 12px;
    align-self: center;
  }
  .run-delete-btn:hover { opacity: 1 !important; background: #3d2028; }

  /* Editor panel */
  .editor-panel {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .editor-top-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    background: #252526;
    border-bottom: 1px solid #3c3c3c;
    flex-shrink: 0;
  }
  .step-name-edit {
    background: #3c3c3c;
    border: 1px solid #555;
    color: #d4d4d4;
    padding: 4px 8px;
    border-radius: 4px;
    font-size: 13px;
    font-weight: 600;
    flex: 1;
    min-width: 0;
  }
  .step-name-edit:focus { outline: none; border-color: #0066cc; }
  .type-select {
    background: #3c3c3c;
    border: 1px solid #555;
    color: #d4d4d4;
    padding: 4px 8px;
    border-radius: 4px;
    font-size: 12px;
    width: auto;
  }
  .options-input {
    background: #3c3c3c;
    border: 1px solid #555;
    color: #d4d4d4;
    padding: 4px 8px;
    border-radius: 4px;
    font-size: 12px;
    flex: 1;
    font-family: monospace;
  }
  .options-input:focus { outline: none; border-color: #0066cc; }
  .options-input::placeholder { color: #666; }
  .step-name-edit::placeholder { color: #666; }

  /* pgbench multi-script split */
  .pgbench-split {
    flex: 1;
    display: flex;
    flex-direction: row;
    min-height: 0;
    overflow: hidden;
  }
  .scripts-panel {
    width: 210px;
    flex-shrink: 0;
    background: #1e1e2e;
    border-right: 1px solid #313244;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .scripts-list {
    flex: 1;
    overflow-y: auto;
    min-height: 0;
  }
  .script-item {
    display: flex;
    flex-direction: column;
    padding: 6px 8px 5px;
    border-bottom: 1px solid #252535;
    cursor: pointer;
    border-left: 3px solid transparent;
  }
  .script-item:hover { background: #2a2a3e; }
  .script-item.script-selected { border-left-color: #a6e3a1; background: #252535; }
  .script-item-name-row {
    display: flex;
    align-items: center;
    min-width: 0;
    margin-bottom: 4px;
  }
  .script-item-controls-row {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .script-name-label {
    flex: 1;
    min-width: 0;
    color: #cdd6f4;
    font-size: 12px;
    padding: 1px 2px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    user-select: none;
  }
  .script-name-input {
    flex: 1;
    min-width: 0;
    background: transparent;
    border: none;
    color: #cdd6f4;
    font-size: 12px;
    padding: 1px 2px;
  }
  .script-name-input:focus { outline: 1px solid #45475a; border-radius: 2px; }
  .script-name-input::placeholder { color: #585b70; }
  .weight-label { color: #585b70; font-size: 10px; flex-shrink: 0; }
  .weight-input {
    width: 40px;
    background: #313244;
    border: 1px solid #45475a;
    color: #cdd6f4;
    font-size: 11px;
    padding: 1px 3px;
    border-radius: 3px;
    text-align: center;
    flex-shrink: 0;
  }
  .add-script-btn {
    margin: 6px;
    font-size: 11px;
    padding: 4px 8px;
    background: #313244;
    color: #cdd6f4;
    border: 1px solid #45475a;
    border-radius: 3px;
    cursor: pointer;
    text-align: left;
  }
  .add-script-btn:hover { background: #45475a; }
  .scripts-total {
    flex-shrink: 0;
    padding: 6px 10px;
    font-size: 11px;
    border-top: 1px solid #313244;
    color: #a6adc8;
  }
  .scripts-total.total-exact { color: #a6e3a1; border-top-color: #a6e3a133; }
  .scripts-total.total-warn { color: #f9e2af; }
  .total-hint { color: #585b70; margin-left: 4px; }

  /* editor-wrap: must have position:relative + explicit size for position:absolute children */
  .editor-wrap {
    flex: 1;
    min-height: 0;
    position: relative;
    overflow: hidden;
  }
  .editor-empty {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #555;
    font-size: 14px;
  }

  /* SQL step — no transaction toggle */
  .no-txn-label { display: flex; align-items: center; gap: 5px; color: #a6adc8; font-size: 11px; white-space: nowrap; cursor: pointer; user-select: none; }
  .no-txn-label input { cursor: pointer; }

  /* Collect step */
  .collect-duration-label { display: flex; align-items: center; gap: 6px; color: #d4d4d4; font-size: 12px; white-space: nowrap; }
  .collect-duration-input { width: 72px; background: #3c3c3c; border: 1px solid #555; color: #d4d4d4; padding: 4px 6px; border-radius: 4px; font-size: 12px; text-align: center; }
  .collect-duration-input:focus { outline: none; border-color: #a78bfa; }
  .collect-info { flex: 1; display: flex; align-items: center; gap: 16px; padding: 32px 24px; background: #1e1e1e; }
  .collect-icon { font-size: 32px; }
  .collect-desc { color: #888; font-size: 13px; line-height: 1.6; }
  .collect-desc strong { color: #a78bfa; }
  .phase-pill { display: inline-block; padding: 1px 7px; border-radius: 8px; font-size: 11px; font-weight: 700; }
  .phase-pill.pre  { background: #e8f4ff; color: #0055aa; }
  .phase-pill.post { background: #fff8e8; color: #885500; }

  /* Profiles section in params panel */
  .profiles-section-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 8px 0 4px; border-top: 1px solid #313244; margin-top: 8px;
  }
  .profile-item {
    background: #181825; border: 1px solid #313244; border-radius: 4px;
    padding: 6px 8px; margin-bottom: 6px;
  }
  .profile-item-header { display: flex; align-items: center; gap: 4px; margin-bottom: 4px; }
  .profile-name { flex: 1; font-size: 12px; font-weight: 600; color: #cba6f7; }
  .profile-values { display: flex; flex-wrap: wrap; gap: 3px; }
  .profile-value-pill {
    font-size: 10px; font-family: monospace;
    background: #313244; color: #a6e3a1;
    padding: 1px 5px; border-radius: 8px;
  }
</style>
