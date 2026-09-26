<script lang="ts">
	import type { BenchmarkMetrics, HardwareSpec, SystemBenchmark } from '$lib/server/preset-benchmark';

	type PresetProfile = 'quick' | 'standard' | 'deep';
	type TestCategory = 'cpu' | 'memory' | 'wal_write' | 'checkpoint_write' | 'random_read' | 'sequential_read' | 'mixed_io';

	interface PgServer {
		id: number;
		name: string;
		host: string;
		ssh_host: string | null;
	}

	interface CompletedTest {
		index: number;
		total: number;
		category: TestCategory;
		threads: number;
		label?: string;
		metrics: BenchmarkMetrics;
		exitCode: number;
	}

	const CATEGORIES: TestCategory[] = ['cpu', 'memory', 'wal_write', 'checkpoint_write', 'random_read', 'sequential_read', 'mixed_io'];

	const CATEGORY_LABELS: Record<TestCategory, string> = {
		cpu: 'CPU',
		memory: 'Memory',
		wal_write: 'WAL Write',
		checkpoint_write: 'Checkpoint Write',
		random_read: 'Random Read',
		sequential_read: 'Sequential Read',
		mixed_io: 'Mixed OLTP I/O',
	};

	const CATEGORY_DESCRIPTIONS: Record<TestCategory, string> = {
		cpu: 'Raw compute throughput',
		memory: 'Sequential memory bandwidth',
		wal_write: 'Sequential 8KB + fsync (commit path)',
		checkpoint_write: 'Random 8KB + periodic fsync',
		random_read: '8KB random reads (buffer miss)',
		sequential_read: '256KB sequential reads (seq scan)',
		mixed_io: '70/30 random read/write mix',
	};

	const PRESET_INFO: Record<PresetProfile, { label: string; duration: string }> = {
		quick: { label: 'Quick', duration: '~3 min' },
		standard: { label: 'Standard', duration: '~10 min' },
		deep: { label: 'Deep', duration: '~25 min' },
	};

	let {
		servers,
		benchmarks: initialBenchmarks,
	}: {
		servers: PgServer[];
		benchmarks: SystemBenchmark[];
	} = $props();

	let selectedServerId = $state(servers[0] ? String(servers[0].id) : '');
	let preset = $state<PresetProfile>('standard');
	let running = $state(false);
	let runError = $state('');
	let activeBenchmarkId = $state<number | null>(null);

	// Progress state
	let currentTestIndex = $state(-1);
	let currentTestTotal = $state(0);
	let currentTestLabel = $state('');
	let completedTests = $state<CompletedTest[]>([]);
	let hardwareSpec = $state<HardwareSpec | null>(null);
	let benchmarkStatus = $state<string | null>(null);

	// History + viewing
	let benchmarks = $state<SystemBenchmark[]>([...initialBenchmarks]);
	let viewingBenchmarkId = $state<number | null>(null);
	let viewingResults = $state<CompletedTest[]>([]);
	let viewingSpec = $state<HardwareSpec | null>(null);

	// Compare
	let compareIds = $state<Set<number>>(new Set());
	let compareBenchmarks = $state<{ benchmark: SystemBenchmark; results: CompletedTest[] }[]>([]);
	let showCompare = $state(false);

	// Reconnect to a running benchmark on mount
	$effect(() => {
		if (running) return;
		const runningBm = initialBenchmarks.find(b => b.status === 'running');
		if (runningBm) {
			running = true;
			activeBenchmarkId = runningBm.id;
			startElapsedTimer();
			connectSSE(runningBm.id);
		}
	});

	let startTime = $state<number | null>(null);
	let elapsedSecs = $state(0);
	let elapsedTimer: ReturnType<typeof setInterval> | null = null;

	function startElapsedTimer() {
		startTime = Date.now();
		elapsedSecs = 0;
		elapsedTimer = setInterval(() => {
			if (startTime) elapsedSecs = Math.floor((Date.now() - startTime) / 1000);
		}, 1000);
	}

	function stopElapsedTimer() {
		if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
	}

	function fmtElapsed(secs: number): string {
		const m = Math.floor(secs / 60);
		const s = secs % 60;
		return m > 0 ? `${m}m ${s}s` : `${s}s`;
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

	function fmtNumber(n: number | undefined): string {
		if (n == null) return '-';
		if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
		if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
		return n.toFixed(1);
	}

	function primaryMetric(category: TestCategory, metrics: BenchmarkMetrics): string {
		switch (category) {
			case 'cpu':
			case 'memory':
				if (category === 'memory' && metrics.throughput_write_mbps != null)
					return `${fmtNumber(metrics.throughput_write_mbps)} MiB/s`;
				return `${fmtNumber(metrics.events_per_sec)} evt/s`;
			case 'wal_write':
			case 'checkpoint_write':
				return `${fmtNumber(metrics.fsyncs_per_sec ?? metrics.iops)} IOPS`;
			case 'random_read':
				return `${fmtNumber(metrics.reads_per_sec ?? metrics.iops)} IOPS`;
			case 'sequential_read':
				return `${fmtNumber(metrics.throughput_read_mbps)} MB/s`;
			case 'mixed_io':
				return `${fmtNumber(metrics.iops)} IOPS`;
			default:
				return '-';
		}
	}

	function primaryMetricValue(category: TestCategory, metrics: BenchmarkMetrics): number {
		switch (category) {
			case 'cpu':
				return metrics.events_per_sec ?? 0;
			case 'memory':
				return metrics.throughput_write_mbps ?? metrics.events_per_sec ?? 0;
			case 'wal_write':
			case 'checkpoint_write':
				return metrics.fsyncs_per_sec ?? metrics.iops ?? 0;
			case 'random_read':
				return metrics.reads_per_sec ?? metrics.iops ?? 0;
			case 'sequential_read':
				return metrics.throughput_read_mbps ?? 0;
			case 'mixed_io':
				return metrics.iops ?? 0;
			default:
				return 0;
		}
	}

	async function startBenchmark() {
		if (!selectedServerId) return;
		running = true;
		runError = '';
		completedTests = [];
		hardwareSpec = null;
		benchmarkStatus = null;
		currentTestIndex = -1;
		currentTestTotal = 0;
		currentTestLabel = '';
		viewingBenchmarkId = null;
		showCompare = false;
		startElapsedTimer();

		try {
			const res = await fetch('/api/preset-benchmarks', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ pg_server_id: Number(selectedServerId), preset }),
			});
			if (!res.ok) {
				const body = await res.json().catch(() => ({ message: res.statusText }));
				throw new Error(body.message || res.statusText);
			}
			const { id } = await res.json();
			activeBenchmarkId = id;

			connectSSE(id);
		} catch (err) {
			running = false;
			stopElapsedTimer();
			runError = err instanceof Error ? err.message : String(err);
		}
	}

	function connectSSE(benchmarkId: number) {
		const evtSource = new EventSource(`/api/preset-benchmarks/${benchmarkId}/stream`);

		evtSource.addEventListener('spec', (e) => {
			hardwareSpec = JSON.parse(e.data);
		});

		evtSource.addEventListener('test_start', (e) => {
			const d = JSON.parse(e.data);
			currentTestIndex = d.index;
			currentTestTotal = d.total;
			currentTestLabel = d.label || `${CATEGORY_LABELS[d.category as TestCategory]} (${d.threads} threads)`;
		});

		evtSource.addEventListener('test_done', (e) => {
			const d = JSON.parse(e.data);
			completedTests = [...completedTests, d];
			if (d.total) currentTestTotal = d.total;
		});

		evtSource.addEventListener('benchmark_done', (e) => {
			const d = JSON.parse(e.data);
			benchmarkStatus = d.status;
			if (d.error) runError = d.error;
			running = false;
			stopElapsedTimer();
			activeBenchmarkId = null;
			evtSource.close();
			refreshBenchmarks();
		});

		evtSource.onerror = () => {
			evtSource.close();
			if (running) {
				running = false;
				stopElapsedTimer();
				runError = 'Connection lost';
			}
		};
	}

	async function refreshBenchmarks() {
		try {
			const res = await fetch('/api/preset-benchmarks');
			if (res.ok) benchmarks = await res.json();
		} catch { /* ignore */ }
	}

	async function viewBenchmark(id: number) {
		showCompare = false;
		try {
			const res = await fetch(`/api/preset-benchmarks/${id}`);
			if (!res.ok) return;
			const data = await res.json();
			viewingBenchmarkId = id;
			viewingSpec = {
				cpu_model: data.benchmark.cpu_model,
				cpu_cores: data.benchmark.cpu_cores,
				ram_mb: data.benchmark.ram_mb,
				storage_type: data.benchmark.storage_type,
				disk_size_gb: data.benchmark.disk_size_gb,
				os_version: data.benchmark.os_version,
				kernel_version: data.benchmark.kernel_version,
			};
			viewingResults = data.results.map((r: any, i: number) => ({
				index: i,
				total: data.results.length,
				category: r.test_category,
				threads: r.threads,
				metrics: JSON.parse(r.metrics_json),
				exitCode: r.exit_code,
			}));
		} catch { /* ignore */ }
	}

	let editingNameId = $state<number | null>(null);
	let editingNameValue = $state('');

	function startEditName(bm: SystemBenchmark) {
		editingNameId = bm.id;
		editingNameValue = bm.pg_server_name;
	}

	async function saveEditName(id: number) {
		const name = editingNameValue.trim();
		if (!name) { editingNameId = null; return; }
		const res = await fetch(`/api/preset-benchmarks/${id}`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ pg_server_name: name }),
		});
		if (res.ok) {
			benchmarks = benchmarks.map(b => b.id === id ? { ...b, pg_server_name: name } : b);
		}
		editingNameId = null;
	}

	async function deleteBenchmark(id: number) {
		const res = await fetch(`/api/preset-benchmarks/${id}`, { method: 'DELETE' });
		if (!res.ok) return;
		benchmarks = benchmarks.filter((b) => b.id !== id);
		if (viewingBenchmarkId === id) { viewingBenchmarkId = null; viewingResults = []; viewingSpec = null; }
		compareIds.delete(id);
		compareIds = new Set(compareIds);
	}

	type CompareMetric = '1_thread' | 'n_thread' | 'scaling' | 'latency_p95';
	const COMPARE_METRICS: { key: CompareMetric; label: string }[] = [
		{ key: '1_thread', label: '1 Thread' },
		{ key: 'n_thread', label: 'N Threads' },
		{ key: 'scaling', label: 'Scaling' },
		{ key: 'latency_p95', label: 'Latency p95' },
	];
	let selectedCompareMetrics = $state<Set<CompareMetric>>(new Set(['1_thread', 'n_thread']));

	function toggleCompareMetric(key: CompareMetric) {
		const next = new Set(selectedCompareMetrics);
		if (next.has(key)) { if (next.size > 1) next.delete(key); }
		else next.add(key);
		selectedCompareMetrics = next;
	}

	function toggleCompare(id: number) {
		const next = new Set(compareIds);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		compareIds = next;
	}

	async function loadCompare() {
		const ids = [...compareIds];
		if (ids.length < 2) return;
		showCompare = true;
		viewingBenchmarkId = null;
		compareBenchmarks = [];

		const results = await Promise.all(ids.map(async (id) => {
			const res = await fetch(`/api/preset-benchmarks/${id}`);
			const data = await res.json();
			return {
				benchmark: data.benchmark as SystemBenchmark,
				results: (data.results as any[]).map((r: any, i: number) => ({
					index: i, total: data.results.length,
					category: r.test_category as TestCategory, threads: r.threads,
					metrics: JSON.parse(r.metrics_json) as BenchmarkMetrics, exitCode: r.exit_code,
				})),
			};
		}));
		compareBenchmarks = results;
	}

	function compareMetricValue(
		metric: CompareMetric,
		cat: TestCategory,
		resultsMap: Map<string, CompletedTest>,
		allResults: CompletedTest[],
	): { display: string; value: number } {
		const t1 = resultsMap.get(`${cat}_1`);
		const nThreads = allResults.filter(t => t.category === cat && t.threads > 1)[0]?.threads ?? 0;
		const tN = nThreads > 0 ? resultsMap.get(`${cat}_${nThreads}`) : undefined;

		switch (metric) {
			case '1_thread':
				return t1
					? { display: primaryMetric(cat, t1.metrics), value: primaryMetricValue(cat, t1.metrics) }
					: { display: '-', value: 0 };
			case 'n_thread':
				return tN
					? { display: primaryMetric(cat, tN.metrics), value: primaryMetricValue(cat, tN.metrics) }
					: { display: '-', value: 0 };
			case 'scaling': {
				if (!t1 || !tN) return { display: '-', value: 0 };
				const v1 = primaryMetricValue(cat, t1.metrics);
				const vN = primaryMetricValue(cat, tN.metrics);
				if (v1 === 0) return { display: '-', value: 0 };
				const ratio = vN / v1;
				return { display: ratio.toFixed(2) + 'x', value: ratio };
			}
			case 'latency_p95': {
				const p95 = t1?.metrics.latency_p95_ms;
				if (p95 == null) return { display: '-', value: Infinity };
				return { display: p95.toFixed(2) + ' ms', value: p95 };
			}
		}
	}

	function isBestValue(metric: CompareMetric, value: number, allValues: number[]): boolean {
		if (allValues.every(v => v === 0 || v === Infinity)) return false;
		const validValues = allValues.filter(v => v > 0 && v < Infinity);
		if (validValues.length < 2) return false;
		// For latency: lower is better. For everything else: higher is better.
		if (metric === 'latency_p95') return value === Math.min(...validValues);
		return value === Math.max(...validValues);
	}

	// Helpers for scorecard
	function getResults(tests: CompletedTest[]): Map<string, CompletedTest> {
		const map = new Map<string, CompletedTest>();
		for (const t of tests) map.set(`${t.category}_${t.threads}`, t);
		return map;
	}

	function scalingRatio(t1: number, tN: number): string {
		if (t1 === 0) return '-';
		return (tN / t1).toFixed(2) + 'x';
	}

	function pctDiff(a: number, b: number): { text: string; cls: string } {
		if (a === 0 && b === 0) return { text: '-', cls: '' };
		if (a === 0) return { text: '+inf', cls: 'better' };
		const pct = ((b - a) / a) * 100;
		return {
			text: `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`,
			cls: pct >= 0 ? 'better' : 'worse',
		};
	}

	// Determine which results to show in scorecard
	const activeResults = $derived(
		viewingBenchmarkId ? viewingResults :
		completedTests.length > 0 ? completedTests : []
	);
	const activeSpec = $derived(
		viewingBenchmarkId ? viewingSpec : hardwareSpec
	);
	const activeResultsMap = $derived(getResults(activeResults));
</script>

<div class="preset-panel">
	<!-- Launch section -->
	<section class="card launch-section">
		<h2>Run Preset Benchmark</h2>
		<div class="launch-controls">
			<div class="form-group">
				<label for="preset-server">Server</label>
				<select id="preset-server" bind:value={selectedServerId}>
					{#each servers as server}
						<option value={String(server.id)}>{server.name}</option>
					{/each}
				</select>
			</div>

			<div class="form-group">
				<span class="field-label">Preset</span>
				<div class="preset-options">
					{#each (['quick', 'standard', 'deep'] as const) as p}
						<label class="preset-option" class:active={preset === p}>
							<input type="radio" name="preset" value={p} bind:group={preset} />
							{PRESET_INFO[p].label}
							<span class="preset-duration">{PRESET_INFO[p].duration}</span>
						</label>
					{/each}
				</div>
			</div>

			<div class="launch-actions">
				<button class="btn primary" disabled={running || !selectedServerId} onclick={startBenchmark}>
					{running ? 'Running...' : 'Run Benchmark'}
				</button>
				{#if runError && !running}
					<span class="error-text">{runError}</span>
				{/if}
			</div>
		</div>
	</section>

	<!-- Progress section -->
	{#if running}
		<section class="card progress-section">
			<h2>Progress</h2>
			{#if hardwareSpec}
				<div class="spec-summary">
					{hardwareSpec.cpu_cores} vCPU ({hardwareSpec.cpu_model}),
					{hardwareSpec.ram_mb >= 1024 ? `${Math.round(hardwareSpec.ram_mb / 1024)} GB` : `${hardwareSpec.ram_mb} MB`} RAM,
					{hardwareSpec.disk_size_gb} GB {hardwareSpec.storage_type}
				</div>
			{/if}
			<div class="progress-info">
				<div class="progress-bar-wrap">
					<div class="progress-bar" style="width: {currentTestTotal > 0 ? (completedTests.length / currentTestTotal * 100) : 0}%"></div>
				</div>
				<div class="progress-details">
					<span>{completedTests.length} / {currentTestTotal || '?'} tests</span>
					<span class="elapsed">{fmtElapsed(elapsedSecs)}</span>
				</div>
				{#if currentTestLabel}
					<div class="current-test">Running: {currentTestLabel}</div>
				{/if}
			</div>

			{#if completedTests.length > 0}
				<div class="completed-list">
					{#each completedTests as test}
						<div class="completed-item" class:failed={test.exitCode !== 0}>
							<span class="check">{test.exitCode === 0 ? '✓' : '✗'}</span>
							<span class="test-name">{CATEGORY_LABELS[test.category]} ({test.threads}T)</span>
							<span class="test-metric">{primaryMetric(test.category, test.metrics)}</span>
						</div>
					{/each}
				</div>
			{/if}
		</section>
	{/if}

	<!-- Scorecard section -->
	{#if activeResults.length > 0 && !showCompare}
		<section class="card">
			<h2>
				{viewingBenchmarkId ? 'Results' : benchmarkStatus === 'completed' ? 'Results' : 'Results So Far'}
			</h2>
			{#if activeSpec}
				<div class="spec-card">
					<div class="spec-grid">
						<div><strong>CPU</strong> {activeSpec.cpu_cores} vCPU — {activeSpec.cpu_model}</div>
						<div><strong>RAM</strong> {activeSpec.ram_mb >= 1024 ? `${Math.round(activeSpec.ram_mb / 1024)} GB` : `${activeSpec.ram_mb} MB`}</div>
						<div><strong>Storage</strong> {activeSpec.disk_size_gb} GB {activeSpec.storage_type}</div>
						<div><strong>OS</strong> {activeSpec.os_version}</div>
						<div><strong>Kernel</strong> {activeSpec.kernel_version}</div>
					</div>
				</div>
			{/if}
			<div class="table-wrap">
				<table>
					<thead>
						<tr>
							<th>Test</th>
							<th>Description</th>
							<th class="right">1 Thread</th>
							<th class="right">N Threads</th>
							<th class="right">Scaling</th>
							<th class="right">Latency p95</th>
						</tr>
					</thead>
					<tbody>
						{#each CATEGORIES as cat}
							{@const t1 = activeResultsMap.get(`${cat}_1`)}
							{@const maxThreads = activeResults.filter(t => t.category === cat && t.threads > 1)[0]?.threads ?? 0}
							{@const tN = maxThreads > 0 ? activeResultsMap.get(`${cat}_${maxThreads}`) : undefined}
							<tr>
								<td class="cat-label">{CATEGORY_LABELS[cat]}</td>
								<td class="cat-desc">{CATEGORY_DESCRIPTIONS[cat]}</td>
								<td class="right mono">{t1 ? primaryMetric(cat, t1.metrics) : '-'}</td>
								<td class="right mono">{tN ? primaryMetric(cat, tN.metrics) : '-'}</td>
								<td class="right mono">
									{#if t1 && tN}
										{scalingRatio(primaryMetricValue(cat, t1.metrics), primaryMetricValue(cat, tN.metrics))}
									{:else}
										-
									{/if}
								</td>
								<td class="right mono">
									{#if t1?.metrics.latency_p95_ms != null}
										{t1.metrics.latency_p95_ms.toFixed(2)} ms
									{:else}
										-
									{/if}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</section>
	{/if}

	<!-- Compare section -->
	{#if showCompare && compareBenchmarks.length >= 2}
		{@const baseline = compareBenchmarks[0]}
		{@const maps = compareBenchmarks.map(cb => getResults(cb.results))}
		<section class="card">
			<div class="compare-top-bar">
				<h2>Compare</h2>
				<button class="btn small" onclick={() => { showCompare = false; compareIds = new Set(); }}>Close</button>
			</div>

			<div class="compare-legend">
				{#each compareBenchmarks as cb, i}
					<div class="compare-legend-item">
						<span class="compare-label">#{i + 1}{i === 0 ? ' (baseline)' : ''}</span>
						<strong>{cb.benchmark.pg_server_name}</strong>
						<span class="compare-date">{fmtDate(cb.benchmark.created_at)} — {cb.benchmark.preset}</span>
						<span class="compare-spec">
							{cb.benchmark.cpu_cores} vCPU, {cb.benchmark.ram_mb >= 1024 ? `${Math.round(cb.benchmark.ram_mb / 1024)} GB` : `${cb.benchmark.ram_mb} MB`} RAM, {cb.benchmark.storage_type}
						</span>
					</div>
				{/each}
			</div>

			<div class="metric-toggles">
				{#each COMPARE_METRICS as m}
					<label class="metric-toggle" class:active={selectedCompareMetrics.has(m.key)}>
						<input type="checkbox" checked={selectedCompareMetrics.has(m.key)} onchange={() => toggleCompareMetric(m.key)} />
						{m.label}
					</label>
				{/each}
			</div>

			{#each COMPARE_METRICS.filter(m => selectedCompareMetrics.has(m.key)) as metric}
				<div class="compare-table-section">
					<h3>{metric.label}</h3>
					<div class="table-wrap">
						<table>
							<thead>
								<tr>
									<th>#</th>
									<th>Server</th>
									{#each CATEGORIES as cat}
										<th class="right">{CATEGORY_LABELS[cat]}</th>
									{/each}
								</tr>
							</thead>
							<tbody>
								{#each compareBenchmarks as cb, i}
									{@const map = maps[i]}
									<tr>
										<td class="row-num">{i + 1}</td>
										<td class="cat-label">{cb.benchmark.pg_server_name}</td>
										{#each CATEGORIES as cat}
											{@const val = compareMetricValue(metric.key, cat, map, cb.results)}
											{@const allValues = compareBenchmarks.map((_, j) => compareMetricValue(metric.key, cat, maps[j], compareBenchmarks[j].results).value)}
											<td class="right mono" class:best-value={isBestValue(metric.key, val.value, allValues)}>{val.display}</td>
										{/each}
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				</div>
			{/each}
		</section>
	{/if}

	<!-- History section -->
	{#if benchmarks.length > 0}
		<section class="card">
			<h2>History</h2>
			{#if compareIds.size >= 2}
				<div class="compare-actions">
					<button class="btn primary" onclick={loadCompare}>Compare {compareIds.size} Selected</button>
					<button class="btn" onclick={() => { compareIds = new Set(); }}>Clear</button>
				</div>
			{/if}
			<div class="table-wrap">
				<table>
					<thead>
						<tr>
							<th class="col-cmp"></th>
							<th>Date</th>
							<th>Server</th>
							<th>Preset</th>
							<th>Status</th>
							<th>Hardware</th>
							<th>Actions</th>
						</tr>
					</thead>
					<tbody>
						{#each benchmarks as bm}
							{@const isViewing = viewingBenchmarkId === bm.id}
							<tr class:active-row={isViewing}>
								<td class="col-cmp">
									<input
										type="checkbox"
										checked={compareIds.has(bm.id)}
										onchange={() => toggleCompare(bm.id)}
									/>
								</td>
								<td>{fmtDate(bm.created_at)}</td>
								<td class="name-cell">
									{#if editingNameId === bm.id}
										<input
											class="name-input"
											bind:value={editingNameValue}
											onkeydown={(e) => { if (e.key === 'Enter') saveEditName(bm.id); if (e.key === 'Escape') editingNameId = null; }}
											onblur={() => saveEditName(bm.id)}
										/>
									{:else}
										<span class="name-text" ondblclick={() => startEditName(bm)}>{bm.pg_server_name || '-'}</span>
									{/if}
								</td>
								<td class="capitalize">{bm.preset}</td>
								<td>
									<span class="status-badge {bm.status}">{bm.status}</span>
								</td>
								<td class="spec-cell">
									{#if bm.cpu_cores > 0}
										{bm.cpu_cores} vCPU, {bm.ram_mb >= 1024 ? `${Math.round(bm.ram_mb / 1024)} GB` : `${bm.ram_mb} MB`}, {bm.storage_type}
									{:else}
										-
									{/if}
								</td>
								<td class="row-actions">
									{#if bm.status === 'completed'}
										<button class="btn small" onclick={() => viewBenchmark(bm.id)}>
											{isViewing ? 'Viewing' : 'View'}
										</button>
									{/if}
									<button class="btn small danger" onclick={() => deleteBenchmark(bm.id)}>Delete</button>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</section>
	{/if}
</div>

<style>
	.preset-panel {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.launch-section h2,
	.progress-section h2 {
		margin-bottom: 12px;
	}

	.launch-controls {
		display: flex;
		gap: 20px;
		align-items: flex-end;
		flex-wrap: wrap;
	}

	.preset-options {
		display: flex;
		gap: 6px;
	}

	.preset-option {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 7px 10px;
		border: 1px solid #d8d8d8;
		border-radius: 4px;
		background: #fafafa;
		color: #444;
		cursor: pointer;
		margin: 0;
	}

	.preset-option.active {
		border-color: #0066cc;
		background: #e8f4fd;
		color: #004f9e;
	}

	.preset-option input { width: auto; margin: 0; }

	.preset-duration {
		font-size: 11px;
		color: #888;
	}

	.launch-actions {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.error-text {
		color: #c0392b;
		font-size: 12px;
	}

	/* Progress */
	.spec-summary {
		font-size: 13px;
		color: #555;
		margin-bottom: 10px;
	}

	.progress-info {
		margin-bottom: 12px;
	}

	.progress-bar-wrap {
		height: 8px;
		background: #e8e8e8;
		border-radius: 4px;
		overflow: hidden;
		margin-bottom: 6px;
	}

	.progress-bar {
		height: 100%;
		background: #0066cc;
		border-radius: 4px;
		transition: width 0.3s ease;
	}

	.progress-details {
		display: flex;
		justify-content: space-between;
		font-size: 12px;
		color: #666;
	}

	.elapsed {
		color: #999;
	}

	.current-test {
		margin-top: 6px;
		font-size: 13px;
		color: #333;
		font-weight: 500;
	}

	.completed-list {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.completed-item {
		display: flex;
		gap: 8px;
		align-items: center;
		font-size: 13px;
		padding: 4px 0;
	}

	.completed-item .check {
		color: #27ae60;
		font-weight: 700;
	}

	.completed-item.failed .check {
		color: #c0392b;
	}

	.test-name {
		flex: 1;
	}

	.test-metric {
		font-family: var(--font-mono, monospace);
		color: #333;
	}

	/* Spec card */
	.spec-card {
		border: 1px solid #e8e8e8;
		border-radius: 6px;
		padding: 10px 12px;
		background: #fafafa;
		margin-bottom: 12px;
	}

	.spec-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
		gap: 6px;
		font-size: 13px;
	}

	.spec-grid strong {
		color: #555;
		margin-right: 6px;
	}

	/* Table */
	.table-wrap {
		overflow-x: auto;
	}

	.right { text-align: right; }
	.mono { font-family: var(--font-mono, monospace); }
	.capitalize { text-transform: capitalize; }

	.cat-label { font-weight: 600; white-space: nowrap; }
	.cat-desc { font-size: 12px; color: #888; }

	/* Compare */
	.compare-top-bar {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 12px;
	}

	.compare-top-bar h2 { margin-bottom: 0; }

	.compare-legend {
		display: flex;
		gap: 16px;
		flex-wrap: wrap;
		margin-bottom: 12px;
	}

	.compare-legend-item {
		display: flex;
		flex-direction: column;
		gap: 1px;
		padding: 6px 10px;
		border: 1px solid #e0e0e0;
		border-radius: 4px;
		background: #fafafa;
		min-width: 160px;
	}

	.compare-label {
		font-size: 11px;
		font-weight: 600;
		color: #0066cc;
		text-transform: uppercase;
	}

	.compare-date, .compare-spec {
		font-size: 12px;
		color: #888;
	}

	.metric-toggles {
		display: flex;
		gap: 6px;
		margin-bottom: 16px;
		flex-wrap: wrap;
	}

	.metric-toggle {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 5px 10px;
		border: 1px solid #d8d8d8;
		border-radius: 4px;
		background: #fafafa;
		color: #444;
		cursor: pointer;
		margin: 0;
		font-size: 13px;
	}

	.metric-toggle.active {
		border-color: #0066cc;
		background: #e8f4fd;
		color: #004f9e;
	}

	.metric-toggle input { width: auto; margin: 0; }

	.compare-table-section {
		margin-bottom: 16px;
	}

	.compare-table-section h3 {
		font-size: 14px;
		margin-bottom: 6px;
		color: #555;
	}

	.best-value {
		font-weight: 700;
		color: #27ae60;
	}

	.compare-actions {
		display: flex;
		gap: 8px;
		margin-bottom: 10px;
	}

	.better { color: #27ae60; font-weight: 600; }
	.worse { color: #c0392b; font-weight: 600; }

	/* History */
	.col-cmp { width: 32px; }
	.col-cmp input { width: auto; margin: 0; }

	.active-row { background: #f0f7ff; }

	.name-cell { min-width: 100px; }
	.name-text { cursor: default; }
	.name-text:hover { text-decoration: underline dotted; cursor: text; }
	.name-input {
		width: 100%;
		padding: 2px 4px;
		font-size: inherit;
		border: 1px solid #0066cc;
		border-radius: 3px;
		outline: none;
	}
	.spec-cell { font-size: 12px; color: #666; white-space: nowrap; }

	.status-badge {
		display: inline-block;
		padding: 2px 8px;
		border-radius: 3px;
		font-size: 11px;
		font-weight: 600;
		text-transform: capitalize;
	}

	.status-badge.completed { background: #d4edda; color: #155724; }
	.status-badge.running { background: #fff3cd; color: #856404; }
	.status-badge.failed { background: #f8d7da; color: #721c24; }

	.row-actions {
		display: flex;
		gap: 6px;
	}

	h2 {
		font-size: 16px;
		margin-bottom: 10px;
	}

	@media (max-width: 720px) {
		.launch-controls {
			flex-direction: column;
			align-items: stretch;
		}

		.compare-header {
			flex-direction: column;
		}

		.compare-vs { display: none; }
	}
</style>
