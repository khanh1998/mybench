<script lang="ts">
  import { onMount } from 'svelte';
  import StackedAreaChart from '$lib/StackedAreaChart.svelte';
  import LineChart from '$lib/LineChart.svelte';
  import { buildLockTree, MAX_LOCK_DEPTH, type LockPairRow, type LockWaitInfo, type LockNode } from '$lib/lock-tree';

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
  interface WaitRow    { wait_event_type: string; wait_event: string; occurrences: number; snapshot_count: number; }
  // queryid stored as CAST(queryid AS TEXT) to avoid JS float64 precision loss on large int64 values
  interface SqlRow {
    queryid: string; query_short: string; query_full: string;
    delta_calls: number; delta_exec_time: number; delta_rows: number;
    cache_hit_pct: number | null; delta_blks_read: number;
    mean_exec_time: number; max_exec_time: number; stddev_exec_time: number;
    total_plan_time: number; delta_temp_blks_read: number; delta_wal_bytes: number;
    snapshot_count: number; bench_secs: number;
  }
  interface ActiveLockNode { node: LockNode; runLabel: string; }
  interface ContentionRow {
    resource: string;
    locktype?: string; // present when granularity = 'all'
    mode?: string;     // present when granularity = 'table+mode' | 'all'
    lock_wait: number; lock_hold: number; pid_wait: number; pid_hold: number;
  }
  interface LockSummaryRow {
    total_held: number; total_waited: number; distinct_pids: number; waiting_pids: number; snapshot_count: number;
  }
  interface LockTimeRow { _collected_at: string; waiting_pids: number; holding_pids: number; }
  interface TotalAasRow { _collected_at: string; total_active: number; }

  // ── Hue-rotation color system ──────────────────────────────────────────────
  // Same type family = same hue arc; each unique event gets a hash-derived step.
  // 10 offsets spaced ≥30° apart guarantee human-visible distinction.
  function _djb2(s: string): number {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = (((h << 5) + h) + s.charCodeAt(i)) >>> 0;
    return h;
  }
  const _TYPE_BASE: Record<string, [number, number, number]> = {
    //              [hue, sat%, lit%]
    CPU:       [155, 85, 36],
    IO:        [210, 88, 42],
    Lock:      [ 15, 82, 46],
    LWLock:    [287, 55, 46],
    Client:    [ 40, 88, 40],
    IPC:       [180, 82, 34],
    Extension: [210, 18, 55],
    Timeout:   [315, 62, 50],
    Activity:  [200, 55, 52],
    BufferPin: [ 27, 42, 38],
    Other:     [220, 12, 60],
  };
  const _HUE_STEPS = [0, 35, 70, 110, 150, 185, 220, 260, 295, 330];
  function getWaitColor(type: string, event: string): string {
    const [h0, s, l] = _TYPE_BASE[type] ?? _TYPE_BASE.Other;
    const step = _HUE_STEPS[_djb2(event) % _HUE_STEPS.length];
    return `hsl(${(h0 + step) % 360},${s}%,${l}%)`;
  }

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
  let locksData  = $state<Record<number, LockPairRow[]>>({});
  let hasSql     = $state<Record<number, boolean>>({});

  let sqlSort    = $state<{ col: keyof SqlRow; asc: boolean }>({ col: 'delta_exec_time', asc: false });
  let sqlMode    = $state<'total' | 'persec'>('total');
  let vcpuCount  = $state<number>(4);

  let expandedLockNodes       = $state<Set<string>>(new Set());
  let activeLockNode          = $state<ActiveLockNode | null>(null);
  let lockSort                = $state<'times_seen' | 'pid'>('times_seen');
  let contentionGranularity   = $state<'all' | 'table' | 'table+mode'>('table+mode');
  let contentionData          = $state<Record<number, ContentionRow[]>>({});
  let lockSummary             = $state<Record<number, LockSummaryRow | null>>({});
  let lockTimeData            = $state<Record<number, LockTimeRow[]>>({});

  function toggleLockNode(key: string) {
    const next = new Set(expandedLockNodes);
    if (next.has(key)) next.delete(key); else next.add(key);
    expandedLockNodes = next;
  }

  function nodeHeat(n: LockNode): number {
    return n.waitInfo?.times_seen ?? n.children.length;
  }
  function sortLockNodes(nodes: LockNode[], by: 'times_seen' | 'pid'): LockNode[] {
    return [...nodes]
      .sort((a, b) => by === 'pid' ? a.pid - b.pid : nodeHeat(b) - nodeHeat(a))
      .map(n => ({ ...n, children: sortLockNodes(n.children, by) }));
  }

  const isCompare = $derived(runs.length > 1);

  // ── Queries ────────────────────────────────────────────────────────────────
  // loadContention is separate so it can be re-run when granularity changes
  async function loadContention() {
    // 'all' uses the summary cards (lockSummary), no per-resource breakdown needed
    if (contentionGranularity === 'all') {
      contentionData = {};
      return;
    }
    const p = showPhaseFilter ? localPhases : phases;
    const { clause, params: pParams } = phaseClause(p);
    const gran = contentionGranularity;
    const extraCols = gran === 'table' ? '' : ', l.mode';
    const groupBy   = gran === 'table' ? 'resource' : 'resource, l.mode';

    await Promise.all(runs.map(async (run) => {
      const rid = run.id;
      const res = await queryApi(
        `SELECT
           CASE l.locktype
             WHEN 'transactionid' THEN 'transaction'
             WHEN 'virtualxid'    THEN 'virtual xid'
             ELSE COALESCE(t.schemaname || '.' || t.relname, l.locktype)
           END as resource
           ${extraCols},
           SUM(CASE WHEN l.granted = 0 THEN 1 ELSE 0 END) as lock_wait,
           SUM(CASE WHEN l.granted = 1 THEN 1 ELSE 0 END) as lock_hold,
           COUNT(DISTINCT CASE WHEN l.granted = 0 THEN l.pid END) as pid_wait,
           COUNT(DISTINCT CASE WHEN l.granted = 1 THEN l.pid END) as pid_hold
         FROM snap_pg_locks l
         LEFT JOIN (
           SELECT DISTINCT relid, schemaname, relname
           FROM snap_pg_stat_user_tables WHERE _run_id = ?
         ) t ON t.relid = l.relation
         WHERE l._run_id = ? AND ${clause.replace(/_phase/g, 'l._phase')}
         GROUP BY ${groupBy}
         HAVING lock_wait > 0
         ORDER BY lock_wait DESC
         LIMIT 30`,
        [rid, rid, ...pParams]
      );
      contentionData = { ...contentionData, [rid]: res.error ? [] : (res.rows as unknown as ContentionRow[]) };
    }));
  }

  $effect(() => {
    contentionGranularity; // track reactive dependency
    if (Object.keys(lockSummary).length > 0) loadContention();
  });

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

      // Top waits — include snapshot_count for AAS = occurrences / snapshot_count
      const waitsRes = await queryApi(
        `SELECT COALESCE(wait_event_type,'CPU') as wait_event_type,
                COALESCE(wait_event,'running') as wait_event,
                COUNT(*) as occurrences,
                COUNT(DISTINCT _collected_at) as snapshot_count
         FROM snap_pg_stat_activity
         WHERE _run_id = ? AND ${clause} AND state = 'active'
         GROUP BY 1,2 ORDER BY 3 DESC LIMIT 20`,
        [rid, ...pParams]
      );
      waitsData = { ...waitsData, [rid]: waitsRes.error ? [] : (waitsRes.rows as unknown as WaitRow[]) };

      // Top SQL (no phase filter — step-based collection)
      // When only 1 snapshot exists (single collect step), use absolute MAX values.
      // When 2+ snapshots exist, use delta (MAX-MIN) to capture activity during the run.
      // bench_secs: derive from run time stored in benchmark_runs if available, fallback 0.
      const sqlRes = await queryApi(
        `WITH snap AS (
           SELECT CAST(queryid AS TEXT) as queryid,
                  query,
                  CAST(calls AS REAL) as calls,
                  CAST(total_exec_time AS REAL) as total_exec_time,
                  CAST(rows AS REAL) as rows,
                  CAST(shared_blks_hit AS REAL) as blks_hit,
                  CAST(shared_blks_read AS REAL) as blks_read,
                  CAST(mean_exec_time AS REAL) as mean_exec_time,
                  CAST(max_exec_time AS REAL) as max_exec_time,
                  CAST(stddev_exec_time AS REAL) as stddev_exec_time,
                  CAST(COALESCE(total_plan_time,0) AS REAL) as total_plan_time,
                  CAST(COALESCE(temp_blks_read,0) AS REAL) as temp_blks_read,
                  CAST(COALESCE(wal_bytes,0) AS REAL) as wal_bytes,
                  _collected_at
           FROM snap_pg_stat_statements WHERE _run_id = ?
         ),
         agg AS (
           SELECT queryid,
                  MAX(query) as query_full,
                  CASE WHEN COUNT(*) > 1 THEN MAX(calls)-MIN(calls) ELSE MAX(calls) END as delta_calls,
                  CASE WHEN COUNT(*) > 1 THEN MAX(total_exec_time)-MIN(total_exec_time) ELSE MAX(total_exec_time) END as delta_exec_time,
                  CASE WHEN COUNT(*) > 1 THEN MAX(rows)-MIN(rows) ELSE MAX(rows) END as delta_rows,
                  CASE WHEN (CASE WHEN COUNT(*) > 1 THEN MAX(blks_hit+blks_read)-MIN(blks_hit+blks_read) ELSE MAX(blks_hit+blks_read) END) > 0
                    THEN ROUND(1.0*(CASE WHEN COUNT(*) > 1 THEN MAX(blks_hit)-MIN(blks_hit) ELSE MAX(blks_hit) END)/
                      (CASE WHEN COUNT(*) > 1 THEN MAX(blks_hit+blks_read)-MIN(blks_hit+blks_read) ELSE MAX(blks_hit+blks_read) END)*100,1)
                    ELSE NULL END as cache_hit_pct,
                  CASE WHEN COUNT(*) > 1 THEN MAX(blks_read)-MIN(blks_read) ELSE MAX(blks_read) END as delta_blks_read,
                  CASE WHEN COUNT(*) > 1 THEN MAX(temp_blks_read)-MIN(temp_blks_read) ELSE MAX(temp_blks_read) END as delta_temp_blks_read,
                  CASE WHEN COUNT(*) > 1 THEN MAX(wal_bytes)-MIN(wal_bytes) ELSE MAX(wal_bytes) END as delta_wal_bytes,
                  MAX(mean_exec_time) as mean_exec_time,
                  MAX(max_exec_time) as max_exec_time,
                  MAX(stddev_exec_time) as stddev_exec_time,
                  MAX(total_plan_time) as total_plan_time,
                  COUNT(*) as snapshot_count,
                  CAST((julianday(MAX(_collected_at))-julianday(MIN(_collected_at)))*86400 AS REAL) as bench_secs
           FROM snap GROUP BY queryid
         )
         SELECT queryid, query_full,
                SUBSTR(query_full,1,120) as query_short,
                delta_calls, delta_exec_time, delta_rows,
                cache_hit_pct, delta_blks_read, delta_temp_blks_read, delta_wal_bytes,
                mean_exec_time, max_exec_time, stddev_exec_time, total_plan_time,
                snapshot_count, bench_secs
         FROM agg WHERE delta_exec_time > 0
         ORDER BY delta_exec_time DESC LIMIT 50`,
        [rid]
      );
      hasSql = { ...hasSql, [rid]: !sqlRes.error && sqlRes.rows.length > 0 };
      sqlData = { ...sqlData, [rid]: sqlRes.error ? [] : (sqlRes.rows as unknown as SqlRow[]) };

      // Lock tree from raw pg_locks snapshots — compute blocking pairs in SQLite
      const lockRes = await queryApi(
        `WITH pairs AS (
           SELECT b.pid as blocked_pid, bl.pid as blocking_pid,
                  b.locktype, b.mode as requested_mode, bl.mode as held_mode,
                  COUNT(*) as times_seen
           FROM snap_pg_locks b
           JOIN snap_pg_locks bl
             ON b._run_id = bl._run_id AND b._collected_at = bl._collected_at
             AND b.locktype = bl.locktype
             AND (b.database = bl.database OR (b.database IS NULL AND bl.database IS NULL))
             AND (b.relation = bl.relation OR (b.relation IS NULL AND bl.relation IS NULL))
             AND (b.page = bl.page OR (b.page IS NULL AND bl.page IS NULL))
             AND (b.tuple = bl.tuple OR (b.tuple IS NULL AND bl.tuple IS NULL))
             AND (b.transactionid = bl.transactionid OR (b.transactionid IS NULL AND bl.transactionid IS NULL))
             AND (b.classid = bl.classid OR (b.classid IS NULL AND bl.classid IS NULL))
             AND (b.objid = bl.objid OR (b.objid IS NULL AND bl.objid IS NULL))
             AND b.pid != bl.pid
             AND b.granted = 0 AND bl.granted = 1
           WHERE b._run_id = ? AND ${clause.replace(/_phase/g, 'b._phase')}
           GROUP BY b.pid, bl.pid, b.locktype, b.mode, bl.mode
         ),
         latest_act AS (
           SELECT pid, query, state,
                  ROW_NUMBER() OVER (PARTITION BY pid ORDER BY _collected_at DESC) as rn
           FROM snap_pg_stat_activity WHERE _run_id = ?
         )
         SELECT p.*,
                ba.query as blocked_query, ba.state as blocked_state,
                bla.query as blocking_query, bla.state as blocking_state
         FROM pairs p
         LEFT JOIN latest_act ba ON ba.pid = p.blocked_pid AND ba.rn = 1
         LEFT JOIN latest_act bla ON bla.pid = p.blocking_pid AND bla.rn = 1
         ORDER BY times_seen DESC
         LIMIT 200`,
        [rid, ...pParams, rid]
      );
      locksData = { ...locksData, [rid]: lockRes.error ? [] : (lockRes.rows as unknown as LockPairRow[]) };

      // Overall lock summary (totals — independent of granularity)
      const summaryRes = await queryApi(
        `SELECT
           SUM(CASE WHEN granted = 1 THEN 1 ELSE 0 END) as total_held,
           SUM(CASE WHEN granted = 0 THEN 1 ELSE 0 END) as total_waited,
           COUNT(DISTINCT pid) as distinct_pids,
           COUNT(DISTINCT CASE WHEN granted = 0 THEN pid END) as waiting_pids,
           COUNT(DISTINCT _collected_at) as snapshot_count
         FROM snap_pg_locks
         WHERE _run_id = ? AND ${clause}`,
        [rid, ...pParams]
      );
      lockSummary = { ...lockSummary, [rid]: (summaryRes.error || !summaryRes.rows[0]) ? null : (summaryRes.rows[0] as unknown as LockSummaryRow) };

      // Lock activity over time (waiting vs holding PIDs per snapshot)
      const lockTimeRes = await queryApi(
        `SELECT _collected_at,
           COUNT(DISTINCT CASE WHEN granted = 0 THEN pid END) as waiting_pids,
           COUNT(DISTINCT CASE WHEN granted = 1 THEN pid END) as holding_pids
         FROM snap_pg_locks
         WHERE _run_id = ? AND ${clause}
         GROUP BY _collected_at ORDER BY _collected_at`,
        [rid, ...pParams]
      );
      lockTimeData = { ...lockTimeData, [rid]: lockTimeRes.error ? [] : (lockTimeRes.rows as unknown as LockTimeRow[]) };
    }));

    await loadContention();
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
      color: getWaitColor(type, type), // canonical color for the type (event=type → step 0)
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
      color: getWaitColor(row.wait_event_type ?? 'Other', row.wait_event ?? 'running'),
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
  function fmtBytes(b: number): string {
    if (b >= 1073741824) return (b / 1073741824).toFixed(1) + ' GB';
    if (b >= 1048576) return (b / 1048576).toFixed(1) + ' MB';
    if (b >= 1024) return (b / 1024).toFixed(1) + ' KB';
    return String(Math.round(b)) + ' B';
  }
  function perSec(val: number, secs: number): string {
    if (!secs) return '—';
    const v = val / secs;
    if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M/s';
    if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K/s';
    return v.toFixed(1) + '/s';
  }
  /** Derive bench duration from RunMeta timestamps (more reliable than SQL delta for single-snapshot runs). */
  function runBenchSecs(run: RunMeta): number {
    if (!run.bench_started_at) return 0;
    const end = run.post_started_at ? new Date(run.post_started_at) : new Date();
    return Math.max((end.getTime() - new Date(run.bench_started_at).getTime()) / 1000, 1);
  }

  function sqlColVal(row: SqlRow, col: string, secs: number): string {
    if (sqlMode === 'persec') {
      if (col === 'delta_calls') return perSec(Number(row.delta_calls), secs);
      if (col === 'delta_exec_time') return perSec(Number(row.delta_exec_time), secs);
      if (col === 'delta_blks_read') return perSec(Number(row.delta_blks_read), secs);
    }
    if (col === 'delta_calls') return fmtNum(Number(row.delta_calls));
    if (col === 'delta_exec_time') return fmtMs(Number(row.delta_exec_time));
    if (col === 'delta_blks_read') return fmtNum(Number(row.delta_blks_read));
    return '—';
  }
  function fmtTs(iso: string): string {
    return new Date(iso).toLocaleTimeString();
  }

  function buildLockTimeSeries(run: RunMeta) {
    const rows = lockTimeData[run.id] ?? [];
    const org = origin(run);
    return [
      { label: 'Waiting PIDs', color: '#d63300', points: rows.map(r => ({ t: toMs(r._collected_at, org), v: Number(r.waiting_pids) })) },
      { label: 'Holding PIDs', color: '#0066cc', points: rows.map(r => ({ t: toMs(r._collected_at, org), v: Number(r.holding_pids) })) }
    ];
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
    runId: number; queryId: string; queryShort: string; queryFull: string;
    totalExecMs: number; items: FlameItem[]; noData: boolean; fallback: boolean;
    // Rich stats from pg_stat_statements
    deltaCalls: number; deltaRows: number; benchSecs: number;
    meanExecMs: number; maxExecMs: number; stddevMs: number;
    totalPlanMs: number; deltaBlksRead: number; deltaTempBlks: number; deltaWalBytes: number;
    cacheHitPct: number | null;
  }
  let activeFlame = $state<ActiveFlame | null>(null);
  let flameLoading = $state(false);

  async function openFlame(run: RunMeta, row: SqlRow) {
    flameLoading = true;
    activeFlame = null;

    const totalExecMs = Number(row.delta_exec_time ?? 0);
    const p = showPhaseFilter ? localPhases : phases;
    const { clause, params: pParams } = phaseClause(p);

    // queryid is already a TEXT string from the SQL query (CAST(queryid AS TEXT))
    // so no float64 precision loss. Compare as text in SQLite.
    const res = await queryApi(
      `SELECT COALESCE(wait_event_type,'CPU') as wtype,
              COALESCE(wait_event,'running') as wevent,
              COUNT(*) as samples
       FROM snap_pg_stat_activity
       WHERE _run_id = ? AND ${clause}
         AND state = 'active'
         AND CAST(query_id AS TEXT) = ?
       GROUP BY 1,2 ORDER BY 3 DESC`,
      [run.id, ...pParams, row.queryid]);

    let rawItems = res.rows as { wtype: string; wevent: string; samples: number }[];
    let fallback = false;

    // If per-query match found nothing, fall back to run-wide wait distribution
    if (rawItems.length === 0) {
      fallback = true;
      const fbRes = await queryApi(
        `SELECT COALESCE(wait_event_type,'CPU') as wtype,
                COALESCE(wait_event,'running') as wevent,
                COUNT(*) as samples
         FROM snap_pg_stat_activity
         WHERE _run_id = ? AND ${clause} AND state = 'active'
         GROUP BY 1,2 ORDER BY 3 DESC`,
        [run.id, ...pParams]);
      rawItems = fbRes.rows as { wtype: string; wevent: string; samples: number }[];
    }

    const totalSamples = rawItems.reduce((s, r) => s + Number(r.samples), 0);

    // Apportion exec time proportionally across wait categories
    const items: FlameItem[] = rawItems.map(r => ({
      wtype: r.wtype,
      wevent: r.wevent,
      seconds: totalSamples > 0
        ? (Number(r.samples) / totalSamples) * totalExecMs / 1000
        : 0,
      color: getWaitColor(r.wtype, r.wevent)
    })).sort((a, b) => b.seconds - a.seconds);

    activeFlame = {
      runId: run.id,
      queryId: row.queryid,
      queryShort: row.query_short,
      queryFull: row.query_full ?? row.query_short,
      totalExecMs,
      items,
      noData: items.length === 0,
      fallback,
      deltaCalls: Number(row.delta_calls ?? 0),
      deltaRows: Number(row.delta_rows ?? 0),
      benchSecs: runBenchSecs(run),
      meanExecMs: Number(row.mean_exec_time ?? 0),
      maxExecMs: Number(row.max_exec_time ?? 0),
      stddevMs: Number(row.stddev_exec_time ?? 0),
      totalPlanMs: Number(row.total_plan_time ?? 0),
      deltaBlksRead: Number(row.delta_blks_read ?? 0),
      deltaTempBlks: Number(row.delta_temp_blks_read ?? 0),
      deltaWalBytes: Number(row.delta_wal_bytes ?? 0),
      cacheHitPct: row.cache_hit_pct != null ? Number(row.cache_hit_pct) : null,
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
        <StackedAreaChart {series} {rawRows} title="Session states" markers={buildMarkers(run)} originMs={origin(run)} showDetailToggle={false} />
      </div>
    {/each}
  </div>
</div>

<!-- ── Section 3: Top Wait Events ───────────────────────────────────────── -->
<div class="section">
  <h4 class="section-title">Top Wait Events</h4>
  <div class="waits-header-row">
    <p class="section-desc" style="margin:0">Most frequent wait events across active sessions. AAS = avg active sessions (bar scaled to vCPU count).</p>
    <label class="vcpu-label">
      vCPUs:
      <input type="number" class="vcpu-input" min="1" max="512" bind:value={vcpuCount} />
    </label>
  </div>
  <div class="waits-grid" style="margin-top:10px">
    {#each runs as run}
      {@const allRows = waitsData[run.id] ?? []}
      {@const pageRows = pagedWaits(run.id)}
      {@const totalSnapshots = allRows.length ? Math.max(...allRows.map(r => Number(r.snapshot_count || 1))) : 1}
      {@const totalPages = waitsPageCount(run.id)}
      <div class="waits-panel">
        {#if isCompare}<div class="run-label" style="color:{run.color}">{run.label}</div>{/if}
        {#if allRows.length === 0}
          <div class="empty">No wait event data</div>
        {:else}
          <table class="data-table">
            <thead>
              <tr>
                <th>Wait Type</th>
                <th>Wait Event</th>
                <th style="text-align:right">Count</th>
                <th style="text-align:right">AAS</th>
                <th style="width:100px" title="Load by waits (AAS), bar scaled to {vcpuCount} vCPUs">Load (AAS/{vcpuCount} vCPU)</th>
              </tr>
            </thead>
            <tbody>
              {#each pageRows as row}
                {@const occ = Number(row.occurrences)}
                {@const snaps = Number(row.snapshot_count || totalSnapshots)}
                {@const aas = snaps > 0 ? occ / snaps : 0}
                {@const barW = Math.min(aas / vcpuCount * 100, 100).toFixed(1)}
                {@const color = getWaitColor(row.wait_event_type, row.wait_event)}
                <tr>
                  <td><span class="wait-badge" style="background:{color}20;color:{color}">{row.wait_event_type}</span></td>
                  <td style="font-family:monospace;font-size:11px">{row.wait_event}</td>
                  <td style="text-align:right;font-variant-numeric:tabular-nums">{fmtNum(occ)}</td>
                  <td style="text-align:right;font-variant-numeric:tabular-nums;color:#555">{aas.toFixed(2)}</td>
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
  <div style="display:flex;align-items:center;gap:12px;margin-bottom:6px;flex-wrap:wrap">
    <h4 class="section-title" style="margin:0">Top SQL</h4>
    <div class="mode-toggle">
      <button class:active={sqlMode === 'total'} onclick={() => sqlMode = 'total'}>Total</button>
      <button class:active={sqlMode === 'persec'} onclick={() => sqlMode = 'persec'}>Per Second</button>
    </div>
  </div>
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
      Click column headers to sort. Click ▦ for wait profile.
    </p>
    <div class="sql-panels">
      {#each runs as run}
        {#if hasSql[run.id]}
          {@const allRows = sortedSql(run.id)}
          {@const pageRows = pagedSql(run.id)}
          {@const totalTime = totalExecTime(sqlData[run.id] ?? [])}
          {@const totalPages = sqlPageCount(run.id)}
          {@const runSecs = runBenchSecs(run)}
          <div class="sql-panel">
            {#if isCompare}<div class="run-label" style="color:{run.color}">{run.label}</div>{/if}
            <table class="data-table sql-table">
              <thead>
                <tr>
                  <th>Query</th>
                  <th class="sortable" onclick={() => setSqlSort('delta_calls')}>
                    {sqlMode === 'persec' ? 'Calls/s' : 'Calls'} {sqlSort.col === 'delta_calls' ? (sqlSort.asc ? '▲' : '▼') : ''}
                  </th>
                  {#if sqlMode === 'total'}
                  <th class="sortable" onclick={() => setSqlSort('delta_exec_time')}>
                    Total Time {sqlSort.col === 'delta_exec_time' ? (sqlSort.asc ? '▲' : '▼') : ''}
                  </th>
                  {:else}
                  <th title="DB time consumed per wall-clock second — higher = more load">DB Load (ms/s)</th>
                  {/if}
                  <th title="Share of total DB execution time">% Total</th>
                  <th class="sortable" onclick={() => setSqlSort('cache_hit_pct')}>
                    Cache% {sqlSort.col === 'cache_hit_pct' ? (sqlSort.asc ? '▲' : '▼') : ''}
                  </th>
                  <th class="sortable" onclick={() => setSqlSort('delta_blks_read')}>
                    {sqlMode === 'persec' ? 'Blks/s' : 'Blks Read'} {sqlSort.col === 'delta_blks_read' ? (sqlSort.asc ? '▲' : '▼') : ''}
                  </th>
                  <th title="Avg latency per call (both modes)">Avg Lat</th>
                  <th title="Wait profile — click to expand">Profile</th>
                </tr>
              </thead>
              <tbody>
                {#each pageRows as row}
                  {@const execTime = Number(row.delta_exec_time ?? 0)}
                  {@const pct = totalTime > 0 ? (execTime / totalTime * 100).toFixed(1) : '0'}
                  <tr>
                    <td class="query-cell" title={row.query_full || row.query_short}>{row.query_short}</td>
                    <td style="text-align:right">{sqlColVal(row, 'delta_calls', runSecs)}</td>
                    <td style="text-align:right">
                      {#if sqlMode === 'persec'}
                        {perSec(Number(row.delta_exec_time), runSecs)}
                      {:else}
                        {fmtMs(Number(row.delta_exec_time))}
                      {/if}
                    </td>
                    <td style="text-align:right;color:#888">{pct}%</td>
                    <td style="text-align:right">{row.cache_hit_pct != null ? row.cache_hit_pct + '%' : '—'}</td>
                    <td style="text-align:right">{sqlColVal(row, 'delta_blks_read', runSecs)}</td>
                    <td style="text-align:right;font-variant-numeric:tabular-nums">{fmtMs(Number(row.mean_exec_time ?? 0))}</td>
                    <td>
                      <button class="flame-btn" onclick={() => openFlame(run, row)} title="Show wait breakdown">
                        <span class="flame-mini">
                          {#each WAIT_ORDER as wt}
                            <span class="flame-seg" style="background:{getWaitColor(wt, wt)}"></span>
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

{#snippet lockNodeRow(node: LockNode, runId: number, depth: number, parentKey: string, idx: number)}
  {@const key = `${parentKey}/${node.pid}`}
  {@const hasChildren = node.children.length > 0}
  {@const isExpanded = expandedLockNodes.has(key)}
  {@const stateBg = node.waitInfo ? '#fee2e2' : node.state === 'active' ? '#dcfce7' : '#fef3c7'}
  {@const stateColor = node.waitInfo ? '#991b1b' : node.state === 'active' ? '#166534' : '#92400e'}
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div
    class="lock-node-row"
    style:padding-left="{depth * 18 + 6}px"
    onclick={() => activeLockNode = { node, runLabel: String(runId) }}
    title="Click for details"
  >
    <!-- level index -->
    <span class="lock-idx">{idx + 1}</span>
    <!-- toggle arrow -->
    <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
    <span
      class="lock-toggle-btn"
      onclick={(e) => { e.stopPropagation(); if (hasChildren) toggleLockNode(key); }}
      style:cursor={hasChildren ? 'pointer' : 'default'}
      style:color={hasChildren ? '#555' : '#ddd'}
    >{#if hasChildren}{isExpanded ? '▼' : '▶'}{:else}·{/if}</span>

    <span class="lock-pid-badge {node.waitInfo ? 'blocked' : 'blocker'}">PID {node.pid}</span>
    <span class="lock-state-badge" style:background={stateBg} style:color={stateColor}>{node.state}</span>

    {#if node.waitInfo}
      <span class="lock-mode-info">
        waiting for <span class="lock-badge">{node.waitInfo.locktype}</span>
        <span class="lock-badge-dim">{node.waitInfo.requested_mode}</span>
        <span class="lock-held-dim">(holds {node.waitInfo.held_mode})</span>
      </span>
      <span class="lock-times-seen" title="snapshots where this conflict was captured">{node.waitInfo.times_seen}×</span>
    {:else if hasChildren}
      <span class="lock-blocking-label">blocking {node.children.length} session(s)</span>
    {/if}

    <div class="lock-node-query">{(node.query ?? '').substring(0, 140)}</div>
  </div>
  {#if isExpanded && hasChildren}
    {#if node.flattened}
      <div class="lock-flat-note" style:padding-left="{(depth + 1) * 18 + 6}px">Deeper nodes flattened to this level ({node.children.length} sessions)</div>
    {/if}
    {#each node.children as child, ci}
      {@render lockNodeRow(child, runId, depth + 1, key, ci)}
    {/each}
  {/if}
{/snippet}

<div class="section">
  <h4 class="section-title">Lock Analysis</h4>
  {#if !anyLocks}
    <div class="empty">No lock conflicts detected during this run. 🎉</div>
  {:else}
    <div class="lock-sort-bar">
      <span class="lock-sort-label">Sort tree:</span>
      <button class="lock-sort-btn" class:active={lockSort === 'times_seen'} onclick={() => lockSort = 'times_seen'}>by duration</button>
      <button class="lock-sort-btn" class:active={lockSort === 'pid'} onclick={() => lockSort = 'pid'}>by PID</button>
    </div>
    {#each runs as run}
      {@const pairs = locksData[run.id] ?? []}
      {@const contention = contentionData[run.id] ?? []}
      {@const summary = lockSummary[run.id] ?? null}
      {#if pairs.length > 0 || contention.length > 0}
        {@const tree = sortLockNodes(buildLockTree(pairs), lockSort)}
        <div class="lock-panel">
          {#if isCompare}<div class="run-label" style="color:{run.color}">{run.label}</div>{/if}

          <!-- Lock activity time-series chart -->
          {#if buildLockTimeSeries(run).some(s => s.points.length > 1)}
            <div style="margin-bottom:12px">
              <LineChart series={buildLockTimeSeries(run)} title="Lock Activity (PIDs over time)" originMs={origin(run)} />
            </div>
          {/if}

          <div class="lock-layout">

            <!-- ── Left: blocking chain tree ── -->
            <div class="lock-chain-col">
              <div class="lock-subsec-title">
                Lock Chain
                <span class="lock-subsec-hint">ordered by {lockSort === 'times_seen' ? 'duration' : 'PID'} · max depth {MAX_LOCK_DEPTH}</span>
              </div>
              <div class="lock-tree">
                {#each tree as root, ri}
                  {@render lockNodeRow(root, run.id, 0, String(run.id), ri)}
                {/each}
              </div>
            </div>

            <!-- ── Right: contention summary ── -->
            <div class="lock-summary-col">
              {#if summary}
                <div class="ct-gran-bar">
                  <span class="lock-sort-label">View:</span>
                  <button class="lock-sort-btn" class:active={contentionGranularity === 'all'} onclick={() => contentionGranularity = 'all'}>Overview</button>
                  <button class="lock-sort-btn" class:active={contentionGranularity === 'table'} onclick={() => contentionGranularity = 'table'}>By Table</button>
                  <button class="lock-sort-btn" class:active={contentionGranularity === 'table+mode'} onclick={() => contentionGranularity = 'table+mode'}>Table + Mode</button>
                </div>

                {#if contentionGranularity === 'all'}
                  <div class="lock-stat-grid">
                    <div class="lsg-cell">
                      <span class="lsg-label">Total Waits</span>
                      <span class="lsg-val lsg-hot">{summary.total_waited}</span>
                    </div>
                    <div class="lsg-cell">
                      <span class="lsg-label">Total Held</span>
                      <span class="lsg-val">{summary.total_held}</span>
                    </div>
                    <div class="lsg-cell">
                      <span class="lsg-label">Waiting PIDs</span>
                      <span class="lsg-val lsg-hot">{summary.waiting_pids}</span>
                    </div>
                    <div class="lsg-cell">
                      <span class="lsg-label">All PIDs</span>
                      <span class="lsg-val">{summary.distinct_pids}</span>
                    </div>
                    <div class="lsg-cell" style="grid-column:span 2">
                      <span class="lsg-label">Contention Rate</span>
                      <span class="lsg-val">{summary.total_held + summary.total_waited > 0 ? Math.round(summary.total_waited / (summary.total_held + summary.total_waited) * 100) : 0}% of lock observations were waits</span>
                    </div>
                  </div>
                {:else if contention.length > 0}
                  <div class="ct-table">
                    <div class="ct-header" class:ct-has-mode={contentionGranularity === 'table+mode'}>
                      <span>Resource</span>
                      {#if contentionGranularity === 'table+mode'}<span>Mode</span>{/if}
                      <span title="Lock wait observations">Wait</span>
                      <span title="Lock held observations">Hold</span>
                      <span title="Distinct PIDs waiting">PIDs Wait</span>
                      <span title="Distinct PIDs holding">PIDs Hold</span>
                    </div>
                    {#each contention as r}
                      <div class="ct-row" class:ct-has-mode={contentionGranularity === 'table+mode'}>
                        <span class="ct-resource"><span class="ct-resname">{r.resource}</span></span>
                        {#if contentionGranularity === 'table+mode'}<span class="ct-mode">{r.mode ?? '—'}</span>{/if}
                        <span class="ct-waited-num">{r.lock_wait}</span>
                        <span class="ct-held-num">{r.lock_hold}</span>
                        <span class="ct-pids-num ct-pids-wait">{r.pid_wait}</span>
                        <span class="ct-pids-num">{r.pid_hold}</span>
                      </div>
                    {/each}
                  </div>
                {:else}
                  <div class="empty" style="font-size:11px">Loading breakdown…</div>
                {/if}
              {/if}
            </div>

          </div>
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
        <!-- Full query text, scrollable -->
        <div class="flame-query-full">{activeFlame.queryFull}</div>

        <!-- Rich stats grid -->
        {@const secs = activeFlame.benchSecs}
        <div class="flame-stats-grid">
          <div class="fsg-cell">
            <span class="fsg-label">Calls</span>
            <span class="fsg-val">{fmtNum(activeFlame.deltaCalls)}</span>
          </div>
          <div class="fsg-cell">
            <span class="fsg-label">Calls/sec</span>
            <span class="fsg-val">{perSec(activeFlame.deltaCalls, secs)}</span>
          </div>
          <div class="fsg-cell">
            <span class="fsg-label">Avg Latency</span>
            <span class="fsg-val">{fmtMs(activeFlame.meanExecMs)}</span>
          </div>
          <div class="fsg-cell">
            <span class="fsg-label">Max Latency</span>
            <span class="fsg-val">{fmtMs(activeFlame.maxExecMs)}</span>
          </div>
          <div class="fsg-cell">
            <span class="fsg-label">Rows</span>
            <span class="fsg-val">{fmtNum(activeFlame.deltaRows)}</span>
          </div>
          <div class="fsg-cell">
            <span class="fsg-label">Rows/sec</span>
            <span class="fsg-val">{perSec(activeFlame.deltaRows, secs)}</span>
          </div>
          <div class="fsg-cell">
            <span class="fsg-label">Cache Hit</span>
            <span class="fsg-val">{activeFlame.cacheHitPct != null ? activeFlame.cacheHitPct + '%' : '—'}</span>
          </div>
          <div class="fsg-cell">
            <span class="fsg-label">Blks Read</span>
            <span class="fsg-val">{fmtNum(activeFlame.deltaBlksRead)}</span>
          </div>
          <div class="fsg-cell">
            <span class="fsg-label">Stddev</span>
            <span class="fsg-val">{fmtMs(activeFlame.stddevMs)}</span>
          </div>
          <div class="fsg-cell">
            <span class="fsg-label">Plan Time</span>
            <span class="fsg-val">{activeFlame.totalPlanMs > 0 ? fmtMs(activeFlame.totalPlanMs) : '—'}</span>
          </div>
          <div class="fsg-cell">
            <span class="fsg-label">Temp Spill</span>
            <span class="fsg-val">{activeFlame.deltaTempBlks > 0 ? fmtNum(activeFlame.deltaTempBlks) + ' blks' : 'none'}</span>
          </div>
          <div class="fsg-cell">
            <span class="fsg-label">WAL Bytes</span>
            <span class="fsg-val">{activeFlame.deltaWalBytes > 0 ? fmtBytes(activeFlame.deltaWalBytes) : '—'}</span>
          </div>
        </div>

        {#if activeFlame.noData}
          <div class="flame-nodata">No activity samples found for this run.</div>
        {:else}
          {#if activeFlame.fallback}
            <div class="flame-notice">⚠ Query not captured in activity snapshots — showing run-wide wait distribution instead.</div>
          {/if}
          {@const total = flameTotalSeconds(activeFlame.items)}
          <!-- Stacked horizontal bar -->
          <div class="flame-bar-wrap">
            {#each activeFlame.items as item}
              {@const w = total > 0 ? (item.seconds / total * 100).toFixed(2) : '0'}
              <div class="flame-bar-seg" style="width:{w}%;background:{item.color}" title="{item.wtype}:{item.wevent} {item.seconds.toFixed(2)}s"></div>
            {/each}
          </div>
          <!-- Legend -->
          {@const flameSecs = activeFlame.benchSecs}
          <div class="flame-legend-title">
            Wait Profile
            <span class="flame-mode-btns">
              <button class:active={sqlMode === 'total'} onclick={() => sqlMode = 'total'}>Total</button>
              <button class:active={sqlMode === 'persec'} onclick={() => sqlMode = 'persec'}>Per sec</button>
            </span>
          </div>
          <div class="flame-legend">
            {#each activeFlame.items as item}
              {@const pct = total > 0 ? (item.seconds / total * 100).toFixed(0) : '0'}
              <div class="flame-leg-row">
                <span class="flame-leg-dot" style="background:{item.color}"></span>
                <span class="flame-leg-label">{item.wtype}{item.wevent !== 'running' && item.wevent !== item.wtype ? ':' + item.wevent : ''}</span>
                <span class="flame-leg-pct">{pct}%</span>
                <span class="flame-leg-val">
                  {#if sqlMode === 'persec' && flameSecs > 0}
                    {(item.seconds / flameSecs).toFixed(3)}s/s
                  {:else}
                    {item.seconds.toFixed(2)}s
                  {/if}
                </span>
              </div>
            {/each}
          </div>
          <div class="flame-footer">
            Total exec time: {fmtMs(activeFlame.totalExecMs)}
            {#if sqlMode === 'persec' && flameSecs > 0}
              &nbsp;·&nbsp; {(activeFlame.totalExecMs / 1000 / flameSecs).toFixed(3)}s/s
            {/if}
          </div>
        {/if}
      {/if}
    </div>
  </div>
{/if}

<!-- ── Lock Detail Popup ─────────────────────────────────────────────────── -->
{#if activeLockNode}
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions a11y_no_noninteractive_element_interactions -->
  <div role="dialog" aria-modal="true" class="flame-overlay" onclick={() => activeLockNode = null}>
    <div role="document" class="lock-detail-modal" onclick={e => e.stopPropagation()}>
      <div class="flame-modal-header">
        <span class="flame-modal-title">Lock Detail — PID {activeLockNode.node.pid}</span>
        <button class="flame-close" onclick={() => activeLockNode = null}>✕</button>
      </div>
      <div class="lock-detail-grid">
        <div class="ldg-row"><span class="ldg-label">PID</span><span class="ldg-val">{activeLockNode.node.pid}</span></div>
        <div class="ldg-row"><span class="ldg-label">State</span><span class="ldg-val">{activeLockNode.node.state}</span></div>
        {#if activeLockNode.node.waitInfo}
          <div class="ldg-row"><span class="ldg-label">Lock Type</span><span class="ldg-val">{activeLockNode.node.waitInfo.locktype}</span></div>
          <div class="ldg-row"><span class="ldg-label">Requested Mode</span><span class="ldg-val">{activeLockNode.node.waitInfo.requested_mode}</span></div>
          <div class="ldg-row"><span class="ldg-label">Held Mode (blocker)</span><span class="ldg-val">{activeLockNode.node.waitInfo.held_mode}</span></div>
          <div class="ldg-row"><span class="ldg-label">Times Seen</span><span class="ldg-val">{activeLockNode.node.waitInfo.times_seen}× across snapshots</span></div>
        {:else}
          <div class="ldg-row"><span class="ldg-label">Role</span><span class="ldg-val">Root blocker</span></div>
        {/if}
        <div class="ldg-row"><span class="ldg-label">Blocking</span><span class="ldg-val">{activeLockNode.node.children.length} direct session(s)</span></div>
      </div>
      <div class="ldg-label" style="margin: 8px 0 4px">Full Query</div>
      <div class="flame-query-full">{activeLockNode.node.query}</div>
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
  /* ── Lock sort bar ── */
  .lock-sort-bar { display: flex; align-items: center; gap: 6px; margin-bottom: 12px; }
  .lock-sort-label { font-size: 11px; color: #888; }
  .lock-sort-btn { background: none; border: 1px solid #ddd; border-radius: 3px; padding: 2px 10px; font-size: 11px; cursor: pointer; color: #555; }
  .lock-sort-btn:hover { background: #f0f4ff; }
  .lock-sort-btn.active { background: #0066cc; color: #fff; border-color: #0066cc; }

  /* ── Lock layout: tree left, summary right ── */
  .lock-panel { margin-bottom: 16px; }
  .lock-layout { display: flex; gap: 20px; align-items: flex-start; flex-wrap: wrap; }
  .lock-chain-col { flex: 1.6; min-width: 260px; }
  .lock-summary-col { flex: 1; min-width: 260px; }
  .lock-subsec-title { font-size: 12px; font-weight: 700; color: #333; margin-bottom: 8px; }
  .lock-subsec-hint { font-size: 10px; color: #aaa; font-weight: normal; margin-left: 6px; }

  /* ── Tree rows ── */
  .lock-tree { border: 1px solid #e8e8e8; border-radius: 6px; overflow: hidden; }
  .lock-node-row {
    display: flex; align-items: flex-start; gap: 6px; flex-wrap: wrap;
    padding: 5px 10px 5px 6px;
    border-bottom: 1px solid #f3f3f3;
    cursor: pointer;
    transition: background 0.1s;
  }
  .lock-node-row:last-child { border-bottom: none; }
  .lock-node-row:hover { background: #f0f4ff; }
  .lock-idx { font-size: 9px; color: #ccc; font-family: monospace; min-width: 14px; text-align: right; flex-shrink: 0; margin-top: 3px; }
  .lock-toggle-btn { flex-shrink: 0; font-size: 10px; width: 14px; text-align: center; margin-top: 2px; user-select: none; }
  .lock-blocking-label { font-size: 11px; color: #888; }
  .lock-node-query { flex-basis: 100%; font-family: monospace; font-size: 10px; color: #888; padding: 1px 0 0 34px; white-space: pre-wrap; word-break: break-all; }
  .lock-flat-note { font-size: 10px; color: #b45309; background: #fef3c7; padding: 2px 8px; border-bottom: 1px solid #e8e8e8; }
  .lock-mode-info { font-size: 11px; color: #555; display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
  .lock-held-dim { font-size: 10px; color: #999; }
  .lock-times-seen { font-size: 10px; color: #0066cc; font-weight: 600; margin-left: auto; white-space: nowrap; }
  .lock-pid-badge { display: inline-block; padding: 1px 6px; border-radius: 3px; font-size: 11px; font-weight: 700; font-family: monospace; flex-shrink: 0; }
  .lock-pid-badge.blocker { background: #e8eeff; color: #0044bb; }
  .lock-pid-badge.blocked { background: #fee2e2; color: #991b1b; }
  .lock-state-badge { display: inline-block; padding: 1px 5px; border-radius: 3px; font-size: 10px; font-weight: 600; flex-shrink: 0; }
  .lock-badge { display: inline-block; padding: 1px 5px; border-radius: 3px; font-size: 10px; background: #f0f0f0; color: #555; font-weight: 600; }
  .lock-badge-dim { display: inline-block; padding: 1px 5px; border-radius: 3px; font-size: 10px; background: #fff3e0; color: #b84d00; font-weight: 600; }

  /* ── Contention overview stats grid ── */
  .lock-stat-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 5px; margin-bottom: 4px; }
  .lsg-cell { background: #f7f7f7; border: 1px solid #ececec; border-radius: 5px; padding: 6px 9px; display: flex; flex-direction: column; gap: 2px; }
  .lsg-label { font-size: 10px; color: #999; text-transform: uppercase; letter-spacing: 0.03em; }
  .lsg-val { font-size: 15px; font-weight: 700; color: #222; font-variant-numeric: tabular-nums; }
  .lsg-val.lsg-hot { color: #cc2200; }

  /* ── Granularity toggle ── */
  .ct-gran-bar { display: flex; align-items: center; gap: 6px; margin: 10px 0 6px; }

  /* ── Contention table — columns vary by granularity ── */
  .ct-table { font-size: 11px; border: 1px solid #e8e8e8; border-radius: 5px; overflow: hidden; }
  /* base: by-table — resource | wait | hold | pid_wait | pid_hold */
  .ct-header,
  .ct-row {
    display: grid;
    grid-template-columns: 2.4fr 1fr 0.8fr 0.8fr 0.8fr;
    gap: 4px; padding: 4px 6px; align-items: center;
  }
  /* table+mode — add mode column */
  .ct-header.ct-has-mode,
  .ct-row.ct-has-mode {
    grid-template-columns: 2fr 1.4fr 1fr 0.8fr 0.8fr 0.8fr;
  }
  .ct-header { background: #f7f7f7; font-weight: 600; color: #666; border-bottom: 1px solid #e8e8e8; }
  .ct-row { border-bottom: 1px solid #f3f3f3; }
  .ct-row:last-child { border-bottom: none; }
  .ct-row:hover { background: #fafafa; }
  .ct-resource { display: flex; align-items: center; gap: 4px; min-width: 0; }
  .ct-resname { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #333; font-family: monospace; font-size: 10px; font-weight: 600; }
  .ct-type { display: flex; }
  .ct-mode { color: #555; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 10px; }
  .ct-waited-cell { display: flex; align-items: center; gap: 4px; }
  .ct-bar-bg { flex: 1; height: 6px; background: #f0f0f0; border-radius: 3px; overflow: hidden; min-width: 16px; }
  .ct-bar { height: 100%; background: #d63300; border-radius: 3px; }
  .ct-waited-num { color: #cc2200; font-weight: 700; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .ct-held-num { color: #666; font-variant-numeric: tabular-nums; }
  .ct-pids-num { color: #888; text-align: center; font-variant-numeric: tabular-nums; }
  .ct-pids-wait { color: #cc2200; font-weight: 600; }

  /* Lock detail modal */
  .lock-detail-modal {
    background: #1e1f2e; color: #e0e0e0;
    border: 1px solid #3a3b50; border-radius: 10px;
    padding: 20px 22px; min-width: 340px; max-width: 520px; width: 95%;
    max-height: 80vh; overflow-y: auto;
    box-shadow: 0 12px 40px rgba(0,0,0,0.5);
  }
  .lock-detail-grid { display: flex; flex-direction: column; gap: 4px; margin-bottom: 10px; }
  .ldg-row { display: flex; gap: 8px; align-items: baseline; font-size: 12px; }
  .ldg-label { color: #6b7280; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; min-width: 130px; flex-shrink: 0; }
  .ldg-val { color: #e0e0e0; font-family: monospace; font-size: 12px; }

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

  /* Waits header row (desc + vCPU input) */
  .waits-header-row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  .vcpu-label { display: flex; align-items: center; gap: 5px; font-size: 12px; color: #555; white-space: nowrap; margin-left: auto; }
  .vcpu-input { width: 52px; padding: 2px 6px; border: 1px solid #ddd; border-radius: 4px; font-size: 12px; text-align: right; }

  /* SQL mode toggle */
  .mode-toggle { display: flex; border: 1px solid #e0e0e0; border-radius: 4px; overflow: hidden; flex-shrink: 0; }
  .mode-toggle button { background: none; border: none; padding: 3px 10px; font-size: 12px; cursor: pointer; color: #666; }
  .mode-toggle button:hover { background: #f5f5f5; }
  .mode-toggle button.active { background: #0066cc; color: #fff; }

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
    padding: 20px 22px; min-width: 360px; max-width: 580px; width: 95%;
    max-height: 85vh; overflow-y: auto;
    box-shadow: 0 12px 40px rgba(0,0,0,0.5);
  }
  .flame-modal-header { display: flex; align-items: center; margin-bottom: 12px; }
  .flame-modal-title { font-size: 13px; font-weight: 700; color: #e0e0e0; flex: 1; }
  .flame-close { background: none; border: none; color: #9ca3af; font-size: 16px; cursor: pointer; padding: 0 0 0 8px; }
  .flame-close:hover { color: #fff; }
  .flame-query-full {
    font-family: monospace; font-size: 11px; color: #c4cad6;
    background: #13141e; border: 1px solid #2e3048; border-radius: 5px;
    padding: 8px 10px; margin-bottom: 12px;
    max-height: 120px; overflow-y: auto;
    white-space: pre-wrap; word-break: break-word; line-height: 1.5;
  }
  .flame-stats-grid {
    display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; margin-bottom: 14px;
  }
  .fsg-cell {
    background: #13141e; border: 1px solid #2e3048; border-radius: 5px;
    padding: 5px 8px; display: flex; flex-direction: column; gap: 2px;
  }
  .fsg-label { font-size: 9px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.04em; }
  .fsg-val { font-size: 12px; font-weight: 600; color: #e0e0e0; font-variant-numeric: tabular-nums; }
  .flame-loading { font-size: 13px; color: #9ca3af; padding: 12px 0; text-align: center; }
  .flame-nodata { font-size: 12px; color: #9ca3af; padding: 12px 0; line-height: 1.6; }
  .flame-notice { font-size: 11px; color: #f59e0b; background: #2d2a1e; border: 1px solid #78500a; border-radius: 5px; padding: 6px 9px; margin-bottom: 12px; line-height: 1.5; }

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
  .flame-leg-pct { font-size: 10px; color: #9ca3af; font-variant-numeric: tabular-nums; min-width: 30px; text-align: right; }
  .flame-leg-val { font-size: 12px; font-variant-numeric: tabular-nums; color: #f9fafb; font-weight: 600; min-width: 60px; text-align: right; }
  .flame-legend-title { display: flex; align-items: center; gap: 8px; }
  .flame-mode-btns { display: flex; border: 1px solid #3a3b50; border-radius: 4px; overflow: hidden; margin-left: auto; }
  .flame-mode-btns button { background: none; border: none; padding: 2px 8px; font-size: 10px; cursor: pointer; color: #9ca3af; }
  .flame-mode-btns button.active { background: #3a3b50; color: #e0e0e0; }
  .flame-footer { font-size: 11px; color: #6b7280; margin-top: 14px; padding-top: 10px; border-top: 1px solid #3a3b50; }
</style>
