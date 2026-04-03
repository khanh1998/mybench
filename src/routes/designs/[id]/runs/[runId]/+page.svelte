<script lang="ts">
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import { onMount, onDestroy, tick } from 'svelte';
  import { marked } from 'marked';
  import MarkdownEditor from '$lib/MarkdownEditor.svelte';
  import LoadAnalysis from '$lib/LoadAnalysis.svelte';
  import DatabaseTelemetry from '$lib/DatabaseTelemetry.svelte';
  import LineChart from '$lib/LineChart.svelte';
  import { parsePgbenchProgress } from '$lib/pgbench-progress';
  import {
    parsePgbenchFinalOutput,
    parseProcessedPgbenchScripts,
    type PgbenchScriptResult,
    type PgbenchStepSummary
  } from '$lib/pgbench-results';
  import type { PageData } from './$types';
  import { fmtTs, fmtTime } from '$lib/utils';

  let { data }: { data: PageData } = $props();

  const designId = $derived(Number($page.params.id));
  const runId = $derived(Number($page.params.runId));

  interface StepResult {
    id: number; step_id: number; name: string; type: string; status: string;
    stdout: string; stderr: string; started_at: string|null; finished_at: string|null;
    command: string; processed_script: string;
    pgbench_summary_json: string; pgbench_scripts_json: string;
  }
  interface Run {
    id: number; status: string; tps: number|null; latency_avg_ms: number|null;
    latency_stddev_ms: number|null; transactions: number|null;
    started_at: string; finished_at: string|null;
    bench_started_at: string|null; post_started_at: string|null;
    pre_collect_secs: number; post_collect_secs: number;
    is_imported?: number;
    name: string; notes: string; profile_name: string; run_params: string;
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
  interface PgbenchStepSection {
    step_id: number;
    step_name: string;
    summary: PgbenchStepSummary | null;
    scripts: PgbenchScriptResult[];
    snapshotUnavailable: boolean;
  }
  interface PgbenchDetailSection {
    step_id: number;
    step_name: string;
    details: { label: string; value: string }[];
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
  let expandedBenchmarkScript = $state<string | null>(null);
  let scrollPending = false;
  let phases: PhaseState[] = $state([]);
  let activeTab = $state<'overview' | 'load' | 'telemetry' | 'cloudwatch'>('overview');
  let nameInput = $state<HTMLInputElement | null>(null);
  let ec2StatusLoading = $state(false);
  let ec2Status = $state<Ec2Status | null>(null);
  let ec2StatusError = $state<string | null>(null);
  let ec2LogFile = $state<string | null>(null);
  let ec2LogContent = $state<string | null>(null);
  let ec2LogLoading = $state(false);
  const phaseTimers = new Map<string, ReturnType<typeof setInterval>>();

  const pendingLines: string[] = [];

  const pgbenchProgressData = $derived.by(() => {
    if (!run) return null;
    const pgbenchStep = run.steps.find((s) => s.type === 'pgbench' && s.stdout);
    if (!pgbenchStep) return null;
    const points = parsePgbenchProgress(pgbenchStep.stdout);
    if (points.length < 2) return null;
    const interval = Math.round(points[1].elapsedSec - points[0].elapsedSec) || 5;
    const totalFailed = points.reduce((acc, p) => acc + p.failed, 0);
    return {
      points,
      interval,
      totalFailed,
      tpsSeries: [{ label: 'TPS', color: '#0066cc', points: points.map((p) => ({ t: p.elapsedSec * 1000, v: p.tps })) }],
      latSeries: [{ label: 'Avg Latency (ms)', color: '#e6531d', points: points.map((p) => ({ t: p.elapsedSec * 1000, v: p.latAvgMs })) }],
      stddevSeries: [{ label: 'Latency Stddev (ms)', color: '#9b36b7', points: points.map((p) => ({ t: p.elapsedSec * 1000, v: p.latStddevMs })) }],
      failedSeries: totalFailed > 0
        ? [{ label: 'Failed', color: '#cc0000', points: points.map((p) => ({ t: p.elapsedSec * 1000, v: p.failed })) }]
        : []
    };
  });

  function parseJson<T>(value: string | null | undefined): T | null {
    if (!value?.trim()) return null;
    try {
      return JSON.parse(value) as T;
    } catch {
      return null;
    }
  }

  function getStepOutput(step: Pick<StepResult, 'stdout' | 'stderr'>): string {
    return [step.stdout ?? '', step.stderr ?? '']
      .filter((part) => part.trim().length > 0)
      .join('\n');
  }

  function mergePgbenchSummary(
    storedSummary: PgbenchStepSummary | null,
    parsedSummary: PgbenchStepSummary | null
  ): PgbenchStepSummary | null {
    if (!storedSummary && !parsedSummary) return null;

    const summary: PgbenchStepSummary = {
      tps: storedSummary?.tps ?? parsedSummary?.tps ?? null,
      latency_avg_ms: storedSummary?.latency_avg_ms ?? parsedSummary?.latency_avg_ms ?? null,
      latency_stddev_ms: storedSummary?.latency_stddev_ms ?? parsedSummary?.latency_stddev_ms ?? null,
      transactions: storedSummary?.transactions ?? parsedSummary?.transactions ?? null,
      failed_transactions: storedSummary?.failed_transactions ?? parsedSummary?.failed_transactions ?? null,
      transaction_type: storedSummary?.transaction_type ?? parsedSummary?.transaction_type ?? null,
      scaling_factor: storedSummary?.scaling_factor ?? parsedSummary?.scaling_factor ?? null,
      query_mode: storedSummary?.query_mode ?? parsedSummary?.query_mode ?? null,
      number_of_clients: storedSummary?.number_of_clients ?? parsedSummary?.number_of_clients ?? null,
      number_of_threads: storedSummary?.number_of_threads ?? parsedSummary?.number_of_threads ?? null,
      maximum_tries: storedSummary?.maximum_tries ?? parsedSummary?.maximum_tries ?? null,
      duration_secs: storedSummary?.duration_secs ?? parsedSummary?.duration_secs ?? null,
      initial_connection_time_ms: storedSummary?.initial_connection_time_ms ?? parsedSummary?.initial_connection_time_ms ?? null
    };

    if (Object.values(summary).every((value) => value == null)) return null;
    return summary;
  }

  function getPgbenchDetailEntries(summary: PgbenchStepSummary | null): Array<{ label: string; value: string }> {
    if (!summary) return [];

    const details: Array<{ label: string; value: string }> = [];
    if (summary.transaction_type) details.push({ label: 'Transaction Type', value: summary.transaction_type });
    if (summary.scaling_factor != null) details.push({ label: 'Scaling Factor', value: String(summary.scaling_factor) });
    if (summary.query_mode) details.push({ label: 'Query Mode', value: summary.query_mode });
    if (summary.number_of_clients != null) details.push({ label: 'Clients', value: summary.number_of_clients.toLocaleString() });
    if (summary.number_of_threads != null) details.push({ label: 'Threads', value: summary.number_of_threads.toLocaleString() });
    if (summary.maximum_tries != null) details.push({ label: 'Maximum Tries', value: summary.maximum_tries.toLocaleString() });
    if (summary.duration_secs != null) details.push({ label: 'Duration', value: `${summary.duration_secs.toLocaleString()} s` });
    if (summary.initial_connection_time_ms != null) {
      details.push({ label: 'Initial Connection Time', value: `${summary.initial_connection_time_ms.toFixed(3)} ms` });
    }

    return details;
  }

  function buildHistoricalPgbenchScripts(step: StepResult, parsedScripts: PgbenchScriptResult[]): PgbenchScriptResult[] {
    const snapshotScripts = parseProcessedPgbenchScripts(step.processed_script);
    const maxLength = Math.max(parsedScripts.length, snapshotScripts.length);
    const merged: PgbenchScriptResult[] = [];

    for (let index = 0; index < maxLength; index += 1) {
      const parsedScript = parsedScripts.find((script) => script.position === index);
      const snapshotScript = snapshotScripts.find((script) => script.position === index);
      if (!parsedScript && !snapshotScript) continue;
      merged.push({
        position: index,
        name: snapshotScript?.name ?? parsedScript?.name ?? `Script ${index + 1}`,
        weight: snapshotScript?.weight ?? parsedScript?.weight ?? null,
        script: snapshotScript?.script ?? '',
        tps: parsedScript?.tps ?? null,
        latency_avg_ms: parsedScript?.latency_avg_ms ?? null,
        latency_stddev_ms: parsedScript?.latency_stddev_ms ?? null,
        transactions: parsedScript?.transactions ?? null,
        failed_transactions: parsedScript?.failed_transactions ?? null
      });
    }

    return merged;
  }

  function mergePgbenchScripts(
    storedScripts: PgbenchScriptResult[] | null,
    parsedScripts: PgbenchScriptResult[],
    step: StepResult
  ): PgbenchScriptResult[] {
    const fallbackScripts = buildHistoricalPgbenchScripts(step, parsedScripts);
    if (!storedScripts || storedScripts.length === 0) return fallbackScripts;

    const merged: PgbenchScriptResult[] = [];
    const maxLength = Math.max(storedScripts.length, parsedScripts.length);
    for (let index = 0; index < maxLength; index += 1) {
      const storedScript = storedScripts.find((script) => script.position === index);
      const parsedScript = parsedScripts.find((script) => script.position === index);
      if (!storedScript && !parsedScript) continue;
      merged.push({
        position: index,
        name: storedScript?.name ?? parsedScript?.name ?? `Script ${index + 1}`,
        weight: storedScript?.weight ?? parsedScript?.weight ?? null,
        script: storedScript?.script ?? '',
        tps: parsedScript?.tps ?? storedScript?.tps ?? null,
        latency_avg_ms: parsedScript?.latency_avg_ms ?? storedScript?.latency_avg_ms ?? null,
        latency_stddev_ms: parsedScript?.latency_stddev_ms ?? storedScript?.latency_stddev_ms ?? null,
        transactions: parsedScript?.transactions ?? storedScript?.transactions ?? null,
        failed_transactions: parsedScript?.failed_transactions ?? storedScript?.failed_transactions ?? null
      });
    }
    return merged;
  }

  const pgbenchStepSections = $derived.by((): PgbenchStepSection[] => {
    if (!run) return [];

    return run.steps
      .filter((step) => step.type === 'pgbench')
      .map((step) => {
        const storedSummary = parseJson<PgbenchStepSummary>(step.pgbench_summary_json);
        const storedScripts = parseJson<PgbenchScriptResult[]>(step.pgbench_scripts_json);
        const parsedOutput = parsePgbenchFinalOutput(getStepOutput(step));
        const scripts = mergePgbenchScripts(storedScripts, parsedOutput.scripts, step);
        const summary = mergePgbenchSummary(storedSummary, parsedOutput.summary);

        return {
          step_id: step.step_id,
          step_name: step.name,
          summary,
          scripts,
          snapshotUnavailable: scripts.length > 0 && scripts.every((script) => !script.script.trim())
        };
      });
  });

  const benchmarkScriptSections = $derived.by(() => pgbenchStepSections.filter((section) => section.scripts.length > 0));

  const pgbenchDetailSections = $derived.by((): PgbenchDetailSection[] => (
    pgbenchStepSections
      .map((section) => ({
        step_id: section.step_id,
        step_name: section.step_name,
        details: getPgbenchDetailEntries(section.summary)
      }))
      .filter((section) => section.details.length > 0)
  ));

  const displayRunMetrics = $derived.by(() => {
    if (!run) return null;
    if (pgbenchStepSections.length === 1 && pgbenchStepSections[0].summary) {
      return pgbenchStepSections[0].summary;
    }
    return {
      tps: run.tps,
      latency_avg_ms: run.latency_avg_ms,
      latency_stddev_ms: run.latency_stddev_ms,
      transactions: run.transactions,
      failed_transactions: null
    };
  });

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

  function toggleBenchmarkScriptDetails(key: string) {
    expandedBenchmarkScript = expandedBenchmarkScript === key ? null : key;
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
      {ec2StatusLoading ? 'Checking...' : 'EC2 Status'}
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
    <strong>EC2 Status</strong>
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
  <button class="tab-btn" class:active={activeTab === 'cloudwatch'}
    disabled={!done}
    title={!done ? 'Available after run completes' : ''}
    onclick={() => activeTab = 'cloudwatch'}>CloudWatch</button>
</div>

{#if activeTab === 'overview'}
{#if run}
  <div class="card" style="margin-bottom:12px">
    <div class="stats-row">
      <div class="stat">
        <div class="stat-label">TPS</div>
        <div class="stat-value">{displayRunMetrics?.tps?.toFixed(2) ?? '—'}</div>
      </div>
      <div class="stat">
        <div class="stat-label">Avg Latency</div>
        <div class="stat-value">{displayRunMetrics?.latency_avg_ms?.toFixed(3) ?? '—'} ms</div>
      </div>
      <div class="stat">
        <div class="stat-label">Stddev</div>
        <div class="stat-value">{displayRunMetrics?.latency_stddev_ms?.toFixed(3) ?? '—'} ms</div>
      </div>
      <div class="stat">
        <div class="stat-label">Transactions</div>
        <div class="stat-value">{displayRunMetrics?.transactions?.toLocaleString() ?? '—'}</div>
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

  {#if pgbenchDetailSections.length > 0}
    {#each pgbenchDetailSections as section}
      <div class="card" style="margin-bottom:12px">
        <div class="benchmark-scripts-header">
          <div>
            <h3 style="margin:0 0 2px">pgbench Details</h3>
            {#if pgbenchDetailSections.length > 1}
              <p style="margin:0;color:#666;font-size:12px">{section.step_name}</p>
            {/if}
          </div>
        </div>
        <div class="pgbench-details-grid">
          {#each section.details as detail}
            <div class="pgbench-detail-item">
              <div class="pgbench-detail-label">{detail.label}</div>
              <div class="pgbench-detail-value">{detail.value}</div>
            </div>
          {/each}
        </div>
      </div>
    {/each}
  {/if}

  <!-- TPS over time -->
  {#if pgbenchProgressData}
    {@const pd = pgbenchProgressData}
    <div class="card" style="margin-bottom:12px">
      <div class="progress-chart-header">
        <div>
          <h3 style="margin:0 0 2px">Throughput &amp; Latency Over Time</h3>
          <p style="margin:0;color:#666;font-size:12px">Per {pd.interval}s interval — a stable flat line means healthy sustained throughput.</p>
        </div>
        {#if pd.totalFailed > 0}
          <span class="progress-failed-badge">{pd.totalFailed.toLocaleString()} failed txns</span>
        {/if}
      </div>
      <div class="progress-chart-grid">
        <div>
          <div class="progress-chart-label">TPS</div>
          <LineChart series={pd.tpsSeries} title="TPS over time" originMs={0} showAllSeriesByDefault={true} />
        </div>
        <div>
          <div class="progress-chart-label">Avg Latency (ms)</div>
          <LineChart series={pd.latSeries} title="Avg latency over time" originMs={0} showAllSeriesByDefault={true} />
        </div>
        <div>
          <div class="progress-chart-label">Latency Stddev (ms)</div>
          <LineChart series={pd.stddevSeries} title="Latency stddev over time" originMs={0} showAllSeriesByDefault={true} />
        </div>
        {#if pd.failedSeries.length > 0}
          <div>
            <div class="progress-chart-label">Failed Transactions</div>
            <LineChart series={pd.failedSeries} title="Failed transactions over time" originMs={0} showAllSeriesByDefault={true} />
          </div>
        {/if}
      </div>
    </div>
  {/if}

  {#if benchmarkScriptSections.length > 0}
    {#each benchmarkScriptSections as section}
      <div class="card" style="margin-bottom:12px">
        <div class="benchmark-scripts-header">
          <div>
            <h3 style="margin:0 0 2px">Benchmark Scripts</h3>
            <p style="margin:0;color:#666;font-size:12px">{section.step_name}</p>
          </div>
        </div>

        {#if section.snapshotUnavailable}
          <div class="benchmark-scripts-note">Script snapshot unavailable for this run.</div>
        {/if}

        <table class="benchmark-scripts-table">
          <thead>
            <tr>
              <th>Script</th>
              <th>Weight</th>
              <th>Transactions</th>
              <th>TPS</th>
              <th>Avg Latency</th>
              <th>Stddev</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {#each section.scripts as script}
              {@const scriptKey = `${section.step_id}:${script.position}`}
              <tr>
                <td>{script.name}</td>
                <td>{script.weight ?? '—'}</td>
                <td>{script.transactions?.toLocaleString() ?? '—'}</td>
                <td>{script.tps?.toFixed(3) ?? '—'}</td>
                <td>{script.latency_avg_ms?.toFixed(3) ?? '—'} ms</td>
                <td>{script.latency_stddev_ms?.toFixed(3) ?? '—'} ms</td>
                <td>
                  {#if script.script}
                    <button class="expand-btn" onclick={() => toggleBenchmarkScriptDetails(scriptKey)}>
                      {expandedBenchmarkScript === scriptKey ? '▲' : '▼'} script
                    </button>
                  {/if}
                </td>
              </tr>
              {#if expandedBenchmarkScript === scriptKey && script.script}
                <tr class="detail-row">
                  <td colspan="7">
                    <div class="detail-block">
                      <div class="detail-label">Script Snapshot</div>
                      <pre class="detail-pre">{script.script}</pre>
                    </div>
                  </td>
                </tr>
              {/if}
            {/each}
          </tbody>
        </table>
      </div>
    {/each}
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
        bench_started_at: run.bench_started_at, post_started_at: run.post_started_at }] : []}
      showPhaseFilter={true}
    />
  </div>
{:else if activeTab === 'telemetry'}
  <DatabaseTelemetry
    {runId}
    active={activeTab === 'telemetry' && done}
    excludeSectionKeys={['cloudwatch']}
  />
{:else if activeTab === 'cloudwatch'}
  <DatabaseTelemetry
    {runId}
    active={activeTab === 'cloudwatch' && done}
    title="CloudWatch"
    includeSectionKeys={['cloudwatch']}
    showHeroCards={false}
  />
{/if}

<style>
  .run-tabs { display: flex; gap: 2px; margin-bottom: 16px; border-bottom: 2px solid #e8e8e8; }
  .tab-btn { background: none; border: none; padding: 8px 16px; font-size: 13px; font-weight: 600; color: #888; cursor: pointer; border-bottom: 2px solid transparent; margin-bottom: -2px; border-radius: 4px 4px 0 0; transition: color 0.15s; }
  .tab-btn:hover:not(:disabled) { color: #333; background: #f5f5f5; }
  .tab-btn.active { color: #0066cc; border-bottom-color: #0066cc; }
  .tab-btn:disabled { cursor: not-allowed; opacity: 0.4; }

  .progress-chart-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 14px; flex-wrap: wrap; }
  .progress-chart-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px; }
  .progress-chart-label { font-size: 11px; font-weight: 700; color: #666; text-transform: uppercase; margin-bottom: 6px; letter-spacing: 0.04em; }
  .progress-failed-badge { background: #fff0f0; border: 1px solid #f5c0c0; color: #a00; font-size: 12px; font-weight: 700; padding: 4px 10px; border-radius: 999px; white-space: nowrap; }
  .benchmark-scripts-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 10px; flex-wrap: wrap; }
  .benchmark-scripts-note { margin-bottom: 10px; padding: 8px 10px; border-radius: 6px; background: #fff6df; border: 1px solid #f2d58c; color: #8a5a00; font-size: 12px; }
  .benchmark-scripts-table th:last-child,
  .benchmark-scripts-table td:last-child { width: 1%; white-space: nowrap; }
  .pgbench-details-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 14px 18px; }
  .pgbench-detail-item { min-width: 0; }
  .pgbench-detail-label { font-size: 11px; color: #666; font-weight: 600; text-transform: uppercase; margin-bottom: 4px; }
  .pgbench-detail-value { font-size: 16px; font-weight: 600; color: #222; word-break: break-word; }

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
