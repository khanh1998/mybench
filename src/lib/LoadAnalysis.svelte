<script lang="ts">
  import { onMount } from 'svelte';
  import StackedAreaChart from '$lib/StackedAreaChart.svelte';
  import LineChart from '$lib/LineChart.svelte';

  interface RunMeta {
    id: number;
    label: string;
    color: string;
    bench_started_at: string | null;
    post_started_at: string | null;
  }
  let {
    runs,
    phases = ['bench'],
    showPhaseFilter = true
  }: { runs: RunMeta[]; phases?: string[]; showPhaseFilter?: boolean } = $props();

  // ── Types ──────────────────────────────────────────────────────────────────
  interface AasRow     { _collected_at: string; wait_event_type: string; wait_event: string; n: number; }
  interface SessionRow { _collected_at: string; state: string; n: number; }
  interface WaitRow    { wait_event_type: string; wait_event: string; occurrences: number; }
  interface SqlRow     { queryid: string; query_short: string; delta_calls: number; delta_exec_time: number; cache_hit_pct: number | null; delta_blks_read: number; snapshot_count: number; }
  interface LockRow    { _collected_at: string; blocked_pid: number; blocked_query: string; blocked_user: string; blocking_pid: number; blocking_query: string; blocking_user: string; locktype: string; held_mode: string; requested_mode: string; }
  interface TotalAasRow { _collected_at: string; total_active: number; }

  const WAIT_COLORS: Record<string, string> = {
    CPU: '#00b37d', IO: '#0066cc', Lock: '#e6531d',
    LWLock: '#9b36b7', Client: '#cc8800', IPC: '#00aaaa',
    Extension: '#888888', Timeout: '#cc44aa', Activity: '#44aacc',
    BufferPin: '#8b5e3c', Other: '#aaaaaa',
  };
  const STATE_COLORS: Record<string, string> = {
    active: '#0066cc',
    idle: '#cccccc',
    'idle in transaction': '#e6531d',
    'idle in transaction (aborted)': '#ff9900',
    'fastpath function call': '#9b36b7',
    unknown: '#aaaaaa',
  };
  const WAIT_ORDER = ['CPU', 'IO', 'Lock', 'LWLock', 'Client', 'IPC', 'Extension', 'Timeout', 'Activity', 'BufferPin', 'Other'];
  const RUN_COLORS = ['#0066cc', '#e6531d', '#00996b', '#9b36b7', '#cc8800'];

  // ── State ──────────────────────────────────────────────────────────────────
  let localPhases = $state<string[]>(phases);
  let loading = $state(false);

  let aasData    = $state<Record<number, AasRow[]>>({});
  let totalAas   = $state<Record<number, TotalAasRow[]>>({});
  let sessionData= $state<Record<number, SessionRow[]>>({});
  let waitsData  = $state<Record<number, WaitRow[]>>({});
  let sqlData    = $state<Record<number, SqlRow[]>>({});
  let locksData  = $state<Record<number, LockRow[]>>({});
  let hasSql     = $state<Record<number, boolean>>({});

  let sqlSort    = $state<{ col: keyof SqlRow; asc: boolean }>({ col: 'delta_exec_time', asc: false });

  const isCompare = $derived(runs.length > 1);

  // ── Queries ────────────────────────────────────────────────────────────────
  function phaseClause(p: string[]): { clause: string; params: string[] } {
    if (p.length === 0) return { clause: '_phase = ?', params: ['bench'] };
    if (p.length === 1) return { clause: '_phase = ?', params: p };
    return { clause: `_phase IN (${p.map(() => '?').join(', ')})`, params: p };
  }

  async function queryApi(sql: string, params: unknown[]): Promise<{ columns: string[]; rows: Record<string, unknown>[]; error?: string }> {
    try {
      const res = await fetch('/api/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sql, params })
      });
      if (!res.ok) { const t = await res.text(); return { columns: [], rows: [], error: t }; }
      return await res.json();
    } catch (e) {
      return { columns: [], rows: [], error: String(e) };
    }
  }

  function origin(run: RunMeta): number {
    return new Date(run.bench_started_at ?? 0).getTime();
  }

  function toMs(iso: string, org: number): number {
    return new Date(iso).getTime() - org;
  }

  async function loadAll() {
    if (runs.length === 0) return;
    loading = true;
    const p = showPhaseFilter ? localPhases : phases;
    const { clause, params: pParams } = phaseClause(p);

    await Promise.all(runs.map(async (run) => {
      const rid = run.id;

      // AAS: group by type+event for detailed tooltip, aggregate to type for chart stacking
      const aasRes = await queryApi(
        `SELECT _collected_at,
          COALESCE(wait_event_type, 'CPU') as wait_event_type,
          COALESCE(wait_event, 'running') as wait_event,
          COUNT(*) as n
         FROM snap_pg_stat_activity
         WHERE _run_id = ? AND ${clause} AND state = 'active'
         GROUP BY _collected_at, wait_event_type, wait_event ORDER BY _collected_at`,
        [rid, ...pParams]
      );
      aasData = { ...aasData, [rid]: aasRes.error ? [] : (aasRes.rows as unknown as AasRow[]) };

      // Total AAS (for compare overlay)
      const totalRes = await queryApi(
        `SELECT _collected_at, COUNT(*) as total_active
         FROM snap_pg_stat_activity
         WHERE _run_id = ? AND ${clause} AND state = 'active'
         GROUP BY _collected_at ORDER BY _collected_at`,
        [rid, ...pParams]
      );
      totalAas = { ...totalAas, [rid]: totalRes.error ? [] : (totalRes.rows as unknown as TotalAasRow[]) };

      // Session states
      const sessRes = await queryApi(
        `SELECT _collected_at, COALESCE(state,'unknown') as state, COUNT(*) as n
         FROM snap_pg_stat_activity
         WHERE _run_id = ? AND ${clause}
         GROUP BY _collected_at, state ORDER BY _collected_at`,
        [rid, ...pParams]
      );
      sessionData = { ...sessionData, [rid]: sessRes.error ? [] : (sessRes.rows as unknown as SessionRow[]) };

      // Top waits
      const waitsRes = await queryApi(
        `SELECT COALESCE(wait_event_type,'CPU') as wait_event_type,
                COALESCE(wait_event,'running') as wait_event,
                COUNT(*) as occurrences
         FROM snap_pg_stat_activity
         WHERE _run_id = ? AND ${clause} AND state = 'active'
         GROUP BY 1,2 ORDER BY 3 DESC LIMIT 20`,
        [rid, ...pParams]
      );
      waitsData = { ...waitsData, [rid]: waitsRes.error ? [] : (waitsRes.rows as unknown as WaitRow[]) };

      // Top SQL (no phase filter — step-based collection)
      // When only 1 snapshot exists (single collect step), use absolute MAX values.
      // When 2+ snapshots exist, use delta (MAX-MIN) to capture activity during the run.
      const sqlRes = await queryApi(
        `SELECT queryid,
                SUBSTR(query,1,120) as query_short,
                CASE WHEN COUNT(*) > 1
                  THEN MAX(CAST(calls AS REAL)) - MIN(CAST(calls AS REAL))
                  ELSE MAX(CAST(calls AS REAL)) END as delta_calls,
                CASE WHEN COUNT(*) > 1
                  THEN MAX(CAST(total_exec_time AS REAL)) - MIN(CAST(total_exec_time AS REAL))
                  ELSE MAX(CAST(total_exec_time AS REAL)) END as delta_exec_time,
                CASE WHEN (CASE WHEN COUNT(*) > 1
                    THEN MAX(CAST(shared_blks_hit AS REAL)+CAST(shared_blks_read AS REAL)) - MIN(CAST(shared_blks_hit AS REAL)+CAST(shared_blks_read AS REAL))
                    ELSE MAX(CAST(shared_blks_hit AS REAL)+CAST(shared_blks_read AS REAL)) END) > 0
                  THEN ROUND(1.0 * (CASE WHEN COUNT(*) > 1
                    THEN MAX(CAST(shared_blks_hit AS REAL)) - MIN(CAST(shared_blks_hit AS REAL))
                    ELSE MAX(CAST(shared_blks_hit AS REAL)) END) /
                    (CASE WHEN COUNT(*) > 1
                    THEN MAX(CAST(shared_blks_hit AS REAL)+CAST(shared_blks_read AS REAL)) - MIN(CAST(shared_blks_hit AS REAL)+CAST(shared_blks_read AS REAL))
                    ELSE MAX(CAST(shared_blks_hit AS REAL)+CAST(shared_blks_read AS REAL)) END) * 100, 1)
                  ELSE NULL END as cache_hit_pct,
                CASE WHEN COUNT(*) > 1
                  THEN MAX(CAST(shared_blks_read AS REAL)) - MIN(CAST(shared_blks_read AS REAL))
                  ELSE MAX(CAST(shared_blks_read AS REAL)) END as delta_blks_read,
                COUNT(*) as snapshot_count
         FROM snap_pg_stat_statements
         WHERE _run_id = ?
         GROUP BY queryid, query_short
         HAVING delta_exec_time > 0
         ORDER BY delta_exec_time DESC LIMIT 50`,
        [rid]
      );
      hasSql = { ...hasSql, [rid]: !sqlRes.error && sqlRes.rows.length > 0 };
      sqlData = { ...sqlData, [rid]: sqlRes.error ? [] : (sqlRes.rows as unknown as SqlRow[]) };

      // Lock conflicts
      const lockRes = await queryApi(
        `SELECT _collected_at, blocked_pid, blocked_query, blocked_user,
                blocking_pid, blocking_query, blocking_user, locktype, held_mode, requested_mode
         FROM snap_pg_lock_conflicts
         WHERE _run_id = ? AND ${clause}
         ORDER BY _collected_at DESC LIMIT 100`,
        [rid, ...pParams]
      );
      locksData = { ...locksData, [rid]: lockRes.error ? [] : (lockRes.rows as unknown as LockRow[]) };
    }));

    loading = false;
  }

  // ── Chart builders ─────────────────────────────────────────────────────────
  function buildAasSeries(run: RunMeta) {
    const rows = aasData[run.id] ?? [];
    const org = origin(run);
    // Aggregate by type (broad) for stacking
    const byType = new Map<string, Map<number, number>>();
    for (const row of rows) {
      const t = toMs(row._collected_at, org);
      const type = row.wait_event_type ?? 'Other';
      if (!byType.has(type)) byType.set(type, new Map());
      byType.get(type)!.set(t, (byType.get(type)!.get(t) ?? 0) + Number(row.n));
    }
    const types = [...byType.keys()].sort((a, b) => {
      const ai = WAIT_ORDER.indexOf(a), bi = WAIT_ORDER.indexOf(b);
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    });
    return types.map(type => ({
      label: type,
      color: WAIT_COLORS[type] ?? WAIT_COLORS.Other,
      points: [...byType.get(type)!.entries()].map(([t, v]) => ({ t, v })).sort((a, b) => a.t - b.t)
    }));
  }

  function buildAasRawRows(run: RunMeta) {
    const rows = aasData[run.id] ?? [];
    const org = origin(run);
    return rows.map(row => ({
      t: toMs(row._collected_at, org),
      typeKey: row.wait_event_type ?? 'Other',
      eventKey: row.wait_event ?? 'running',
      color: WAIT_COLORS[row.wait_event_type ?? 'Other'] ?? WAIT_COLORS.Other,
      v: Number(row.n)
    }));
  }

  function buildSessionSeries(run: RunMeta) {
    const rows = sessionData[run.id] ?? [];
    const org = origin(run);
    const byState = new Map<string, { t: number; v: number }[]>();
    for (const row of rows) {
      const t = toMs(row._collected_at, org);
      const s = row.state ?? 'unknown';
      if (!byState.has(s)) byState.set(s, []);
      byState.get(s)!.push({ t, v: Number(row.n) });
    }
    const stateOrder = ['active', 'idle', 'idle in transaction', 'idle in transaction (aborted)', 'fastpath function call', 'unknown'];
    const states = [...byState.keys()].sort((a, b) => {
      const ai = stateOrder.indexOf(a), bi = stateOrder.indexOf(b);
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    });
    return states.map(s => ({
      label: s,
      color: STATE_COLORS[s] ?? STATE_COLORS.unknown,
      points: byState.get(s)!
    }));
  }

  function buildSessionRawRows(run: RunMeta) {
    const rows = sessionData[run.id] ?? [];
    const org = origin(run);
    return rows.map(row => ({
      t: toMs(row._collected_at, org),
      typeKey: row.state ?? 'unknown',
      eventKey: row.state ?? 'unknown',
      color: STATE_COLORS[row.state ?? 'unknown'] ?? STATE_COLORS.unknown,
      v: Number(row.n)
    }));
  }

  function buildTotalAasSeries() {
    return runs.map((run, i) => {
      const rows = totalAas[run.id] ?? [];
      const org = origin(run);
      return {
        label: run.label,
        color: run.color || RUN_COLORS[i % RUN_COLORS.length],
        points: rows.map(r => ({ t: toMs(r._collected_at, org), v: Number(r.total_active) }))
      };
    });
  }

  function buildMarkers(run: RunMeta) {
    const markers: { t: number; label: string; color: string }[] = [];
    if (run.bench_started_at) markers.push({ t: 0, label: 'bench', color: '#0066cc' });
    if (run.post_started_at) {
      const org = origin(run);
      markers.push({ t: toMs(run.post_started_at, org), label: 'post', color: '#e6531d' });
    }
    return markers;
  }

  function sortedSql(runId: number): SqlRow[] {
    const rows = sqlData[runId] ?? [];
    return [...rows].sort((a, b) => {
      const av = Number(a[sqlSort.col] ?? 0), bv = Number(b[sqlSort.col] ?? 0);
      return sqlSort.asc ? av - bv : bv - av;
    });
  }

  function fmtMs(ms: number): string {
    if (ms >= 1000) return (ms / 1000).toFixed(1) + 's';
    return ms.toFixed(1) + 'ms';
  }
  function fmtNum(n: number): string {
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return String(Math.round(n));
  }
  function fmtTs(iso: string): string {
    return new Date(iso).toLocaleTimeString();
  }

  function totalExecTime(rows: SqlRow[]): number {
    return rows.reduce((s, r) => s + Number(r.delta_exec_time ?? 0), 0);
  }
  function setSqlSort(col: keyof SqlRow) {
    if (sqlSort.col === col) sqlSort = { col, asc: !sqlSort.asc };
    else sqlSort = { col, asc: false };
  }

  const anyLocks = $derived(runs.some(r => (locksData[r.id] ?? []).length > 0));
  const anySql   = $derived(runs.some(r => hasSql[r.id]));

  // ── Paging ─────────────────────────────────────────────────────────────────
  const PER_PAGE = 10;
  let sqlPage   = $state(0);
  let waitsPage = $state(0);

  function pagedSql(runId: number): SqlRow[] {
    const all = sortedSql(runId);
    return all.slice(sqlPage * PER_PAGE, (sqlPage + 1) * PER_PAGE);
  }
  function sqlPageCount(runId: number) { return Math.ceil(sortedSql(runId).length / PER_PAGE); }

  function pagedWaits(runId: number): WaitRow[] {
    const all = waitsData[runId] ?? [];
    return all.slice(waitsPage * PER_PAGE, (waitsPage + 1) * PER_PAGE);
  }
  function waitsPageCount(runId: number) { return Math.ceil((waitsData[runId] ?? []).length / PER_PAGE); }

  // ── Flamegraph ─────────────────────────────────────────────────────────────
  interface FlameItem { wtype: string; wevent: string; seconds: number; color: string; }
  interface ActiveFlame {
    runId: number; queryId: string; queryShort: string;
    totalExecMs: number; items: FlameItem[]; noData: boolean;
  }
  let activeFlame = $state<ActiveFlame | null>(null);
  let flameLoading = $state(false);

  async function openFlame(run: RunMeta, row: SqlRow) {
    flameLoading = true;
    activeFlame = null;

    // Fetch interval from benchmark_runs
    const intRes = await queryApi(
      `SELECT snapshot_interval_seconds FROM benchmark_runs WHERE id = ?`, [run.id]);
    const intervalSecs = Number((intRes.rows[0] as Record<string, unknown>)?.snapshot_interval_seconds ?? 30);

    // Fetch per-query wait attribution from activity snapshots
    const p = showPhaseFilter ? localPhases : phases;
    const { clause, params: pParams } = phaseClause(p);
    const res = await queryApi(
      `SELECT COALESCE(wait_event_type,'CPU') as wtype,
              COALESCE(wait_event,'running') as wevent,
              COUNT(*) as samples
       FROM snap_pg_stat_activity
       WHERE _run_id = ? AND ${clause}
         AND state = 'active'
         AND CAST(query_id AS TEXT) = CAST(? AS TEXT)
       GROUP BY 1,2 ORDER BY 3 DESC`,
      [run.id, ...pParams, row.queryid]);

    const rawItems = res.rows as { wtype: string; wevent: string; samples: number }[];
    const totalSamples = rawItems.reduce((s, r) => s + Number(r.samples), 0);
    const totalExecMs = Number(row.delta_exec_time ?? 0);

    // Apportion exec time proportionally across wait categories
    const items: FlameItem[] = rawItems.map(r => ({
      wtype: r.wtype,
      wevent: r.wevent,
      seconds: totalSamples > 0
        ? (Number(r.samples) / totalSamples) * totalExecMs / 1000
        : Number(r.samples) * intervalSecs,
      color: WAIT_COLORS[r.wtype] ?? WAIT_COLORS.Other
    })).sort((a, b) => b.seconds - a.seconds);

    activeFlame = {
      runId: run.id,
      queryId: row.queryid,
      queryShort: row.query_short,
      totalExecMs,
      items,
      noData: items.length === 0
    };
    flameLoading = false;
  }

  function flameTotalSeconds(items: FlameItem[]) {
    return items.reduce((s, i) => s + i.seconds, 0);
  }

  // Reset paging when data reloads
  function resetPages() { sqlPage = 0; waitsPage = 0; }

  // ── Effects ────────────────────────────────────────────────────────────────
  $effect(() => {
    // Track runs and phases (external)
    const _ = runs.map(r => r.id).join(',') + '|' + (showPhaseFilter ? localPhases : phases).join(',');
    void _;
    resetPages();
    loadAll();
  });

  onMount(() => { loadAll(); });
</script>

<!-- Phase filter -->
{#if showPhaseFilter}
<div class="phase-filter">
  <span class="phase-label">Phase:</span>
  {#each ['pre','bench','post'] as ph}
    <label class="phase-check">
      <input type="checkbox" checked={localPhases.includes(ph)}
        onchange={e => {
          if ((e.target as HTMLInputElement).checked) localPhases = [...localPhases, ph];
          else localPhases = localPhases.filter(x => x !== ph);
        }} />
      {ph}
    </label>
  {/each}
</div>
{/if}

{#if loading}
  <div class="loading">Loading analysis data…</div>
{/if}

<!-- ── Section 1: Average Active Sessions ───────────────────────────────── -->
<div class="section">
  <h4 class="section-title">Average Active Sessions (AAS)</h4>
  <p class="section-desc">Active sessions at each snapshot, stacked by wait event type. Higher = more database load.</p>

  {#if isCompare}
    <!-- Compare: total AAS overlay -->
    <div style="margin-bottom:12px">
      <LineChart series={buildTotalAasSeries()} title="Total Active Sessions — all runs" originMs={runs[0] ? origin(runs[0]) : null} />
    </div>
    <!-- Per-run stacked breakdown -->
    <div class="chart-grid">
      {#each runs as run}
        {@const series = buildAasSeries(run)}
        {@const rawRows = buildAasRawRows(run)}
        <div>
          <div class="run-label" style="color:{run.color}">{run.label}</div>
          <StackedAreaChart {series} {rawRows} title="AAS by wait type" markers={buildMarkers(run)} originMs={origin(run)} />
        </div>
      {/each}
    </div>
  {:else}
    {#each runs as run}
      {@const series = buildAasSeries(run)}
      {@const rawRows = buildAasRawRows(run)}
      <StackedAreaChart {series} {rawRows} title="AAS by wait type" markers={buildMarkers(run)} originMs={origin(run)} />
    {/each}
  {/if}
</div>

<!-- ── Section 2: Session States ────────────────────────────────────────── -->
<div class="section">
  <h4 class="section-title">Session States</h4>
  <p class="section-desc">All sessions over time by state. "idle in transaction" sessions hold locks and block VACUUM.</p>
  <div class="chart-grid">
    {#each runs as run}
      {@const series = buildSessionSeries(run)}
      {@const rawRows = buildSessionRawRows(run)}
      <div>
        {#if isCompare}<div class="run-label" style="color:{run.color}">{run.label}</div>{/if}
        <StackedAreaChart {series} {rawRows} title="Session states" markers={buildMarkers(run)} originMs={origin(run)} />
      </div>
    {/each}
  </div>
</div>

<!-- ── Section 3: Top Wait Events ───────────────────────────────────────── -->
<div class="section">
  <h4 class="section-title">Top Wait Events</h4>
  <p class="section-desc">Most frequent wait events across active sessions during the bench phase.</p>
  <div class="waits-grid">
    {#each runs as run}
      {@const allRows = waitsData[run.id] ?? []}
      {@const pageRows = pagedWaits(run.id)}
      {@const maxOcc = allRows.length ? Math.max(...allRows.map(r => Number(r.occurrences))) : 1}
      {@const totalPages = waitsPageCount(run.id)}
      <div class="waits-panel">
        {#if isCompare}<div class="run-label" style="color:{run.color}">{run.label}</div>{/if}
        {#if allRows.length === 0}
          <div class="empty">No wait event data</div>
        {:else}
          <table class="data-table">
            <thead>
              <tr><th>Wait Type</th><th>Wait Event</th><th>Count</th><th style="width:120px"></th></tr>
            </thead>
            <tbody>
              {#each pageRows as row}
                {@const occ = Number(row.occurrences)}
                {@const barW = (occ / maxOcc * 100).toFixed(1)}
                {@const color = WAIT_COLORS[row.wait_event_type] ?? WAIT_COLORS.Other}
                <tr>
                  <td><span class="wait-badge" style="background:{color}20;color:{color}">{row.wait_event_type}</span></td>
                  <td>{row.wait_event}</td>
                  <td style="text-align:right;font-variant-numeric:tabular-nums">{fmtNum(occ)}</td>
                  <td><div class="bar-bg"><div class="bar-fill" style="width:{barW}%;background:{color}"></div></div></td>
                </tr>
              {/each}
            </tbody>
          </table>
          {#if totalPages > 1}
            <div class="pager">
              <button disabled={waitsPage === 0} onclick={() => waitsPage--}>‹ Prev</button>
              <span>Page {waitsPage + 1} of {totalPages} &nbsp;·&nbsp; {allRows.length} events</span>
              <button disabled={waitsPage >= totalPages - 1} onclick={() => waitsPage++}>Next ›</button>
            </div>
          {/if}
        {/if}
      </div>
    {/each}
  </div>
</div>

<!-- ── Section 4: Top SQL ────────────────────────────────────────────────── -->
<div class="section">
  <h4 class="section-title">Top SQL</h4>
  {#if !anySql}
    <div class="empty">pg_stat_statements not available — add a <code>pg_stat_statements_collect</code> step to collect query stats.</div>
  {:else}
    {@const isSingleSnapshot = runs.every(r => (sqlData[r.id] ?? [])[0]?.snapshot_count === 1)}
    <p class="section-desc">
      {#if isSingleSnapshot}
        Absolute values from single pg_stat_statements snapshot (add a pre-benchmark collect step for deltas).
      {:else}
        Delta from first to last pg_stat_statements snapshot.
      {/if}
      Click column headers to sort.
    </p>
    <div class="sql-panels">
      {#each runs as run}
        {#if hasSql[run.id]}
          {@const allRows = sortedSql(run.id)}
          {@const pageRows = pagedSql(run.id)}
          {@const totalTime = totalExecTime(sqlData[run.id] ?? [])}
          {@const totalPages = sqlPageCount(run.id)}
          <div class="sql-panel">
            {#if isCompare}<div class="run-label" style="color:{run.color}">{run.label}</div>{/if}
            <table class="data-table sql-table">
              <thead>
                <tr>
                  <th>Query</th>
                  <th class="sortable" onclick={() => setSqlSort('delta_calls')}>
                    Calls {sqlSort.col === 'delta_calls' ? (sqlSort.asc ? '▲' : '▼') : ''}
                  </th>
                  <th class="sortable" onclick={() => setSqlSort('delta_exec_time')}>
                    Total Time {sqlSort.col === 'delta_exec_time' ? (sqlSort.asc ? '▲' : '▼') : ''}
                  </th>
                  <th>% Total</th>
                  <th class="sortable" onclick={() => setSqlSort('cache_hit_pct')}>
                    Cache% {sqlSort.col === 'cache_hit_pct' ? (sqlSort.asc ? '▲' : '▼') : ''}
                  </th>
                  <th class="sortable" onclick={() => setSqlSort('delta_blks_read')}>
                    Blks Read {sqlSort.col === 'delta_blks_read' ? (sqlSort.asc ? '▲' : '▼') : ''}
                  </th>
                  <th title="Wait profile — click to expand">Wait Profile</th>
                </tr>
              </thead>
              <tbody>
                {#each pageRows as row}
                  {@const execTime = Number(row.delta_exec_time ?? 0)}
                  {@const pct = totalTime > 0 ? (execTime / totalTime * 100).toFixed(1) : '0'}
                  <tr>
                    <td class="query-cell" title={row.query_short}>{row.query_short}</td>
                    <td style="text-align:right">{fmtNum(Number(row.delta_calls))}</td>
                    <td style="text-align:right">{fmtMs(execTime)}</td>
                    <td style="text-align:right">
                      <div class="pct-bar-wrap">
                        <div class="pct-bar" style="width:{pct}%"></div>
                        <span>{pct}%</span>
                      </div>
                    </td>
                    <td style="text-align:right">{row.cache_hit_pct != null ? row.cache_hit_pct + '%' : '—'}</td>
                    <td style="text-align:right">{fmtNum(Number(row.delta_blks_read))}</td>
                    <td>
                      <button class="flame-btn" onclick={() => openFlame(run, row)} title="Show wait breakdown">
                        <span class="flame-mini">
                          {#each WAIT_ORDER as wt}
                            <span class="flame-seg" style="background:{WAIT_COLORS[wt] ?? WAIT_COLORS.Other}"></span>
                          {/each}
                        </span>
                        <span class="flame-icon">▦</span>
                      </button>
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
            {#if totalPages > 1}
              <div class="pager">
                <button disabled={sqlPage === 0} onclick={() => sqlPage--}>‹ Prev</button>
                <span>Page {sqlPage + 1} of {totalPages} &nbsp;·&nbsp; {allRows.length} queries</span>
                <button disabled={sqlPage >= totalPages - 1} onclick={() => sqlPage++}>Next ›</button>
              </div>
            {/if}
          </div>
        {/if}
      {/each}
    </div>
  {/if}
</div>

<!-- ── Section 5: Lock Analysis ──────────────────────────────────────────── -->
<div class="section">
  <h4 class="section-title">Lock Analysis</h4>
  {#if !anyLocks}
    <div class="empty">No lock conflicts detected during this run. 🎉</div>
  {:else}
    <p class="section-desc">Blocking pairs captured at each snapshot. Each row is a blocked→blocker relationship at that moment.</p>
    {#each runs as run}
      {@const rows = locksData[run.id] ?? []}
      {#if rows.length > 0}
        <div class="lock-panel">
          {#if isCompare}<div class="run-label" style="color:{run.color}">{run.label} — {rows.length} conflict event(s)</div>{/if}
          <table class="data-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Blocked PID</th>
                <th>Blocked Query</th>
                <th>Blocking PID</th>
                <th>Blocking Query</th>
                <th>Lock Type</th>
                <th>Held Mode</th>
              </tr>
            </thead>
            <tbody>
              {#each rows as row}
                <tr>
                  <td style="white-space:nowrap;font-size:11px">{fmtTs(row._collected_at)}</td>
                  <td>{row.blocked_pid}</td>
                  <td class="query-cell" title={row.blocked_query}>{(row.blocked_query ?? '').substring(0, 60)}</td>
                  <td>{row.blocking_pid}</td>
                  <td class="query-cell" title={row.blocking_query}>{(row.blocking_query ?? '').substring(0, 60)}</td>
                  <td><span class="badge">{row.locktype}</span></td>
                  <td><span class="badge badge-warn">{row.held_mode}</span></td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    {/each}
  {/if}
</div>

<!-- ── Flame Popup ─────────────────────────────────────────────────────────── -->
{#if activeFlame || flameLoading}
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions a11y_no_noninteractive_element_interactions -->
  <div role="dialog" aria-modal="true" class="flame-overlay" onclick={() => activeFlame = null}>
    <div role="document" class="flame-modal" onclick={e => e.stopPropagation()}>
      <div class="flame-modal-header">
        <span class="flame-modal-title">Wait Profile</span>
        <button class="flame-close" onclick={() => activeFlame = null}>✕</button>
      </div>

      {#if flameLoading}
        <div class="flame-loading">Loading wait data…</div>
      {:else if activeFlame}
        <div class="flame-query" title={activeFlame.queryShort}>{activeFlame.queryShort}</div>

        {#if activeFlame.noData}
          <div class="flame-nodata">No activity samples matched this query.<br>
            <small>query_id matching requires PostgreSQL 14+ and pg_stat_activity.query_id.</small>
          </div>
        {:else}
          {@const total = flameTotalSeconds(activeFlame.items)}
          <!-- Stacked horizontal bar -->
          <div class="flame-bar-wrap">
            {#each activeFlame.items as item}
              {@const w = total > 0 ? (item.seconds / total * 100).toFixed(2) : '0'}
              <div class="flame-bar-seg" style="width:{w}%;background:{item.color}" title="{item.wtype}:{item.wevent} {item.seconds.toFixed(2)}s"></div>
            {/each}
          </div>
          <!-- Legend -->
          <div class="flame-legend-title">Legend</div>
          <div class="flame-legend">
            {#each activeFlame.items as item}
              <div class="flame-leg-row">
                <span class="flame-leg-dot" style="background:{item.color}"></span>
                <span class="flame-leg-label">{item.wtype}{item.wevent !== 'running' && item.wevent !== item.wtype ? ':' + item.wevent : ''}</span>
                <span class="flame-leg-val">{item.seconds.toFixed(2)}s</span>
              </div>
            {/each}
          </div>
          <div class="flame-footer">
            Total exec time: {fmtMs(activeFlame.totalExecMs)} &nbsp;·&nbsp;
            Based on {activeFlame.items.reduce((s,i) => s, 0)} activity samples
          </div>
        {/if}
      {/if}
    </div>
  </div>
{/if}

<style>
  .phase-filter { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; flex-wrap: wrap; }
  .phase-label { font-size: 12px; font-weight: 600; color: #555; }
  .phase-check { display: flex; align-items: center; gap: 4px; font-size: 13px; cursor: pointer; }

  .loading { font-size: 13px; color: #888; padding: 8px 0; }

  .section { margin-bottom: 28px; }
  .section-title { font-size: 14px; font-weight: 700; color: #222; margin: 0 0 4px; }
  .section-desc { font-size: 12px; color: #888; margin: 0 0 12px; }

  .run-label { font-size: 12px; font-weight: 600; margin-bottom: 4px; }

  .chart-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 12px; }
  .waits-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 16px; }
  .sql-panels { display: flex; flex-direction: column; gap: 16px; }
  .lock-panel { margin-bottom: 16px; overflow-x: auto; }

  .empty { font-size: 13px; color: #999; padding: 12px 0; }

  .data-table { width: 100%; border-collapse: collapse; font-size: 12px; }
  .data-table th { text-align: left; padding: 5px 8px; background: #f7f7f7; border-bottom: 1px solid #e8e8e8; font-weight: 600; color: #555; white-space: nowrap; }
  .data-table td { padding: 4px 8px; border-bottom: 1px solid #f3f3f3; color: #333; vertical-align: middle; }
  .data-table tr:hover td { background: #fafafa; }

  .sortable { cursor: pointer; user-select: none; }
  .sortable:hover { background: #eef; }

  .sql-table .query-cell { max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: monospace; font-size: 11px; }

  .wait-badge { display: inline-block; padding: 1px 6px; border-radius: 3px; font-size: 11px; font-weight: 600; white-space: nowrap; }
  .badge { display: inline-block; padding: 1px 6px; border-radius: 3px; font-size: 11px; background: #f0f0f0; color: #555; }
  .badge-warn { background: #fff3e0; color: #b84d00; }

  .bar-bg { height: 8px; background: #f0f0f0; border-radius: 4px; overflow: hidden; }
  .bar-fill { height: 100%; border-radius: 4px; transition: width 0.2s; }

  .pct-bar-wrap { display: flex; align-items: center; gap: 6px; min-width: 80px; }
  .pct-bar { height: 8px; background: #0066cc; border-radius: 3px; min-width: 2px; flex-shrink: 0; }

  /* Pager */
  .pager { display: flex; align-items: center; gap: 10px; margin-top: 8px; font-size: 12px; color: #666; }
  .pager button { background: #f5f5f5; border: 1px solid #ddd; border-radius: 4px; padding: 2px 10px; font-size: 12px; cursor: pointer; }
  .pager button:hover:not(:disabled) { background: #e8eeff; border-color: #aac; }
  .pager button:disabled { opacity: 0.35; cursor: not-allowed; }

  /* Flame button in table */
  .flame-btn { background: none; border: 1px solid #e0e0e0; border-radius: 4px; padding: 2px 6px; cursor: pointer; display: flex; align-items: center; gap: 4px; }
  .flame-btn:hover { background: #f0f4ff; border-color: #99b; }
  .flame-mini { display: flex; gap: 1px; width: 40px; height: 10px; border-radius: 2px; overflow: hidden; flex-shrink: 0; }
  .flame-seg { flex: 1; }
  .flame-icon { font-size: 13px; color: #888; }

  /* Flame popup overlay */
  .flame-overlay {
    position: fixed; inset: 0; z-index: 100;
    background: rgba(0,0,0,0.45);
    display: flex; align-items: center; justify-content: center;
  }
  .flame-modal {
    background: #1e1f2e; color: #e0e0e0;
    border: 1px solid #3a3b50; border-radius: 10px;
    padding: 20px 22px; min-width: 320px; max-width: 480px; width: 90%;
    box-shadow: 0 12px 40px rgba(0,0,0,0.5);
  }
  .flame-modal-header { display: flex; align-items: center; margin-bottom: 12px; }
  .flame-modal-title { font-size: 13px; font-weight: 700; color: #e0e0e0; flex: 1; }
  .flame-close { background: none; border: none; color: #9ca3af; font-size: 16px; cursor: pointer; padding: 0 0 0 8px; }
  .flame-close:hover { color: #fff; }
  .flame-query { font-family: monospace; font-size: 11px; color: #9ca3af; margin-bottom: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .flame-loading { font-size: 13px; color: #9ca3af; padding: 12px 0; text-align: center; }
  .flame-nodata { font-size: 12px; color: #9ca3af; padding: 12px 0; line-height: 1.6; }
  .flame-nodata small { font-size: 11px; color: #6b7280; }

  /* Horizontal stacked bar */
  .flame-bar-wrap { display: flex; height: 28px; border-radius: 5px; overflow: hidden; margin-bottom: 16px; gap: 1px; }
  .flame-bar-seg { min-width: 2px; transition: opacity 0.15s; }
  .flame-bar-seg:hover { opacity: 0.75; }

  /* Legend */
  .flame-legend-title { font-size: 11px; font-weight: 600; color: #6b7280; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 6px; }
  .flame-legend { display: flex; flex-direction: column; gap: 4px; }
  .flame-leg-row { display: flex; align-items: center; gap: 8px; }
  .flame-leg-dot { width: 10px; height: 10px; border-radius: 3px; flex-shrink: 0; }
  .flame-leg-label { flex: 1; font-size: 12px; color: #d1d5db; }
  .flame-leg-val { font-size: 12px; font-variant-numeric: tabular-nums; color: #f9fafb; font-weight: 600; min-width: 50px; text-align: right; }
  .flame-footer { font-size: 11px; color: #6b7280; margin-top: 14px; padding-top: 10px; border-top: 1px solid #3a3b50; }
</style>
