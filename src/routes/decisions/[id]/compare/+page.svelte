<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/stores';

  const decisionId = $derived(Number($page.params.id));

  interface Design { id: number; name: string; }
  interface Run { id: number; design_id: number; status: string; tps: number|null; latency_avg_ms: number|null; latency_stddev_ms: number|null; transactions: number|null; started_at: string; }
  interface SavedQuery { id: number; name: string; sql: string; decision_id: number|null; }
  interface QueryResult { columns: string[]; rows: Record<string,unknown>[]; error?: string; }

  let designs: Design[] = $state([]);
  let runsPerDesign: Record<number, Run[]> = $state({});
  let selectedRuns: Record<number, number> = $state({}); // design_id -> run_id
  let savedQueries: SavedQuery[] = $state([]);
  let queryResults: Record<number, Record<number, QueryResult>> = $state({}); // query_id -> design_id -> result
  let adHocSql = $state('SELECT * FROM snap_pg_stat_database WHERE _run_id = ? LIMIT 5');
  let adHocResults: Record<number, QueryResult> = $state({});
  let adHocRunning = $state(false);
  let newQueryName = $state('');
  let showSaveForm = $state(false);
  let loading = $state(true);

  async function load() {
    const [dRes, sqRes] = await Promise.all([
      fetch(`/api/designs?decision_id=${decisionId}`),
      fetch(`/api/saved-queries?decision_id=${decisionId}`)
    ]);
    designs = await dRes.json();
    savedQueries = await sqRes.json();

    // Load runs for each design
    for (const d of designs) {
      const rRes = await fetch(`/api/runs?design_id=${d.id}`);
      const runs: Run[] = await rRes.json();
      runsPerDesign[d.id] = runs;
      if (runs.length > 0) selectedRuns[d.id] = runs[0].id;
    }
    loading = false;
  }

  const selectedRunIds = $derived(Object.values(selectedRuns).filter(Boolean));

  async function runSavedQuery(q: SavedQuery) {
    queryResults[q.id] = {};
    for (const [designId, runId] of Object.entries(selectedRuns)) {
      if (!runId) continue;
      try {
        const res = await fetch('/api/query', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sql: q.sql, params: [runId] })
        });
        queryResults[q.id][Number(designId)] = await res.json();
      } catch (e) {
        queryResults[q.id][Number(designId)] = { columns: [], rows: [], error: String(e) };
      }
    }
    queryResults = { ...queryResults };
  }

  async function runAllSavedQueries() {
    for (const q of savedQueries) {
      await runSavedQuery(q);
    }
  }

  async function runAdHoc() {
    adHocRunning = true;
    adHocResults = {};
    for (const [designId, runId] of Object.entries(selectedRuns)) {
      if (!runId) continue;
      try {
        const res = await fetch('/api/query', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sql: adHocSql, params: [runId] })
        });
        const data = await res.json();
        adHocResults[Number(designId)] = data;
      } catch (e) {
        adHocResults[Number(designId)] = { columns: [], rows: [], error: String(e) };
      }
    }
    adHocRunning = false;
    adHocResults = { ...adHocResults };
  }

  async function saveAdHoc() {
    if (!newQueryName.trim()) return;
    const res = await fetch('/api/saved-queries', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision_id: decisionId, name: newQueryName, sql: adHocSql })
    });
    const q = await res.json();
    savedQueries = [...savedQueries, q];
    showSaveForm = false;
    newQueryName = '';
  }

  async function deleteQuery(q: SavedQuery) {
    if (q.decision_id === null) return;
    await fetch(`/api/saved-queries/${q.id}`, { method: 'DELETE' });
    savedQueries = savedQueries.filter(x => x.id !== q.id);
  }

  function getDesignName(designId: number) {
    return designs.find(d => d.id === designId)?.name ?? `Design ${designId}`;
  }

  onMount(load);
</script>

<div class="row" style="margin-bottom:16px">
  <a href="/decisions/{decisionId}" style="color:#0066cc; text-decoration:none">← Decision</a>
  <h1 style="margin-left:8px">Compare Designs</h1>
</div>

{#if loading}
  <p>Loading...</p>
{:else}

<!-- Run selector per design -->
<div class="card">
  <h3>Select Runs to Compare</h3>
  <div class="design-grid">
    {#each designs as d}
      <div class="design-col">
        <strong>{d.name}</strong>
        <select bind:value={selectedRuns[d.id]} onchange={runAllSavedQueries}>
          <option value={0}>— none —</option>
          {#each runsPerDesign[d.id] ?? [] as r}
            <option value={r.id}>Run #{r.id} ({r.status}) — {r.started_at?.slice(0,16)}</option>
          {/each}
        </select>
      </div>
    {/each}
  </div>
</div>

<!-- pgbench summary -->
<div class="card">
  <h3>pgbench Summary</h3>
  <table>
    <thead>
      <tr>
        <th>Design</th>
        <th>Run</th>
        <th>TPS</th>
        <th>Avg Latency (ms)</th>
        <th>Stddev (ms)</th>
        <th>Transactions</th>
        <th>Status</th>
      </tr>
    </thead>
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

<!-- Saved queries -->
<div class="card">
  <div class="row" style="margin-bottom:12px">
    <h3>Saved Queries</h3>
    <span class="spacer"></span>
    <button onclick={runAllSavedQueries}>Run All</button>
  </div>

  {#each savedQueries as q}
    <div class="query-block">
      <div class="row" style="margin-bottom:6px">
        <strong>{q.name}</strong>
        {#if q.decision_id !== null}<span style="font-size:11px; color:#999">(custom)</span>{/if}
        <span class="spacer"></span>
        <button onclick={() => runSavedQuery(q)}>Run</button>
        {#if q.decision_id !== null}
          <button class="danger" onclick={() => deleteQuery(q)}>Delete</button>
        {/if}
      </div>
      <details>
        <summary style="font-size:11px; color:#666; cursor:pointer">SQL</summary>
        <pre style="font-size:11px; color:#555; background:#f8f8f8; padding:8px; border-radius:3px; overflow:auto; margin:4px 0">{q.sql}</pre>
      </details>
      {#if queryResults[q.id]}
        <div class="results-grid" style="margin-top:8px">
          {#each designs as d}
            {@const res = queryResults[q.id][d.id]}
            <div class="result-col">
              <div class="result-col-header">{d.name}</div>
              {#if res?.error}
                <p class="error">{res.error}</p>
              {:else if res?.rows?.length > 0}
                <div class="table-wrap">
                  <table>
                    <thead><tr>{#each res.columns as c}<th>{c}</th>{/each}</tr></thead>
                    <tbody>
                      {#each res.rows.slice(0,10) as row}
                        <tr>{#each res.columns as c}<td>{row[c] ?? 'NULL'}</td>{/each}</tr>
                      {/each}
                    </tbody>
                  </table>
                </div>
              {:else if res}
                <p style="color:#999; font-size:12px">No rows</p>
              {/if}
            </div>
          {/each}
        </div>
      {/if}
    </div>
  {/each}
</div>

<!-- Ad-hoc SQL -->
<div class="card">
  <h3>Ad-hoc SQL</h3>
  <p style="color:#666; font-size:12px; margin-bottom:8px">
    Use <code>?</code> as placeholder for <code>_run_id</code>. Query any <code>snap_*</code> table.
  </p>
  <textarea class="code" bind:value={adHocSql} rows="5" style="margin-bottom:8px"></textarea>
  <div class="row">
    <button class="primary" onclick={runAdHoc} disabled={adHocRunning}>
      {adHocRunning ? 'Running…' : 'Run Query'}
    </button>
    <button onclick={() => showSaveForm = !showSaveForm}>Save as…</button>
  </div>
  {#if showSaveForm}
    <div class="row" style="margin-top:8px">
      <input bind:value={newQueryName} placeholder="Query name" style="max-width:300px" />
      <button class="primary" onclick={saveAdHoc}>Save</button>
      <button onclick={() => showSaveForm = false}>Cancel</button>
    </div>
  {/if}

  {#if Object.keys(adHocResults).length > 0}
    <div class="results-grid" style="margin-top:12px">
      {#each designs as d}
        {@const res = adHocResults[d.id]}
        {#if res}
          <div class="result-col">
            <div class="result-col-header">{d.name}</div>
            {#if res.error}
              <p class="error">{res.error}</p>
            {:else if res.rows?.length > 0}
              <div class="table-wrap">
                <table>
                  <thead><tr>{#each res.columns as c}<th>{c}</th>{/each}</tr></thead>
                  <tbody>
                    {#each res.rows.slice(0,20) as row}
                      <tr>{#each res.columns as c}<td>{row[c] ?? 'NULL'}</td>{/each}</tr>
                    {/each}
                  </tbody>
                </table>
              </div>
            {:else}
              <p style="color:#999; font-size:12px">No rows</p>
            {/if}
          </div>
        {/if}
      {/each}
    </div>
  {/if}
</div>

{/if}

<style>
  .design-grid { display: flex; gap: 12px; flex-wrap: wrap; }
  .design-col { flex: 1; min-width: 200px; }
  .design-col strong { display: block; margin-bottom: 4px; font-size: 13px; }
  .query-block { border-bottom: 1px solid #eee; padding: 12px 0; }
  .query-block:last-child { border-bottom: none; }
  .results-grid { display: flex; gap: 12px; overflow-x: auto; }
  .result-col { flex: 1; min-width: 200px; }
  .result-col-header { font-weight: 600; font-size: 12px; color: #0066cc; margin-bottom: 6px; }
  .table-wrap { overflow-x: auto; }
</style>
