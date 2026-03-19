<script lang="ts">
  import { page } from '$app/stores';
  import { onMount, onDestroy } from 'svelte';

  const designId = $derived(Number($page.params.id));
  const runId = $derived(Number($page.params.runId));

  interface StepResult {
    id: number; name: string; type: string; status: string;
    stdout: string; stderr: string; started_at: string|null; finished_at: string|null;
  }
  interface Run {
    id: number; status: string; tps: number|null; latency_avg_ms: number|null;
    latency_stddev_ms: number|null; transactions: number|null;
    started_at: string; finished_at: string|null;
    steps: StepResult[];
  }

  let run: Run | null = $state(null);
  let lines: string[] = $state([]);
  let done = $state(false);
  let finalStatus = $state('');
  let eventSource: EventSource | null = null;
  let outputEl: HTMLPreElement | null = $state(null);

  async function loadRun() {
    const res = await fetch(`/api/runs/${runId}`);
    run = await res.json();
  }

  function connectSSE() {
    eventSource = new EventSource(`/api/runs/${runId}/stream`);
    eventSource.onmessage = (e) => {
      try {
        const line = JSON.parse(e.data);
        lines = [...lines, line];
        // Auto-scroll
        setTimeout(() => {
          if (outputEl) outputEl.scrollTop = outputEl.scrollHeight;
        }, 10);
      } catch {}
    };
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

  onMount(() => {
    loadRun();
    connectSSE();
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
          <tr><th>Step</th><th>Type</th><th>Status</th><th>Started</th><th>Finished</th></tr>
        </thead>
        <tbody>
          {#each run.steps as s}
            <tr>
              <td>{s.name}</td>
              <td><span class="badge badge-{s.type}">{s.type}</span></td>
              <td><span class="badge badge-{s.status}">{s.status}</span></td>
              <td>{s.started_at?.slice(11,19) ?? '—'}</td>
              <td>{s.finished_at?.slice(11,19) ?? '—'}</td>
            </tr>
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
  <pre class="output" bind:this={outputEl}>{lines.join('\n')}{#if !done}
▋{/if}</pre>
</div>

<style>
  .stats-row { display: flex; gap: 20px; flex-wrap: wrap; }
  .stat { min-width: 100px; }
  .stat-label { font-size: 11px; color: #666; font-weight: 600; text-transform: uppercase; }
  .stat-value { font-size: 18px; font-weight: 700; color: #333; }
</style>
