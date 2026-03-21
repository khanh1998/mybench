<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/stores';
  import LineChart from '$lib/LineChart.svelte';
  import CodeEditor from '$lib/CodeEditor.svelte';

  const decisionId = $derived(Number($page.params.id));

  interface Design { id: number; name: string; }
  interface Run { id: number; design_id: number; status: string; tps: number|null; latency_avg_ms: number|null; latency_stddev_ms: number|null; transactions: number|null; started_at: string; bench_started_at: string|null; post_started_at: string|null; }
  interface Metric { id: number; name: string; category: string; description: string; sql: string; is_builtin: number; higher_is_better: number; }
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

  let metrics: Metric[] = $state([]);
  // per-metric: results per design, view mode, chart columns, table filter, collapsed
  let metricResults: Record<number, Record<number, QueryResult>> = $state({});
  let metricView: Record<number, 'table' | 'chart'> = $state({});
  let metricTimeCol: Record<number, string> = $state({});
  let metricValueCol: Record<number, string> = $state({});
  let metricTableFilter: Record<number, string[]> = $state({});
  let collapsedCategories: Record<string, boolean> = $state({});
  let deltaMode = $state(true);
  let runningMetricId = $state<number | null>(null);

  // metric CRUD form
  let editingMetric = $state<Partial<Metric> & { isNew?: boolean } | null>(null);
  let metricFormError = $state('');
  let metricTestResults: Record<number, QueryResult> = $state({});
  let metricTestRunning = $state(false);

  // snap tables (for metric form autocomplete)
  let snapTables: SnapTable[] = $state([]);

  const snapSchema = $derived(Object.fromEntries(snapTables.map(t => [t.name, t.columns])));
  const selectedRunIds = $derived(Object.values(selectedRuns).filter(Boolean));
  const metricsByCategory = $derived(() => {
    const map: Record<string, Metric[]> = {};
    for (const m of metrics) {
      (map[m.category] ??= []).push(m);
    }
    return map;
  });

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
    const metric = metrics.find(m => m.id === metricId);
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
            points: grows.map(r => ({ t: new Date(String(r[timeCol])).getTime(), v: Number(r[valueCol]) })).filter(p => !isNaN(p.t) && !isNaN(p.v))
          });
          gi++;
        }
      } else {
        series.push({
          label: getDesignName(designId),
          color,
          points: rows.map(r => ({ t: new Date(String(r[timeCol])).getTime(), v: Number(r[valueCol]) })).filter(p => !isNaN(p.t) && !isNaN(p.v))
        });
      }
      // Phase markers
      const run = runsPerDesign[designId]?.find(r => r.id === selectedRuns[designId]);
      if (run?.bench_started_at) {
        markers.push({ t: new Date(run.bench_started_at).getTime(), label: 'bench', color });
      }
      if (run?.post_started_at) {
        markers.push({ t: new Date(run.post_started_at).getTime(), label: 'post', color });
      }
    });
    return { series, markers };
  }

  // ── Data loading ──────────────────────────────────────────────────────────
  async function load() {
    const [dRes, mRes] = await Promise.all([
      fetch(`/api/designs?decision_id=${decisionId}`),
      fetch('/api/metrics')
    ]);
    designs = await dRes.json();
    metrics = await mRes.json();

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

  // ── Metrics ───────────────────────────────────────────────────────────────
  async function runMetric(m: Metric) {
    runningMetricId = m.id;
    metricResults[m.id] = {};
    for (const [did, runId] of Object.entries(selectedRuns)) {
      if (!runId) continue;
      metricResults[m.id][Number(did)] = await queryApi(m.sql, [runId]);
    }
    metricResults = { ...metricResults };
    // Auto-detect time/value columns
    const firstRes = Object.values(metricResults[m.id])[0];
    if (firstRes && !metricTimeCol[m.id]) {
      const timeCandidates = firstRes.columns.filter(c => c.includes('at') || c.includes('time'));
      const valueCandidates = firstRes.columns.filter(c => !c.includes('name') && !c.includes('schema') && !c.includes('at') && !c.includes('type') && !timeCandidates.includes(c));
      if (timeCandidates.length) metricTimeCol[m.id] = timeCandidates[0];
      if (valueCandidates.length) metricValueCol[m.id] = valueCandidates[0];
    }
    runningMetricId = null;
  }

  async function runAllMetrics() {
    for (const m of metrics) await runMetric(m);
  }

  async function saveMetric() {
    if (!editingMetric) return;
    metricFormError = '';
    if (!editingMetric.name?.trim() || !editingMetric.sql?.trim()) {
      metricFormError = 'Name and SQL are required.'; return;
    }
    if (editingMetric.isNew) {
      const res = await fetch('/api/metrics', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(editingMetric)
      });
      if (!res.ok) { metricFormError = (await res.json()).message; return; }
      const m = await res.json();
      metrics = [...metrics, m];
      await runMetric(m);
    } else {
      const res = await fetch(`/api/metrics/${editingMetric.id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(editingMetric)
      });
      if (!res.ok) { metricFormError = (await res.json()).message; return; }
      const m = await res.json();
      metrics = metrics.map(x => x.id === m.id ? m : x);
      await runMetric(m);
    }
    editingMetric = null;
  }

  async function deleteMetric(m: Metric) {
    await fetch(`/api/metrics/${m.id}`, { method: 'DELETE' });
    metrics = metrics.filter(x => x.id !== m.id);
    delete metricResults[m.id];
    metricResults = { ...metricResults };
  }

  function cloneMetric(m: Metric) {
    editingMetric = { ...m, id: undefined, name: m.name + ' (copy)', is_builtin: 0, isNew: true };
    metricTestResults = {};
  }

  async function testMetric() {
    if (!editingMetric?.sql?.trim()) return;
    metricTestRunning = true;
    metricTestResults = {};
    for (const [did, runId] of Object.entries(selectedRuns)) {
      if (!runId) continue;
      metricTestResults[Number(did)] = await queryApi(editingMetric.sql, [runId]);
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
  <div class="row" style="margin-bottom:12px">
    <h3>Metrics</h3>
    <span class="spacer"></span>
    <label class="delta-toggle">
      <input type="checkbox" bind:checked={deltaMode} />
      Δ from baseline only
    </label>
    <button onclick={() => { editingMetric = { name:'', category:'Custom', description:'', sql:'SELECT _collected_at FROM snap_pg_stat_database WHERE _run_id = ?', higher_is_better: 1, isNew: true }; metricFormError = ''; metricTestResults = {}; }}>+ Add metric</button>
    <button onclick={runAllMetrics}>↺ Run all</button>
  </div>

  {#if editingMetric}
    <div class="metric-form card" style="margin-bottom:12px">
      <h4>{editingMetric.isNew ? 'New Metric' : 'Edit Metric'}</h4>
      <div class="row" style="gap:8px;flex-wrap:wrap;margin-bottom:8px">
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
        <div class="form-group" style="flex:0;min-width:130px">
          <label for="m-hib">Direction</label>
          <select id="m-hib" bind:value={editingMetric.higher_is_better}>
            <option value={1}>Higher is better</option>
            <option value={0}>Lower is better</option>
          </select>
        </div>
      </div>
      <div class="form-group" style="margin-bottom:8px">
        <label for="m-desc">Description</label>
        <input id="m-desc" bind:value={editingMetric.description} placeholder="What this metric shows…" />
      </div>
      <div class="form-group" style="margin-bottom:8px">
        <span class="form-label">SQL <span style="color:#999;font-size:11px">(use ? for _run_id, returns rows from snap_* tables)</span></span>
        <div class="editor-wrap">
          <CodeEditor bind:value={editingMetric.sql!} schema={snapSchema} />
        </div>
      </div>
      {#if metricFormError}<p class="error">{metricFormError}</p>{/if}
      <div class="row" style="margin-bottom: {Object.keys(metricTestResults).length ? '10px' : '0'}">
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
                    {#if res.rows.length > 5}<p style="font-size:11px;color:#999">Showing 5 of {res.rows.length} rows</p>{/if}
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
              {@const view = metricView[m.id] ?? 'table'}
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
                    {#if m.is_builtin}<span class="builtin-badge">built-in</span>{/if}
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
                    {#if m.is_builtin}
                      <button class="icon-btn" onclick={() => cloneMetric(m)} title="Clone to edit">⎘</button>
                    {:else}
                      <button class="icon-btn" onclick={() => { editingMetric = { ...m }; metricFormError = ''; metricTestResults = {}; }} title="Edit">✎</button>
                      <button class="icon-btn danger" onclick={() => deleteMetric(m)} title="Delete">✕</button>
                    {/if}
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
                        <select bind:value={metricTimeCol[m.id]}>
                          {#each firstRes?.columns ?? [] as c}<option>{c}</option>{/each}
                        </select>
                      </label>
                      <label>Value col:
                        <select bind:value={metricValueCol[m.id]}>
                          {#each firstRes?.columns ?? [] as c}<option>{c}</option>{/each}
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
                                  {#each rows.slice(0, deltaMode ? rows.length : 5) as row}
                                    <tr>{#each r.columns as c}<td>{row[c] ?? 'NULL'}</td>{/each}</tr>
                                  {/each}
                                </tbody>
                              </table>
                            </div>
                            {#if !deltaMode && rows.length > 5}
                              <p style="font-size:11px;color:#999">Showing 5 of {rows.length} rows</p>
                            {/if}
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

{/if}

<style>
  .design-grid { display: flex; gap: 12px; flex-wrap: wrap; }
  .design-col { flex: 1; min-width: 200px; }
  .design-col strong { display: block; margin-bottom: 4px; font-size: 13px; }

  /* metrics */
  .delta-toggle { display: flex; align-items: center; gap: 5px; font-size: 12px; font-weight: 600; color: #555; }
  .delta-toggle input { width: auto; }

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
  .builtin-badge { font-size: 10px; background: #f0f4ff; color: #4466cc; padding: 1px 6px; border-radius: 10px; border: 1px solid #c8d4ff; }
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
  .table-wrap { overflow-x: auto; }

  /* metric form */
  .metric-form { border: 1px solid #c8d4ff; background: #f8f9ff !important; }
  .metric-form h4 { margin: 0 0 10px; font-size: 13px; }
  .editor-wrap { position: relative; height: 160px; border-radius: 4px; overflow: hidden; }
  .test-results { border-top: 1px solid #d8e0ff; margin-top: 10px; padding-top: 10px; }
</style>
