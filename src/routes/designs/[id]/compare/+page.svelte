<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import LineChart from '$lib/LineChart.svelte';
  import LoadAnalysis from '$lib/LoadAnalysis.svelte';
  import { fmtTs } from '$lib/utils';
  import CodeEditor from '$lib/CodeEditor.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  const designId = $derived(Number($page.params.id));

  interface RunInfo {
    id: number;
    name: string;
    status: string;
    tps: number | null;
    latency_avg_ms: number | null;
    latency_stddev_ms: number | null;
    transactions: number | null;
    profile_name: string;
    run_params: string;
    started_at: string;
    bench_started_at: string | null;
    post_started_at: string | null;
    finished_at: string | null;
  }
  interface DecisionMetric { id: number; decision_id: number; name: string; category: string; description: string; sql: string; higher_is_better: number; position: number; time_col: string; value_col: string; }
  interface LibraryMetric { id: number; name: string; category: string; description: string; sql: string; is_builtin: number; higher_is_better: number; }
  interface QueryResult { columns: string[]; rows: Record<string, unknown>[]; error?: string; }
  interface ChartPoint { t: number; v: number; }
  interface ChartSeries { label: string; color: string; points: ChartPoint[]; }
  interface SnapTable { name: string; columns: string[]; }
  interface ParamRow { name: string; values: (string | null)[]; hasDiff: boolean; }

  const COLORS = ['#0066cc', '#e6531d', '#00996b', '#9b36b7', '#cc8800'];
  const CATEGORIES = ['Cache & I/O', 'Access Patterns', 'Write Efficiency', 'Checkpoint & BGWriter', 'Vacuum Health', 'Concurrency', 'Custom'];
  const MAX_RUNS = 4;
  const SUMMARY_METRICS = [
    { key: 'tps' as const,              label: 'TPS',                  decimals: 2, higherBetter: true  },
    { key: 'latency_avg_ms' as const,   label: 'Avg Latency (ms)',     decimals: 3, higherBetter: false },
    { key: 'latency_stddev_ms' as const,label: 'Latency StdDev (ms)',  decimals: 3, higherBetter: false },
    { key: 'transactions' as const,     label: 'Transactions',         decimals: 0, higherBetter: true  },
  ];

  // ── State ──────────────────────────────────────────────────────────────────
  const allRuns: RunInfo[] = data.runs as RunInfo[];
  let selectedRunIds: number[] = $state([]);
  let decisionMetrics: DecisionMetric[] = $state(data.metrics as DecisionMetric[]);

  let metricResults: Record<number, Record<number, QueryResult>> = $state({});
  let metricView: Record<number, 'table' | 'chart'> = $state({});
  let metricTimeCol: Record<number, string> = $state({});
  let metricValueCol: Record<number, string> = $state({});
  let metricTableFilter: Record<number, string[]> = $state({});
  let collapsedCategories: Record<string, boolean> = $state({});
  let loadAnalysisOpen = $state(false);
  let runningMetricId = $state<number | null>(null);
  let includedPhases = $state<string[]>(['bench']);

  let libraryTemplates: LibraryMetric[] = $state([]);
  let libraryLoaded = false;
  let showLibraryPicker = $state(false);
  let librarySearch = $state('');

  let editingMetric = $state<Partial<DecisionMetric> & { isNew?: boolean } | null>(null);
  let metricFormError = $state('');
  let metricTestResults: Record<number, QueryResult> = $state({});
  let metricTestRunning = $state(false);

  let snapTables: SnapTable[] = $state([]);
  const snapSchema = $derived(Object.fromEntries(snapTables.map(t => [t.name, t.columns])));

  const decisionId = $derived((data.decision as { id: number } | null)?.id ?? 0);

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

  // ── Run helpers ────────────────────────────────────────────────────────────
  function getRunLabel(runId: number) {
    const r = allRuns.find(r => r.id === runId);
    if (!r) return `Run #${runId}`;
    return r.name || `Run #${r.id}`;
  }
  function getRunForId(runId: number) { return allRuns.find(r => r.id === runId); }

  // ── URL state ──────────────────────────────────────────────────────────────
  function initFromUrl() {
    const param = $page.url.searchParams.get('runs');
    if (param) {
      const ids = param.split(',').map(Number).filter(n => n > 0 && allRuns.some(r => r.id === n));
      selectedRunIds = ids.slice(0, MAX_RUNS);
    }
    for (const m of decisionMetrics) {
      if (m.time_col) metricTimeCol[m.id] = m.time_col;
      if (m.value_col) metricValueCol[m.id] = m.value_col;
    }
  }

  function syncUrl() {
    const url = new URL($page.url);
    if (selectedRunIds.length > 0) {
      url.searchParams.set('runs', selectedRunIds.join(','));
    } else {
      url.searchParams.delete('runs');
    }
    goto(url.toString(), { replaceState: true, noScroll: true, keepFocus: true });
  }

  function toggleRun(runId: number) {
    if (selectedRunIds.includes(runId)) {
      selectedRunIds = selectedRunIds.filter(id => id !== runId);
    } else if (selectedRunIds.length < MAX_RUNS) {
      selectedRunIds = [...selectedRunIds, runId];
    }
    syncUrl();
    onRunChange();
  }

  function clearSelection() {
    selectedRunIds = [];
    syncUrl();
    snapTables = [];
    metricResults = {};
  }

  // ── Helpers ────────────────────────────────────────────────────────────────
  async function queryApi(sql: string, params: unknown[]): Promise<QueryResult> {
    const res = await fetch('/api/query', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql, params })
    });
    const json = await res.json();
    if (!res.ok) return { columns: [], rows: [], error: json.message ?? `HTTP ${res.status}` };
    return json as QueryResult;
  }

  function copyCSV(metricId: number) {
    const results = metricResults[metricId];
    if (!results) return;
    const entries = Object.entries(results);
    if (!entries.length) return;
    const cols = entries[0][1].columns;
    const lines = [['run', ...cols].join(',')];
    for (const [rid, res] of entries) {
      const label = getRunLabel(Number(rid));
      for (const row of res.rows) {
        lines.push([JSON.stringify(label), ...cols.map(c => String(row[c] ?? ''))].join(','));
      }
    }
    navigator.clipboard.writeText(lines.join('\n'));
  }

  function getSummary(metricId: number, valueCol: string): { runId: number; avg: number }[] {
    const results = metricResults[metricId];
    if (!results) return [];
    return selectedRunIds.map(runId => {
      const res = results[runId];
      if (!res) return null;
      const vals = res.rows.map(r => Number(r[valueCol])).filter(v => !isNaN(v));
      return { runId, avg: vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : NaN };
    }).filter((x): x is { runId: number; avg: number } => x !== null && !isNaN(x.avg));
  }

  function getWinner(metricId: number, valueCol: string): number | null {
    const metric = decisionMetrics.find(m => m.id === metricId);
    if (!metric) return null;
    const summary = getSummary(metricId, valueCol);
    if (summary.length < 2) return null;
    let best = summary[0];
    for (const s of summary.slice(1)) {
      const isBetter = metric.higher_is_better ? s.avg > best.avg : s.avg < best.avg;
      if (isBetter) best = s;
    }
    const allEqual = summary.every(s => s.avg === best.avg);
    return allEqual ? null : best.runId;
  }

  function buildChartSeriesFromResult(
    metricId: number, timeCol: string, valueCol: string
  ): { series: ChartSeries[]; markers: { t: number; label: string; color: string }[] } {
    const results = metricResults[metricId];
    const filter = metricTableFilter[metricId] ?? [];
    const series: ChartSeries[] = [];
    const markers: { t: number; label: string; color: string }[] = [];

    selectedRunIds.forEach((runId, i) => {
      const res = results?.[runId];
      if (!res) return;
      const color = COLORS[i % COLORS.length];
      let rows = res.rows;
      if (filter.length > 0 && res.columns.includes('relname')) {
        rows = rows.filter(r => filter.includes(String(r['relname'])));
      }

      const run = getRunForId(runId);
      const originMs = run ? new Date(run.bench_started_at ?? run.started_at).getTime() : 0;

      const groupCols = ['relname', 'indexrelname', 'state', 'datname'].filter(
        c => res.columns.includes(c) && c !== timeCol && c !== valueCol
      );
      if (groupCols.length > 0) {
        const groupKey = groupCols[0];
        const groups = new Map<string, Record<string, unknown>[]>();
        for (const row of rows) {
          const k = String(row[groupKey] ?? '');
          (groups.get(k) ?? groups.set(k, []).get(k)!).push(row);
        }
        let gi = 0;
        for (const [gk, grows] of groups) {
          series.push({
            label: `${getRunLabel(runId)} · ${gk}`,
            color: COLORS[(i + gi) % COLORS.length],
            points: grows.map(r => ({ t: new Date(String(r[timeCol])).getTime() - originMs, v: Number(r[valueCol]) })).filter(p => !isNaN(p.t) && !isNaN(p.v))
          });
          gi++;
        }
      } else {
        series.push({
          label: getRunLabel(runId),
          color,
          points: rows.map(r => ({ t: new Date(String(r[timeCol])).getTime() - originMs, v: Number(r[valueCol]) })).filter(p => !isNaN(p.t) && !isNaN(p.v))
        });
      }
      if (run?.bench_started_at) {
        markers.push({ t: new Date(run.bench_started_at).getTime() - originMs, label: 'bench', color });
      }
      if (run?.post_started_at) {
        markers.push({ t: new Date(run.post_started_at).getTime() - originMs, label: 'post', color });
      }
    });
    return { series, markers };
  }

  // ── Parameter diff ─────────────────────────────────────────────────────────
  const paramDiffRows = $derived((): ParamRow[] => {
    if (selectedRunIds.length === 0) return [];
    const runs = selectedRunIds.map(id => getRunForId(id));
    const parsedParams = runs.map(r => {
      try { return (r?.run_params ? JSON.parse(r.run_params) : []) as { name: string; value: string }[]; }
      catch { return []; }
    });
    const paramNames = new Set<string>();
    for (const params of parsedParams) for (const p of params) paramNames.add(p.name);

    const rows: ParamRow[] = [];
    const profileValues = runs.map(r => r?.profile_name || null);
    rows.push({ name: 'Profile', values: profileValues, hasDiff: profileValues.some(v => v !== profileValues[0]) });

    for (const name of paramNames) {
      const values = parsedParams.map(params => params.find(p => p.name === name)?.value ?? null);
      rows.push({ name, values, hasDiff: values.some(v => v !== values[0]) });
    }
    return rows;
  });
  const hasParamDiff = $derived(paramDiffRows().some(r => r.hasDiff));

  // ── Data loading ───────────────────────────────────────────────────────────
  async function loadSnapTables() {
    if (selectedRunIds.length === 0) { snapTables = []; return; }
    const res = await fetch(`/api/snap-tables?run_ids=${selectedRunIds.join(',')}`);
    snapTables = await res.json();
  }

  async function onRunChange() {
    await loadSnapTables();
    runAllMetrics();
  }

  // ── Phase filter ───────────────────────────────────────────────────────────
  function applyPhaseFilter(sql: string): string {
    const phases = includedPhases;
    if (phases.length === 0) return sql;
    const filter = phases.length === 1
      ? `_phase = '${phases[0]}'`
      : `_phase IN (${phases.map(p => `'${p}'`).join(', ')})`;
    return sql.replace(/_phase = 'bench'/g, filter);
  }

  // ── Metrics ────────────────────────────────────────────────────────────────
  async function runMetric(m: DecisionMetric) {
    if (selectedRunIds.length === 0) return;
    runningMetricId = m.id;
    metricResults[m.id] = {};
    for (const runId of selectedRunIds) {
      metricResults[m.id][runId] = await queryApi(applyPhaseFilter(m.sql), [runId]);
    }
    metricResults = { ...metricResults };
    const firstRes = metricResults[m.id][selectedRunIds[0]];
    if (firstRes && !metricTimeCol[m.id]) {
      const timeCandidates = firstRes.columns.filter(c => c.includes('at') || c.includes('time'));
      const valueCandidates = firstRes.columns.filter(c => !c.includes('name') && !c.includes('schema') && !c.includes('at') && !c.includes('type') && !timeCandidates.includes(c));
      if (timeCandidates.length) metricTimeCol[m.id] = timeCandidates[0];
      if (valueCandidates.length) metricValueCol[m.id] = valueCandidates[0];
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
    for (const runId of selectedRunIds) {
      metricTestResults[runId] = await queryApi(applyPhaseFilter(editingMetric.sql), [runId]);
    }
    metricTestResults = { ...metricTestResults };
    metricTestRunning = false;
  }

  onMount(() => {
    initFromUrl();
    if (selectedRunIds.length > 0) {
      loadSnapTables();
      runAllMetrics();
    }
  });
</script>

<!-- ── Header ───────────────────────────────────────────────────────────────── -->
<div class="row" style="margin-bottom:16px;align-items:center;gap:8px">
  <a href="/designs/{designId}" style="color:#0066cc;text-decoration:none">← {(data.design as {name:string}|null)?.name ?? 'Design'}</a>
  <h1 style="margin-left:8px">Compare Runs</h1>
</div>

<!-- ── Run selector ─────────────────────────────────────────────────────────── -->
<div class="card">
  <div class="row" style="margin-bottom:12px;align-items:center;gap:10px;flex-wrap:wrap">
    <h3 style="margin:0">Select Runs to Compare</h3>
    <span style="font-size:12px;color:#999">Select 2–{MAX_RUNS} completed runs</span>
    {#if selectedRunIds.length > 0}
      <button onclick={clearSelection} style="margin-left:auto;font-size:12px">Clear</button>
    {/if}
  </div>
  {#if allRuns.length === 0}
    <p style="color:#999;font-size:13px">No completed runs for this design yet.</p>
  {:else}
    <div class="run-list">
      {#each allRuns as r}
        {@const colorIdx = selectedRunIds.indexOf(r.id)}
        {@const selected = colorIdx >= 0}
        {@const disabled = !selected && selectedRunIds.length >= MAX_RUNS}
        <label
          class="run-chip"
          class:selected
          class:disabled
          style={selected ? `border-color:${COLORS[colorIdx]};background:${COLORS[colorIdx]}18` : ''}
        >
          <input type="checkbox" checked={selected} {disabled} onchange={() => toggleRun(r.id)} />
          <span class="run-chip-id" style={selected ? `color:${COLORS[colorIdx]};font-weight:700` : ''}>
            {r.name || '#' + r.id}
          </span>
          {#if r.profile_name}
            <span class="run-chip-profile">{r.profile_name}</span>
          {/if}
          {#if r.tps !== null}
            <span class="run-chip-tps">{r.tps.toFixed(1)} TPS</span>
          {/if}
          <span class="run-chip-date">{fmtTs(r.started_at)}</span>
        </label>
      {/each}
    </div>
  {/if}
</div>

{#if selectedRunIds.length >= 2}

<!-- ── pgbench Summary ───────────────────────────────────────────────────────── -->
<div class="card">
  <h3>pgbench Summary</h3>
  <div class="table-wrap">
    <table class="summary-table">
      <thead>
        <tr>
          <th>Metric</th>
          {#each selectedRunIds as runId, i}
            <th style="color:{COLORS[i % COLORS.length]}">{getRunLabel(runId)}</th>
          {/each}
          <th>Best</th>
        </tr>
      </thead>
      <tbody>
        {#each SUMMARY_METRICS as sm}
          {@const numVals = selectedRunIds.map(id => {
            const r = getRunForId(id);
            const v = r?.[sm.key] ?? null;
            return v !== null ? Number(v) : null;
          })}
          {@const valid = numVals.filter((v): v is number => v !== null)}
          {@const bestVal = valid.length === 0 ? null : sm.higherBetter ? Math.max(...valid) : Math.min(...valid)}
          {@const baselineVal = numVals[0]}
          <tr>
            <td class="metric-label">{sm.label}</td>
            {#each numVals as val, i}
              {@const isBest = val !== null && val === bestVal && valid.length >= 2}
              <td class:winner-cell={isBest}>
                {#if val !== null}
                  <span class:winner-value={isBest}>
                    {sm.decimals === 0 ? val.toFixed(0) : val.toFixed(sm.decimals)}
                  </span>
                  {#if i > 0 && baselineVal !== null && baselineVal !== 0}
                    {@const delta = (val - baselineVal) / Math.abs(baselineVal) * 100}
                    {@const isGood = sm.higherBetter ? delta > 0 : delta < 0}
                    <span class="inline-delta" class:positive={isGood} class:negative={!isGood && delta !== 0}>
                      {delta > 0 ? '+' : ''}{delta.toFixed(1)}%
                    </span>
                  {/if}
                {:else}
                  <span style="color:#bbb">—</span>
                {/if}
              </td>
            {/each}
            <td>
              {#if bestVal !== null && valid.length >= 2}
                {@const bestIdx = numVals.findIndex(v => v === bestVal)}
                {#if bestIdx >= 0}
                  <span class="winner-badge" style="border-color:{COLORS[bestIdx % COLORS.length]};color:{COLORS[bestIdx % COLORS.length]}">
                    ▲ {getRunLabel(selectedRunIds[bestIdx])}
                  </span>
                {/if}
              {/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
</div>

<!-- ── Parameter diff ────────────────────────────────────────────────────────── -->
{#if paramDiffRows().length > 0}
<div class="card">
  <div class="row" style="margin-bottom:12px;gap:8px;align-items:center">
    <h3 style="margin:0">Parameters</h3>
    {#if !hasParamDiff}
      <span style="font-size:12px;color:#999">No parameter changes between selected runs</span>
    {:else}
      <span style="font-size:12px;color:#885500">Highlighted cells differ from first run</span>
    {/if}
  </div>
  <div class="table-wrap">
    <table class="params-table">
      <thead>
        <tr>
          <th>Parameter</th>
          {#each selectedRunIds as runId, i}
            <th style="color:{COLORS[i % COLORS.length]}">{getRunLabel(runId)}</th>
          {/each}
        </tr>
      </thead>
      <tbody>
        {#each paramDiffRows() as row}
          <tr>
            <td class="param-name">{row.name}</td>
            {#each row.values as val, i}
              <td class:param-diff={i > 0 && val !== row.values[0]}>
                {#if val !== null && val !== ''}
                  {val}
                {:else}
                  <span style="color:#bbb">—</span>
                {/if}
              </td>
            {/each}
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
</div>
{/if}

<!-- ── Load Analysis ─────────────────────────────────────────────────────────── -->
{#if selectedRunIds.length >= 1}
<div class="card" style="margin-bottom:12px">
  <div class="row" style="cursor:pointer;align-items:center;gap:8px;margin-bottom:0"
       onclick={() => loadAnalysisOpen = !loadAnalysisOpen}>
    <h3 style="margin:0">Load Analysis</h3>
    <span style="font-size:12px;color:#888;margin-left:4px">{loadAnalysisOpen ? '▲' : '▼'}</span>
  </div>
  {#if loadAnalysisOpen}
    <div style="margin-top:16px">
      <LoadAnalysis
        runs={selectedRunIds.map((id, i) => {
          const r = allRuns.find(x => x.id === id);
          return {
            id,
            label: r?.name || `Run #${id}`,
            color: COLORS[i % COLORS.length],
            bench_started_at: r?.bench_started_at ?? null,
            post_started_at: r?.post_started_at ?? null
          };
        })}
        phases={includedPhases}
        showPhaseFilter={false}
      />
    </div>
  {/if}
</div>
{/if}

<!-- ── Metrics ────────────────────────────────────────────────────────────────── -->
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
              {@const firstRes = res ? (res[selectedRunIds[0]] ?? Object.values(res)[0] ?? null) : null}
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
                <div class="mc-header">
                  <div class="mc-title-row">
                    <span class="mc-name">{m.name}</span>
                    {#if winner !== null}
                      {@const wIdx = selectedRunIds.indexOf(winner)}
                      {@const wcolor = COLORS[wIdx >= 0 ? wIdx % COLORS.length : 0]}
                      <span class="winner-badge" style="border-color:{wcolor};color:{wcolor}">▲ {getRunLabel(winner)}</span>
                    {/if}
                  </div>
                  {#if m.description}<p class="mc-desc">{m.description}</p>{/if}
                  <div class="mc-actions">
                    <button class="icon-btn" onclick={() => runMetric(m)} disabled={runningMetricId === m.id} title="Run">
                      {runningMetricId === m.id ? '…' : '↺'}
                    </button>
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
                        {@const base = summary[0].avg}
                        {@const best = summary.reduce((a, b) => Math.abs(b.avg - base) > Math.abs(a.avg - base) ? b : a)}
                        <div class="summary-row">
                          {#each summary as s, i}
                            <span style="color:{COLORS[i % COLORS.length]}">{getRunLabel(s.runId)}: <strong>{s.avg.toFixed(4)}</strong></span>
                          {/each}
                          {#if best.runId !== summary[0].runId && base !== 0}
                            {@const delta = (best.avg - base) / Math.abs(base) * 100}
                            <span class="delta-pct" class:positive={delta > 0} class:negative={delta < 0}>
                              {delta > 0 ? '+' : ''}{delta.toFixed(1)}%
                            </span>
                          {/if}
                        </div>
                      {/if}
                    {:else}
                      <p style="color:#999;font-size:12px;padding:8px">Select time and value columns above to render chart.</p>
                    {/if}

                  {:else}
                    <div class="results-grid">
                      {#each selectedRunIds as runId, i}
                        {@const r = res[runId]}
                        <div class="result-col">
                          <div class="result-col-header" style="color:{COLORS[i % COLORS.length]}">{getRunLabel(runId)}</div>
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

{:else if allRuns.length < 2}
  <div class="card" style="text-align:center;padding:32px;color:#999;font-size:13px">
    This design needs at least 2 completed runs to compare. Run the benchmark a few more times with different settings or parameter profiles.
  </div>
{:else}
  <div class="card" style="text-align:center;padding:32px;color:#999;font-size:13px">
    Select at least 2 runs above to begin comparing.
  </div>
{/if}

<!-- ── Library picker modal ─────────────────────────────────────────────────── -->
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

<!-- ── Metric form modal ─────────────────────────────────────────────────────── -->
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
        <button onclick={testMetric} disabled={metricTestRunning || selectedRunIds.length === 0}>
          {metricTestRunning ? 'Testing…' : '▶ Test'}
        </button>
        <button onclick={() => { editingMetric = null; metricTestResults = {}; }}>Cancel</button>
      </div>
      {#if Object.keys(metricTestResults).length > 0}
        <div class="test-results">
          <div class="results-grid">
            {#each selectedRunIds as runId, i}
              {@const res = metricTestResults[runId]}
              {#if res}
                <div class="result-col">
                  <div class="result-col-header" style="color:{COLORS[i % COLORS.length]}">{getRunLabel(runId)}</div>
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

<style>
  /* run selector */
  .run-list { display: flex; flex-direction: column; gap: 6px; }
  .run-chip {
    display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
    padding: 8px 12px; border: 1.5px solid #e0e0e0; border-radius: 6px;
    cursor: pointer; font-size: 13px; transition: border-color 0.1s, background 0.1s;
  }
  .run-chip:hover:not(.disabled) { border-color: #0066cc; background: #f0f6ff; }
  .run-chip.selected { font-weight: 500; }
  .run-chip.disabled { opacity: 0.45; cursor: not-allowed; }
  .run-chip input { width: auto; cursor: pointer; }
  .run-chip-id { font-size: 13px; }
  .run-chip-profile { font-size: 11px; background: #e8f0ff; color: #0055aa; padding: 1px 6px; border-radius: 8px; }
  .run-chip-tps { font-size: 11px; color: #00996b; font-weight: 600; }
  .run-chip-date { font-size: 11px; color: #aaa; margin-left: auto; font-family: monospace; }

  /* summary table */
  .summary-table { width: 100%; border-collapse: collapse; font-size: 13px; }
  .summary-table th { text-align: left; padding: 6px 10px; border-bottom: 2px solid #eee; font-size: 12px; }
  .summary-table td { padding: 7px 10px; border-bottom: 1px solid #f5f5f5; }
  .metric-label { font-weight: 600; color: #444; white-space: nowrap; }
  .winner-cell { background: #f0fff8; }
  .winner-value { font-weight: 700; color: #00774f; }
  .inline-delta { font-size: 11px; font-weight: 600; margin-left: 5px; }
  .inline-delta.positive { color: #00996b; }
  .inline-delta.negative { color: #cc3333; }

  /* parameter diff */
  .params-table { width: 100%; border-collapse: collapse; font-size: 13px; }
  .params-table th { text-align: left; padding: 6px 10px; border-bottom: 2px solid #eee; font-size: 12px; }
  .params-table td { padding: 6px 10px; border-bottom: 1px solid #f5f5f5; font-family: monospace; font-size: 12px; }
  .param-name { font-family: monospace; font-weight: 600; color: #444; font-size: 12px; white-space: nowrap; }
  .param-diff { background: #fff8e8; color: #885500; font-weight: 600; }

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
  .result-col-header { font-weight: 600; font-size: 12px; margin-bottom: 6px; }
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
