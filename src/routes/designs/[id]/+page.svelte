<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import CodeEditor from '$lib/CodeEditor.svelte';
  import { validateDesignParams, type ValidationError } from '$lib/params';

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
    type: 'sql' | 'pgbench';
    script: string;
    pgbench_options: string;
    enabled: number;
    pgbench_scripts?: PgbenchScript[];
  }
  interface Design {
    id: number; decision_id: number; name: string; description: string;
    server_id: number|null; database: string; steps: Step[]; params: Param[];
    pre_collect_secs: number; post_collect_secs: number;
  }
  interface Server { id: number; name: string; }
  interface Run { id: number; status: string; tps: number|null; latency_avg_ms: number|null; started_at: string; }

  let design: Design | null = $state(null);
  let servers: Server[] = $state([]);
  let runs: Run[] = $state([]);
  let selectedStepId = $state<number|null>(null);
  let selectedScriptIdx = $state(0);
  let saving = $state(false);
  let startingRun = $state(false);
  let snapshotInterval = $state(30);
  let msg = $state('');
  let showConfig = $state(false);
  let showValidation = $state(false);
  let showParams = $state(false);
  let showRunModal = $state(false);

  // Run modal ephemeral state (editable, not persisted)
  let runServer = $state<number|null>(null);
  let runDatabase = $state('');
  let runSnapshotInterval = $state(30);

  function loadPersistedRunConfig() {
    if (typeof localStorage === 'undefined') return;
    const raw = localStorage.getItem(`run-config-${id}`);
    if (!raw) return;
    try {
      const cfg = JSON.parse(raw);
      if (cfg.server_id !== undefined && design) design.server_id = cfg.server_id;
      if (cfg.database !== undefined && design) design.database = cfg.database;
      if (cfg.snapshotInterval !== undefined) snapshotInterval = cfg.snapshotInterval;
    } catch {}
  }

  function persistRunConfig() {
    if (typeof localStorage === 'undefined' || !design) return;
    localStorage.setItem(`run-config-${id}`, JSON.stringify({
      server_id: design.server_id,
      database: design.database,
      snapshotInterval
    }));
  }

  function openRunModal() {
    if (!design) return;
    if (!isValid) {
      msg = `Cannot run: ${validationErrors.length} undefined placeholder(s). Check params.`;
      return;
    }
    // Pre-fill modal with current persisted values
    runServer = design.server_id;
    runDatabase = design.database;
    runSnapshotInterval = snapshotInterval;
    showRunModal = true;
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
  const isValid = $derived(validationErrors.length === 0);

  async function load() {
    const [dRes, sRes, rRes] = await Promise.all([
      fetch(`/api/designs/${id}`),
      fetch('/api/connections'),
      fetch(`/api/runs?design_id=${id}`)
    ]);
    design = await dRes.json();
    if (design && !design.params) design.params = [];
    servers = await sRes.json();
    runs = await rRes.json();
    // Select first enabled step by default
    if (design?.steps?.length && selectedStepId === null) {
      selectedStepId = design.steps.find(s => s.enabled) ?.id ?? design.steps[0].id;
    }
  }

  async function save() {
    if (!design) return;
    if (!isValid) {
      const ok = confirm(
        `${validationErrors.length} undefined placeholder(s) found.\n` +
        validationErrors.map(e => `  {{${e.placeholder}}} in "${e.step} / ${e.script}"`).join('\n') +
        '\n\nSave anyway?'
      );
      if (!ok) return;
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
    // Persist chosen config for next time
    persistRunConfig();
    const res = await fetch('/api/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        design_id: id,
        server_id: runServer,
        database: runDatabase,
        snapshot_interval_seconds: runSnapshotInterval
      })
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

  function handleKeydown(e: KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault();
      save();
    }
  }

  onMount(() => {
    load().then(loadPersistedRunConfig);
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
    >{isValid ? '✓ Valid' : `⚠ ${validationErrors.length} issue(s)`}</button>
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
    <div class="validation-title">⚠ Undefined placeholders:</div>
    {#each validationErrors as e}
      <div class="validation-item">· {e.step} / {e.script}: <code>&#123;&#123;{e.placeholder}&#125;&#125;</code></div>
    {/each}
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
        <input id="design-snap-interval" type="number" bind:value={snapshotInterval} min="5" max="300" />
      </div>
    </div>
    <div class="config-row">
      <div class="form-group" style="flex:0 0 200px">
        <label for="design-pre" title="Collect pg_stat_* data for this many seconds before starting the benchmark">Pre-collect (s)</label>
        <input id="design-pre" type="number" bind:value={design.pre_collect_secs} min="0" max="600" />
      </div>
      <div class="form-group" style="flex:0 0 200px">
        <label for="design-post" title="Continue collecting pg_stat_* data for this many seconds after the benchmark finishes">Post-collect (s)</label>
        <input id="design-post" type="number" bind:value={design.post_collect_secs} min="0" max="600" />
      </div>
      <div class="phase-timeline">
        <span class="phase pre">pre {design.pre_collect_secs}s</span>
        <span class="phase-arrow">→</span>
        {#each design.steps.filter(s => s.enabled) as s}
          <span class="phase bench">{s.name}</span>
          <span class="phase-arrow">→</span>
        {/each}
        <span class="phase post">post {design.post_collect_secs}s</span>
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

      <!-- Collection timeline -->
      <div class="run-timeline">
        <span class="phase pre">pre {design.pre_collect_secs}s</span>
        <span class="phase-arrow">→</span>
        {#each design.steps.filter(s => s.enabled) as s}
          <span class="phase {s.type}">{s.name}</span>
          <span class="phase-arrow">→</span>
        {/each}
        <span class="phase post">post {design.post_collect_secs}s</span>
      </div>

      <div class="modal-actions">
        <button onclick={() => showRunModal = false}>Cancel</button>
        <button class="primary" onclick={startRun} disabled={!runServer || !runDatabase}>▶ Start Run</button>
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
    {#if runs.length > 0}
      <div class="runs-section">
        <div class="steps-title" style="padding: 8px 12px 4px;">Run History</div>
        {#each runs.slice(0, 8) as r}
          <div class="run-item-row">
            <a href="/designs/{id}/runs/{r.id}" class="run-item">
              <span class="badge badge-{r.status}" style="font-size:10px">{r.status}</span>
              <span class="run-item-id">#{r.id}</span>
              {#if r.tps !== null}
                <span class="run-item-tps">{r.tps.toFixed(1)} TPS</span>
              {/if}
            </a>
            <button class="run-delete-btn" title="Delete run" onclick={() => deleteRun(r.id)}>✕</button>
          </div>
        {/each}
      </div>
    {/if}
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
        </select>
        {#if selectedStep.type === 'pgbench'}
          <input
            bind:value={selectedStep.pgbench_options}
            placeholder="-c 10 -T 60 -P 5"
            class="options-input"
            title="pgbench options"
          />
        {/if}
      </div>
      {#if selectedStep.type === 'pgbench'}
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
    width: 240px;
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
    max-height: 200px;
    overflow-y: auto;
  }
  .run-item-row { display: flex; align-items: center; border-bottom: 1px solid #1e1e2e; }
  .run-item-row:hover .run-delete-btn { opacity: 1; }
  .run-item {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 5px 12px;
    text-decoration: none;
    font-size: 12px;
    color: #a6adc8;
    flex: 1;
  }
  .run-item:hover { background: #2a2a3e; color: #cdd6f4; }
  .run-item-id { font-family: monospace; }
  .run-item-tps { margin-left: auto; color: #a6e3a1; font-size: 11px; }
  .run-delete-btn {
    opacity: 0; flex-shrink: 0; padding: 4px 8px;
    background: none; border: none; color: #f38ba8; cursor: pointer; font-size: 12px;
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
</style>
