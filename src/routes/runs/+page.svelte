<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import { page } from '$app/state';
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
    design_names: string | null;
  };
  type RunItem = {
    id: number; status: string; started_at: string; finished_at: string | null;
    tps: number | null; latency_avg_ms: number | null; profile_name: string; name: string;
    design_id: number; design_name: string; decision_id: number; decision_name: string;
  };

  // Filters — initialised from URL so they survive navigation / bookmarks
  let filterKind = $state(page.url.searchParams.get('kind') ?? 'all');
  let filterDecisionId = $state(page.url.searchParams.get('decision') ?? 'all');
  let filterStatus = $state(page.url.searchParams.get('status') ?? 'all');

  $effect(() => {
    const params = new URLSearchParams();
    if (filterKind !== 'all') params.set('kind', filterKind);
    if (filterDecisionId !== 'all') params.set('decision', filterDecisionId);
    if (filterStatus !== 'all') params.set('status', filterStatus);
    const search = params.toString();
    history.replaceState(history.state, '', search ? `?${search}` : location.pathname);
  });

  type TimelineEntry =
    | { kind: 'suite'; sortKey: string; item: SuiteItem }
    | { kind: 'series'; sortKey: string; item: SeriesItem }
    | { kind: 'run'; sortKey: string; item: RunItem };

  const timeline = $derived(() => {
    const entries: TimelineEntry[] = [];
    if (filterKind === 'all' || filterKind === 'suite') {
      for (const s of (data.suiteList as SuiteItem[])) {
        if (filterDecisionId !== 'all' && String(s.decision_id) !== filterDecisionId) continue;
        if (filterStatus !== 'all' && s.status !== filterStatus) continue;
        entries.push({ kind: 'suite', sortKey: s.created_at, item: s });
      }
    }
    if (filterKind === 'all' || filterKind === 'series') {
      for (const s of data.seriesWithRuns) {
        if (filterDecisionId !== 'all' && String(s.decision_id) !== filterDecisionId) continue;
        if (filterStatus !== 'all' && s.status !== filterStatus) continue;
        entries.push({ kind: 'series', sortKey: s.created_at, item: s });
      }
    }
    if (filterKind === 'all' || filterKind === 'run') {
      for (const r of data.standaloneRuns) {
        if (filterDecisionId !== 'all' && String(r.decision_id) !== filterDecisionId) continue;
        if (filterStatus !== 'all' && r.status !== filterStatus) continue;
        entries.push({ kind: 'run', sortKey: r.started_at, item: r });
      }
    }
    entries.sort((a, b) => b.sortKey.localeCompare(a.sortKey));
    return entries;
  });

  // Live polling while any item is running
  $effect(() => {
    const hasRunning = timeline().some(e => e.item.status === 'running');
    if (!hasRunning) return;
    const timer = setInterval(() => invalidateAll(), 5000);
    return () => clearInterval(timer);
  });

  // ── Per-item delete ────────────────────────────────────────────────────────
  type DeleteTarget = { kind: string; id: number; label: string };
  let pendingDelete = $state<DeleteTarget | null>(null);
  let isDeleting = $state(false);

  function requestDelete(kind: string, id: number, label: string) {
    pendingDelete = { kind, id, label };
  }

  function cancelDelete() { pendingDelete = null; }

  async function confirmDelete() {
    if (!pendingDelete) return;
    isDeleting = true;
    const { kind, id } = pendingDelete;
    try {
      await deleteOne(kind, id);
      pendingDelete = null;
      await invalidateAll();
    } finally {
      isDeleting = false;
    }
  }

  async function deleteOne(kind: string, id: number) {
    if (kind === 'suite') await fetch(`/api/suites/${id}?action=delete`, { method: 'DELETE' });
    else if (kind === 'series') await fetch(`/api/series/${id}?action=delete`, { method: 'DELETE' });
    else await fetch(`/api/runs/${id}?action=delete`, { method: 'DELETE' });
  }

  // ── Multi-select ───────────────────────────────────────────────────────────
  let selectMode = $state(false);
  let selected = $state(new Set<string>());
  let bulkConfirming = $state(false);
  let isBulkDeleting = $state(false);

  function entryKey(kind: string, id: number) { return `${kind}-${id}`; }

  function toggleSelect(key: string) {
    const next = new Set(selected);
    if (next.has(key)) next.delete(key); else next.add(key);
    selected = next;
  }

  function toggleSelectAll() {
    const all = timeline().map(e => entryKey(e.kind, e.item.id));
    selected = selected.size === all.length ? new Set() : new Set(all);
  }

  function exitSelectMode() {
    selectMode = false;
    selected = new Set();
    bulkConfirming = false;
  }

  async function runBulkDelete() {
    isBulkDeleting = true;
    try {
      for (const key of selected) {
        const [kind, idStr] = key.split('-');
        await deleteOne(kind, Number(idStr));
      }
      exitSelectMode();
      await invalidateAll();
    } finally {
      isBulkDeleting = false;
    }
  }

  function isPendingDelete(kind: string, id: number) {
    return pendingDelete?.kind === kind && pendingDelete?.id === id;
  }

  // ── Formatting ─────────────────────────────────────────────────────────────
  function fmtTimestamp(iso: string): string {
    const d = new Date(iso);
    const now = new Date();
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const day = String(d.getDate()).padStart(2, '0');
    const mon = months[d.getMonth()];
    const yr = d.getFullYear() !== now.getFullYear() ? ` ${d.getFullYear()}` : '';
    const h = String(d.getHours()).padStart(2, '0');
    const m = String(d.getMinutes()).padStart(2, '0');
    return `${mon} ${day}${yr}, ${h}:${m}`;
  }

  function fmtDuration(startIso: string, endIso: string | null): string | null {
    if (!endIso) return null;
    const secs = Math.round((new Date(endIso).getTime() - new Date(startIso).getTime()) / 1000);
    if (secs < 60) return `${secs}s`;
    const mins = Math.floor(secs / 60);
    if (mins < 60) return `${mins}m ${secs % 60}s`;
    return `${Math.floor(mins / 60)}h ${mins % 60}m`;
  }

  function fmtTps(tps: number | null) { return tps != null ? `${tps.toFixed(0)} TPS` : null; }
  function fmtLatency(ms: number | null) { return ms != null ? `${ms.toFixed(2)}ms` : null; }

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

  function designChips(names: string | null): string[] {
    if (!names) return [];
    return [...new Set(names.split(',').map(n => n.trim()))].sort();
  }
</script>

<div class="page">
  <div class="page-header">
    <h1>Runs</h1>
    <div class="filters">
      <select bind:value={filterKind}>
        <option value="all">All types</option>
        <option value="suite">Suite</option>
        <option value="series">Series</option>
        <option value="run">Single run</option>
      </select>
      <select bind:value={filterDecisionId}>
        <option value="all">All decisions</option>
        {#each data.decisions as d}
          <option value={String(d.id)}>{d.name}</option>
        {/each}
      </select>
      <select bind:value={filterStatus}>
        <option value="all">All statuses</option>
        <option value="running">Running</option>
        <option value="completed">Completed</option>
        <option value="failed">Failed</option>
      </select>
      {#if !selectMode}
        <button class="select-btn" onclick={() => { selectMode = true; selected = new Set(); }}>Select</button>
      {/if}
    </div>
  </div>

  <!-- Multi-select action bar -->
  {#if selectMode}
    <div class="select-bar">
      <label class="select-all-label">
        <input
          type="checkbox"
          checked={selected.size > 0 && selected.size === timeline().length}
          indeterminate={selected.size > 0 && selected.size < timeline().length}
          onchange={toggleSelectAll}
        />
        {selected.size === 0 ? 'Select all' : `${selected.size} selected`}
      </label>

      {#if bulkConfirming}
        <span class="bulk-confirm-text">Delete {selected.size} item{selected.size !== 1 ? 's' : ''}?</span>
        <button class="confirm-yes" onclick={runBulkDelete} disabled={isBulkDeleting}>
          {isBulkDeleting ? 'Deleting…' : 'Yes, delete'}
        </button>
        <button class="confirm-no" onclick={() => bulkConfirming = false} disabled={isBulkDeleting}>Cancel</button>
      {:else}
        <button
          class="bulk-delete-btn"
          disabled={selected.size === 0}
          onclick={() => bulkConfirming = true}
        >
          Delete selected{selected.size > 0 ? ` (${selected.size})` : ''}
        </button>
      {/if}

      <button class="cancel-select-btn" onclick={exitSelectMode}>Done</button>
    </div>
  {/if}

  {#if timeline().length === 0}
    <div class="empty">
      <p>No runs yet{filterKind !== 'all' || filterDecisionId !== 'all' || filterStatus !== 'all' ? ' matching these filters' : ''}.</p>
      {#if filterKind !== 'all' || filterDecisionId !== 'all' || filterStatus !== 'all'}
        <button class="clear-filters" onclick={() => { filterKind = 'all'; filterDecisionId = 'all'; filterStatus = 'all'; }}>
          Clear filters
        </button>
      {/if}
    </div>
  {:else}
    <div class="timeline">
      {#each timeline() as entry (entry.kind + '-' + entry.item.id)}
        {@const key = entryKey(entry.kind, entry.item.id)}
        {@const isSelected = selected.has(key)}

        {#if entry.kind === 'suite'}
          {@const s = entry.item as SuiteItem}
          {@const dur = fmtDuration(s.created_at, s.finished_at)}
          <div class="card suite-card" class:dimmed={isDeleting && isPendingDelete('suite', s.id)} class:card-selected={isSelected}>
            <div class="card-header">
              <div class="card-title-row">
                {#if selectMode}
                  <input type="checkbox" class="item-checkbox" checked={isSelected} onchange={() => toggleSelect(key)} />
                {/if}
                <span class="kind-label suite-label">suite</span>
                <a class="item-name" href="/decisions/{s.decision_id}/suites/{s.id}">{s.name}</a>
                <span class={statusBadgeClass(s.status)}>{s.status}</span>
              </div>
              <div class="breadcrumb">
                <a href="/decisions/{s.decision_id}">{s.decision_name}</a>
              </div>
            </div>

            {#if designChips(s.design_names).length > 0}
              <div class="design-names">
                {#each designChips(s.design_names) as dn}
                  <span class="design-chip">{dn}</span>
                {/each}
              </div>
            {/if}

            <div class="run-stats">
              <span class="stat">{s.series_count} design{s.series_count !== 1 ? 's' : ''}</span>
              <span class="stat">{s.run_count} run{s.run_count !== 1 ? 's' : ''}</span>
              {#if dur}<span class="stat stat-dur">⏱ {dur}</span>{/if}
              <span class="stat stat-ts">{fmtTimestamp(s.created_at)}</span>
            </div>

            {#if !selectMode}
              <div class="card-footer">
                <a href="/decisions/{s.decision_id}/suites/{s.id}" class="footer-link">View suite →</a>
                {#if isPendingDelete('suite', s.id)}
                  <div class="inline-confirm">
                    <span>Delete "{s.name}"?</span>
                    <button class="confirm-yes" onclick={confirmDelete} disabled={isDeleting}>
                      {isDeleting ? 'Deleting…' : 'Yes, delete'}
                    </button>
                    <button class="confirm-no" onclick={cancelDelete} disabled={isDeleting}>Cancel</button>
                  </div>
                {:else}
                  <button class="delete-btn" onclick={() => requestDelete('suite', s.id, s.name)}>Delete</button>
                {/if}
              </div>
            {/if}
          </div>

        {:else if entry.kind === 'series'}
          {@const s = entry.item as SeriesItem}
          {@const cmpUrl = compareUrl(s)}
          {@const dur = fmtDuration(s.created_at, s.finished_at)}
          <div class="card series-card" class:dimmed={isDeleting && isPendingDelete('series', s.id)} class:card-selected={isSelected}>
            <div class="card-header">
              <div class="card-title-row">
                {#if selectMode}
                  <input type="checkbox" class="item-checkbox" checked={isSelected} onchange={() => toggleSelect(key)} />
                {/if}
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
              {#if dur}· <span class="dur-inline">⏱ {dur}</span>{/if}
            </div>

            {#if s.runs.length > 0}
              <div class="series-runs">
                {#each s.runs as run}
                  <div class="series-run-row">
                    <span class="run-icon {run.status}">{runIcon(run.status)}</span>
                    <span class="run-profile">{run.profile_name || '—'}</span>
                    {#if fmtTps(run.tps)}<span class="run-tps">{fmtTps(run.tps)}</span>{/if}
                    {#if fmtLatency(run.latency_avg_ms)}<span class="run-lat">{fmtLatency(run.latency_avg_ms)}</span>{/if}
                    {#if run.status === 'completed' || run.status === 'failed'}
                      <a class="run-link" href="/designs/{s.design_id}/runs/{run.id}">view →</a>
                    {/if}
                  </div>
                {/each}
              </div>
            {/if}

            <div class="card-footer">
              {#if !selectMode}
                <a href="/designs/{s.design_id}/series/{s.id}" class="footer-link">View series →</a>
                {#if cmpUrl}<a href={cmpUrl} class="footer-link">Compare runs →</a>{/if}
                {#if isPendingDelete('series', s.id)}
                  <div class="inline-confirm">
                    <span>Delete "{s.name}"?</span>
                    <button class="confirm-yes" onclick={confirmDelete} disabled={isDeleting}>
                      {isDeleting ? 'Deleting…' : 'Yes, delete'}
                    </button>
                    <button class="confirm-no" onclick={cancelDelete} disabled={isDeleting}>Cancel</button>
                  </div>
                {:else}
                  <button class="delete-btn" onclick={() => requestDelete('series', s.id, s.name)}>Delete</button>
                {/if}
              {/if}
              <span class="stat-ts footer-ts">{fmtTimestamp(s.created_at)}</span>
            </div>
          </div>

        {:else}
          {@const r = entry.item as RunItem}
          {@const label = r.name || r.profile_name || `Run #${r.id}`}
          {@const dur = fmtDuration(r.started_at, r.finished_at)}
          <div class="card run-card" class:dimmed={isDeleting && isPendingDelete('run', r.id)} class:card-selected={isSelected}>
            <div class="card-header">
              <div class="card-title-row">
                {#if selectMode}
                  <input type="checkbox" class="item-checkbox" checked={isSelected} onchange={() => toggleSelect(key)} />
                {/if}
                <span class="kind-label run-label">run</span>
                <a class="item-name" href="/designs/{r.design_id}/runs/{r.id}">{label}</a>
                <span class={statusBadgeClass(r.status)}>{r.status}</span>
              </div>
              <div class="breadcrumb">
                <a href="/decisions/{r.decision_id}">{r.decision_name}</a>
                <span class="sep">›</span>
                <a href="/designs/{r.design_id}">{r.design_name}</a>
              </div>
            </div>

            <div class="run-stats">
              {#if fmtTps(r.tps)}<span class="stat"><strong>{fmtTps(r.tps)}</strong></span>{/if}
              {#if fmtLatency(r.latency_avg_ms)}<span class="stat">latency <strong>{fmtLatency(r.latency_avg_ms)}</strong></span>{/if}
              {#if dur}<span class="stat stat-dur">⏱ {dur}</span>{/if}
              <span class="stat stat-ts">{fmtTimestamp(r.started_at)}</span>
            </div>

            {#if !selectMode}
              <div class="card-footer">
                <a href="/designs/{r.design_id}/runs/{r.id}" class="footer-link">View run →</a>
                {#if isPendingDelete('run', r.id)}
                  <div class="inline-confirm">
                    <span>Delete "{label}"?</span>
                    <button class="confirm-yes" onclick={confirmDelete} disabled={isDeleting}>
                      {isDeleting ? 'Deleting…' : 'Yes, delete'}
                    </button>
                    <button class="confirm-no" onclick={cancelDelete} disabled={isDeleting}>Cancel</button>
                  </div>
                {:else}
                  <button class="delete-btn" onclick={() => requestDelete('run', r.id, label)}>Delete</button>
                {/if}
              </div>
            {/if}
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
    margin-bottom: 12px;
    flex-wrap: wrap;
  }
  .page-header h1 { margin: 0; font-size: 22px; }

  .filters { display: flex; gap: 8px; margin-left: auto; flex-wrap: wrap; align-items: center; }
  .filters select { width: auto; font-size: 13px; }

  .select-btn {
    font-size: 13px;
    padding: 4px 12px;
    border: 1px solid #ccc;
    border-radius: 4px;
    background: #fff;
    cursor: pointer;
    color: #333;
  }
  .select-btn:hover { background: #f5f5f5; }

  /* Multi-select bar */
  .select-bar {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 12px;
    background: #f0f4ff;
    border: 1px solid #c5d0f0;
    border-radius: 5px;
    font-size: 13px;
    margin-bottom: 12px;
  }
  .select-all-label { display: flex; align-items: center; gap: 6px; cursor: pointer; font-weight: 500; color: #333; }
  .bulk-confirm-text { color: #555; }
  .bulk-delete-btn {
    font-size: 12px;
    color: #cc0000;
    background: none;
    border: 1px solid #cc0000;
    border-radius: 3px;
    padding: 3px 10px;
    cursor: pointer;
  }
  .bulk-delete-btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .bulk-delete-btn:not(:disabled):hover { background: #fff0f0; }
  .cancel-select-btn {
    margin-left: auto;
    font-size: 12px;
    background: none;
    border: 1px solid #ccc;
    border-radius: 3px;
    padding: 3px 10px;
    cursor: pointer;
    color: #555;
  }
  .cancel-select-btn:hover { background: #f5f5f5; }

  /* Empty state */
  .empty { text-align: center; padding: 40px 0; color: #999; }
  .empty p { margin-bottom: 12px; }
  .clear-filters {
    font-size: 13px;
    color: #0066cc;
    background: none;
    border: 1px solid #0066cc;
    border-radius: 3px;
    padding: 4px 12px;
    cursor: pointer;
  }
  .clear-filters:hover { background: #e8f0fe; }

  .timeline { display: flex; flex-direction: column; gap: 10px; }

  .card {
    background: #fff;
    border: 1px solid #e0e0e0;
    border-radius: 6px;
    padding: 14px 16px;
    transition: opacity 0.2s, box-shadow 0.15s;
  }
  .card.dimmed { opacity: 0.5; pointer-events: none; }
  .card.card-selected { box-shadow: 0 0 0 2px #4a7ef5; border-color: #4a7ef5; }
  .suite-card { border-left: 3px solid #6600cc; }
  .series-card { border-left: 3px solid #0066cc; }
  .run-card { border-left: 3px solid #888; }

  .item-checkbox { cursor: pointer; width: 15px; height: 15px; flex-shrink: 0; }

  .card-header { margin-bottom: 6px; }
  .card-title-row { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }

  .kind-label {
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    padding: 1px 5px;
    border-radius: 3px;
    letter-spacing: 0.5px;
    flex-shrink: 0;
  }
  .suite-label { background: #f0e8ff; color: #6600cc; }
  .series-label { background: #e8f0fe; color: #0066cc; }
  .run-label { background: #f0f0f0; color: #555; }

  .item-name {
    font-weight: 600;
    font-size: 14px;
    color: #1a1a1a;
    text-decoration: none;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .item-name:hover { color: #0066cc; text-decoration: underline; }

  .breadcrumb { font-size: 12px; color: #888; display: flex; align-items: center; gap: 4px; }
  .breadcrumb a { color: #888; text-decoration: none; }
  .breadcrumb a:hover { color: #0066cc; }
  .sep { color: #bbb; }

  .design-names { display: flex; flex-wrap: wrap; gap: 4px; margin: 6px 0 4px; }
  .design-chip { font-size: 11px; background: #f0e8ff; color: #6600cc; padding: 2px 7px; border-radius: 10px; }

  .series-meta { font-size: 12px; color: #666; margin-bottom: 8px; }
  .dur-inline { color: #555; }

  .series-runs {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-bottom: 10px;
    padding: 8px 10px;
    background: #f8f8f8;
    border-radius: 4px;
  }
  .series-run-row { display: flex; align-items: center; gap: 8px; font-size: 12px; }
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

  .run-stats { display: flex; align-items: center; gap: 14px; font-size: 13px; color: #555; margin-top: 6px; }
  .stat strong { color: #1a1a1a; }
  .stat-dur { color: #777; font-size: 12px; }
  .stat-ts { margin-left: auto; color: #999; font-size: 12px; font-variant-numeric: tabular-nums; }

  .card-footer {
    display: flex;
    align-items: center;
    gap: 14px;
    padding-top: 8px;
    margin-top: 8px;
    border-top: 1px solid #f0f0f0;
  }
  .footer-link { font-size: 12px; color: #0066cc; text-decoration: none; }
  .footer-link:hover { text-decoration: underline; }
  .footer-ts { font-size: 12px; }

  .inline-confirm {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    color: #555;
  }
  .confirm-yes {
    font-size: 12px;
    background: #cc0000;
    color: #fff;
    border: none;
    border-radius: 3px;
    padding: 3px 10px;
    cursor: pointer;
  }
  .confirm-yes:disabled { opacity: 0.6; cursor: not-allowed; }
  .confirm-no {
    font-size: 12px;
    background: none;
    border: 1px solid #ccc;
    border-radius: 3px;
    padding: 3px 10px;
    cursor: pointer;
    color: #555;
  }
  .delete-btn {
    margin-left: auto;
    font-size: 12px;
    color: #cc0000;
    background: none;
    border: 1px solid transparent;
    border-radius: 3px;
    padding: 2px 8px;
    cursor: pointer;
  }
  .delete-btn:hover { border-color: #cc0000; background: #fff0f0; }

  :global(.badge-pending) { background: #f0f0f0; color: #555; }
</style>
