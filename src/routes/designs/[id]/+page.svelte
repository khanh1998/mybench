<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import CodeEditor from '$lib/CodeEditor.svelte';

  const id = $derived(Number($page.params.id));

  interface Step {
    id: number;
    design_id: number;
    position: number;
    name: string;
    type: 'sql' | 'pgbench';
    script: string;
    pgbench_options: string;
    enabled: number;
  }
  interface Design {
    id: number; decision_id: number; name: string; description: string;
    server_id: number|null; database: string; steps: Step[];
  }
  interface Server { id: number; name: string; }
  interface Run { id: number; status: string; tps: number|null; latency_avg_ms: number|null; started_at: string; }

  let design: Design | null = $state(null);
  let servers: Server[] = $state([]);
  let runs: Run[] = $state([]);
  let selectedStepId = $state<number|null>(null);
  let saving = $state(false);
  let startingRun = $state(false);
  let snapshotInterval = $state(30);
  let msg = $state('');
  let showConfig = $state(false);

  const selectedStep: Step | null = $derived(
    (design as Design | null)?.steps.find((s: Step) => s.id === selectedStepId) ?? null
  );

  async function load() {
    const [dRes, sRes, rRes] = await Promise.all([
      fetch(`/api/designs/${id}`),
      fetch('/api/connections'),
      fetch(`/api/runs?design_id=${id}`)
    ]);
    design = await dRes.json();
    servers = await sRes.json();
    runs = await rRes.json();
    // Select first enabled step by default
    if (design?.steps?.length && selectedStepId === null) {
      selectedStepId = design.steps.find(s => s.enabled) ?.id ?? design.steps[0].id;
    }
  }

  async function save() {
    if (!design) return;
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
    startingRun = true;
    const res = await fetch('/api/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ design_id: id, snapshot_interval_seconds: snapshotInterval })
    });
    const { run_id } = await res.json();
    startingRun = false;
    goto(`/designs/${id}/runs/${run_id}`);
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
      enabled: 1
    };
    design.steps = [...design.steps, newStep];
    selectedStepId = newStep.id;
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

  onMount(load);
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
    <label class="inline-label">
      Interval (s)
      <input type="number" bind:value={snapshotInterval} style="width:60px" min="5" max="300" />
    </label>
    <button onclick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
    <button class="primary" onclick={startRun} disabled={startingRun}>
      {startingRun ? 'Starting…' : '▶ Run'}
    </button>
    <button class="danger" onclick={deleteDesign}>Delete</button>
  </div>
</div>

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
    <div class="form-group">
      <label for="design-desc">Description</label>
      <input id="design-desc" bind:value={design.description} />
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
          onclick={() => selectedStepId = step.id}
          onkeydown={(e) => e.key === 'Enter' && (selectedStepId = step.id)}
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
          <a href="/designs/{id}/runs/{r.id}" class="run-item">
            <span class="badge badge-{r.status}" style="font-size:10px">{r.status}</span>
            <span class="run-item-id">#{r.id}</span>
            {#if r.tps !== null}
              <span class="run-item-tps">{r.tps.toFixed(1)} TPS</span>
            {/if}
          </a>
        {/each}
      </div>
    {/if}
  </div>

  <!-- RIGHT: Editor -->
  <div class="editor-panel">
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
      <div class="editor-wrap">
        <CodeEditor bind:value={selectedStep.script} />
      </div>
    {:else}
      <div class="editor-empty">Select a step to edit</div>
    {/if}
  </div>

</div>

</div> <!-- /page-root -->
{:else}
  <p>Loading...</p>
{/if}

<style>
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
  .inline-label input { width: 60px; }

  button.active { background: #e8f0fe; border-color: #0066cc; color: #0066cc; }

  .config-panel {
    background: #f8f8f8;
    border-bottom: 1px solid #e0e0e0;
    padding: 12px 16px;
    flex-shrink: 0;
  }
  .config-row { display: flex; gap: 12px; }

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
  .run-item {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 5px 12px;
    text-decoration: none;
    font-size: 12px;
    color: #a6adc8;
    border-bottom: 1px solid #1e1e2e;
  }
  .run-item:hover { background: #2a2a3e; color: #cdd6f4; }
  .run-item-id { font-family: monospace; }
  .run-item-tps { margin-left: auto; color: #a6e3a1; font-size: 11px; }

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
