<script lang="ts">
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import { onMount, onDestroy, tick } from 'svelte';
  import { marked } from 'marked';
  import MarkdownEditor from '$lib/MarkdownEditor.svelte';
  import LoadAnalysis from '$lib/LoadAnalysis.svelte';
  import DatabaseTelemetry from '$lib/DatabaseTelemetry.svelte';
  import PgbenchOverview from '$lib/PgbenchOverview.svelte';
  import SysbenchOverview from '$lib/SysbenchOverview.svelte';
  import type { PageData } from './$types';
  import { fmtTs, fmtTime, markdownTable } from '$lib/utils';
  import { correctPerfEvent } from '$lib/perf-utils';
  import CopyTableButton from '$lib/CopyTableButton.svelte';

  let { data }: { data: PageData } = $props();

  const designId = $derived(Number($page.params.id));
  const runId = $derived(Number($page.params.runId));

  interface StepResult {
    id: number; step_id: number; name: string; type: string; status: string;
    stdout: string; stderr: string; started_at: string|null; finished_at: string|null;
    command: string; processed_script: string;
    pgbench_summary_json: string; pgbench_scripts_json: string;
    sysbench_summary_json: string;
    perfs: StepPerf[];
  }
  interface StepPerfEvent {
    event_name: string;
    counter_value: number | null;
    unit: string;
    runtime_secs: number | null;
    percent_running: number | null;
    per_transaction: number | null;
    derived_value: number | null;
    derived_unit: string;
  }
  interface StepPerf {
    mode: 'stat' | 'record' | 'trace';
    status: string;
    scope: 'postgres_cgroup' | 'system' | 'disabled';
    cgroup: string;
    command: string;
    raw_output: string;
    raw_error: string;
    result_json: string;
    perf_script_output: string;
    warnings_json: string;
    events: StepPerfEvent[];
  }
  interface PerfTopFunction {
    overhead: number;
    symbol: string;
    dso: string;
  }
  interface SyscallEntry {
    process: string;
    pid: number;
    syscall: string;
    calls: number;
    errors: number;
    total_ms: number;
    min_ms: number;
    avg_ms: number;
    max_ms: number;
  }
  type SyscallSortKey = 'syscall' | 'calls' | 'errors' | 'avg_ms' | 'max_ms';
  interface SyscallGrouped {
    syscall: string;
    calls: number;
    errors: number;
    avg_ms: number;
    max_ms: number;
    processes: SyscallEntry[];
  }
  interface Run {
    id: number; status: string; tps: number|null; latency_avg_ms: number|null;
    latency_stddev_ms: number|null; transactions: number|null;
    started_at: string; finished_at: string|null;
    bench_started_at: string|null; post_started_at: string|null;
    pre_collect_secs: number; post_collect_secs: number;
    is_imported?: number;
    name: string; notes: string; profile_name: string; run_params: string;
    host_config?: string | null;
    runner_spec?: string | null;
    db_spec?: string | null;
    db_pg_config?: string | null;
    ec2_server_id?: number | null;
    ec2_run_token?: string | null;
    steps: StepResult[];
  }
  interface Ec2Status {
    alive: boolean;
    pid?: number;
    result_exists: boolean;
    log_files: string[];
  }
  interface PhaseState {
    name: 'pre' | 'post';
    status: 'running' | 'completed';
    duration_secs: number;
    started_ms: number;
    elapsed_secs: number;
  }
  let run = $state<Run | null>(null);
  let done = $state(false);
  let finalStatus = $state('');
  let editingName = $state(false);
  let nameEdit = $state('');
  let notesEdit = $state('');
  let notesSaveStatus = $state<'' | 'saving' | 'saved'>('');
  let notesTimer: ReturnType<typeof setTimeout> | null = null;
  let notesMode = $state<'edit' | 'view'>('edit');
  let notesFullscreen = $state(false);
  let showRunParams = $state(false);
  let eventSource: EventSource | null = null;
  let outputEl: HTMLPreElement | null = $state(null);
  let expandedStep = $state<number | null>(null);
  let scrollPending = false;
  let phases: PhaseState[] = $state([]);
  let activeTab = $state<'overview' | 'load' | 'telemetry' | 'host_metrics' | 'perf'>('overview');
  let hostSubTab = $state<'system' | 'processes'>('system');
  let nameInput = $state<HTMLInputElement | null>(null);
  let ec2StatusLoading = $state(false);
  let ec2Status = $state<Ec2Status | null>(null);
  let ec2StatusError = $state<string | null>(null);
  let ec2LogFile = $state<string | null>(null);
  let ec2LogContent = $state<string | null>(null);
  let ec2LogLoading = $state(false);
  let syscallSort = $state<{ col: SyscallSortKey; asc: boolean }>({ col: 'calls', asc: false });
  let expandedSyscalls = $state<Set<string>>(new Set());
  const phaseTimers = new Map<string, ReturnType<typeof setInterval>>();

  const pendingLines: string[] = [];

  function parseJson<T>(value: string | null | undefined): T | null {
    if (!value?.trim()) return null;
    try {
      return JSON.parse(value) as T;
    } catch {
      return null;
    }
  }

  interface HostConfig {
    cpu_model?: string;
    nproc?: number;
    mem_total_kb?: number;
    kernel?: string;
    swappiness?: number;
    dirty_background_ratio?: number;
    dirty_ratio?: number;
    overcommit_memory?: number;
    swap_total_kb?: number;
    hugepagesize_kb?: number;
    file_max?: number;
  }

  const hostConfig = $derived(parseJson<HostConfig>(run?.host_config ?? null));

  function fmtMemKb(kb: number): string {
    if (kb >= 1024 * 1024) return `${(kb / 1024 / 1024).toFixed(1)} GB`;
    if (kb >= 1024) return `${(kb / 1024).toFixed(0)} MB`;
    return `${kb} KB`;
  }

  const pgbenchSteps = $derived(run?.steps.filter(s => s.type === 'pgbench') ?? []);
  const sysbenchSteps = $derived(run?.steps.filter(s => s.type === 'sysbench') ?? []);
  const perfSteps = $derived(run?.steps.filter(s => s.perfs?.length > 0) ?? []);

  $effect(() => {
    const nextRun = (data.run as Run | null) ?? null;
    run = nextRun;
    nameEdit = nextRun?.name ?? '';
    notesEdit = nextRun?.notes ?? '';
  });

  function appendLine(line: string) {
    if (!outputEl) { pendingLines.push(line); return; }
    outputEl.appendChild(document.createTextNode(line + '\n'));
    if (!scrollPending) {
      scrollPending = true;
      setTimeout(() => {
        if (outputEl) outputEl.scrollTop = outputEl.scrollHeight;
        scrollPending = false;
      }, 50);
    }
  }

  function flushPending() {
    if (!outputEl || pendingLines.length === 0) return;
    const frag = document.createDocumentFragment();
    for (const l of pendingLines) frag.appendChild(document.createTextNode(l + '\n'));
    outputEl.appendChild(frag);
    pendingLines.length = 0;
    outputEl.scrollTop = outputEl.scrollHeight;
  }

  async function loadRun(): Promise<void> {
    const res = await fetch(`/api/runs/${runId}`);
    run = await res.json();
  }

  function renderStoredOutput() {
    if (!run?.steps?.length || !outputEl) return;
    const frag = document.createDocumentFragment();
    for (const s of run.steps) {
      frag.appendChild(document.createTextNode(`\n=== Step: ${s.name} (${s.type}) ===\n`));
      if (s.stdout) frag.appendChild(document.createTextNode(s.stdout));
      if (s.stderr) {
        for (const line of s.stderr.split('\n')) {
          if (line) frag.appendChild(document.createTextNode('[stderr] ' + line + '\n'));
        }
      }
    }
    outputEl.appendChild(frag);
  }

  function applyPhaseEvent(data: { name: 'pre' | 'post'; status: 'running' | 'completed'; duration_secs: number; started_ms: number }) {
    const idx = phases.findIndex(p => p.name === data.name);
    if (data.status === 'running') {
      const phase: PhaseState = { ...data, elapsed_secs: Math.floor((Date.now() - data.started_ms) / 1000) };
      phases = idx >= 0 ? phases.map((p, i) => i === idx ? phase : p) : [...phases, phase];
      if (!phaseTimers.has(data.name)) {
        phaseTimers.set(data.name, setInterval(() => {
          phases = phases.map(p => p.name === data.name ? { ...p, elapsed_secs: p.elapsed_secs + 1 } : p);
        }, 1000));
      }
    } else {
      clearInterval(phaseTimers.get(data.name));
      phaseTimers.delete(data.name);
      phases = idx >= 0
        ? phases.map((p, i) => i === idx ? { ...p, status: 'completed' } : p)
        : [...phases, { ...data, elapsed_secs: data.duration_secs }];
    }
  }

  async function saveName() {
    editingName = false;
    if (!run) return;
    const trimmed = nameEdit.trim();
    await fetch(`/api/runs/${runId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: trimmed })
    });
    run = { ...run, name: trimmed };
  }

  async function saveNotesNow() {
    if (!run) return;
    if (notesTimer) { clearTimeout(notesTimer); notesTimer = null; }
    notesSaveStatus = 'saving';
    await fetch(`/api/runs/${runId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notes: notesEdit })
    });
    run = { ...run, notes: notesEdit };
    notesSaveStatus = 'saved';
    setTimeout(() => { notesSaveStatus = ''; }, 2500);
  }

  function onNotesInput(val?: string) {
    if (val !== undefined) notesEdit = val;
    if (notesTimer) clearTimeout(notesTimer);
    notesSaveStatus = '';
    notesTimer = setTimeout(saveNotesNow, 1000);
  }

  function onKeydown(e: KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault();
      saveNotesNow();
    }
    if (e.key === 'Escape' && notesFullscreen) {
      notesFullscreen = false;
    }
  }

  function connectSSE() {
    eventSource = new EventSource(`/api/runs/${runId}/stream`);
    eventSource.onmessage = (e) => {
      try { appendLine(JSON.parse(e.data)); } catch {}
    };
    eventSource.addEventListener('step', (e) => {
      try {
        const update = JSON.parse((e as MessageEvent).data) as { step_id: number; status: string; started_at?: string; finished_at?: string };
        if (run?.steps) {
          run.steps = run.steps.map(s =>
            s.step_id === update.step_id ? { ...s, ...update } : s
          );
        }
      } catch {}
    });
    eventSource.addEventListener('phase', (e) => {
      try { applyPhaseEvent(JSON.parse((e as MessageEvent).data)); } catch {}
    });
    eventSource.addEventListener('done', (e) => {
      finalStatus = (e as MessageEvent).data;
      done = true;
      eventSource?.close();
      // Mark any still-running phase as completed
      phases = phases.map(p => p.status === 'running' ? { ...p, status: 'completed' } : p);
      for (const t of phaseTimers.values()) clearInterval(t);
      phaseTimers.clear();
      loadRun();
    });
    eventSource.onerror = () => {
      if (!done) {
        eventSource?.close();
        done = true;
        loadRun();
      }
    };
  }

  async function stopRun() {
    await fetch(`/api/runs/${runId}`, { method: 'DELETE' });
    eventSource?.close();
    done = true;
    loadRun();
  }

  async function deleteRun() {
    if (!confirm(`Delete run #${runId}?`)) return;
    eventSource?.close();
    await fetch(`/api/runs/${runId}?action=delete`, { method: 'DELETE' });
    goto(`/designs/${designId}`);
  }

  async function checkEc2Status() {
    ec2StatusLoading = true;
    ec2StatusError = null;
    ec2Status = null;
    try {
      const res = await fetch(`/api/runs/${runId}/ec2-status`);
      if (!res.ok) { ec2StatusError = (await res.json().catch(() => ({}))).message ?? `Error ${res.status}`; return; }
      ec2Status = await res.json();
    } catch (e) {
      ec2StatusError = e instanceof Error ? e.message : String(e);
    } finally {
      ec2StatusLoading = false;
    }
  }

  async function openEc2Log(filename: string) {
    if (ec2LogFile === filename) { ec2LogFile = null; ec2LogContent = null; return; }
    ec2LogFile = filename;
    ec2LogContent = null;
    ec2LogLoading = true;
    try {
      const res = await fetch(`/api/runs/${runId}/ec2-logs?file=${encodeURIComponent(filename)}`);
      if (!res.ok) { ec2LogContent = `Error: ${(await res.json().catch(() => ({}))).message ?? res.status}`; return; }
      const data = await res.json();
      ec2LogContent = data.content;
    } catch (e) {
      ec2LogContent = `Error: ${e instanceof Error ? e.message : String(e)}`;
    } finally {
      ec2LogLoading = false;
    }
  }

  function toggleStep(stepId: number) {
    expandedStep = expandedStep === stepId ? null : stepId;
  }

  function perfWarnings(perf: StepPerf): string[] {
    return parseJson<string[]>(perf.warnings_json) ?? [];
  }

  function perfTopFunctions(perf: StepPerf): PerfTopFunction[] {
    return parseJson<{ top_functions?: PerfTopFunction[] }>(perf.result_json)?.top_functions ?? [];
  }

  function perfSyscalls(perf: StepPerf): SyscallEntry[] {
    return parseJson<{ syscall_summary?: SyscallEntry[] }>(perf.result_json)?.syscall_summary ?? [];
  }

  function setSyscallSort(col: SyscallSortKey) {
    if (syscallSort.col === col) {
      syscallSort = { col, asc: !syscallSort.asc };
      return;
    }
    syscallSort = { col, asc: col === 'syscall' };
  }

  function syscallSortLabel(col: SyscallSortKey): string {
    if (syscallSort.col !== col) return '';
    return syscallSort.asc ? ' ▲' : ' ▼';
  }

  function groupSyscalls(rows: SyscallEntry[]): SyscallGrouped[] {
    const map = new Map<string, SyscallGrouped>();
    for (const row of rows) {
      const key = row.syscall ?? '';
      let g = map.get(key);
      if (!g) {
        g = { syscall: key, calls: 0, errors: 0, avg_ms: 0, max_ms: 0, processes: [] };
        map.set(key, g);
      }
      g.calls += Number(row.calls ?? 0);
      g.errors += Number(row.errors ?? 0);
      g.max_ms = Math.max(g.max_ms, Number(row.max_ms ?? 0));
      g.processes.push(row);
    }
    // weighted average: sum(calls * avg_ms) / total_calls
    for (const g of map.values()) {
      const totalCalls = g.processes.reduce((s, r) => s + Number(r.calls ?? 0), 0);
      g.avg_ms = totalCalls > 0
        ? g.processes.reduce((s, r) => s + Number(r.calls ?? 0) * Number(r.avg_ms ?? 0), 0) / totalCalls
        : 0;
    }
    return [...map.values()];
  }

  function sortedGroupedSyscalls(groups: SyscallGrouped[]): SyscallGrouped[] {
    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    return [...groups].sort((a, b) => {
      let result: number;
      if (syscallSort.col === 'syscall') {
        result = collator.compare(a.syscall, b.syscall);
      } else {
        result = Number(a[syscallSort.col] ?? 0) - Number(b[syscallSort.col] ?? 0);
      }
      return syscallSort.asc ? result : -result;
    });
  }

  function toggleSyscall(syscall: string) {
    const next = new Set(expandedSyscalls);
    if (next.has(syscall)) next.delete(syscall);
    else next.add(syscall);
    expandedSyscalls = next;
  }

  function fmtMetric(value: number | null | undefined, digits = 2): string {
    if (value === null || value === undefined || Number.isNaN(value)) return '—';
    return value.toLocaleString(undefined, { maximumFractionDigits: digits });
  }

  function displayPerfEvent(perf: StepPerf, event: StepPerfEvent): StepPerfEvent {
    return correctPerfEvent(event, perf.raw_error ?? '');
  }

  function fmtDurationSecs(value: number | null | undefined): string {
    if (value === null || value === undefined || Number.isNaN(value)) return '—';
    if (value < 1) return `${fmtMetric(value * 1000, 2)} ms`;
    return `${fmtMetric(value, 3)} s`;
  }

  function fmtDerivedMetric(event: StepPerfEvent): string {
    if (event.derived_value === null || event.derived_value === undefined || Number.isNaN(event.derived_value)) return '—';
    const unit = event.derived_unit ? ` ${event.derived_unit}` : '';
    return `${fmtMetric(event.derived_value, 3)}${unit}`;
  }

  function scopeLabel(scope: StepPerf['scope']): string {
    if (scope === 'postgres_cgroup') return 'PostgreSQL service cgroup';
    if (scope === 'system') return 'System-wide';
    return 'Unavailable';
  }

  const PERF_GROUP_ORDER = ['CPU', 'Memory', 'Branch', 'Scheduler', 'Other'] as const;
  type PerfGroup = (typeof PERF_GROUP_ORDER)[number];

  interface PerfDisplayRow extends StepPerfEvent {
    group: PerfGroup;
    isHot: boolean;
  }

  function perfEventGroup(name: string): PerfGroup {
    const n = name.toLowerCase();
    if (/cache|llc|tlb/.test(n)) return 'Memory';
    if (/branch/.test(n)) return 'Branch';
    if (/context.switch|migration|fault/.test(n)) return 'Scheduler';
    if (/cycle|instruction|clock/.test(n)) return 'CPU';
    return 'Other';
  }

  function buildPerfRows(perf: StepPerf, totalTransactions?: number | null): Map<PerfGroup, PerfDisplayRow[]> {
    const events = (perf.events ?? []).map((e) => displayPerfEvent(perf, e));
    const findVal = (name: string) => events.find((e) => e.event_name === name)?.counter_value ?? null;

    const baseRows: PerfDisplayRow[] = events.map((event) => ({
      ...event,
      per_transaction: event.per_transaction ?? (totalTransactions && event.counter_value !== null ? event.counter_value / totalTransactions : null),
      group: perfEventGroup(event.event_name),
      isHot: false
    }));

    const perTxValues = baseRows
      .map((r) => r.per_transaction)
      .filter((v): v is number => v !== null && v > 0);
    if (perTxValues.length >= 3) {
      perTxValues.sort((a, b) => a - b);
      const threshold = perTxValues[Math.floor(perTxValues.length * 0.75)];
      for (const row of baseRows) {
        row.isHot = row.per_transaction !== null && row.per_transaction > 0 && row.per_transaction >= threshold;
      }
    }

    const grouped = new Map<PerfGroup, PerfDisplayRow[]>();
    for (const g of PERF_GROUP_ORDER) {
      const rows = baseRows.filter((r) => r.group === g);
      if (rows.length) grouped.set(g, rows);
    }
    return grouped;
  }

  async function startEditingName() {
    nameEdit = run?.name ?? '';
    editingName = true;
    await tick();
    nameInput?.focus();
    nameInput?.select();
  }

  onMount(() => {
    if (run?.status === 'running') {
      connectSSE();
      setTimeout(flushPending, 0);
    } else {
      done = true;
      finalStatus = run?.status ?? '';
      renderStoredOutput();
    }
  });

  onDestroy(() => {
    eventSource?.close();
    for (const t of phaseTimers.values()) clearInterval(t);
  });
</script>

<svelte:window onkeydown={onKeydown} />

<div class="row" style="margin-bottom:16px">
  <a href="/designs/{designId}" style="color:#0066cc; text-decoration:none; font-size:13px">← Design</a>
  {#if editingName}
    <input
      class="run-name-input"
      bind:value={nameEdit}
      bind:this={nameInput}
      onblur={saveName}
      onkeydown={(e) => { if (e.key === 'Enter') saveName(); if (e.key === 'Escape') { editingName = false; nameEdit = run?.name ?? ''; } }}
    />
  {:else}
    <button type="button" class="run-name-trigger" title="Click to edit name" onclick={startEditingName}>
      <span class="run-name-title">{run?.name || `Run #${runId}`}</span>
    </button>
  {/if}
  {#if run}
    <span class="badge badge-{run.status}">{run.status}</span>
    {#if run.profile_name}
      <span class="profile-badge">{run.profile_name}</span>
    {/if}
  {/if}
  <span class="spacer"></span>
  {#if run?.ec2_server_id && (run.status === 'running' || run.status === 'failed')}
    <button onclick={checkEc2Status} disabled={ec2StatusLoading}>
      {ec2StatusLoading ? 'Checking...' : 'VPS Status'}
    </button>
  {/if}
  {#if !done && run?.status === 'running'}
    <button class="danger" onclick={stopRun}>Stop Run</button>
  {/if}
  {#if done}
    <button class="danger" onclick={deleteRun}>Delete Run</button>
  {/if}
</div>

{#if ec2Status || ec2StatusError}
<div class="ec2-status-card">
  <div class="ec2-status-header">
    <strong>VPS Status</strong>
    <button class="ec2-status-close" onclick={() => { ec2Status = null; ec2StatusError = null; ec2LogFile = null; ec2LogContent = null; }}>✕</button>
  </div>
  {#if ec2StatusError}
    <p class="ec2-status-error">{ec2StatusError}</p>
  {:else if ec2Status}
    <div class="ec2-status-row">
      <span class="ec2-status-label">Process</span>
      {#if ec2Status.alive}
        <span class="badge badge-running">alive</span>
        {#if ec2Status.pid}<span class="ec2-pid">PID {ec2Status.pid}</span>{/if}
      {:else}
        <span class="badge badge-failed">not running</span>
      {/if}
    </div>
    <div class="ec2-status-row">
      <span class="ec2-status-label">Result file</span>
      {#if ec2Status.result_exists}
        <span class="badge badge-completed">exists</span>
      {:else}
        <span style="color:#888;font-size:12px">not found</span>
      {/if}
    </div>
    {#if ec2Status.log_files.length > 0}
      <div class="ec2-status-row ec2-log-files-row">
        <span class="ec2-status-label">Log files</span>
        <div class="ec2-log-files">
          {#each ec2Status.log_files as filename}
            <button class="ec2-log-btn" class:active={ec2LogFile === filename} onclick={() => openEc2Log(filename)}>
              {filename}
            </button>
          {/each}
        </div>
      </div>
      {#if ec2LogFile}
        <div class="ec2-log-viewer">
          <div class="ec2-log-viewer-title">{ec2LogFile}</div>
          {#if ec2LogLoading}
            <p style="color:#888;font-size:12px;padding:8px">Loading...</p>
          {:else}
            <pre class="ec2-log-content">{ec2LogContent ?? ''}</pre>
          {/if}
        </div>
      {/if}
    {:else}
      <div class="ec2-status-row">
        <span class="ec2-status-label">Log files</span>
        <span style="color:#888;font-size:12px">none found</span>
      </div>
    {/if}
  {/if}
</div>
{/if}

<div class="run-tabs">
  <button class="tab-btn" class:active={activeTab === 'overview'} onclick={() => activeTab = 'overview'}>Overview</button>
  <button class="tab-btn" class:active={activeTab === 'load'}
    disabled={!done}
    title={!done ? 'Available after run completes' : ''}
    onclick={() => activeTab = 'load'}>Load Analysis</button>
  <button class="tab-btn" class:active={activeTab === 'telemetry'}
    disabled={!done}
    title={!done ? 'Available after run completes' : ''}
    onclick={() => activeTab = 'telemetry'}>Database Telemetry</button>
  <button class="tab-btn" class:active={activeTab === 'perf'}
    disabled={!done}
    title={!done ? 'Available after run completes' : ''}
    onclick={() => activeTab = 'perf'}>Perf</button>
  <button class="tab-btn" class:active={activeTab === 'host_metrics'}
    disabled={!done}
    title={!done ? 'Available after run completes' : ''}
    onclick={() => activeTab = 'host_metrics'}>Host Metrics</button>
</div>

{#if activeTab === 'overview'}
{#if run}
  <div class="card" style="margin-bottom:12px">
    <div class="stats-row">
      <div class="stat">
        <div class="stat-label">TPS</div>
        <div class="stat-value">{run.tps?.toFixed(2) ?? '—'}</div>
      </div>
      <div class="stat">
        <div class="stat-label">Avg Latency</div>
        <div class="stat-value">{run.latency_avg_ms?.toFixed(3) ?? '—'} ms</div>
      </div>
      <div class="stat">
        <div class="stat-label">Stddev</div>
        <div class="stat-value">{run.latency_stddev_ms?.toFixed(3) ?? '—'} ms</div>
      </div>
      <div class="stat">
        <div class="stat-label">Transactions</div>
        <div class="stat-value">{run.transactions?.toLocaleString() ?? '—'}</div>
      </div>
      <div class="stat">
        <div class="stat-label">Started</div>
        <div class="stat-value">{fmtTs(run.started_at)}</div>
      </div>
      {#if run.finished_at}
        <div class="stat">
          <div class="stat-label">Finished</div>
          <div class="stat-value">{fmtTs(run.finished_at)}</div>
        </div>
      {/if}
    </div>
  </div>

  {#if pgbenchSteps.length > 0}
    <PgbenchOverview steps={pgbenchSteps} />
  {/if}

  {#if sysbenchSteps.length > 0}
    <SysbenchOverview steps={sysbenchSteps} />
  {/if}

  <!-- Collection phases -->
  {#if run.status === 'running' && (phases.length > 0 || (run.pre_collect_secs > 0 || run.post_collect_secs > 0))}
    <div class="card" style="margin-bottom:12px">
      <h3>Collection Phases</h3>
      <div class="phases-list">
        {#if run.pre_collect_secs > 0}
          {@const ph = phases.find(p => p.name === 'pre')}
          <div class="phase-row">
            <span class="phase-tag pre">pre-collect</span>
            <span class="phase-dur">{run.pre_collect_secs}s</span>
            {#if !ph}
              <span class="phase-status pending">pending</span>
            {:else if ph.status === 'running'}
              <span class="phase-status running">collecting…</span>
              <div class="phase-bar"><div class="phase-fill" style="width:{Math.min(100, (ph.elapsed_secs / ph.duration_secs) * 100).toFixed(1)}%"></div></div>
              <span class="phase-elapsed">{ph.elapsed_secs}s / {ph.duration_secs}s</span>
            {:else}
              <span class="phase-status done">✓ done</span>
            {/if}
          </div>
        {/if}
        {#if run.post_collect_secs > 0}
          {@const ph = phases.find(p => p.name === 'post')}
          <div class="phase-row">
            <span class="phase-tag post">post-collect</span>
            <span class="phase-dur">{run.post_collect_secs}s</span>
            {#if !ph}
              <span class="phase-status pending">pending</span>
            {:else if ph.status === 'running'}
              <span class="phase-status running">collecting…</span>
              <div class="phase-bar"><div class="phase-fill" style="width:{Math.min(100, (ph.elapsed_secs / ph.duration_secs) * 100).toFixed(1)}%"></div></div>
              <span class="phase-elapsed">{ph.elapsed_secs}s / {ph.duration_secs}s</span>
            {:else}
              <span class="phase-status done">✓ done</span>
            {/if}
          </div>
        {/if}
      </div>
    </div>
  {/if}

  {#if run.steps?.length > 0}
    <div class="card" style="margin-bottom:12px">
      <h3>Steps</h3>
      <table>
        <thead>
          <tr><th>Step</th><th>Type</th><th>Status</th><th>Started</th><th>Finished</th><th></th></tr>
        </thead>
        <tbody>
          {#each run.steps as s}
            <tr>
              <td>{s.name}</td>
              <td><span class="badge badge-{s.type}">{s.type}</span></td>
              <td><span class="badge badge-{s.status}">{s.status}</span></td>
              <td>{fmtTime(s.started_at)}</td>
              <td>{fmtTime(s.finished_at)}</td>
              <td>
                {#if s.command}
                  <button class="expand-btn" onclick={() => toggleStep(s.step_id)}>
                    {expandedStep === s.step_id ? '▲' : '▼'} details
                  </button>
                {/if}
              </td>
            </tr>
            {#if expandedStep === s.step_id && s.command}
              <tr class="detail-row">
                <td colspan="6">
                  <div class="detail-block">
                    <div class="detail-label">Command</div>
                    <pre class="detail-pre">{s.command}</pre>
                    {#if s.processed_script}
                      <div class="detail-label" style="margin-top:8px">Script</div>
                      <pre class="detail-pre">{s.processed_script}</pre>
                    {/if}
                  </div>
                </td>
              </tr>
            {/if}
          {/each}
        </tbody>
      </table>
    </div>
  {/if}

  <!-- run_params: Parameters used -->
  {#if run?.run_params}
    {@const parsedParams = (() => { try { return JSON.parse(run.run_params) as { name: string; value: string }[]; } catch { return []; } })()}
    {#if parsedParams.length > 0}
      <div class="card" style="margin-bottom:12px">
        <button type="button" class="run-params-toggle" onclick={() => showRunParams = !showRunParams}>
          <span class="run-params-title">Parameters used</span>
          <span class="run-params-meta">{showRunParams ? '▲' : '▼'} {parsedParams.length} param(s)</span>
        </button>
        {#if showRunParams}
          <div class="params-grid" style="margin-top:8px">
            {#each parsedParams as p}
              <div class="param-row">
                <code class="param-name">{p.name}</code>
                <code class="param-val">{p.value}</code>
              </div>
            {/each}
          </div>
        {/if}
      </div>
    {/if}
  {/if}

{/if}

{#if run && (run.runner_spec || run.db_spec || run.db_pg_config || hostConfig)}
  <div class="card" style="margin-bottom:12px">
    <h3 style="margin-bottom:10px">Instance Info</h3>
    <div class="instance-info-grid">
      {#if run.runner_spec}
        <div class="instance-info-row">
          <span class="instance-info-label">Runner</span>
          <span class="instance-info-val">{run.runner_spec}</span>
        </div>
      {/if}
      {#if hostConfig && !run.runner_spec}
        {#if hostConfig.cpu_model}
          <div class="instance-info-row">
            <span class="instance-info-label">CPU</span>
            <span class="instance-info-val">{hostConfig.cpu_model}{hostConfig.nproc != null ? ` × ${hostConfig.nproc}` : ''}</span>
          </div>
        {:else if hostConfig.nproc != null}
          <div class="instance-info-row">
            <span class="instance-info-label">vCPUs</span>
            <span class="instance-info-val">{hostConfig.nproc}</span>
          </div>
        {/if}
        {#if hostConfig.mem_total_kb != null}
          <div class="instance-info-row">
            <span class="instance-info-label">Memory</span>
            <span class="instance-info-val">{fmtMemKb(hostConfig.mem_total_kb)}{hostConfig.swap_total_kb ? ` + ${fmtMemKb(hostConfig.swap_total_kb)} swap` : ''}</span>
          </div>
        {/if}
        {#if hostConfig.kernel}
          <div class="instance-info-row">
            <span class="instance-info-label">Kernel</span>
            <span class="instance-info-val">{hostConfig.kernel}</span>
          </div>
        {/if}
      {/if}
      {#if run.db_spec}
        <div class="instance-info-row">
          <span class="instance-info-label">DB</span>
          <span class="instance-info-val">{run.db_spec}</span>
        </div>
      {/if}
      {#if run.db_pg_config}
        <div class="instance-info-row">
          <span class="instance-info-label">PG config</span>
          <pre class="instance-info-pre">{run.db_pg_config}</pre>
        </div>
      {/if}
      {#if hostConfig && !run.runner_spec && (hostConfig.swappiness != null || hostConfig.dirty_background_ratio != null || hostConfig.overcommit_memory != null)}
        <div class="instance-info-row">
          <span class="instance-info-label">OS params</span>
          <span class="instance-info-val" style="font-size:12px; color:#555">
            {[
              hostConfig.swappiness != null ? `swappiness=${hostConfig.swappiness}` : null,
              hostConfig.dirty_background_ratio != null ? `dirty_bg=${hostConfig.dirty_background_ratio}%` : null,
              hostConfig.dirty_ratio != null ? `dirty=${hostConfig.dirty_ratio}%` : null,
              hostConfig.overcommit_memory != null ? `overcommit=${hostConfig.overcommit_memory}` : null,
            ].filter(Boolean).join('  ')}
          </span>
        </div>
      {/if}
    </div>
  </div>
{/if}

<div class="card" style="margin-bottom:12px">
  <div class="row" style="margin-bottom:8px">
    <h3>Output</h3>
    {#if !done}
      <span style="font-size:12px; color:#856404">● Live</span>
    {:else}
      <span style="font-size:12px; color:#155724">✓ {finalStatus || 'Done'}</span>
    {/if}
  </div>
  {#if run?.is_imported && !run?.steps?.some((s: { stdout?: string }) => s.stdout)}
    <div style="padding:16px; color:#666; font-style:italic; font-size:13px">Logs not available for imported runs</div>
  {:else}
    <pre class="output" bind:this={outputEl}>{#if !done}<span class="cursor">▋</span>{/if}</pre>
  {/if}
</div>

<!-- Notes — split editor + live preview, or view-only; optional fullscreen -->
{#if run}
  <div class="card notes-card" class:notes-fullscreen={notesFullscreen}>
    <div class="notes-header">
      <h3 style="margin:0">Notes</h3>
      <span class="notes-hint">Markdown · ⌘S to save</span>
      {#if notesSaveStatus === 'saving'}
        <span class="notes-status saving">Saving…</span>
      {:else if notesSaveStatus === 'saved'}
        <span class="notes-status saved">✓ Saved</span>
      {/if}
      <div class="notes-mode-toggle">
        <button
          class="mode-btn"
          class:active={notesMode === 'edit'}
          onclick={() => notesMode = 'edit'}
          title="Edit mode"
        >✏ Edit</button>
        <button
          class="mode-btn"
          class:active={notesMode === 'view'}
          onclick={() => notesMode = 'view'}
          title="View mode"
        >👁 View</button>
      </div>
      <button
        class="fullscreen-btn"
        onclick={() => notesFullscreen = !notesFullscreen}
        title={notesFullscreen ? 'Exit fullscreen (Esc)' : 'Fullscreen'}
      >{notesFullscreen ? '⤓' : '⤢'}</button>
    </div>

    {#if notesMode === 'edit'}
      <div class="notes-split">
        <MarkdownEditor
          bind:value={notesEdit}
          onchange={onNotesInput}
          minHeight="200px"
        />
        <div class="notes-preview notes-content">
          {#if notesEdit.trim()}
            {@html marked(notesEdit)}
          {:else}
            <span class="notes-empty">Preview will appear here…</span>
          {/if}
        </div>
      </div>
    {:else}
      <div class="notes-content notes-view">
        {#if notesEdit.trim()}
          {@html marked(notesEdit)}
        {:else}
          <span class="notes-empty">No notes yet.</span>
        {/if}
      </div>
    {/if}
  </div>
{/if}
{:else if activeTab === 'load'}
  <div class="card">
    <LoadAnalysis
      runs={run ? [{ id: run.id, label: run.name || `Run #${run.id}`, color: '#0066cc',
        bench_started_at: run.bench_started_at, post_started_at: run.post_started_at,
        host_config: run.host_config ?? null }] : []}
      showPhaseFilter={true}
    />
  </div>
{:else if activeTab === 'telemetry'}
  <DatabaseTelemetry
    {runId}
    active={activeTab === 'telemetry' && done}
    excludeSectionKeys={['host_system', 'host_processes']}
  />
{:else if activeTab === 'perf'}
  {#if perfSteps.length > 0}
    <div class="perf-steps">
      {#each perfSteps as s}
        <div class="perf-card">
          <div class="perf-card-header">
            <div class="perf-card-title">
              <span class="perf-step-dot"></span>
              <span class="perf-step-name">{s.name}</span>
            </div>
          </div>

          {#each s.perfs as perf}
            {@const warnings = perfWarnings(perf)}
            <section class="perf-mode-section">
              <div class="perf-mode-heading">
                <div class="perf-card-title">
                  <span class="badge">{perf.mode ?? 'stat'}</span>
                  <span class="badge badge-{perf.status ?? 'pending'}">{perf.status}</span>
                </div>
                <div class="perf-card-meta">
                  <span class="perf-scope-pill perf-scope-{perf.scope ?? 'disabled'}">{scopeLabel(perf.scope ?? 'disabled')}</span>
                  {#if perf.cgroup}<span class="perf-cgroup">{perf.cgroup}</span>{/if}
                </div>
              </div>

              {#if warnings.length > 0}
                <div class="perf-warnings">
                  {#each warnings as warning}
                    <div class="perf-warning-row">⚠ {warning}</div>
                  {/each}
                </div>
              {/if}

              {#if (perf.mode ?? 'stat') === 'stat' && perf.events.length}
                {@const groupedRows = buildPerfRows(perf, run?.transactions)}
                <div class="perf-events-wrap">
                  <div class="table-copy-header">
                    <CopyTableButton getMarkdown={() => {
                      const rows: (string | number | null)[][] = [];
                      for (const group of PERF_GROUP_ORDER) {
                        const groupRows = groupedRows.get(group);
                        if (!groupRows) continue;
                        rows.push([`**${group}**`, '', '', '', '']);
                        for (const row of groupRows) {
                          rows.push([
                            row.event_name,
                            row.counter_value !== null ? fmtMetric(row.counter_value, 3) : '—',
                            row.per_transaction !== null ? fmtMetric(row.per_transaction, 3) : '—',
                            fmtDerivedMetric(row),
                            row.percent_running !== null ? `${fmtMetric(row.percent_running, 2)}%` : '—'
                          ]);
                        }
                      }
                      return markdownTable(['Event', 'Total', 'Per Tx', 'Derived', 'Coverage'], rows);
                    }} />
                  </div>
                  <table class="perf-events-table">
                    <thead>
                      <tr>
                        <th class="col-event">Event</th>
                        <th class="col-num">Total</th>
                        <th class="col-num">Per Tx</th>
                        <th class="col-num">Derived</th>
                        <th class="col-num">Coverage</th>
                      </tr>
                    </thead>
                    <tbody>
                      {#each PERF_GROUP_ORDER as group}
                        {#if groupedRows.has(group)}
                          <tr class="perf-group-header"><td colspan="5">{group}</td></tr>
                          {#each groupedRows.get(group) ?? [] as row}
                            <tr class:perf-hot={row.isHot}>
                              <td class="col-event">
                                <code class="event-name">{row.event_name}</code>
                                {#if row.isHot}<span class="hot-badge">↑ hot</span>{/if}
                              </td>
                              <td class="col-num">{fmtMetric(row.counter_value, 3)}{#if row.unit} <span class="unit">{row.unit}</span>{/if}</td>
                              <td class="col-num">{fmtMetric(row.per_transaction, 3)}</td>
                              <td class="col-num">{fmtDerivedMetric(row)}</td>
                              <td class="col-num">
                                {#if row.percent_running !== null}{fmtMetric(row.percent_running, 2)}<span class="unit">%</span>{:else}—{/if}
                              </td>
                            </tr>
                          {/each}
                        {/if}
                      {/each}
                    </tbody>
                  </table>
                </div>
              {:else if perf.mode === 'record'}
                {@const topFunctions = perfTopFunctions(perf)}
                <div class="perf-events-wrap">
                  <div class="perf-record-actions">
                    <a class="button-link" href={`/api/runs/${runId}/perf-script/${s.step_id}?mode=record`}>Download perf script</a>
                    <div class="table-copy-header">
                      <CopyTableButton getMarkdown={() => {
                        const rows = topFunctions.map(row => [`${fmtMetric(row.overhead, 2)}%`, row.symbol, row.dso]);
                        return markdownTable(['Overhead', 'Symbol', 'DSO'], rows);
                      }} />
                    </div>
                  </div>
                  <table class="perf-events-table">
                    <thead>
                      <tr>
                        <th class="col-num">Overhead</th>
                        <th>Symbol</th>
                        <th>DSO</th>
                      </tr>
                    </thead>
                    <tbody>
                      {#each topFunctions as row}
                        <tr>
                          <td class="col-num">{fmtMetric(row.overhead, 2)}<span class="unit">%</span></td>
                          <td><code class="event-name">{row.symbol}</code></td>
                          <td>{row.dso}</td>
                        </tr>
                      {:else}
                        <tr><td colspan="3">No top functions parsed.</td></tr>
                      {/each}
                    </tbody>
                  </table>
                </div>
              {:else if perf.mode === 'trace'}
                {@const syscallGroups = sortedGroupedSyscalls(groupSyscalls(perfSyscalls(perf)))}
                <div class="perf-events-wrap">
                  <div class="table-copy-header">
                    <CopyTableButton getMarkdown={() => {
                      const rows = syscallGroups.map(g => [g.syscall, fmtMetric(g.calls, 0), fmtMetric(g.errors, 0), fmtMetric(g.avg_ms, 3), fmtMetric(g.max_ms, 3)]);
                      return markdownTable(['Syscall', 'Calls', 'Errors', 'Avg ms', 'Max ms'], rows);
                    }} />
                  </div>
                  <table class="perf-events-table">
                    <thead>
                      <tr>
                        <th class="col-expand"></th>
                        <th class="sortable" onclick={() => setSyscallSort('syscall')}>Syscall{syscallSortLabel('syscall')}</th>
                        <th class="col-num sortable" onclick={() => setSyscallSort('calls')}>Calls{syscallSortLabel('calls')}</th>
                        <th class="col-num sortable" onclick={() => setSyscallSort('errors')}>Errors{syscallSortLabel('errors')}</th>
                        <th class="col-num sortable" onclick={() => setSyscallSort('avg_ms')}>Avg ms{syscallSortLabel('avg_ms')}</th>
                        <th class="col-num sortable" onclick={() => setSyscallSort('max_ms')}>Max ms{syscallSortLabel('max_ms')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {#each syscallGroups as g}
                        {@const expanded = expandedSyscalls.has(g.syscall)}
                        <tr class="syscall-group-row" class:syscall-expanded={expanded}>
                          <td class="col-expand">
                            {#if g.processes.length > 1}
                              <button class="expand-btn" onclick={() => toggleSyscall(g.syscall)}>{expanded ? '▾' : '▸'}</button>
                            {/if}
                          </td>
                          <td><code class="event-name">{g.syscall}</code></td>
                          <td class="col-num">{fmtMetric(g.calls, 0)}</td>
                          <td class="col-num">{fmtMetric(g.errors, 0)}</td>
                          <td class="col-num">{fmtMetric(g.avg_ms, 3)}</td>
                          <td class="col-num">{fmtMetric(g.max_ms, 3)}</td>
                        </tr>
                        {#if expanded}
                          {#each g.processes as row}
                            <tr class="syscall-process-row">
                              <td></td>
                              <td class="syscall-process-name">{row.process}{#if row.pid} <span class="unit">({row.pid})</span>{/if}</td>
                              <td class="col-num">{fmtMetric(row.calls, 0)}</td>
                              <td class="col-num">{fmtMetric(row.errors, 0)}</td>
                              <td class="col-num">{fmtMetric(row.avg_ms, 3)}</td>
                              <td class="col-num">{fmtMetric(row.max_ms, 3)}</td>
                            </tr>
                          {/each}
                        {/if}
                      {:else}
                        <tr><td colspan="6">No syscall summary parsed.</td></tr>
                      {/each}
                    </tbody>
                  </table>
                </div>
              {/if}

              {#if perf.command}
                <details class="perf-detail-toggle">
                  <summary class="perf-detail-summary">Perf command</summary>
                  <pre class="detail-pre perf-detail-pre">{perf.command}</pre>
                </details>
              {/if}
              {#if perf.raw_error}
                <details class="perf-detail-toggle">
                  <summary class="perf-detail-summary">Raw output</summary>
                  <pre class="detail-pre perf-detail-pre">{perf.raw_error}</pre>
                </details>
              {/if}
            </section>
          {/each}
        </div>
      {/each}
    </div>
  {:else}
    <div class="card">
      <h3>Perf</h3>
      <p style="color:#666;font-size:13px;margin:0">No perf data was collected for this run.</p>
    </div>
  {/if}
{:else if activeTab === 'host_metrics'}
  <div class="host-sub-tabs">
    <button
      class="host-sub-btn"
      class:active={hostSubTab === 'system'}
      onclick={() => hostSubTab = 'system'}
    >System</button>
    <button
      class="host-sub-btn"
      class:active={hostSubTab === 'processes'}
      onclick={() => hostSubTab = 'processes'}
    >Processes</button>
  </div>
  <DatabaseTelemetry
    {runId}
    active={activeTab === 'host_metrics' && done}
    title={hostSubTab === 'system' ? 'System Metrics' : 'Process Metrics'}
    includeSectionKeys={hostSubTab === 'system' ? ['host_system'] : ['host_processes']}
    showHeroCards={false}
  />
{/if}

<style>
  .run-tabs { display: flex; gap: 2px; margin-bottom: 16px; border-bottom: 2px solid #e8e8e8; }
  .tab-btn { background: none; border: none; padding: 8px 16px; font-size: 13px; font-weight: 600; color: #888; cursor: pointer; border-bottom: 2px solid transparent; margin-bottom: -2px; border-radius: 4px 4px 0 0; transition: color 0.15s; }
  .tab-btn:hover:not(:disabled) { color: #333; background: #f5f5f5; }
  .tab-btn.active { color: #0066cc; border-bottom-color: #0066cc; }
  .tab-btn:disabled { cursor: not-allowed; opacity: 0.4; }

  .stats-row { display: flex; gap: 20px; flex-wrap: wrap; }
  .stat { min-width: 100px; }
  .stat-label { font-size: 11px; color: #666; font-weight: 600; text-transform: uppercase; }
  .stat-value { font-size: 18px; font-weight: 700; color: #333; }
  .expand-btn { font-size: 11px; padding: 2px 6px; background: none; border: 1px solid #ccc; border-radius: 3px; cursor: pointer; color: #555; }
  .expand-btn:hover { background: #f0f0f0; }
  .detail-row td { padding: 0 !important; }
  .detail-block { padding: 8px 12px; background: #f8f8f8; border-top: 1px solid #eee; }
  .detail-label { font-size: 10px; font-weight: 700; color: #888; text-transform: uppercase; margin-bottom: 4px; }
  .detail-pre { margin: 0; font-size: 12px; white-space: pre-wrap; word-break: break-all; background: #1e1e1e; color: #d4d4d4; padding: 8px; border-radius: 4px; max-height: 200px; overflow-y: auto; }
  /* Perf tab */
  .perf-steps { display: flex; flex-direction: column; gap: 12px; }
  .perf-card { background: #fff; border: 1px solid #e0e0e0; border-radius: 8px; padding: 16px 18px; }
  .perf-card-header { margin-bottom: 12px; }
  .perf-card-title { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
  .perf-mode-section { padding-top: 12px; margin-top: 12px; border-top: 1px solid #eee; }
  .perf-mode-section:first-of-type { padding-top: 0; margin-top: 0; border-top: 0; }
  .perf-mode-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 10px; }
  .perf-step-dot { width: 8px; height: 8px; border-radius: 50%; background: #0066cc; flex-shrink: 0; }
  .perf-step-name { font-size: 14px; font-weight: 700; color: #222; }
  .perf-card-meta { display: flex; align-items: center; gap: 8px; padding-left: 16px; }
  .perf-scope-pill { font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 10px; white-space: nowrap; }
  .perf-scope-postgres_cgroup { background: #e8f0ff; color: #0044bb; }
  .perf-scope-system { background: #f0e8ff; color: #6600aa; }
  .perf-scope-disabled { background: #f0f0f0; color: #888; }
  .perf-cgroup { font-size: 11px; color: #999; font-family: monospace; }
  .perf-warnings { margin-bottom: 12px; padding: 8px 12px; background: #fff8e8; border: 1px solid #f3dfaa; border-radius: 6px; color: #7a4f00; font-size: 12px; display: flex; flex-direction: column; gap: 4px; }
  .perf-warning-row { display: flex; align-items: flex-start; gap: 6px; }
  .perf-events-wrap { margin-bottom: 10px; border: 1px solid #e8e8e8; border-radius: 6px; overflow: hidden; }
  .perf-record-actions { display: flex; align-items: center; gap: 8px; padding: 8px 10px; background: #fafafa; border-bottom: 1px solid #e8e8e8; }
  .table-copy-header { display: flex; justify-content: flex-end; padding: 4px 8px; background: #fafafa; border-bottom: 1px solid #e8e8e8; }
  .button-link { display: inline-flex; align-items: center; padding: 5px 10px; border: 1px solid #cbd5e1; border-radius: 4px; background: #fff; color: #0044bb; font-size: 12px; font-weight: 700; text-decoration: none; }
  .button-link:hover { background: #f5f7fa; }
  .perf-events-table { width: 100%; font-size: 12px; border-collapse: collapse; background: #fff; }
  .perf-events-table thead tr { background: #f5f7fa; }
  .perf-events-table th { padding: 7px 10px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.03em; color: #888; white-space: nowrap; }
  .perf-events-table td { padding: 7px 10px; border-top: 1px solid #f0f0f0; color: #333; }
  .perf-events-table tbody tr:hover { background: #f8f9fc; }
  .perf-events-table th.sortable { cursor: pointer; user-select: none; }
  .perf-events-table th.sortable:hover { background: #eef2ff; color: #555; }
  .col-event { text-align: left; }
  .col-num { text-align: right; }
  .event-name { font-family: monospace; font-size: 12px; background: #f0f4ff; color: #0044bb; padding: 1px 6px; border-radius: 3px; }
  .unit { color: #bbb; font-size: 11px; margin-left: 1px; }
  .perf-detail-toggle { margin-top: 6px; }
  .perf-detail-toggle + .perf-detail-toggle { margin-top: 4px; }
  .perf-detail-summary { font-size: 11px; font-weight: 700; color: #999; text-transform: uppercase; letter-spacing: 0.03em; cursor: pointer; user-select: none; padding: 3px 0; list-style: none; display: flex; align-items: center; gap: 5px; }
  .perf-detail-summary::-webkit-details-marker { display: none; }
  .perf-detail-summary::before { content: '▶'; font-size: 8px; transition: transform 0.15s; color: #bbb; }
  details[open] > .perf-detail-summary::before { transform: rotate(90deg); }
  .perf-detail-pre { margin-top: 6px; }
  .perf-group-header td { background: #f5f7fa; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: #888; padding: 4px 10px; }
  .col-expand { width: 28px; padding: 4px 4px 4px 8px !important; }
  .syscall-group-row td { font-weight: 500; }
  .syscall-process-row td { background: #fafbff; color: #555; font-size: 11px; }
  .syscall-process-row .col-num { color: #666; }
  .syscall-process-name { padding-left: 24px !important; color: #777; font-family: monospace; font-size: 11px; }
  .perf-hot { background: #fffbf0 !important; }
  .perf-hot .col-event { border-left: 3px solid #f59e0b; padding-left: 7px; }
  .hot-badge { font-size: 10px; font-weight: 700; color: #b45309; background: #fef3c7; border: 1px solid #fcd34d; border-radius: 3px; padding: 0 4px; margin-left: 5px; vertical-align: middle; }
  .cursor { animation: blink 1s step-end infinite; }
  @keyframes blink { 0%,100% { opacity: 1; } 50% { opacity: 0; } }

  /* Collection phases */
  .phases-list { display: flex; flex-direction: column; gap: 8px; }
  .phase-row { display: flex; align-items: center; gap: 10px; font-size: 12px; }
  .phase-tag { padding: 2px 8px; border-radius: 10px; font-weight: 700; font-size: 11px; white-space: nowrap; }
  .phase-tag.pre  { background: #e8f4ff; color: #0055aa; }
  .phase-tag.post { background: #fff8e8; color: #885500; }
  .phase-dur { color: #888; font-size: 11px; min-width: 28px; }
  .phase-status { font-size: 11px; font-weight: 600; min-width: 80px; }
  .phase-status.pending { color: #aaa; }
  .phase-status.running { color: #0066cc; animation: pulse 1.5s ease-in-out infinite; }
  .phase-status.done    { color: #00884d; }
  .phase-bar { flex: 1; max-width: 200px; height: 6px; background: #eee; border-radius: 3px; overflow: hidden; }
  .phase-fill { height: 100%; background: #0066cc; border-radius: 3px; transition: width 0.8s linear; }
  .phase-elapsed { color: #666; font-size: 11px; }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.5; } }

  .profile-badge {
    background: #e8d8ff; color: #5500aa; font-size: 11px; font-weight: 700;
    padding: 2px 8px; border-radius: 10px; margin-left: 6px;
  }
  .run-name-trigger {
    margin-left: 8px;
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
    text-align: left;
  }
  .run-name-title {
    font-size: 32px;
    font-weight: 700;
    color: #222;
    line-height: 1.2;
  }
  .run-name-input {
    margin-left: 8px; font-size: 22px; font-weight: 700;
    border: none; border-bottom: 2px solid #0066cc;
    background: transparent; outline: none; color: #222;
    flex: 1; min-width: 0;
  }
  .run-params-toggle {
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
    text-align: left;
  }
  .run-params-title { font-size: 18px; font-weight: 600; color: #222; }
  .run-params-meta { color: #888; font-size: 12px; }
  .instance-info-grid { display: flex; flex-direction: column; gap: 8px; }
  .instance-info-row { display: flex; align-items: baseline; gap: 12px; }
  .instance-info-label { font-size: 11px; font-weight: 600; text-transform: uppercase; color: #888; min-width: 70px; }
  .instance-info-val { font-size: 13px; color: #333; }
  .instance-info-pre { margin: 0; font-size: 12px; color: #333; font-family: monospace; white-space: pre-wrap; background: #f7f7f7; border: 1px solid #e0e0e0; border-radius: 4px; padding: 6px 8px; }
  .params-grid { display: flex; flex-direction: column; gap: 4px; }
  .param-row { display: flex; align-items: center; gap: 8px; }
  .param-name { background: #f0f0f0; color: #5500aa; padding: 1px 6px; border-radius: 3px; font-size: 12px; }
  .param-val  { color: #007a2e; font-size: 12px; }
  .notes-card { display: flex; flex-direction: column; }
  .notes-fullscreen {
    position: fixed; inset: 0; z-index: 1000;
    border-radius: 0; margin: 0;
    display: flex; flex-direction: column;
  }
  .notes-fullscreen .notes-split {
    flex: 1; min-height: 0;
  }
  .notes-fullscreen .notes-split > :global(.md-editor-root),
  .notes-fullscreen .notes-split .notes-preview {
    min-height: unset; height: 100%;
  }
  .notes-fullscreen .notes-view {
    flex: 1; overflow-y: auto;
  }
  .notes-header { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; flex-wrap: wrap; }
  .notes-hint { font-size: 11px; color: #aaa; }
  .notes-status { font-size: 11px; }
  .notes-mode-toggle { display: flex; margin-left: auto; border: 1px solid #ddd; border-radius: 5px; overflow: hidden; }
  .mode-btn {
    background: none; border: none; padding: 3px 10px; font-size: 12px;
    cursor: pointer; color: #888; border-radius: 0;
  }
  .mode-btn:hover { background: #f5f5f5; color: #333; }
  .mode-btn.active { background: #0066cc; color: #fff; }
  .fullscreen-btn {
    background: none; border: 1px solid #ddd; border-radius: 5px;
    padding: 3px 8px; font-size: 14px; cursor: pointer; color: #888; line-height: 1;
  }
  .fullscreen-btn:hover { background: #f5f5f5; color: #333; border-color: #aaa; }
  .notes-view { padding: 2px 0; min-height: 40px; }
  .notes-status.saving { color: #888; }
  .notes-status.saved { color: #00884d; }
  .notes-split {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
    align-items: stretch;
  }
  .notes-preview {
    border: 1px solid #eee; border-radius: 4px; padding: 10px;
    min-height: 200px; overflow-y: auto; background: #fff;
  }
  .notes-empty { color: #ccc; font-style: italic; font-size: 13px; }
  .notes-content { font-size: 13px; line-height: 1.6; color: #333; }
  .notes-content :global(h1), .notes-content :global(h2), .notes-content :global(h3) { margin: 0 0 8px; font-size: 15px; }
  .notes-content :global(p) { margin: 0 0 8px; }
  .notes-content :global(ul), .notes-content :global(ol) { margin: 0 0 8px; padding-left: 20px; }
  .notes-content :global(pre) { background: #f5f5f5; padding: 8px; border-radius: 4px; overflow-x: auto; }
  .notes-content :global(code) { background: #f5f5f5; padding: 1px 4px; border-radius: 3px; font-size: 12px; font-family: monospace; }
  .notes-content :global(blockquote) { border-left: 3px solid #ddd; margin: 0 0 8px; padding-left: 10px; color: #666; }

  .host-sub-tabs { display: flex; gap: 4px; margin-bottom: 12px; }
  .host-sub-btn { background: #f0f4ff; border: 1px solid #c8d8f5; border-radius: 6px; padding: 5px 14px; font-size: 12px; font-weight: 600; color: #3355aa; cursor: pointer; }
  .host-sub-btn:hover { background: #dce8ff; border-color: #aabfe8; }
  .host-sub-btn.active { background: #0066cc; border-color: #0055bb; color: #fff; }

  .ec2-status-card { background: #fff; border: 1px solid #d0d0d0; border-radius: 6px; padding: 12px 14px; margin-bottom: 16px; }
  .ec2-status-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
  .ec2-status-header strong { font-size: 13px; }
  .ec2-status-close { background: none; border: none; cursor: pointer; font-size: 14px; color: #888; padding: 0 2px; line-height: 1; }
  .ec2-status-close:hover { color: #333; }
  .ec2-status-row { display: flex; align-items: flex-start; gap: 10px; margin-bottom: 8px; font-size: 12px; }
  .ec2-status-label { font-weight: 600; color: #555; min-width: 80px; padding-top: 2px; }
  .ec2-pid { font-size: 11px; color: #666; font-family: monospace; padding-top: 2px; }
  .ec2-status-error { color: #a00; font-size: 12px; margin: 0; }
  .ec2-log-files-row { align-items: flex-start; }
  .ec2-log-files { display: flex; flex-wrap: wrap; gap: 6px; }
  .ec2-log-btn { background: #f0f4ff; border: 1px solid #c0cff5; border-radius: 4px; padding: 3px 8px; font-size: 11px; font-family: monospace; cursor: pointer; color: #0044aa; }
  .ec2-log-btn:hover { background: #dce8ff; }
  .ec2-log-btn.active { background: #0066cc; color: #fff; border-color: #0055bb; }
  .ec2-log-viewer { margin-top: 10px; border: 1px solid #e0e0e0; border-radius: 4px; overflow: hidden; }
  .ec2-log-viewer-title { background: #f5f5f5; border-bottom: 1px solid #e0e0e0; padding: 4px 10px; font-size: 11px; font-family: monospace; font-weight: 600; color: #444; }
  .ec2-log-content { margin: 0; padding: 10px; font-size: 11px; line-height: 1.5; overflow-x: auto; max-height: 400px; overflow-y: auto; white-space: pre-wrap; word-break: break-all; background: #fafafa; }
</style>
