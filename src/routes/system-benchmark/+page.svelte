<script lang="ts">
	import type { PageData } from './$types';
	import PresetBenchmarkPanel from '$lib/PresetBenchmarkPanel.svelte';

	type BenchmarkTab = 'preset' | 'custom';
	let activeTab = $state<BenchmarkTab>('preset');

	type TestType = 'cpu' | 'memory' | 'fileio' | 'mutex' | 'threads';

	interface PgServer {
		id: number;
		name: string;
		host: string;
		ssh_host: string | null;
	}

	interface SysbenchRun {
		id: number;
		pg_server_id: number;
		pg_server_name: string;
		test_type: TestType;
		flags: string;
		output: string;
		exit_code: number;
		created_at: string;
	}

	interface SysbenchJob {
		test_type: TestType;
		flags: string;
		label: string;
	}

	type CheckState =
		| { status: 'idle' }
		| { status: 'checking' }
		| { status: 'ok'; version: string }
		| { status: 'fail'; error: string };

	const TEST_TYPES: TestType[] = ['cpu', 'memory', 'fileio', 'mutex', 'threads'];
	const FILEIO_MODES = ['seqwr', 'seqrd', 'seqrewr', 'rndrd', 'rndwr', 'rndrw'];
	const MEMORY_OPERATIONS = ['write', 'read'];
	const MEMORY_ACCESS_MODES = ['seq', 'rnd'];

	let { data }: { data: PageData } = $props();

	const servers = $derived((data.servers ?? []) as PgServer[]);

	function initialServerId(): string {
		const list = (data.servers ?? []) as PgServer[];
		return list[0] ? String(list[0].id) : '';
	}

	function initialRuns(): SysbenchRun[] {
		return (data.runs ?? []) as SysbenchRun[];
	}

	let selectedServerId = $state(initialServerId());
	let selectedTypes = $state<Set<TestType>>(new Set(['cpu']));
	let running = $state(false);
	let runError = $state('');
	let latestOutput = $state('');
	let runs = $state<SysbenchRun[]>(initialRuns());
	let expandedRuns = $state(new Set<number>());
	let checkState = $state<CheckState>({ status: 'idle' });
	let checkSeq = 0;
	let runningIndex = $state(0);
	let runningTotal = $state(0);
	let runningLabel = $state('');

	let cpu = $state({ threads: '4', time: '30', maxPrime: '10000', extraFlags: '' });
	let memory = $state({
		threads: '4',
		time: '30',
		blockSize: '1K',
		totalSize: '100G',
		operations: new Set<string>(MEMORY_OPERATIONS),
		accessModes: new Set<string>(MEMORY_ACCESS_MODES),
		extraFlags: ''
	});
	let fileio = $state({
		threads: '4',
		time: '30',
		totalSize: '2G',
		testModes: new Set<string>(FILEIO_MODES),
		blockSize: '16K',
		direct: true,
		extraFlags: ''
	});
	let mutex = $state({
		threads: '4',
		time: '30',
		mutexNum: '4096',
		mutexLocks: '50000',
		mutexLoops: '10000',
		extraFlags: ''
	});
	let threads = $state({ threads: '4', time: '30', yields: '1000', locks: '8', extraFlags: '' });

	$effect(() => {
		const id = Number(selectedServerId);
		const seq = ++checkSeq;
		if (!id) {
			checkState = { status: 'idle' };
			return;
		}

		checkState = { status: 'checking' };
		fetch(`/api/sysbench-system/check?pg_server_id=${id}`)
			.then((res) => res.json())
			.then((result) => {
				if (seq !== checkSeq) return;
				checkState = result.ok
					? { status: 'ok', version: result.version ?? 'sysbench' }
					: { status: 'fail', error: result.error ?? 'sysbench not found' };
			})
			.catch((err) => {
				if (seq !== checkSeq) return;
				checkState = { status: 'fail', error: err instanceof Error ? err.message : String(err) };
			});
	});

	const selectedServer = $derived(() =>
		servers.find((server) => String(server.id) === selectedServerId) ?? null
	);
	const jobs = $derived(() => buildJobs());
	const commandPreview = $derived(() => jobs().map((job) => `sysbench ${job.test_type} ${job.flags} run`));
	const progressText = $derived(
		running && runningTotal > 0 ? `Running [${runningIndex}/${runningTotal}] ${runningLabel}...` : ''
	);

	function joinFlags(parts: string[], sectionExtraFlags: string): string {
		const extra = sectionExtraFlags.trim();
		return extra ? [...parts, extra].join(' ') : parts.join(' ');
	}

	function buildJobs(): SysbenchJob[] {
		const result: SysbenchJob[] = [];
		if (selectedTypes.has('cpu')) {
			result.push({
				test_type: 'cpu',
				label: 'cpu',
				flags: joinFlags([`--threads=${cpu.threads}`, `--time=${cpu.time}`, `--cpu-max-prime=${cpu.maxPrime}`], cpu.extraFlags)
			});
		}
		if (selectedTypes.has('memory')) {
			for (const operation of MEMORY_OPERATIONS) {
				if (!memory.operations.has(operation)) continue;
				for (const accessMode of MEMORY_ACCESS_MODES) {
					if (!memory.accessModes.has(accessMode)) continue;
					result.push({
						test_type: 'memory',
						label: `memory ${operation}+${accessMode}`,
						flags: joinFlags([
							`--threads=${memory.threads}`,
							`--time=${memory.time}`,
							`--memory-block-size=${memory.blockSize}`,
							`--memory-total-size=${memory.totalSize}`,
							`--memory-oper=${operation}`,
							`--memory-access-mode=${accessMode}`
						], memory.extraFlags)
					});
				}
			}
		}
		if (selectedTypes.has('fileio')) {
			for (const mode of FILEIO_MODES) {
				if (!fileio.testModes.has(mode)) continue;
				const parts = [
					`--threads=${fileio.threads}`,
					`--time=${fileio.time}`,
					`--file-total-size=${fileio.totalSize}`,
					`--file-test-mode=${mode}`,
					`--file-block-size=${fileio.blockSize}`
				];
				if (fileio.direct) parts.push('--file-extra-flags=direct');
				result.push({
					test_type: 'fileio',
					label: `fileio ${mode}`,
					flags: joinFlags(parts, fileio.extraFlags)
				});
			}
		}
		if (selectedTypes.has('mutex')) {
			result.push({
				test_type: 'mutex',
				label: 'mutex',
				flags: joinFlags([
					`--threads=${mutex.threads}`,
					`--time=${mutex.time}`,
					`--mutex-num=${mutex.mutexNum}`,
					`--mutex-locks=${mutex.mutexLocks}`,
					`--mutex-loops=${mutex.mutexLoops}`
				], mutex.extraFlags)
			});
		}
		if (selectedTypes.has('threads')) {
			result.push({
				test_type: 'threads',
				label: 'threads',
				flags: joinFlags([
					`--threads=${threads.threads}`,
					`--time=${threads.time}`,
					`--thread-yields=${threads.yields}`,
					`--thread-locks=${threads.locks}`
				], threads.extraFlags)
			});
		}
		return result;
	}

	function toggleType(type: TestType) {
		const next = new Set(selectedTypes);
		if (next.has(type)) {
			next.delete(type);
		} else {
			next.add(type);
			if (type === 'fileio') fileio.testModes = new Set(FILEIO_MODES);
		}
		selectedTypes = next;
	}

	function toggleMemoryOperation(operation: string) {
		const next = new Set(memory.operations);
		if (next.has(operation)) next.delete(operation);
		else next.add(operation);
		memory.operations = next;
	}

	function toggleMemoryAccessMode(mode: string) {
		const next = new Set(memory.accessModes);
		if (next.has(mode)) next.delete(mode);
		else next.add(mode);
		memory.accessModes = next;
	}

	function toggleFileioMode(mode: string) {
		const next = new Set(fileio.testModes);
		if (next.has(mode)) next.delete(mode);
		else next.add(mode);
		fileio.testModes = next;
	}

	async function runBenchmark() {
		const pgServerId = Number(selectedServerId);
		const activeJobs = jobs();
		if (!pgServerId || activeJobs.length === 0) return;

		running = true;
		runError = '';
		latestOutput = '';
		runningTotal = activeJobs.length;
		try {
			for (let i = 0; i < activeJobs.length; i += 1) {
				const job = activeJobs[i];
				runningIndex = i + 1;
				runningLabel = job.label;
				const res = await fetch('/api/sysbench-system', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ pg_server_id: pgServerId, test_type: job.test_type, flags: job.flags })
				});
				const body = await res.json().catch(() => null);
				if (!res.ok) {
					runError = body?.message ?? body?.error ?? `Run failed with HTTP ${res.status}`;
					return;
				}
				const run = body as SysbenchRun;
				runs = [run, ...runs.filter((existing) => existing.id !== run.id)];
				latestOutput = run.output;
				expandedRuns = new Set([run.id]);
				if (run.exit_code !== 0) {
					runError = `${job.label} failed with exit code ${run.exit_code}`;
					return;
				}
			}
		} catch (err) {
			runError = err instanceof Error ? err.message : String(err);
		} finally {
			running = false;
			runningIndex = 0;
			runningTotal = 0;
			runningLabel = '';
		}
	}

	async function deleteRun(id: number) {
		const res = await fetch(`/api/sysbench-system/${id}`, { method: 'DELETE' });
		if (!res.ok) return;
		runs = runs.filter((run) => run.id !== id);
		const next = new Set(expandedRuns);
		next.delete(id);
		expandedRuns = next;
	}

	function toggleOutput(id: number) {
		const next = new Set(expandedRuns);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		expandedRuns = next;
	}

	function getFlagValue(flagString: string, name: string): string {
		const match = flagString.match(new RegExp(`(?:^|\\s)--${name}=([^\\s]+)`));
		return match?.[1] ?? '';
	}

	function keyMetric(run: SysbenchRun): string {
		if (run.test_type === 'memory') {
			const match = run.output.match(/([\d.]+)\s+MiB\/sec/i);
			return match ? `${match[1]} MiB/sec` : 'n/a';
		}
		if (run.test_type === 'fileio') {
			const readMatch = run.output.match(/reads\/s:\s+([\d.]+)/i);
			const writeMatch = run.output.match(/writes\/s:\s+([\d.]+)/i);
			if (readMatch) return `${readMatch[1]} reads/s`;
			if (writeMatch) return `${writeMatch[1]} writes/s`;
			return 'n/a';
		}
		const match = run.output.match(/events per second:\s+([\d.]+)/i);
		return match ? `${match[1]} events/sec` : 'n/a';
	}

	function fmtDate(value: string): string {
		const d = new Date(value.replace(' ', 'T'));
		if (Number.isNaN(d.getTime())) return value;
		const yyyy = d.getFullYear();
		const mm = String(d.getMonth() + 1).padStart(2, '0');
		const dd = String(d.getDate()).padStart(2, '0');
		const hh = String(d.getHours()).padStart(2, '0');
		const min = String(d.getMinutes()).padStart(2, '0');
		return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
	}
</script>

<svelte:head><title>System Benchmarks — mybench</title></svelte:head>

<div class="page">
	<div class="page-header">
		<h1>System Benchmarks</h1>
	</div>

	<div class="tab-bar">
		<button class="tab-btn" class:active={activeTab === 'preset'} onclick={() => activeTab = 'preset'}>Preset Benchmarks</button>
		<button class="tab-btn" class:active={activeTab === 'custom'} onclick={() => activeTab = 'custom'}>Custom Benchmarks</button>
	</div>

	{#if servers.length === 0}
		<section class="card empty">
			No SSH-enabled PostgreSQL servers. Add SSH details for a server in Settings first.
		</section>
	{:else if activeTab === 'preset'}
		<PresetBenchmarkPanel servers={servers as any} benchmarks={(data.presetBenchmarks ?? []) as any} />
	{:else}
		<div class="server-select">
			<label for="server">Server</label>
			<select id="server" bind:value={selectedServerId}>
				{#each servers as server}
					<option value={String(server.id)}>{server.name}</option>
				{/each}
			</select>
			{#if checkState.status === 'checking'}
				<span class="status-badge muted">checking...</span>
			{:else if checkState.status === 'ok'}
				<span class="status-badge ok">{checkState.version} ✓</span>
			{:else if checkState.status === 'fail'}
				<span class="status-badge fail">{checkState.error} ✗</span>
			{/if}
		</div>

		<section class="card">
			<div class="type-tabs">
				{#each TEST_TYPES as type}
					<label class="type-tab" class:active={selectedTypes.has(type)}>
						<input
							type="checkbox"
							checked={selectedTypes.has(type)}
							onchange={() => toggleType(type)}
						/>
						{type}
					</label>
				{/each}
			</div>

			<div class="param-sections">
				{#if selectedTypes.has('cpu')}
					<section class="param-section">
						<h3>CPU</h3>
						<div class="param-grid">
							<div class="form-group"><label for="cpu-threads">Threads</label><input id="cpu-threads" bind:value={cpu.threads} /></div>
							<div class="form-group"><label for="cpu-time">Time</label><input id="cpu-time" bind:value={cpu.time} /></div>
							<div class="form-group"><label for="cpu-prime">Max Prime</label><input id="cpu-prime" bind:value={cpu.maxPrime} /></div>
							<div class="form-group compact-flags"><label for="cpu-extra-flags">Extra Flags</label><input id="cpu-extra-flags" class="code" bind:value={cpu.extraFlags} /></div>
						</div>
					</section>
				{/if}

				{#if selectedTypes.has('memory')}
					<section class="param-section">
						<h3>Memory</h3>
						<div class="param-grid">
							<div class="form-group"><label for="memory-threads">Threads</label><input id="memory-threads" bind:value={memory.threads} /></div>
							<div class="form-group"><label for="memory-time">Time</label><input id="memory-time" bind:value={memory.time} /></div>
							<div class="form-group"><label for="memory-block">Block Size</label><input id="memory-block" bind:value={memory.blockSize} /></div>
							<div class="form-group"><label for="memory-total">Total Size</label><input id="memory-total" bind:value={memory.totalSize} /></div>
							<div class="form-group compact-flags"><label for="memory-extra-flags">Extra Flags</label><input id="memory-extra-flags" class="code" bind:value={memory.extraFlags} /></div>
						</div>
						<div class="choice-groups">
							<div>
								<div class="choice-title">Operations</div>
								<div class="check-list">
									{#each MEMORY_OPERATIONS as operation}
										<label class="check-row">
											<input type="checkbox" checked={memory.operations.has(operation)} onchange={() => toggleMemoryOperation(operation)} />
											<span>{operation}</span>
										</label>
									{/each}
								</div>
							</div>
							<div>
								<div class="choice-title">Access Modes</div>
								<div class="check-list">
									{#each MEMORY_ACCESS_MODES as mode}
										<label class="check-row">
											<input type="checkbox" checked={memory.accessModes.has(mode)} onchange={() => toggleMemoryAccessMode(mode)} />
											<span>{mode}</span>
										</label>
									{/each}
								</div>
							</div>
						</div>
					</section>
				{/if}

				{#if selectedTypes.has('fileio')}
					<section class="param-section">
						<h3>File I/O</h3>
						<div class="param-grid">
							<div class="form-group"><label for="fileio-threads">Threads</label><input id="fileio-threads" bind:value={fileio.threads} /></div>
							<div class="form-group"><label for="fileio-time">Time</label><input id="fileio-time" bind:value={fileio.time} /></div>
							<div class="form-group"><label for="fileio-total">File Total Size</label><input id="fileio-total" bind:value={fileio.totalSize} /></div>
							<div class="form-group"><label for="fileio-block">Block Size</label><input id="fileio-block" bind:value={fileio.blockSize} /></div>
							<div class="form-group compact-flags"><label for="fileio-extra-flags">Extra Flags</label><input id="fileio-extra-flags" class="code" bind:value={fileio.extraFlags} /></div>
						</div>
						<div class="choice-groups">
							<div>
								<div class="choice-title">Test Modes</div>
								<div class="check-list mode-list">
									{#each FILEIO_MODES as mode}
										<label class="check-row">
											<input type="checkbox" checked={fileio.testModes.has(mode)} onchange={() => toggleFileioMode(mode)} />
											<span>{mode}</span>
										</label>
									{/each}
								</div>
							</div>
							<label class="check-row direct-row">
								<input type="checkbox" checked={fileio.direct} onchange={(e) => fileio.direct = e.currentTarget.checked} />
								<span>direct</span>
							</label>
						</div>
					</section>
				{/if}

				{#if selectedTypes.has('mutex')}
					<section class="param-section">
						<h3>Mutex</h3>
						<div class="param-grid">
							<div class="form-group"><label for="mutex-threads">Threads</label><input id="mutex-threads" bind:value={mutex.threads} /></div>
							<div class="form-group"><label for="mutex-time">Time</label><input id="mutex-time" bind:value={mutex.time} /></div>
							<div class="form-group"><label for="mutex-num">Mutex Num</label><input id="mutex-num" bind:value={mutex.mutexNum} /></div>
							<div class="form-group"><label for="mutex-locks">Mutex Locks</label><input id="mutex-locks" bind:value={mutex.mutexLocks} /></div>
							<div class="form-group"><label for="mutex-loops">Mutex Loops</label><input id="mutex-loops" bind:value={mutex.mutexLoops} /></div>
							<div class="form-group compact-flags"><label for="mutex-extra-flags">Extra Flags</label><input id="mutex-extra-flags" class="code" bind:value={mutex.extraFlags} /></div>
						</div>
					</section>
				{/if}

				{#if selectedTypes.has('threads')}
					<section class="param-section">
						<h3>Threads</h3>
						<div class="param-grid">
							<div class="form-group"><label for="threads-threads">Threads</label><input id="threads-threads" bind:value={threads.threads} /></div>
							<div class="form-group"><label for="threads-time">Time</label><input id="threads-time" bind:value={threads.time} /></div>
							<div class="form-group"><label for="threads-yields">Thread Yields</label><input id="threads-yields" bind:value={threads.yields} /></div>
							<div class="form-group"><label for="threads-locks">Thread Locks</label><input id="threads-locks" bind:value={threads.locks} /></div>
							<div class="form-group compact-flags"><label for="threads-extra-flags">Extra Flags</label><input id="threads-extra-flags" class="code" bind:value={threads.extraFlags} /></div>
						</div>
					</section>
				{/if}
			</div>

			<div class="command-block">
				<div class="preview-list">
					{#if commandPreview().length === 0}
						<code>No jobs selected</code>
					{:else}
						{#each commandPreview() as command}
							<code>{command}</code>
						{/each}
					{/if}
				</div>
				<div class="run-actions">
					{#if progressText}
						<div class="progress-text">{progressText}</div>
					{/if}
					<button class="primary" disabled={running || !selectedServer() || jobs().length === 0} onclick={runBenchmark}>
						{running ? 'Running...' : `Run ${jobs().length} job${jobs().length === 1 ? '' : 's'}`}
					</button>
				</div>
			</div>
			{#if runError}
				<div class="error" style="margin-top:8px">{runError}</div>
			{/if}
		</section>

		{#if latestOutput}
			<section class="card">
				<h2>Result</h2>
				<pre class="output">{latestOutput}</pre>
			</section>
		{/if}
	<section class="card">
		<h2>History</h2>
		{#if runs.length === 0}
			<p class="empty-copy">No system benchmark runs yet.</p>
		{:else}
			<div class="table-wrap">
				<table>
					<thead>
						<tr>
							<th>Date</th>
							<th>Server</th>
							<th>Type</th>
							<th>Threads</th>
							<th>Time</th>
							<th>Key Metric</th>
							<th>Actions</th>
						</tr>
					</thead>
					<tbody>
						{#each runs as run}
							<tr>
								<td>{fmtDate(run.created_at)}</td>
								<td>{run.pg_server_name}</td>
								<td><span class="badge badge-sysbench">{run.test_type}</span></td>
								<td>{getFlagValue(run.flags, 'threads') || 'n/a'}</td>
								<td>{getFlagValue(run.flags, 'time') ? `${getFlagValue(run.flags, 'time')}s` : 'n/a'}</td>
								<td>{keyMetric(run)}</td>
								<td>
									<div class="row-actions">
										<button onclick={() => toggleOutput(run.id)}>
											{expandedRuns.has(run.id) ? 'Hide Output' : 'View Output'}
										</button>
										<button class="danger" disabled={running} onclick={() => deleteRun(run.id)}>Delete</button>
									</div>
								</td>
							</tr>
							{#if expandedRuns.has(run.id)}
								<tr class="output-row">
									<td colspan="7">
										<pre class="output">{run.output}</pre>
									</td>
								</tr>
							{/if}
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</section>
	{/if}
</div>

<style>
	.page {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.page-header {
		display: flex;
		justify-content: space-between;
		gap: 16px;
		align-items: flex-start;
		flex-wrap: wrap;
	}

	.tab-bar {
		display: flex;
		gap: 0;
		border-bottom: 2px solid #e0e0e0;
	}

	.tab-btn {
		padding: 8px 16px;
		border: none;
		background: none;
		cursor: pointer;
		font-size: 14px;
		font-weight: 500;
		color: #666;
		border-bottom: 2px solid transparent;
		margin-bottom: -2px;
		transition: color 0.15s, border-color 0.15s;
	}

	.tab-btn.active {
		color: #0066cc;
		border-bottom-color: #0066cc;
	}

	.tab-btn:hover:not(.active) {
		color: #333;
	}

	.server-select {
		display: grid;
		grid-template-columns: minmax(220px, 320px) auto;
		gap: 6px 10px;
		align-items: center;
	}

	.server-select label {
		grid-column: 1 / -1;
		margin-bottom: 0;
	}

	.status-badge {
		white-space: nowrap;
		border-radius: 4px;
		padding: 5px 8px;
		font-size: 12px;
		font-weight: 600;
	}

	.status-badge.ok { background: #d4edda; color: #155724; }
	.status-badge.fail { background: #f8d7da; color: #721c24; }
	.status-badge.muted { background: #e2e3e5; color: #383d41; }

	.type-tabs {
		display: flex;
		gap: 6px;
		flex-wrap: wrap;
		margin-bottom: 16px;
	}

	.type-tab {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		margin: 0;
		padding: 7px 10px;
		border: 1px solid #d8d8d8;
		border-radius: 4px;
		background: #fafafa;
		color: #444;
		cursor: pointer;
	}

	.type-tab.active {
		border-color: #0066cc;
		background: #e8f4fd;
		color: #004f9e;
	}

	.type-tab input {
		width: auto;
		margin: 0;
	}

	.param-sections {
		display: flex;
		flex-direction: column;
		gap: 12px;
		margin-bottom: 12px;
	}

	.param-section {
		border: 1px solid #e8e8e8;
		border-radius: 6px;
		padding: 12px;
		background: #fafafa;
	}

	.param-section h3 {
		font-size: 14px;
		margin-bottom: 10px;
	}

	.param-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
		gap: 12px;
		align-items: end;
	}

	.compact-flags {
		max-width: 220px;
	}

	.choice-groups {
		display: flex;
		gap: 22px;
		align-items: flex-start;
		flex-wrap: wrap;
		margin-top: 10px;
	}

	.choice-title {
		font-size: 12px;
		font-weight: 600;
		color: #555;
		margin-bottom: 4px;
	}

	.check-list {
		display: flex;
		gap: 10px;
		flex-wrap: wrap;
	}

	.mode-list {
		max-width: 520px;
	}

	.check-row {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		margin: 0;
		min-height: 28px;
		color: #444;
		font-weight: 500;
	}

	.check-row input {
		width: auto;
		margin: 0;
	}

	.direct-row {
		margin-top: 18px;
	}

	.command-block {
		display: grid;
		grid-template-columns: 1fr auto;
		gap: 10px;
		align-items: end;
	}

	.preview-list {
		display: flex;
		flex-direction: column;
		gap: 6px;
		min-width: 0;
	}

	.preview-list code {
		display: block;
		background: #f5f5f5;
		border: 1px solid #e0e0e0;
		border-radius: 4px;
		padding: 8px 10px;
		overflow-x: auto;
		white-space: nowrap;
	}

	.run-actions {
		display: flex;
		flex-direction: column;
		gap: 6px;
		align-items: flex-end;
	}

	.progress-text {
		color: #555;
		font-size: 12px;
		white-space: nowrap;
	}

	.table-wrap {
		overflow-x: auto;
	}

	.row-actions {
		display: flex;
		gap: 6px;
		flex-wrap: wrap;
	}

	.output-row td {
		background: #fafafa;
		padding: 0 10px 10px;
	}

	.output-row pre {
		margin: 0;
	}

	.empty,
	.empty-copy {
		color: #666;
	}

	h2 {
		font-size: 16px;
		margin-bottom: 10px;
	}

	@media (max-width: 720px) {
		.server-select,
		.command-block {
			grid-template-columns: 1fr;
		}

		.run-actions {
			align-items: stretch;
		}
	}
</style>
