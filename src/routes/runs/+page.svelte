<script lang="ts">
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  type SeriesRun = {
    id: number; series_id: number; status: string; profile_name: string;
    tps: number | null; latency_avg_ms: number | null; started_at: string; finished_at: string | null;
  };
  type SeriesItem = {
    id: number; name: string; status: string; created_at: string; finished_at: string | null;
    design_id: number; delay_seconds: number; design_name: string;
    decision_id: number; decision_name: string; runs: SeriesRun[];
  };
  type SuiteItem = {
    id: number; name: string; status: string; created_at: string; finished_at: string | null;
    decision_id: number; decision_name: string; series_count: number; run_count: number;
  };
  type RunItem = {
    id: number; status: string; started_at: string; finished_at: string | null;
    tps: number | null; latency_avg_ms: number | null; profile_name: string; name: string;
    design_id: number; design_name: string; decision_id: number; decision_name: string;
  };

  let filterDecisionId = $state<number | 'all'>('all');
  let filterStatus = $state<string>('all');

  // Merge suites, series and standalone runs into a unified timeline
  type TimelineEntry =
    | { kind: 'suite'; sortKey: string; item: SuiteItem }
    | { kind: 'series'; sortKey: string; item: SeriesItem }
    | { kind: 'run'; sortKey: string; item: RunItem };

  const timeline = $derived(() => {
    const entries: TimelineEntry[] = [];

    for (const s of (data.suiteList as SuiteItem[])) {
      if (filterDecisionId !== 'all' && s.decision_id !== filterDecisionId) continue;
      if (filterStatus !== 'all' && s.status !== filterStatus) continue;
      entries.push({ kind: 'suite', sortKey: s.created_at, item: s });
    }
    for (const s of data.seriesWithRuns) {
      if (filterDecisionId !== 'all' && s.decision_id !== filterDecisionId) continue;
      if (filterStatus !== 'all' && s.status !== filterStatus) continue;
      entries.push({ kind: 'series', sortKey: s.created_at, item: s });
    }
    for (const r of data.standaloneRuns) {
      if (filterDecisionId !== 'all' && r.decision_id !== filterDecisionId) continue;
      if (filterStatus !== 'all' && r.status !== filterStatus) continue;
      entries.push({ kind: 'run', sortKey: r.started_at, item: r });
    }

    entries.sort((a, b) => b.sortKey.localeCompare(a.sortKey));
    return entries;
  });

  function timeAgo(iso: string): string {
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    return `${days}d ago`;
  }

  function fmtTps(tps: number | null) {
    return tps != null ? `${tps.toFixed(0)} TPS` : null;
  }

  function fmtLatency(ms: number | null) {
    return ms != null ? `${ms.toFixed(2)}ms` : null;
  }

  function statusBadgeClass(s: string) {
    if (s === 'completed') return 'badge badge-completed';
    if (s === 'failed') return 'badge badge-failed';
    if (s === 'running') return 'badge badge-running';
    return 'badge badge-pending';
  }

  function runIcon(s: string) {
    if (s === 'completed') return '✓';
    if (s === 'failed') return '✕';
    if (s === 'running') return '▶';
    return '·';
  }

  function compareUrl(series: SeriesItem) {
    const done = series.runs.filter(r => r.status === 'completed' || r.status === 'failed');
    return done.length >= 2
      ? `/designs/${series.design_id}/compare?runs=${done.map(r => r.id).join(',')}`
      : null;
  }
</script>

<div class="page">
  <div class="page-header">
    <h1>Runs</h1>
    <div class="filters">
      <select bind:value={filterDecisionId}>
        <option value="all">All decisions</option>
        {#each data.decisions as d}
          <option value={d.id}>{d.name}</option>
        {/each}
      </select>
      <select bind:value={filterStatus}>
        <option value="all">All statuses</option>
        <option value="running">Running</option>
        <option value="completed">Completed</option>
        <option value="failed">Failed</option>
      </select>
    </div>
  </div>

  {#if timeline().length === 0}
    <p class="empty">No runs yet.</p>
  {:else}
    <div class="timeline">
      {#each timeline() as entry (entry.kind + '-' + entry.item.id)}
        {#if entry.kind === 'suite'}
          {@const s = entry.item as SuiteItem}
          <div class="card suite-card">
            <div class="card-header">
              <div class="card-title-row">
                <span class="kind-label suite-label">suite</span>
                <a class="item-name" href="/decisions/{s.decision_id}/suites/{s.id}">{s.name}</a>
                <span class={statusBadgeClass(s.status)}>{s.status}</span>
              </div>
              <div class="breadcrumb">
                <a href="/decisions/{s.decision_id}">{s.decision_name}</a>
              </div>
            </div>
            <div class="run-stats">
              <span class="stat">{s.series_count} design{s.series_count !== 1 ? 's' : ''}</span>
              <span class="stat">{s.run_count} run{s.run_count !== 1 ? 's' : ''}</span>
              <span class="stat time">{timeAgo(s.created_at)}</span>
            </div>
            <div class="card-footer">
              <a href="/decisions/{s.decision_id}/suites/{s.id}" class="footer-link">View suite →</a>
            </div>
          </div>

        {:else if entry.kind === 'series'}
          {@const s = entry.item as SeriesItem}
          {@const cmpUrl = compareUrl(s)}
          <div class="card series-card">
            <div class="card-header">
              <div class="card-title-row">
                <span class="kind-label series-label">series</span>
                <a class="item-name" href="/designs/{s.design_id}/series/{s.id}">{s.name}</a>
                <span class={statusBadgeClass(s.status)}>{s.status}</span>
              </div>
              <div class="breadcrumb">
                <a href="/decisions/{s.decision_id}">{s.decision_name}</a>
                <span class="sep">›</span>
                <a href="/designs/{s.design_id}">{s.design_name}</a>
              </div>
            </div>

            <div class="series-meta">
              {s.runs.length} run{s.runs.length !== 1 ? 's' : ''}
              {#if s.delay_seconds > 0}· {s.delay_seconds}s delay{/if}
              · {timeAgo(s.created_at)}
            </div>

            {#if s.runs.length > 0}
              <div class="series-runs">
                {#each s.runs as run}
                  <div class="series-run-row">
                    <span class="run-icon {run.status}">{runIcon(run.status)}</span>
                    <span class="run-profile">{run.profile_name || '—'}</span>
                    {#if fmtTps(run.tps)}
                      <span class="run-tps">{fmtTps(run.tps)}</span>
                    {/if}
                    {#if fmtLatency(run.latency_avg_ms)}
                      <span class="run-lat">{fmtLatency(run.latency_avg_ms)}</span>
                    {/if}
                    {#if run.status === 'completed' || run.status === 'failed'}
                      <a class="run-link" href="/designs/{s.design_id}/runs/{run.id}">view →</a>
                    {/if}
                  </div>
                {/each}
              </div>
            {/if}

            <div class="card-footer">
              <a href="/designs/{s.design_id}/series/{s.id}" class="footer-link">View series →</a>
              {#if cmpUrl}
                <a href={cmpUrl} class="footer-link">Compare runs →</a>
              {/if}
            </div>
          </div>

        {:else}
          {@const r = entry.item as RunItem}
          <div class="card run-card">
            <div class="card-header">
              <div class="card-title-row">
                <span class="kind-label run-label">run</span>
                <a class="item-name" href="/designs/{r.design_id}/runs/{r.id}">
                  {r.name || r.profile_name || 'Run #' + r.id}
                </a>
                <span class={statusBadgeClass(r.status)}>{r.status}</span>
              </div>
              <div class="breadcrumb">
                <a href="/decisions/{r.decision_id}">{r.decision_name}</a>
                <span class="sep">›</span>
                <a href="/designs/{r.design_id}">{r.design_name}</a>
              </div>
            </div>

            <div class="run-stats">
              {#if fmtTps(r.tps)}
                <span class="stat"><strong>{fmtTps(r.tps)}</strong></span>
              {/if}
              {#if fmtLatency(r.latency_avg_ms)}
                <span class="stat">latency <strong>{fmtLatency(r.latency_avg_ms)}</strong></span>
              {/if}
              <span class="stat time">{timeAgo(r.started_at)}</span>
            </div>
          </div>
        {/if}
      {/each}
    </div>
  {/if}
</div>

<style>
  .page { max-width: 800px; }

  .page-header {
    display: flex;
    align-items: center;
    gap: 16px;
    margin-bottom: 20px;
    flex-wrap: wrap;
  }
  .page-header h1 { margin: 0; font-size: 22px; }

  .filters { display: flex; gap: 8px; margin-left: auto; }
  .filters select { width: auto; font-size: 13px; }

  .empty { color: #999; }

  .timeline { display: flex; flex-direction: column; gap: 10px; }

  .card {
    background: #fff;
    border: 1px solid #e0e0e0;
    border-radius: 6px;
    padding: 14px 16px;
  }
  .suite-card { border-left: 3px solid #6600cc; }
  .series-card { border-left: 3px solid #0066cc; }
  .run-card { border-left: 3px solid #888; }

  .card-header { margin-bottom: 6px; }
  .card-title-row { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }

  .kind-label {
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    padding: 1px 5px;
    border-radius: 3px;
    letter-spacing: 0.5px;
  }
  .suite-label { background: #f0e8ff; color: #6600cc; }
  .series-label { background: #e8f0fe; color: #0066cc; }
  .run-label { background: #f0f0f0; color: #555; }

  .item-name {
    font-weight: 600;
    font-size: 14px;
    color: #1a1a1a;
    text-decoration: none;
  }
  .item-name:hover { color: #0066cc; text-decoration: underline; }

  .breadcrumb { font-size: 12px; color: #888; display: flex; align-items: center; gap: 4px; }
  .breadcrumb a { color: #888; text-decoration: none; }
  .breadcrumb a:hover { color: #0066cc; }
  .sep { color: #bbb; }

  .series-meta { font-size: 12px; color: #666; margin-bottom: 10px; }

  .series-runs {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-bottom: 10px;
    padding: 8px 10px;
    background: #f8f8f8;
    border-radius: 4px;
  }
  .series-run-row {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
  }
  .run-icon { font-size: 11px; width: 14px; text-align: center; }
  .run-icon.completed { color: #155724; }
  .run-icon.failed { color: #721c24; }
  .run-icon.running { color: #856404; }
  .run-icon.pending { color: #999; }
  .run-profile { color: #333; min-width: 100px; }
  .run-tps { color: #0066cc; font-weight: 600; }
  .run-lat { color: #666; }
  .run-link { color: #0066cc; text-decoration: none; margin-left: auto; }
  .run-link:hover { text-decoration: underline; }

  .card-footer {
    display: flex;
    gap: 16px;
    padding-top: 8px;
    border-top: 1px solid #f0f0f0;
  }
  .footer-link { font-size: 12px; color: #0066cc; text-decoration: none; }
  .footer-link:hover { text-decoration: underline; }

  .run-stats { display: flex; align-items: center; gap: 16px; font-size: 13px; color: #555; margin-top: 4px; }
  .stat strong { color: #1a1a1a; }
  .stat.time { margin-left: auto; color: #999; font-size: 12px; }

  /* badge overrides for pending */
  :global(.badge-pending) { background: #f0f0f0; color: #555; }
</style>
