<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  interface SeriesRun {
    id: number;
    status: string;
    profile_name: string;
    name: string;
    tps: number | null;
    latency_avg_ms: number | null;
    started_at: string;
    finished_at: string | null;
  }

  let series = $state(data.series as {
    id: number; design_id: number; name: string; delay_seconds: number;
    status: string; created_at: string; finished_at: string | null;
  });
  let runs = $state<SeriesRun[]>(data.runs as SeriesRun[]);
  let design = data.design;

  let logLines = $state<string[]>([]);
  let progress = $state<{ current: number; total: number; current_run_id: number | null } | null>(null);
  let es: EventSource | null = null;
  let logEl: HTMLElement | null = null;
  let autoScroll = $state(true);

  const completedRuns = $derived(runs.filter(r => r.status === 'completed' || r.status === 'failed'));
  const compareUrl = $derived(
    completedRuns.length >= 2
      ? `/designs/${design.id}/compare?runs=${completedRuns.map(r => r.id).join(',')}`
      : null
  );

  function fmtTps(tps: number | null) {
    return tps != null ? `${tps.toFixed(0)} TPS` : '';
  }

  function statusClass(s: string) {
    if (s === 'completed') return 'status-ok';
    if (s === 'failed') return 'status-fail';
    if (s === 'running') return 'status-running';
    return 'status-pending';
  }

  function statusIcon(s: string) {
    if (s === 'completed') return '✓';
    if (s === 'failed') return '✕';
    if (s === 'running') return '▶';
    return '·';
  }

  async function refreshRuns() {
    try {
      const res = await fetch(`/api/series/${series.id}`);
      if (res.ok) {
        const d = await res.json();
        runs = d.runs;
        series = d.series;
      }
    } catch { /* ignore */ }
  }

  onMount(() => {
    if (series.status === 'running') {
      es = new EventSource(`/api/series/${series.id}/stream`);

      es.addEventListener('message', (e) => {
        const line = JSON.parse(e.data);
        logLines = [...logLines, line];
        if (autoScroll && logEl) {
          setTimeout(() => logEl?.scrollTo({ top: logEl.scrollHeight, behavior: 'smooth' }), 10);
        }
      });

      es.addEventListener('progress', (e) => {
        progress = JSON.parse(e.data);
        refreshRuns();
      });

      es.addEventListener('done', () => {
        es?.close();
        es = null;
        refreshRuns();
      });

      es.onerror = () => {
        setTimeout(refreshRuns, 3000);
      };
    }
  });

  onDestroy(() => {
    es?.close();
  });
</script>

<div class="series-page">
  <div class="series-header">
    <a class="back-link" href="/designs/{design.id}">← {design.name}</a>
    <div class="series-title-row">
      <h2>{series.name}</h2>
      <span class="series-status {statusClass(series.status)}">{series.status}</span>
    </div>
    {#if series.delay_seconds > 0}
      <div class="series-meta">{runs.length} runs · {series.delay_seconds}s delay between runs</div>
    {:else}
      <div class="series-meta">{runs.length} runs</div>
    {/if}
  </div>

  {#if progress && series.status === 'running'}
    <div class="progress-bar-wrap">
      <div class="progress-label">Run {progress.current} / {progress.total}</div>
      <div class="progress-bar">
        <div class="progress-fill" style="width: {(progress.current / progress.total) * 100}%"></div>
      </div>
    </div>
  {/if}

  <div class="series-body">
    <!-- Run list -->
    <div class="runs-panel">
      <h3>Runs</h3>
      <table class="runs-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Profile</th>
            <th>Status</th>
            <th>TPS</th>
            <th>Detail</th>
          </tr>
        </thead>
        <tbody>
          {#each runs as run, i}
            <tr class:active-run={progress?.current_run_id === run.id}>
              <td>{i + 1}</td>
              <td>{run.profile_name || '—'}</td>
              <td>
                <span class="run-status {statusClass(run.status)}">
                  {statusIcon(run.status)} {run.status}
                </span>
              </td>
              <td>{fmtTps(run.tps)}</td>
              <td>
                {#if run.status === 'completed' || run.status === 'failed'}
                  <a href="/designs/{design.id}/runs/{run.id}">view →</a>
                {:else}
                  —
                {/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>

      {#if compareUrl && series.status !== 'running'}
        <div class="compare-action">
          <a class="compare-btn" href={compareUrl}>Compare all runs →</a>
        </div>
      {/if}
    </div>

    <!-- Log panel -->
    <div class="log-panel">
      <div class="log-header">
        <h3>Output</h3>
        <label class="autoscroll-label">
          <input type="checkbox" bind:checked={autoScroll} />
          auto-scroll
        </label>
      </div>
      <div
        class="log-output"
        bind:this={logEl}
        onscroll={() => {
          if (logEl) {
            autoScroll = logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 20;
          }
        }}
      >
        {#if logLines.length === 0 && series.status !== 'running'}
          <div class="log-empty">No output captured.</div>
        {:else}
          {#each logLines as line}
            <div class="log-line">{line}</div>
          {/each}
          {#if series.status === 'running'}
            <div class="log-cursor">▌</div>
          {/if}
        {/if}
      </div>
    </div>
  </div>
</div>

<style>
  .series-page { padding: 24px; max-width: 1200px; margin: 0 auto; font-family: monospace; color: #cdd6f4; }
  .back-link { color: #89b4fa; text-decoration: none; font-size: 13px; }
  .back-link:hover { text-decoration: underline; }
  .series-title-row { display: flex; align-items: center; gap: 12px; margin: 8px 0 4px; }
  h2 { margin: 0; font-size: 20px; color: #cdd6f4; }
  h3 { margin: 0 0 12px; font-size: 14px; color: #a6adc8; }
  .series-meta { font-size: 12px; color: #6c7086; margin-bottom: 16px; }
  .series-status { font-size: 12px; padding: 2px 8px; border-radius: 999px; }
  .status-ok { background: #1e3a1e; color: #a6e3a1; border: 1px solid #2d5a2d; }
  .status-fail { background: #3a1e1e; color: #f38ba8; border: 1px solid #5a2d2d; }
  .status-running { background: #1e2e3a; color: #89b4fa; border: 1px solid #2d4a5a; }
  .status-pending { background: #2a2a3a; color: #a6adc8; border: 1px solid #45475a; }

  .progress-bar-wrap { margin-bottom: 16px; }
  .progress-label { font-size: 12px; color: #a6adc8; margin-bottom: 4px; }
  .progress-bar { height: 6px; background: #313244; border-radius: 3px; overflow: hidden; }
  .progress-fill { height: 100%; background: #89b4fa; border-radius: 3px; transition: width 0.3s; }

  .series-body { display: grid; grid-template-columns: 320px 1fr; gap: 20px; }

  .runs-panel { background: #1e1e2e; border: 1px solid #313244; border-radius: 6px; padding: 16px; }
  .runs-table { width: 100%; border-collapse: collapse; font-size: 12px; }
  .runs-table th { text-align: left; color: #6c7086; padding: 4px 8px; border-bottom: 1px solid #313244; }
  .runs-table td { padding: 6px 8px; border-bottom: 1px solid #1e1e2e; }
  .runs-table tr.active-run td { background: #1e2e3a; }
  .run-status { font-size: 11px; }
  .compare-action { margin-top: 16px; }
  .compare-btn {
    display: inline-block; padding: 6px 14px; background: #313244;
    border: 1px solid #45475a; border-radius: 4px; color: #cdd6f4;
    text-decoration: none; font-size: 12px;
  }
  .compare-btn:hover { background: #45475a; }

  .log-panel { background: #1e1e2e; border: 1px solid #313244; border-radius: 6px; display: flex; flex-direction: column; }
  .log-header { display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; border-bottom: 1px solid #313244; }
  .autoscroll-label { display: flex; align-items: center; gap: 6px; font-size: 11px; color: #6c7086; cursor: pointer; }
  .log-output { flex: 1; overflow-y: auto; padding: 12px 16px; min-height: 400px; max-height: 600px; font-size: 12px; line-height: 1.5; }
  .log-line { white-space: pre-wrap; word-break: break-all; color: #cdd6f4; }
  .log-line:empty { height: 0.5em; }
  .log-cursor { color: #89b4fa; animation: blink 1s step-end infinite; }
  .log-empty { color: #6c7086; font-style: italic; }
  @keyframes blink { 50% { opacity: 0; } }

  a { color: #89b4fa; }
  a:hover { text-decoration: underline; }
</style>
