<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  type Run = { id: number; series_id: number; design_id: number; status: string;
    profile_name: string; tps: number | null; latency_avg_ms: number | null;
    started_at: string; finished_at: string | null; };
  type Series = { id: number; name: string; status: string; created_at: string; finished_at: string | null;
    design_id: number; delay_seconds: number; design_name: string; };

  let suite = $state(data.suite);
  let seriesList = $state<Series[]>(data.seriesList as Series[]);
  let runs = $state<Run[]>(data.runs as Run[]);

  let logLines = $state<string[]>([]);
  let completedDesignIds = $state<Set<number>>(new Set());
  let es: EventSource | null = null;
  let logEl: HTMLElement | null = null;
  let autoScroll = $state(true);

  const runsBySeries = $derived(() => {
    const map = new Map<number, Run[]>();
    for (const r of runs) {
      const arr = map.get(r.series_id) ?? [];
      arr.push(r);
      map.set(r.series_id, arr);
    }
    return map;
  });

  const completedSeries = $derived(seriesList.filter(s => s.status === 'completed' || s.status === 'failed').length);

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

  function fmtTps(tps: number | null) {
    return tps != null ? `${tps.toFixed(0)} TPS` : '';
  }

  function compareUrl(s: Series) {
    const sRuns = runsBySeries().get(s.id) ?? [];
    const done = sRuns.filter(r => r.status === 'completed' || r.status === 'failed');
    return done.length >= 2
      ? `/designs/${s.design_id}/compare?runs=${done.map(r => r.id).join(',')}`
      : null;
  }

  async function refreshData() {
    try {
      const res = await fetch(`/api/suites/${suite.id}`);
      if (res.ok) {
        const d = await res.json();
        suite = d.suite;
        seriesList = d.seriesList;
        runs = d.runs;
      }
    } catch { /* ignore */ }
  }

  onMount(() => {
    if (suite.status === 'running') {
      es = new EventSource(`/api/suites/${suite.id}/stream`);

      es.addEventListener('message', (e) => {
        const line = JSON.parse(e.data);
        logLines = [...logLines, line];
        if (autoScroll && logEl) {
          setTimeout(() => logEl?.scrollTo({ top: logEl.scrollHeight, behavior: 'smooth' }), 10);
        }
      });

      es.addEventListener('series-done', (e) => {
        const data = JSON.parse(e.data);
        completedDesignIds = new Set([...completedDesignIds, data.design_id]);
        refreshData();
      });

      es.addEventListener('done', () => {
        es?.close();
        es = null;
        refreshData();
      });

      es.onerror = () => {
        setTimeout(refreshData, 3000);
      };
    }
  });

  onDestroy(() => es?.close());
</script>

<div class="suite-page">
  <div class="suite-header">
    <a class="back-link" href="/decisions/{suite.decision_id}">← {suite.decision_name}</a>
    <div class="suite-title-row">
      <h2>{suite.name}</h2>
      <span class="suite-status {statusClass(suite.status)}">{suite.status}</span>
    </div>
    <div class="suite-meta">
      {seriesList.length} design{seriesList.length !== 1 ? 's' : ''}
      · {runs.length} total run{runs.length !== 1 ? 's' : ''}
      {#if suite.status === 'running'}· {completedSeries}/{seriesList.length} designs done{/if}
    </div>
  </div>

  {#if suite.status === 'running' && seriesList.length > 0}
    <div class="progress-bar-wrap">
      <div class="progress-label">{completedSeries} / {seriesList.length} designs</div>
      <div class="progress-bar">
        <div class="progress-fill" style="width: {(completedSeries / seriesList.length) * 100}%"></div>
      </div>
    </div>
  {/if}

  <div class="suite-body">
    <!-- Designs panel -->
    <div class="designs-panel">
      {#each seriesList as s}
        {@const sRuns = runsBySeries().get(s.id) ?? []}
        {@const cmpUrl = compareUrl(s)}
        <div class="design-block">
          <div class="design-block-header">
            <span class="design-status-icon {statusClass(s.status)}">{statusIcon(s.status)}</span>
            <a class="design-name-link" href="/designs/{s.design_id}/series/{s.id}">{s.design_name}</a>
            <span class="design-status-badge {statusClass(s.status)}">{s.status}</span>
            {#if cmpUrl}
              <a class="compare-link" href={cmpUrl}>compare →</a>
            {/if}
          </div>

          {#if sRuns.length > 0}
            <table class="runs-table">
              <thead>
                <tr><th>#</th><th>Profile</th><th>Status</th><th>TPS</th><th></th></tr>
              </thead>
              <tbody>
                {#each sRuns as run, i}
                  <tr>
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
                        <a href="/designs/{s.design_id}/runs/{run.id}">view →</a>
                      {/if}
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          {:else}
            <div class="no-runs">waiting…</div>
          {/if}
        </div>
      {/each}
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
          if (logEl) autoScroll = logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 20;
        }}
      >
        {#if logLines.length === 0 && suite.status !== 'running'}
          <div class="log-empty">No output captured.</div>
        {:else}
          {#each logLines as line}
            <div class="log-line">{line}</div>
          {/each}
          {#if suite.status === 'running'}
            <div class="log-cursor">▌</div>
          {/if}
        {/if}
      </div>
    </div>
  </div>
</div>

<style>
  .suite-page { padding: 24px; max-width: 1200px; margin: 0 auto; font-family: monospace; color: #cdd6f4; }
  .back-link { color: #89b4fa; text-decoration: none; font-size: 13px; }
  .back-link:hover { text-decoration: underline; }

  .suite-title-row { display: flex; align-items: center; gap: 12px; margin: 8px 0 4px; }
  h2 { margin: 0; font-size: 20px; color: #cdd6f4; }
  h3 { margin: 0 0 12px; font-size: 14px; color: #a6adc8; }
  .suite-meta { font-size: 12px; color: #6c7086; margin-bottom: 16px; }
  .suite-status { font-size: 12px; padding: 2px 8px; border-radius: 999px; }

  .status-ok { background: #1e3a1e; color: #a6e3a1; border: 1px solid #2d5a2d; }
  .status-fail { background: #3a1e1e; color: #f38ba8; border: 1px solid #5a2d2d; }
  .status-running { background: #1e2e3a; color: #89b4fa; border: 1px solid #2d4a5a; }
  .status-pending { background: #2a2a3a; color: #a6adc8; border: 1px solid #45475a; }

  .progress-bar-wrap { margin-bottom: 16px; }
  .progress-label { font-size: 12px; color: #a6adc8; margin-bottom: 4px; }
  .progress-bar { height: 6px; background: #313244; border-radius: 3px; overflow: hidden; }
  .progress-fill { height: 100%; background: #89b4fa; border-radius: 3px; transition: width 0.4s; }

  .suite-body { display: grid; grid-template-columns: 380px 1fr; gap: 20px; }

  /* Designs panel */
  .designs-panel { display: flex; flex-direction: column; gap: 10px; }
  .design-block { background: #1e1e2e; border: 1px solid #313244; border-radius: 6px; overflow: hidden; }
  .design-block-header {
    display: flex; align-items: center; gap: 8px;
    padding: 10px 12px; border-bottom: 1px solid #313244;
  }
  .design-status-icon { font-size: 13px; flex-shrink: 0; }
  .design-status-icon.status-ok { color: #a6e3a1; background: none; border: none; padding: 0; }
  .design-status-icon.status-fail { color: #f38ba8; background: none; border: none; padding: 0; }
  .design-status-icon.status-running { color: #89b4fa; background: none; border: none; padding: 0; }
  .design-status-icon.status-pending { color: #6c7086; background: none; border: none; padding: 0; }
  .design-name-link { flex: 1; font-size: 13px; font-weight: 600; color: #cdd6f4; text-decoration: none; }
  .design-name-link:hover { color: #89b4fa; text-decoration: underline; }
  .design-status-badge { font-size: 11px; padding: 1px 6px; border-radius: 999px; }
  .compare-link { font-size: 11px; color: #89b4fa; text-decoration: none; flex-shrink: 0; }
  .compare-link:hover { text-decoration: underline; }

  .runs-table { width: 100%; border-collapse: collapse; font-size: 12px; }
  .runs-table th { text-align: left; color: #6c7086; padding: 4px 10px; border-bottom: 1px solid #313244; font-size: 11px; }
  .runs-table td { padding: 5px 10px; border-bottom: 1px solid #1e1e2e; color: #a6adc8; }
  .runs-table td a { color: #89b4fa; text-decoration: none; }
  .runs-table td a:hover { text-decoration: underline; }
  .run-status { font-size: 11px; }
  .no-runs { padding: 10px 12px; font-size: 12px; color: #6c7086; font-style: italic; }

  /* Log panel */
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
</style>
