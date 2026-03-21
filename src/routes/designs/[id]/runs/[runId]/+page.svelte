<script lang="ts">
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import { onMount, onDestroy } from 'svelte';

  const designId = $derived(Number($page.params.id));
  const runId = $derived(Number($page.params.runId));

  interface StepResult {
    id: number; step_id: number; name: string; type: string; status: string;
    stdout: string; stderr: string; started_at: string|null; finished_at: string|null;
    command: string; processed_script: string;
  }
  interface Run {
    id: number; status: string; tps: number|null; latency_avg_ms: number|null;
    latency_stddev_ms: number|null; transactions: number|null;
    started_at: string; finished_at: string|null;
    steps: StepResult[];
  }

  let run: Run | null = $state(null);
  let done = $state(false);
  let finalStatus = $state('');
  let eventSource: EventSource | null = null;
  let outputEl: HTMLPreElement | null = $state(null);
  let expandedStep = $state<number | null>(null);
  let scrollPending = false;

  const pendingLines: string[] = [];

  function appendLine(line: string) {
    if (!outputEl) { pendingLines.push(line); return; }
    outputEl.appendChild(document.createTextNode(line + '\n'));
    if (!scrollPending) {
      scrollPending = true;
      setTimeout(() => {
        if (outputEl) outputEl.scrollTop = outputEl.scrollHeight;
        scrollPending = false;
      }, 50);
    }
  }

  function flushPending() {
    if (!outputEl || pendingLines.length === 0) return;
    const frag = document.createDocumentFragment();
    for (const l of pendingLines) frag.appendChild(document.createTextNode(l + '\n'));
    outputEl.appendChild(frag);
    pendingLines.length = 0;
    outputEl.scrollTop = outputEl.scrollHeight;
  }

  async function loadRun(): Promise<void> {
    const res = await fetch(`/api/runs/${runId}`);
    run = await res.json();
  }

  function renderStoredOutput() {
    if (!run?.steps?.length || !outputEl) return;
    const frag = document.createDocumentFragment();
    for (const s of run.steps) {
      frag.appendChild(document.createTextNode(`\n=== Step: ${s.name} (${s.type}) ===\n`));
      if (s.stdout) frag.appendChild(document.createTextNode(s.stdout));
      if (s.stderr) {
        for (const line of s.stderr.split('\n')) {
          if (line) frag.appendChild(document.createTextNode('[stderr] ' + line + '\n'));
        }
      }
    }
    outputEl.appendChild(frag);
  }

  function connectSSE() {
    eventSource = new EventSource(`/api/runs/${runId}/stream`);
    eventSource.onmessage = (e) => {
      try { appendLine(JSON.parse(e.data)); } catch {}
    };
    eventSource.addEventListener('step', (e) => {
      try {
        const update = JSON.parse((e as MessageEvent).data) as { step_id: number; status: string; started_at?: string; finished_at?: string };
        if (run?.steps) {
          run.steps = run.steps.map(s =>
            s.step_id === update.step_id ? { ...s, ...update } : s
          );
        }
      } catch {}
    });
    eventSource.addEventListener('done', (e) => {
      finalStatus = (e as MessageEvent).data;
      done = true;
      eventSource?.close();
      loadRun();
    });
    eventSource.onerror = () => {
      if (!done) {
        eventSource?.close();
        done = true;
        loadRun();
      }
    };
  }

  async function stopRun() {
    await fetch(`/api/runs/${runId}`, { method: 'DELETE' });
    eventSource?.close();
    done = true;
    loadRun();
  }

  async function deleteRun() {
    if (!confirm(`Delete run #${runId}?`)) return;
    eventSource?.close();
    await fetch(`/api/runs/${runId}?action=delete`, { method: 'DELETE' });
    goto(`/designs/${designId}`);
  }

  function toggleStep(stepId: number) {
    expandedStep = expandedStep === stepId ? null : stepId;
  }

  onMount(async () => {
    await loadRun();
    if (run?.status === 'running') {
      connectSSE();
      setTimeout(flushPending, 0);
    } else {
      done = true;
      finalStatus = run?.status ?? '';
      renderStoredOutput();
    }
  });

  onDestroy(() => {
    eventSource?.close();
  });
</script>

<div class="row" style="margin-bottom:16px">
  <a href="/designs/{designId}" style="color:#0066cc; text-decoration:none; font-size:13px">← Design</a>
  <h1 style="margin-left:8px">Run #{runId}</h1>
  {#if run}
    <span class="badge badge-{run.status}">{run.status}</span>
  {/if}
  <span class="spacer"></span>
  {#if !done && run?.status === 'running'}
    <button class="danger" onclick={stopRun}>Stop Run</button>
  {/if}
  {#if done}
    <button class="danger" onclick={deleteRun}>Delete Run</button>
  {/if}
</div>

{#if run}
  <div class="card" style="margin-bottom:12px">
    <div class="stats-row">
      <div class="stat">
        <div class="stat-label">TPS</div>
        <div class="stat-value">{run.tps?.toFixed(2) ?? '—'}</div>
      </div>
      <div class="stat">
        <div class="stat-label">Avg Latency</div>
        <div class="stat-value">{run.latency_avg_ms?.toFixed(3) ?? '—'} ms</div>
      </div>
      <div class="stat">
        <div class="stat-label">Stddev</div>
        <div class="stat-value">{run.latency_stddev_ms?.toFixed(3) ?? '—'} ms</div>
      </div>
      <div class="stat">
        <div class="stat-label">Transactions</div>
        <div class="stat-value">{run.transactions?.toLocaleString() ?? '—'}</div>
      </div>
      <div class="stat">
        <div class="stat-label">Started</div>
        <div class="stat-value">{run.started_at?.slice(0,16)}</div>
      </div>
      {#if run.finished_at}
        <div class="stat">
          <div class="stat-label">Finished</div>
          <div class="stat-value">{run.finished_at?.slice(0,16)}</div>
        </div>
      {/if}
    </div>
  </div>

  {#if run.steps?.length > 0}
    <div class="card" style="margin-bottom:12px">
      <h3>Steps</h3>
      <table>
        <thead>
          <tr><th>Step</th><th>Type</th><th>Status</th><th>Started</th><th>Finished</th><th></th></tr>
        </thead>
        <tbody>
          {#each run.steps as s}
            <tr>
              <td>{s.name}</td>
              <td><span class="badge badge-{s.type}">{s.type}</span></td>
              <td><span class="badge badge-{s.status}">{s.status}</span></td>
              <td>{s.started_at?.slice(11,19) ?? '—'}</td>
              <td>{s.finished_at?.slice(11,19) ?? '—'}</td>
              <td>
                {#if s.command}
                  <button class="expand-btn" onclick={() => toggleStep(s.step_id)}>
                    {expandedStep === s.step_id ? '▲' : '▼'} details
                  </button>
                {/if}
              </td>
            </tr>
            {#if expandedStep === s.step_id && s.command}
              <tr class="detail-row">
                <td colspan="6">
                  <div class="detail-block">
                    <div class="detail-label">Command</div>
                    <pre class="detail-pre">{s.command}</pre>
                    {#if s.processed_script}
                      <div class="detail-label" style="margin-top:8px">Script</div>
                      <pre class="detail-pre">{s.processed_script}</pre>
                    {/if}
                  </div>
                </td>
              </tr>
            {/if}
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
{/if}

<div class="card">
  <div class="row" style="margin-bottom:8px">
    <h3>Output</h3>
    {#if !done}
      <span style="font-size:12px; color:#856404">● Live</span>
    {:else}
      <span style="font-size:12px; color:#155724">✓ {finalStatus || 'Done'}</span>
    {/if}
  </div>
  <pre class="output" bind:this={outputEl}>{#if !done}<span class="cursor">▋</span>{/if}</pre>
</div>

<style>
  .stats-row { display: flex; gap: 20px; flex-wrap: wrap; }
  .stat { min-width: 100px; }
  .stat-label { font-size: 11px; color: #666; font-weight: 600; text-transform: uppercase; }
  .stat-value { font-size: 18px; font-weight: 700; color: #333; }
  .expand-btn { font-size: 11px; padding: 2px 6px; background: none; border: 1px solid #ccc; border-radius: 3px; cursor: pointer; color: #555; }
  .expand-btn:hover { background: #f0f0f0; }
  .detail-row td { padding: 0 !important; }
  .detail-block { padding: 8px 12px; background: #f8f8f8; border-top: 1px solid #eee; }
  .detail-label { font-size: 10px; font-weight: 700; color: #888; text-transform: uppercase; margin-bottom: 4px; }
  .detail-pre { margin: 0; font-size: 12px; white-space: pre-wrap; word-break: break-all; background: #1e1e1e; color: #d4d4d4; padding: 8px; border-radius: 4px; max-height: 200px; overflow-y: auto; }
  .cursor { animation: blink 1s step-end infinite; }
  @keyframes blink { 0%,100% { opacity: 1; } 50% { opacity: 0; } }
</style>
