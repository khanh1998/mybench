<script lang="ts">
  /**
   * Expanded detail for one row of the run page's "Steps" table.
   * Prefers config_json (launch-time snapshot with params resolved); falls back to
   * command / processed_script for runs recorded before config_json existed.
   */
  interface Props {
    step: { type: string; command: string; processed_script: string; config_json?: string };
  }
  let { step }: Props = $props();

  const config = $derived.by((): Record<string, unknown> | null => {
    if (!step.config_json?.trim()) return null;
    try { return JSON.parse(step.config_json) as Record<string, unknown>; } catch { return null; }
  });

  type Entry = { label: string; value: string };

  function fmt(v: unknown): string {
    if (typeof v === 'boolean') return v ? 'yes' : 'no';
    if (Array.isArray(v)) return v.length ? v.join(', ') : '—';
    if (v === null || v === undefined || v === '') return '—';
    return String(v);
  }
  function secs(v: unknown): string {
    const n = Number(v);
    return n > 0 ? `${n}s` : '—';
  }

  const PERF_LABELS: Record<string, string> = {
    stat_enabled: 'stat', record_enabled: 'record', trace_enabled: 'trace', c2c_enabled: 'c2c',
    events: 'Events', duration: 'Duration', delay: 'Delay',
    stat_duration: 'Stat duration', stat_delay: 'Stat delay',
    record_duration: 'Record duration', record_delay: 'Record delay',
    trace_duration: 'Trace duration', trace_delay: 'Trace delay',
    c2c_duration: 'c2c duration', c2c_delay: 'c2c delay', ldlat: 'ldlat',
    cgroup: 'cgroup', repeat: 'Repeat', freq: 'Frequency', call_graph: 'Call graph', mmap_pages: 'mmap pages'
  };

  const entries = $derived.by((): Entry[] => {
    const c = config;
    if (!c) return [];
    switch (step.type) {
      case 'sql':
        return [{ label: 'Transaction', value: c.no_transaction ? 'no (autocommit)' : 'single transaction' }];
      case 'pgbench':
        return (c.scripts as { name: string; weight: unknown }[] | undefined)?.length
          ? [{ label: 'Scripts', value: (c.scripts as { name: string; weight: unknown }[]).map(s => `${s.name} @${s.weight}`).join(', ') }]
          : [];
      case 'sysbench':
        return [{ label: 'Duration', value: secs(c.duration_secs) }];
      case 'pg_stat':
        return [
          { label: 'Interval', value: secs(c.interval_seconds) },
          { label: 'pg_stat_statements', value: c.collect_statements ? 'collected at bench end' : 'no' },
          { label: 'pg_locks', value: c.pg_locks_enabled ? `yes (every ${secs(c.pg_locks_interval_seconds || c.interval_seconds)})` : 'no' },
          { label: 'Reset stats', value: fmt(c.reset_stats) },
          { label: 'Reset statements', value: fmt(c.reset_statements) },
          { label: 'Track planning', value: fmt(c.pss_track_planning) }
        ];
      case 'proc':
        return [
          { label: 'Interval', value: secs(c.interval_seconds) },
          { label: 'Collect runner host', value: fmt(c.collect_runner) }
        ];
      case 'perf': {
        const modes = ['stat', 'record', 'trace', 'c2c'].filter(m => c[`${m}_enabled`]);
        const out: Entry[] = [{ label: 'Modes', value: modes.join(', ') || '—' }];
        for (const [k, v] of Object.entries(c)) {
          if (k.endsWith('_enabled')) continue;
          out.push({ label: PERF_LABELS[k] ?? k, value: fmt(v) });
        }
        return out;
      }
    }
    return [];
  });

  const tables = $derived(step.type === 'pg_stat' && Array.isArray(config?.tables) ? (config!.tables as string[]) : []);
  const groups = $derived(step.type === 'proc' && Array.isArray(config?.groups) ? (config!.groups as string[]) : []);

  // SQL body: prefer the CLI's processed script, then the launch snapshot.
  // (pgbench/sysbench scripts are shown in their own overview cards, so not repeated here.)
  const script = $derived(
    step.type === 'sql' ? (step.processed_script || (config?.script as string | undefined) || '') : ''
  );
  const options = $derived(
    (step.type === 'pgbench' || step.type === 'sysbench') ? ((config?.options as string | undefined) ?? '') : ''
  );
</script>

<div class="detail-block">
  {#if entries.length > 0}
    <div class="cfg-grid">
      {#each entries as e}
        <div class="cfg-item"><div class="detail-label">{e.label}</div><div class="cfg-value">{e.value}</div></div>
      {/each}
    </div>
  {/if}

  {#if tables.length > 0}
    <div class="detail-label section">Tables ({tables.length})</div>
    <div class="chips">{#each tables as t}<span class="chip">{t}</span>{/each}</div>
  {/if}

  {#if groups.length > 0}
    <div class="detail-label section">Groups</div>
    <div class="chips">{#each groups as g}<span class="chip">{g}</span>{/each}</div>
  {/if}

  {#if step.command}
    <div class="detail-label section">Command</div>
    <pre class="detail-pre">{step.command}</pre>
  {/if}

  {#if options}
    <div class="detail-label section">Options</div>
    <pre class="detail-pre">{options}</pre>
  {/if}

  {#if script}
    <div class="detail-label section">SQL</div>
    <pre class="detail-pre">{script}</pre>
  {/if}

  {#if step.type === 'pgbench'}
    <p class="hint">Per-script content and results are in <strong>Benchmark Scripts</strong> above.</p>
  {:else if step.type === 'sysbench' && step.processed_script}
    <p class="hint">The Lua script is shown in the <strong>sysbench</strong> card above.</p>
  {/if}

  {#if !config && !step.command && !script}
    <p class="hint">No configuration was recorded for this step (runs before this was tracked only store the command).</p>
  {/if}
</div>

<style>
  .detail-block { padding: 8px 12px; background: #f8f8f8; border-top: 1px solid #eee; }
  .detail-label { font-size: 10px; font-weight: 700; color: #888; text-transform: uppercase; margin-bottom: 4px; }
  .detail-label.section { margin-top: 10px; }
  .detail-label.section:first-child { margin-top: 0; }
  .detail-pre { margin: 0; font-size: 12px; white-space: pre-wrap; word-break: break-all; background: #1e1e1e; color: #d4d4d4; padding: 8px; border-radius: 4px; max-height: 300px; overflow-y: auto; }
  .cfg-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px 16px; }
  .cfg-item { min-width: 0; }
  .cfg-value { font-size: 13px; color: #222; word-break: break-word; }
  .chips { display: flex; flex-wrap: wrap; gap: 4px; }
  .chip { font-size: 11px; font-family: monospace; background: #fff; border: 1px solid #ddd; border-radius: 3px; padding: 1px 6px; color: #444; }
  .hint { margin: 8px 0 0; font-size: 12px; color: #777; }
</style>
