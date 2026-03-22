<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/stores';
  import LineChart from '$lib/LineChart.svelte';
  import CodeEditor from '$lib/CodeEditor.svelte';

  const decisionId = $derived(Number($page.params.id));

  interface Design { id: number; name: string; }
  interface Run { id: number; design_id: number; status: string; tps: number|null; latency_avg_ms: number|null; latency_stddev_ms: number|null; transactions: number|null; started_at: string; bench_started_at: string|null; post_started_at: string|null; }
  interface DecisionMetric { id: number; decision_id: number; name: string; category: string; description: string; sql: string; higher_is_better: number; position: number; time_col: string; value_col: string; }
  interface LibraryMetric { id: number; name: string; category: string; description: string; sql: string; is_builtin: number; higher_is_better: number; }
  interface QueryResult { columns: string[]; rows: Record<string, unknown>[]; error?: string; }
  interface ChartPoint { t: number; v: number; }
  interface ChartSeries { label: string; color: string; points: ChartPoint[]; }
  interface SnapTable { name: string; columns: string[]; }


  const COLORS = ['#0066cc', '#e6531d', '#00996b', '#9b36b7', '#cc8800'];
  const CATEGORIES = ['Cache & I/O', 'Access Patterns', 'Write Efficiency', 'Checkpoint & BGWriter', 'Vacuum Health', 'Concurrency', 'Custom'];

  // ── State ────────────────────────────────────────────────────────────────
  let designs: Design[] = $state([]);
  let runsPerDesign: Record<number, Run[]> = $state({});
  let selectedRuns: Record<number, number> = $state({});
  let loading = $state(true);

  let decisionMetrics: DecisionMetric[] = $state([]);
  // per-metric: results per design, view mode, chart columns, table filter, collapsed
  let metricResults: Record<number, Record<number, QueryResult>> = $state({});
  let metricView: Record<number, 'table' | 'chart'> = $state({});
  let metricTimeCol: Record<number, string> = $state({});
  let metricValueCol: Record<number, string> = $state({});
  let metricTableFilter: Record<number, string[]> = $state({});
  let collapsedCategories: Record<string, boolean> = $state({});
  let runningMetricId = $state<number | null>(null);
  let includedPhases = $state<string[]>(['bench']);

  // library picker
  let libraryTemplates: LibraryMetric[] = $state([]);
  let libraryLoaded = false;
  let showLibraryPicker = $state(false);
  let librarySearch = $state('');

  // metric add/edit form
  let editingMetric = $state<Partial<DecisionMetric> & { isNew?: boolean } | null>(null);
  let metricFormError = $state('');
  let metricTestResults: Record<number, QueryResult> = $state({});
  let metricTestRunning = $state(false);

  // snap tables (for metric form autocomplete)
  let snapTables: SnapTable[] = $state([]);

  const snapSchema = $derived(Object.fromEntries(snapTables.map(t => [t.name, t.columns])));
  const selectedRunIds = $derived(Object.values(selectedRuns).filter(Boolean));
  const metricsByCategory = $derived(() => {
    const map: Record<string, DecisionMetric[]> = {};
    for (const m of decisionMetrics) (map[m.category] ??= []).push(m);
    return map;
  });
  const filteredLibrary = $derived(
    librarySearch.trim()
      ? libraryTemplates.filter(t =>
          t.name.toLowerCase().includes(librarySearch.toLowerCase()) ||
          t.category.toLowerCase().includes(librarySearch.toLowerCase()))
      : libraryTemplates
  );

  // ── Helpers ──────────────────────────────────────────────────────────────
  function getDesignName(did: number) { return designs.find(d => d.id === did)?.name ?? `Design ${did}`; }

  async function queryApi(sql: string, params: unknown[]): Promise<QueryResult> {
    const res = await fetch('/api/query', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql, params })
    });
    const data = await res.json();
    if (!res.ok) return { columns: [], rows: [], error: data.message ?? `HTTP ${res.status}` };
    return data as QueryResult;
  }

  function copyCSV(metricId: number) {
    const results = metricResults[metricId];
    if (!results) return;
    const entries = Object.entries(results);
    if (!entries.length) return;
    const cols = entries[0][1].columns;
    const lines = [['design', ...cols].join(',')];
    for (const [did, res] of entries) {
      const name = getDesignName(Number(did));
      for (const row of res.rows) {
        lines.push([JSON.stringify(name), ...cols.map(c => String(row[c] ?? ''))].join(','));
      }
    }
    navigator.clipboard.writeText(lines.join('\n'));
  }

  function getSummary(metricId: number, valueCol: string): { designId: number; avg: number }[] {
    const results = metricResults[metricId];
    if (!results) return [];
    return Object.entries(results).map(([did, res]) => {
      const vals = res.rows.map(r => Number(r[valueCol])).filter(v => !isNaN(v));
      return { designId: Number(did), avg: vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : NaN };
    }).filter(x => !isNaN(x.avg));
  }

  function getWinner(metricId: number, valueCol: string): number | null {
    const metric = decisionMetrics.find((m: DecisionMetric) => m.id === metricId);
    if (!metric) return null;
    const summary = getSummary(metricId, valueCol);
    if (summary.length < 2) return null;
    const [a, b] = summary;
    if (a.avg === b.avg) return null;
    return metric.higher_is_better
      ? (a.avg > b.avg ? a.designId : b.designId)
      : (a.avg < b.avg ? a.designId : b.designId);
  }

  function buildChartSeriesFromResult(
    metricId: number, timeCol: string, valueCol: string
  ): { series: ChartSeries[]; markers: { t: number; label: string; color: string }[] } {
    const results = metricResults[metricId];
    const filter = metricTableFilter[metricId] ?? [];
    const series: ChartSeries[] = [];
    const markers: { t: number; label: string; color: string }[] = [];

    Object.entries(results ?? {}).forEach(([did, res], i) => {
      const designId = Number(did);
      const color = COLORS[i % COLORS.length];
      let rows = res.rows;
      if (filter.length > 0 && res.columns.includes('relname')) {
        rows = rows.filter(r => filter.includes(String(r['relname'])));
      }

      // Use bench_started_at (or started_at) as t=0 so runs align for comparison
      const run = runsPerDesign[designId]?.find(r => r.id === selectedRuns[designId]);
      const originMs = run
        ? new Date(run.bench_started_at ?? run.started_at).getTime()
        : 0;

      // Group by a secondary key if present (relname, indexrelname, state, datname)
      const groupCols = ['relname', 'indexrelname', 'state', 'datname'].filter(c => res.columns.includes(c) && c !== timeCol && c !== valueCol);
      if (groupCols.length > 0) {
        const groupKey = groupCols[0];
        const groups = new Map<string, Record<string, unknown>[]>();
        for (const row of rows) {
          const k = String(row[groupKey] ?? '');
          (groups.get(k) ?? groups.set(k, []).get(k)!).push(row);
        }
        let gi = 0;
        for (const [gk, grows] of groups) {
          const subColor = COLORS[(i + gi) % COLORS.length];
          series.push({
            label: `${getDesignName(designId)} · ${gk}`,
            color: subColor,
            points: grows.map(r => ({ t: new Date(String(r[timeCol])).getTime() - originMs, v: Number(r[valueCol]) })).filter(p => !isNaN(p.t) && !isNaN(p.v))
          });
          gi++;
        }
      } else {
        series.push({
          label: getDesignName(designId),
          color,
          points: rows.map(r => ({ t: new Date(String(r[timeCol])).getTime() - originMs, v: Number(r[valueCol]) })).filter(p => !isNaN(p.t) && !isNaN(p.v))
        });
      }
      // Phase markers (also relative to originMs)
      if (run?.bench_started_at) {
        markers.push({ t: new Date(run.bench_started_at).getTime() - originMs, label: 'bench', color });
      }
      if (run?.post_started_at) {
        markers.push({ t: new Date(run.post_started_at).getTime() - originMs, label: 'post', color });
      }
    });
    return { series, markers };
  }

  // ── Data loading ──────────────────────────────────────────────────────────
  async function load() {
    const [dRes, mRes] = await Promise.all([
      fetch(`/api/designs?decision_id=${decisionId}`),
      fetch(`/api/decisions/${decisionId}/metrics`)
    ]);
    designs = await dRes.json();
    decisionMetrics = await mRes.json();
    // Restore persisted col preferences
    for (const m of decisionMetrics) {
      if (m.time_col) metricTimeCol[m.id] = m.time_col;
      if (m.value_col) metricValueCol[m.id] = m.value_col;
    }

    for (const d of designs) {
      const rRes = await fetch(`/api/runs?design_id=${d.id}`);
      const runs: Run[] = await rRes.json();
      runsPerDesign[d.id] = runs;
      if (runs.length > 0) selectedRuns[d.id] = runs[0].id;
    }
    loading = false;
    loadSnapTables();
    runAllMetrics();
  }

  async function loadSnapTables() {
    const runIds = selectedRunIds.join(',');
    if (!runIds) return;
    const res = await fetch(`/api/snap-tables?run_ids=${runIds}`);
    snapTables = await res.json();
  }

  async function onRunChange() {
    await loadSnapTables();
    runAllMetrics();
  }

  // ── Phase filter ──────────────────────────────────────────────────────────
  function applyPhaseFilter(sql: string): string {
    const phases = includedPhases;
    if (phases.length === 0) return sql;
    const filter = phases.length === 1
      ? `_phase = '${phases[0]}'`
      : `_phase IN (${phases.map(p => `'${p}'`).join(', ')})`;
    return sql.replace(/_phase = 'bench'/g, filter);
  }

  // ── Metrics ───────────────────────────────────────────────────────────────
  async function runMetric(m: DecisionMetric) {
    runningMetricId = m.id;
    metricResults[m.id] = {};
    for (const [did, runId] of Object.entries(selectedRuns)) {
      if (!runId) continue;
      metricResults[m.id][Number(did)] = await queryApi(applyPhaseFilter(m.sql), [runId]);
    }
    metricResults = { ...metricResults };
    // Auto-detect time/value columns (only if not already set)
    const firstRes = Object.values(metricResults[m.id])[0];
    if (firstRes && !metricTimeCol[m.id]) {
      const timeCandidates = firstRes.columns.filter(c => c.includes('at') || c.includes('time'));
      const valueCandidates = firstRes.columns.filter(c => !c.includes('name') && !c.includes('schema') && !c.includes('at') && !c.includes('type') && !timeCandidates.includes(c));
      if (timeCandidates.length) metricTimeCol[m.id] = timeCandidates[0];
      if (valueCandidates.length) metricValueCol[m.id] = valueCandidates[0];
      // Persist auto-detected cols
      if (metricTimeCol[m.id] || metricValueCol[m.id]) {
        persistColPrefs(m, metricTimeCol[m.id] ?? '', metricValueCol[m.id] ?? '');
      }
    }
    runningMetricId = null;
  }

  const colSaveTimers = new Map<number, ReturnType<typeof setTimeout>>();
  function persistColPrefs(m: DecisionMetric, tc: string, vc: string) {
    clearTimeout(colSaveTimers.get(m.id));
    colSaveTimers.set(m.id, setTimeout(() => {
      fetch(`/api/decisions/${decisionId}/metrics/${m.id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...m, time_col: tc, value_col: vc })
      });
      decisionMetrics = decisionMetrics.map(x => x.id === m.id ? { ...x, time_col: tc, value_col: vc } : x);
    }, 600));
  }

  async function runAllMetrics() {
    for (const m of decisionMetrics) await runMetric(m);
  }

  async function openAddMetric() {
    if (!libraryLoaded) {
      const res = await fetch('/api/metrics');
      libraryTemplates = await res.json();
      libraryLoaded = true;
    }
    librarySearch = '';
    showLibraryPicker = true;
  }

  function pickFromLibrary(t: LibraryMetric) {
    editingMetric = { name: t.name, category: t.category, description: t.description, sql: t.sql, higher_is_better: t.higher_is_better, isNew: true };
    metricFormError = '';
    metricTestResults = {};
    showLibraryPicker = false;
  }

  function pickFromScratch() {
    editingMetric = { name: '', category: 'Custom', description: '', sql: `SELECT _collected_at FROM snap_pg_stat_database WHERE _run_id = ?`, higher_is_better: 1, isNew: true };
    metricFormError = '';
    metricTestResults = {};
    showLibraryPicker = false;
  }

  async function saveMetric() {
    if (!editingMetric) return;
    metricFormError = '';
    if (!editingMetric.name?.trim() || !editingMetric.sql?.trim()) {
      metricFormError = 'Name and SQL are required.'; return;
    }
    if (editingMetric.isNew) {
      const res = await fetch(`/api/decisions/${decisionId}/metrics`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(editingMetric)
      });
      if (!res.ok) { metricFormError = (await res.json()).message; return; }
      const m = await res.json() as DecisionMetric;
      decisionMetrics = [...decisionMetrics, m];
      await runMetric(m);
    } else {
      const res = await fetch(`/api/decisions/${decisionId}/metrics/${editingMetric.id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(editingMetric)
      });
      if (!res.ok) { metricFormError = (await res.json()).message; return; }
      const m = await res.json() as DecisionMetric;
      decisionMetrics = decisionMetrics.map(x => x.id === m.id ? m : x);
      await runMetric(m);
    }
    editingMetric = null;
  }

  async function deleteMetric(m: DecisionMetric) {
    await fetch(`/api/decisions/${decisionId}/metrics/${m.id}`, { method: 'DELETE' });
    decisionMetrics = decisionMetrics.filter(x => x.id !== m.id);
    delete metricResults[m.id];
    metricResults = { ...metricResults };
  }

  async function testMetric() {
    if (!editingMetric?.sql?.trim()) return;
    metricTestRunning = true;
    metricTestResults = {};
    for (const [did, runId] of Object.entries(selectedRuns)) {
      if (!runId) continue;
      metricTestResults[Number(did)] = await queryApi(applyPhaseFilter(editingMetric.sql), [runId]);
    }
    metricTestResults = { ...metricTestResults };
    metricTestRunning = false;
  }

  onMount(load);
</script>

<!-- ── Header ──────────────────────────────────────────────────────────── -->
<div class="row" style="margin-bottom:16px">
  <a href="/decisions/{decisionId}" style="color:#0066cc;text-decoration:none">← Decision</a>
  <h1 style="margin-left:8px">Compare Designs</h1>
</div>

{#if loading}
  <p>Loading…</p>
{:else}

<!-- ── Run selector ───────────────────────────────────────────────────── -->
<div class="card">
  <h3>Select Runs to Compare</h3>
  <div class="design-grid">
    {#each designs as d}
      <div class="design-col">
        <strong>{d.name}</strong>
        <select bind:value={selectedRuns[d.id]} onchange={onRunChange}>
          <option value={0}>— none —</option>
          {#each runsPerDesign[d.id] ?? [] as r}
            <option value={r.id}>Run #{r.id} ({r.status}) — {r.started_at?.slice(0,16)}</option>
          {/each}
        </select>
      </div>
    {/each}
  </div>
</div>

<!-- ── pgbench summary ────────────────────────────────────────────────── -->
<div class="card">
  <h3>pgbench Summary</h3>
  <table>
    <thead><tr><th>Design</th><th>Run</th><th>TPS</th><th>Avg Latency (ms)</th><th>Stddev (ms)</th><th>Transactions</th><th>Status</th></tr></thead>
    <tbody>
      {#each designs as d}
        {@const runId = selectedRuns[d.id]}
        {@const run = runsPerDesign[d.id]?.find(r => r.id === runId)}
        <tr>
          <td><strong>{d.name}</strong></td>
          <td>{runId ? `#${runId}` : '—'}</td>
          <td>{run?.tps?.toFixed(2) ?? '—'}</td>
          <td>{run?.latency_avg_ms?.toFixed(3) ?? '—'}</td>
          <td>{run?.latency_stddev_ms?.toFixed(3) ?? '—'}</td>
          <td>{run?.transactions ?? '—'}</td>
          <td>{#if run}<span class="badge badge-{run.status}">{run.status}</span>{:else}—{/if}</td>
        </tr>
      {/each}
    </tbody>
  </table>
</div>

<!-- ── Metrics ────────────────────────────────────────────────────────── -->
<div class="card">
  <div class="row" style="margin-bottom:12px;flex-wrap:wrap;gap:8px">
    <h3>Metrics</h3>
    <span class="spacer"></span>
    <div class="phase-filter">
      <span class="phase-filter-label">Phases:</span>
      {#each ['pre', 'bench', 'post'] as ph}
        <label class="phase-check phase-check-{ph}">
          <input type="checkbox"
            checked={includedPhases.includes(ph)}
            onchange={(e) => {
              const checked = (e.currentTarget as HTMLInputElement).checked;
              includedPhases = checked ? [...includedPhases, ph] : includedPhases.filter(p => p !== ph);
              if (includedPhases.length > 0) runAllMetrics();
            }} />
          {ph}
        </label>
      {/each}
    </div>
    <button onclick={openAddMetric}>+ Add metric</button>
    {#if decisionMetrics.length > 0}<button onclick={runAllMetrics}>↺ Run all</button>{/if}
  </div>

  {#if decisionMetrics.length === 0}
    <div style="text-align:center;padding:32px;color:#999;font-size:13px">
      No metrics added yet. Click <strong>+ Add metric</strong> to start comparing.
    </div>
  {/if}

  {#each CATEGORIES as category}
    {@const catMetrics = metricsByCategory()[category] ?? []}
    {#if catMetrics.length > 0}
      <div class="category-section">
        <button class="category-header" onclick={() => collapsedCategories[category] = !collapsedCategories[category]}>
          <span class="cat-arrow">{collapsedCategories[category] ? '▶' : '▼'}</span>
          {category}
          <span class="cat-count">{catMetrics.length}</span>
        </button>

        {#if !collapsedCategories[category]}
          <div class="metric-cards">
            {#each catMetrics as m}
              {@const res = metricResults[m.id]}
              {@const firstRes = res ? Object.values(res)[0] : null}
              {@const view = metricView[m.id] ?? 'chart'}
              {@const timeCol = metricTimeCol[m.id] ?? ''}
              {@const valueCol = metricValueCol[m.id] ?? ''}
              {@const winner = valueCol ? getWinner(m.id, valueCol) : null}
              {@const summary = valueCol ? getSummary(m.id, valueCol) : []}
              {@const relnames = firstRes?.columns.includes('relname')
                ? [...new Set(Object.values(res!).flatMap(r => r.rows.map(row => String(row['relname'] ?? ''))))]
                : []}
              {@const activeFilter = metricTableFilter[m.id] ?? []}

              <div class="metric-card">
                <!-- card header -->
                <div class="mc-header">
                  <div class="mc-title-row">
                    <span class="mc-name">{m.name}</span>
                    {#if winner !== null}
                      {@const wname = getDesignName(winner)}
                      {@const wcolor = COLORS[designs.findIndex(d => d.id === winner) % COLORS.length]}
                      <span class="winner-badge" style="border-color:{wcolor};color:{wcolor}">▲ {wname}</span>
                    {/if}
                  </div>
                  {#if m.description}<p class="mc-desc">{m.description}</p>{/if}
                  <div class="mc-actions">
                    <button class="icon-btn" onclick={() => runMetric(m)} disabled={runningMetricId === m.id}
                      title="Run">{runningMetricId === m.id ? '…' : '↺'}</button>
                    <button class="icon-btn" onclick={() => { editingMetric = { ...m }; metricFormError = ''; metricTestResults = {}; }} title="Edit">✎</button>
                    <button class="icon-btn danger" onclick={() => deleteMetric(m)} title="Remove">✕</button>
                    <button class="icon-btn" onclick={() => copyCSV(m.id)} title="Copy CSV">⎘ CSV</button>
                    <div class="view-toggle">
                      <button class:active={view === 'table'} onclick={() => metricView[m.id] = 'table'}>Table</button>
                      <button class:active={view === 'chart'} onclick={() => metricView[m.id] = 'chart'}>Chart</button>
                    </div>
                  </div>
                </div>

                {#if res}
                  <!-- table filter -->
                  {#if relnames.length > 0}
                    <div class="table-filter">
                      <span class="filter-label">Tables:</span>
                      {#each relnames as rn}
                        <label class="filter-chip">
                          <input type="checkbox"
                            checked={activeFilter.length === 0 || activeFilter.includes(rn)}
                            onchange={(e) => {
                              const checked = (e.currentTarget as HTMLInputElement).checked;
                              const cur = activeFilter.length === 0 ? [...relnames] : [...activeFilter];
                              metricTableFilter[m.id] = checked ? [...cur, rn] : cur.filter(x => x !== rn);
                            }} />
                          {rn}
                        </label>
                      {/each}
                    </div>
                  {/if}

                  {#if view === 'chart'}
                    <!-- column picker -->
                    <div class="col-picker">
                      <label>Time col:
                        <select value={metricTimeCol[m.id]} onchange={(e) => { metricTimeCol[m.id] = e.currentTarget.value; persistColPrefs(m, e.currentTarget.value, metricValueCol[m.id] ?? ''); }}>
                          {#each firstRes?.columns ?? [] as c}<option selected={c === metricTimeCol[m.id]}>{c}</option>{/each}
                        </select>
                      </label>
                      <label>Value col:
                        <select value={metricValueCol[m.id]} onchange={(e) => { metricValueCol[m.id] = e.currentTarget.value; persistColPrefs(m, metricTimeCol[m.id] ?? '', e.currentTarget.value); }}>
                          {#each firstRes?.columns ?? [] as c}<option selected={c === metricValueCol[m.id]}>{c}</option>{/each}
                        </select>
                      </label>
                    </div>
                    {#if timeCol && valueCol}
                      {@const { series, markers } = buildChartSeriesFromResult(m.id, timeCol, valueCol)}
                      <LineChart title="{m.name} — {valueCol}" {series} {markers} />
                      {#if summary.length >= 2}
                        <div class="summary-row">
                          {#each summary as s, i}
                            <span style="color:{COLORS[i % COLORS.length]}">{getDesignName(s.designId)}: <strong>{s.avg.toFixed(4)}</strong></span>
                          {/each}
                          <span class="delta-pct"
                            class:positive={(summary[0].avg - summary[1].avg) / Math.abs(summary[1].avg) > 0}
                            class:negative={(summary[0].avg - summary[1].avg) / Math.abs(summary[1].avg) < 0}>
                            {((summary[0].avg - summary[1].avg) / Math.abs(summary[1].avg) * 100) > 0 ? '+' : ''}{((summary[0].avg - summary[1].avg) / Math.abs(summary[1].avg) * 100).toFixed(1)}%
                          </span>
                        </div>
                      {/if}
                    {:else}
                      <p style="color:#999;font-size:12px;padding:8px">Select time and value columns above to render chart.</p>
                    {/if}

                  {:else}
                    <!-- table view -->
                    <div class="results-grid">
                      {#each designs as d}
                        {@const r = res[d.id]}
                        <div class="result-col">
                          <div class="result-col-header">{d.name}</div>
                          {#if r?.error}
                            <p class="error">{r.error}</p>
                          {:else if r?.rows?.length > 0}
                            {@const rows = (activeFilter.length > 0 && r.columns.includes('relname'))
                              ? r.rows.filter(row => activeFilter.includes(String(row['relname'] ?? '')))
                              : r.rows}
                            <div class="table-wrap">
                              <table>
                                <thead><tr>{#each r.columns as c}<th>{c}</th>{/each}</tr></thead>
                                <tbody>
                                  {#each rows as row}
                                    <tr>{#each r.columns as c}<td>{row[c] ?? 'NULL'}</td>{/each}</tr>
                                  {/each}
                                </tbody>
                              </table>
                            </div>
                          {:else if r}
                            <p style="color:#999;font-size:12px">No rows</p>
                          {/if}
                        </div>
                      {/each}
                    </div>
                  {/if}
                {:else}
                  <p style="color:#999;font-size:12px;padding:8px 0">Not run yet.</p>
                {/if}
              </div>
            {/each}
          </div>
        {/if}
      </div>
    {/if}
  {/each}
</div>

<!-- ── Library picker modal ───────────────────────────────────────────── -->
{#if showLibraryPicker}
  <div class="modal-backdrop" role="dialog" aria-modal="true" tabindex="-1"
    onclick={(e) => { if (e.target === e.currentTarget) showLibraryPicker = false; }}
    onkeydown={(e) => { if (e.key === 'Escape') showLibraryPicker = false; }}>
    <div class="metric-modal library-modal">
      <div class="metric-modal-header">
        <h3>Add Metric</h3>
        <button class="modal-close" onclick={() => showLibraryPicker = false}>✕</button>
      </div>
      <div class="lib-toolbar">
        <input class="lib-search" placeholder="Search library…" bind:value={librarySearch} />
        <button class="primary" onclick={pickFromScratch}>Start from scratch</button>
      </div>
      {#if filteredLibrary.length === 0}
        <p style="color:#999;font-size:13px;text-align:center;padding:24px 0">No templates match.</p>
      {:else}
        {#each CATEGORIES as category}
          {@const catItems = filteredLibrary.filter(t => t.category === category)}
          {#if catItems.length > 0}
            <div class="lib-cat-header">{category}</div>
            <div class="lib-items">
              {#each catItems as t}
                <button class="lib-item" onclick={() => pickFromLibrary(t)}>
                  <span class="lib-item-name">{t.name}</span>
                  {#if t.description}<span class="lib-item-desc">{t.description}</span>{/if}
                  <span class="lib-item-hint">{t.higher_is_better ? '↑ higher better' : '↓ lower better'}</span>
                </button>
              {/each}
            </div>
          {/if}
        {/each}
      {/if}
    </div>
  </div>
{/if}

<!-- ── Metric form modal ──────────────────────────────────────────────── -->
{#if editingMetric}
  <div class="modal-backdrop" role="dialog" aria-modal="true" tabindex="-1"
    onclick={(e) => { if (e.target === e.currentTarget) { editingMetric = null; metricTestResults = {}; } }}
    onkeydown={(e) => { if (e.key === 'Escape') { editingMetric = null; metricTestResults = {}; } }}>
    <div class="metric-modal">
      <div class="metric-modal-header">
        <h3>{editingMetric.isNew ? 'Add Metric' : 'Edit Metric'}</h3>
        <button class="modal-close" onclick={() => { editingMetric = null; metricTestResults = {}; }}>✕</button>
      </div>

      <div class="row" style="gap:8px;flex-wrap:wrap;margin-bottom:10px">
        <div class="form-group" style="flex:2;min-width:160px">
          <label for="m-name">Name</label>
          <input id="m-name" bind:value={editingMetric.name} placeholder="Buffer hit ratio" />
        </div>
        <div class="form-group" style="flex:1;min-width:130px">
          <label for="m-cat">Category</label>
          <select id="m-cat" bind:value={editingMetric.category}>
            {#each CATEGORIES as c}<option>{c}</option>{/each}
          </select>
        </div>
        <div class="form-group" style="flex:0;min-width:140px">
          <label for="m-hib">Direction</label>
          <select id="m-hib" bind:value={editingMetric.higher_is_better}>
            <option value={1}>Higher is better</option>
            <option value={0}>Lower is better</option>
          </select>
        </div>
      </div>
      <div class="form-group" style="margin-bottom:10px">
        <label for="m-desc">Description</label>
        <input id="m-desc" bind:value={editingMetric.description} placeholder="What this metric shows…" />
      </div>
      <div class="form-group" style="margin-bottom:10px">
        <span class="form-label">SQL <span style="color:#999;font-size:11px">(use ? for _run_id, returns rows from snap_* tables)</span></span>
        <div class="editor-wrap">
          <CodeEditor bind:value={editingMetric.sql!} schema={snapSchema} />
        </div>
      </div>
      {#if metricFormError}<p class="error" style="margin-bottom:8px">{metricFormError}</p>{/if}
      <div class="row" style="gap:8px;margin-bottom:{Object.keys(metricTestResults).length ? '12px' : '0'}">
        <button class="primary" onclick={saveMetric}>Save</button>
        <button onclick={testMetric} disabled={metricTestRunning}>{metricTestRunning ? 'Testing…' : '▶ Test'}</button>
        <button onclick={() => { editingMetric = null; metricTestResults = {}; }}>Cancel</button>
      </div>
      {#if Object.keys(metricTestResults).length > 0}
        <div class="test-results">
          <div class="results-grid">
            {#each designs as d}
              {@const res = metricTestResults[d.id]}
              {#if res}
                <div class="result-col">
                  <div class="result-col-header">{d.name}</div>
                  {#if res.error}
                    <p class="error">{res.error}</p>
                  {:else if res.rows.length > 0}
                    <div class="table-wrap">
                      <table>
                        <thead><tr>{#each res.columns as c}<th>{c}</th>{/each}</tr></thead>
                        <tbody>
                          {#each res.rows.slice(0, 5) as row}
                            <tr>{#each res.columns as c}<td>{row[c] ?? 'NULL'}</td>{/each}</tr>
                          {/each}
                        </tbody>
                      </table>
                    </div>
                    {#if res.rows.length > 5}<p style="font-size:11px;color:#999;margin-top:4px">Showing 5 of {res.rows.length} rows</p>{/if}
                  {:else}
                    <p style="color:#999;font-size:12px">No rows</p>
                  {/if}
                </div>
              {/if}
            {/each}
          </div>
        </div>
      {/if}
    </div>
  </div>
{/if}

{/if}

<style>
  .design-grid { display: flex; gap: 12px; flex-wrap: wrap; }
  .design-col { flex: 1; min-width: 200px; }
  .design-col strong { display: block; margin-bottom: 4px; font-size: 13px; }

  /* metrics */

  .phase-filter { display: flex; align-items: center; gap: 6px; font-size: 12px; }
  .phase-filter-label { font-weight: 600; color: #666; }
  .phase-check { display: flex; align-items: center; gap: 3px; font-weight: 600; cursor: pointer; padding: 2px 6px; border-radius: 10px; }
  .phase-check input { width: auto; }
  .phase-check-pre  { background: #e8f4ff; color: #0055aa; }
  .phase-check-bench { background: #e8fff2; color: #006633; }
  .phase-check-post { background: #fff8e8; color: #885500; }

  .category-section { margin-bottom: 4px; }
  .category-header {
    display: flex; align-items: center; gap: 8px; width: 100%; text-align: left;
    background: none; border: none; border-bottom: 1px solid #eee; padding: 8px 0;
    font-size: 13px; font-weight: 700; color: #333; cursor: pointer;
  }
  .category-header:hover { color: #0066cc; }
  .cat-arrow { font-size: 10px; color: #999; }
  .cat-count { font-size: 11px; font-weight: normal; color: #999; background: #f0f0f0; padding: 1px 6px; border-radius: 10px; }

  .metric-cards { display: flex; flex-direction: column; gap: 10px; padding: 10px 0; }
  .metric-card { border: 1px solid #e8e8e8; border-radius: 6px; padding: 12px; background: #fff; }
  .mc-header { margin-bottom: 8px; }
  .mc-title-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 3px; }
  .mc-name { font-size: 13px; font-weight: 700; color: #222; }
  .mc-desc { font-size: 11px; color: #777; margin: 0 0 6px; }
  .mc-actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.winner-badge { font-size: 11px; font-weight: 700; padding: 1px 8px; border-radius: 10px; border: 1.5px solid; }
  .icon-btn { font-size: 12px; padding: 2px 7px; background: none; border: 1px solid #ddd; border-radius: 3px; cursor: pointer; color: #555; }
  .icon-btn:hover { background: #f5f5f5; }
  .icon-btn.danger:hover { background: #fff0f0; color: #cc3333; border-color: #ffcccc; }
  .view-toggle { display: flex; border: 1px solid #ddd; border-radius: 4px; overflow: hidden; margin-left: 4px; }
  .view-toggle button { font-size: 11px; padding: 2px 8px; background: none; border: none; cursor: pointer; color: #666; }
  .view-toggle button.active { background: #0066cc; color: #fff; }

  .table-filter { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; padding: 6px 8px; background: #f8f8f8; border-radius: 4px; }
  .filter-label { font-size: 11px; font-weight: 600; color: #666; }
  .filter-chip { display: flex; align-items: center; gap: 3px; font-size: 11px; font-family: monospace; cursor: pointer; }
  .filter-chip input { width: auto; }

  .col-picker { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 8px; font-size: 12px; align-items: center; }
  .col-picker label { display: flex; align-items: center; gap: 5px; }
  .col-picker select { font-size: 12px; }

  .summary-row { display: flex; align-items: center; gap: 12px; font-size: 12px; margin-top: 6px; flex-wrap: wrap; }
  .delta-pct { font-weight: 700; }
  .delta-pct.positive { color: #00996b; }
  .delta-pct.negative { color: #cc3333; }

  .results-grid { display: flex; gap: 12px; overflow-x: auto; }
  .result-col { flex: 1; min-width: 200px; }
  .result-col-header { font-weight: 600; font-size: 12px; color: #0066cc; margin-bottom: 6px; }
  .table-wrap { overflow-x: auto; max-height: 300px; overflow-y: auto; }

  /* library picker */
  .library-modal { max-height: 80vh; }
  .lib-toolbar { display: flex; gap: 8px; margin-bottom: 12px; align-items: center; }
  .lib-search { flex: 1; }
  .lib-cat-header { font-size: 11px; font-weight: 700; color: #888; text-transform: uppercase; letter-spacing: 0.05em; margin: 12px 0 4px; }
  .lib-items { display: flex; flex-direction: column; gap: 4px; }
  .lib-item {
    display: flex; flex-direction: column; gap: 2px; text-align: left;
    padding: 8px 10px; border: 1px solid #e8e8e8; border-radius: 5px;
    background: #fff; cursor: pointer; width: 100%;
  }
  .lib-item:hover { background: #f0f6ff; border-color: #0066cc; }
  .lib-item-name { font-size: 13px; font-weight: 600; color: #222; }
  .lib-item-desc { font-size: 11px; color: #777; }
  .lib-item-hint { font-size: 11px; color: #aaa; }

  /* metric modal */
  .modal-backdrop {
    position: fixed; inset: 0; background: rgba(0,0,0,0.45);
    display: flex; align-items: center; justify-content: center; z-index: 1000;
  }
  .metric-modal {
    background: #fff; border-radius: 8px; padding: 24px; width: 700px; max-width: 95vw;
    max-height: 92vh; overflow-y: auto;
    box-shadow: 0 8px 40px rgba(0,0,0,0.22);
  }
  .metric-modal-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
  .metric-modal-header h3 { margin: 0; font-size: 15px; }
  .modal-close { background: none; border: none; font-size: 16px; cursor: pointer; color: #888; padding: 2px 6px; border-radius: 4px; }
  .modal-close:hover { background: #f0f0f0; color: #333; }
  .editor-wrap { position: relative; height: 180px; border-radius: 4px; overflow: hidden; }
  .test-results { border-top: 1px solid #eee; margin-top: 12px; padding-top: 12px; }
</style>
