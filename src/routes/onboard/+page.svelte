<script lang="ts">
	// ── Types ────────────────────────────────────────────────────────────────────
	interface ConnectResult {
		ok: boolean;
		hostname?: string;
		private_ip?: string | null;
		os_release?: string;
		error?: string;
	}
	interface ToolStatus { ok: boolean; version?: string; error?: string }
	interface PerfInspect {
		ok: boolean;
		perf_installed: boolean;
		perf_version: string;
		sudo_perf_ok: boolean;
		cgroup_version: string;
		postgres_service: string;
		postgres_cgroup: string;
		cgroup_perf_ok: boolean;
		scope: 'postgres_cgroup' | 'system' | 'disabled';
		perf_cgroup: string;
		perf_events: string;
		needs_custom_slice: boolean;
		warning: string;
		error: string;
	}
	interface InspectResult {
		ok: boolean;
		tools?: Record<string, ToolStatus>;
		perf?: PerfInspect;
		error?: string;
	}
	interface RegisterResult {
		ok: boolean;
		pg_server_id?: number;
		ec2_server_id?: number;
		pg_test?: { ok: boolean; version?: string; error?: string };
		ec2_test?: { ok: boolean; ssh?: { ok: boolean }; binary?: { ok: boolean; version?: string }; error?: string };
		error?: string;
	}

	// ── Helpers ──────────────────────────────────────────────────────────────────
	function randomPassword(len = 24): string {
		const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%^&*';
		return Array.from(crypto.getRandomValues(new Uint8Array(len)))
			.map(b => chars[b % chars.length]).join('');
	}
	function randomVpcTag(): string {
		const hex = Array.from(crypto.getRandomValues(new Uint8Array(3)))
			.map(b => b.toString(16).padStart(2, '0')).join('');
		return `vpc-${hex}`;
	}

	// ── State ────────────────────────────────────────────────────────────────────
	let currentStep = $state(1);

	// Step 1
	let sshKey = $state('');
	let sshUser = $state('root');

	// Step 2
	let clientHost = $state('');
	let dbHost = $state('');
	let connectingClient = $state(false);
	let connectingDb = $state(false);
	let clientInfo = $state<ConnectResult | null>(null);
	let dbInfo = $state<ConnectResult | null>(null);
	let clientPrivateIp = $state('');
	let dbPrivateIp = $state('');
	let vpcTag = $state(randomVpcTag());

	// Step 3
	let clientInspect = $state<InspectResult | null>(null);
	let dbInspect = $state<InspectResult | null>(null);
	let inspecting = $state(false);
	// Set of currently-running install keys ("client:pgbench", "db:postgresql", …)
	let installing = $state(new Set<string>());
	let installOutputs = $state<Record<string, string>>({});
	let installResults = $state<Record<string, boolean>>({});

	// Step 4
	let pgUser = $state('mybench');
	let pgPass = $state(randomPassword());
	let pgDb = $state('mybench');
	let configuring = $state(false);
	let configureOutput = $state('');
	let configureDone = $state(false);
	let configureOk = $state<boolean | null>(null);

	// Step 5
	let clusterName = $state('DO Singapore');
	let registering = $state(false);
	let registerResult = $state<RegisterResult | null>(null);

	// ── Derived ──────────────────────────────────────────────────────────────────
	const step1Done = $derived(sshKey.trim().length > 0);
	const step2Done = $derived(!!(clientInfo?.ok && dbInfo?.ok && clientPrivateIp.trim() && dbPrivateIp.trim()));
	// Two different public IPs = two different machines; allow parallel installs per host
	const sameHost = $derived(clientHost.trim() !== '' && clientHost.trim() === dbHost.trim());
	function isInstallBlocked(key: string): boolean {
		if (sameHost) return installing.size > 0;
		const prefix = key.split(':')[0];
		return [...installing].some(k => k.startsWith(prefix + ':'));
	}
	const allInstallsDone = $derived(() => {
		const ct = clientInspect?.tools;
		const dt = dbInspect?.tools;
		if (!ct || !dt) return false;
		const clientTools = ['mybench-runner', 'pgbench', 'sysbench'];
		const dbTools = ['postgresql']; // perf is optional, not required
		return (
			clientTools.every(t => ct[t]?.ok || installResults[`client:${t}`] === true) &&
			dbTools.every(t => dt[t]?.ok || installResults[`db:${t}`] === true)
		);
	});
	const step3Done = $derived(allInstallsDone());
	const step4Done = $derived(configureOk === true);
	const step5Done = $derived(registerResult?.ok === true);

	function sseStream(url: string, body: object, onLine: (l: string) => void): Promise<boolean> {
		return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
			.then(async (res) => {
				const reader = res.body!.getReader();
				const dec = new TextDecoder();
				let buf = '';
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					buf += dec.decode(value, { stream: true });
					const parts = buf.split('\n\n');
					buf = parts.pop() ?? '';
					for (const part of parts) {
						const dataLine = part.split('\n').find(l => l.startsWith('data: '));
						if (!dataLine) continue;
						const data = JSON.parse(dataLine.slice(6));
						if (data.line !== undefined) onLine(data.line);
						if (data.done) return data.ok as boolean;
					}
				}
				return false;
			});
	}

	async function connectDroplet(role: 'client' | 'db') {
		const host = role === 'client' ? clientHost : dbHost;
		if (!host.trim()) return;
		if (role === 'client') { connectingClient = true; clientInfo = null; }
		else { connectingDb = true; dbInfo = null; }
		try {
			const res = await fetch('/api/onboard/connect', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ host, user: sshUser, private_key: sshKey })
			});
			const data: ConnectResult = await res.json();
			if (role === 'client') {
				clientInfo = data;
				if (data.ok && data.private_ip) clientPrivateIp = data.private_ip;
			} else {
				dbInfo = data;
				if (data.ok && data.private_ip) dbPrivateIp = data.private_ip;
			}
		} finally {
			if (role === 'client') connectingClient = false;
			else connectingDb = false;
		}
	}

	async function runInspect() {
		if (!clientInfo?.ok || !dbInfo?.ok) return;
		inspecting = true;
		clientInspect = null; dbInspect = null;
		try {
			const [cRes, dRes] = await Promise.all([
				fetch('/api/onboard/inspect', { method: 'POST', headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ host: clientHost, user: sshUser, private_key: sshKey, role: 'client' }) }).then(r => r.json()),
				fetch('/api/onboard/inspect', { method: 'POST', headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ host: dbHost, user: sshUser, private_key: sshKey, role: 'db' }) }).then(r => r.json())
			]);
			clientInspect = cRes;
			dbInspect = dRes;
		} finally {
			inspecting = false;
		}
	}

	async function installClientTool(tool: 'mybench-runner' | 'pgbench' | 'sysbench') {
		const key = `client:${tool}`;
		installing = new Set([...installing, key]);
		installOutputs[key] = '';
		installResults[key] = false;
		try {
			const ok = await sseStream('/api/ec2/install', { host: clientHost, user: sshUser, private_key: sshKey, remote_dir: '~/mybench-bench', log_dir: '/tmp/mybench-logs', tool },
				(line) => { installOutputs[key] += line + '\n'; });
			installResults[key] = ok;
			const res = await fetch('/api/onboard/inspect', { method: 'POST', headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ host: clientHost, user: sshUser, private_key: sshKey, role: 'client' }) });
			clientInspect = await res.json();
		} finally {
			installing = new Set([...installing].filter(k => k !== key));
		}
	}

	async function installPostgres() {
		const key = 'db:postgresql';
		installing = new Set([...installing, key]);
		installOutputs[key] = '';
		installResults[key] = false;
		try {
			const ok = await sseStream('/api/onboard/install-pg', { host: dbHost, user: sshUser, private_key: sshKey },
				(line) => { installOutputs[key] += line + '\n'; });
			installResults[key] = ok;
			const res = await fetch('/api/onboard/inspect', { method: 'POST', headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ host: dbHost, user: sshUser, private_key: sshKey, role: 'db' }) });
			dbInspect = await res.json();
		} finally {
			installing = new Set([...installing].filter(k => k !== key));
		}
	}

	async function installPerf() {
		const key = 'db:perf';
		installing = new Set([...installing, key]);
		installOutputs[key] = '';
		installResults[key] = false;
		try {
			const ok = await sseStream('/api/onboard/install-perf', { host: dbHost, user: sshUser, private_key: sshKey },
				(line) => { installOutputs[key] += line + '\n'; });
			installResults[key] = ok;
			const res = await fetch('/api/onboard/inspect', { method: 'POST', headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ host: dbHost, user: sshUser, private_key: sshKey, role: 'db' }) });
			dbInspect = await res.json();
		} finally {
			installing = new Set([...installing].filter(k => k !== key));
		}
	}

	async function configurePerfScope() {
		const key = 'db:perf-scope';
		installing = new Set([...installing, key]);
		installOutputs[key] = '';
		installResults[key] = false;
		try {
			const ok = await sseStream('/api/onboard/configure-perf-scope', { host: dbHost, user: sshUser, private_key: sshKey },
				(line) => { installOutputs[key] += line + '\n'; });
			installResults[key] = ok;
			const res = await fetch('/api/onboard/inspect', { method: 'POST', headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ host: dbHost, user: sshUser, private_key: sshKey, role: 'db' }) });
			dbInspect = await res.json();
		} finally {
			installing = new Set([...installing].filter(k => k !== key));
		}
	}

	async function runConfigure() {
		if (!clientPrivateIp.trim() || !dbPrivateIp.trim() || !pgPass.trim()) return;
		configuring = true; configureOutput = ''; configureOk = null; configureDone = false;
		try {
			const ok = await sseStream('/api/onboard/configure-pg', {
				host: dbHost, user: sshUser, private_key: sshKey,
				db_private_ip: dbPrivateIp.trim(),
				client_private_ip: clientPrivateIp.trim(),
				db_user: pgUser, db_pass: pgPass, db_name: pgDb,
				tune_config: tuneConfig.trim() || null
			}, (line) => { configureOutput += line + '\n'; });
			configureOk = ok;
			configureDone = true;
		} finally {
			configuring = false;
		}
	}

	async function runRegister() {
		registering = true; registerResult = null;
		try {
			const res = await fetch('/api/onboard/register', {
				method: 'POST', headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					cluster_name: clusterName,
					client: { host: clientHost, user: sshUser, private_key: sshKey, private_ip: clientPrivateIp.trim(), vpc: vpcTag },
					db: { public_host: dbHost, private_ip: dbPrivateIp.trim(), user: sshUser, private_key: sshKey, vpc: vpcTag },
					pg_config: { db_user: pgUser, db_pass: pgPass, db_name: pgDb },
					perf: dbInspect?.perf ?? null
				})
			});
			registerResult = await res.json();
		} finally {
			registering = false;
		}
	}

	// Step 4 — auto-tune
	let tuneConfig = $state('');
	let detecting = $state(false);
	let detectError = $state('');

	async function detectTune() {
		detecting = true; detectError = ''; tuneConfig = '';
		try {
			const res = await fetch('/api/onboard/detect-tune', {
				method: 'POST', headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ host: dbHost, user: sshUser, private_key: sshKey })
			});
			const data = await res.json();
			if (data.ok) tuneConfig = data.config;
			else detectError = data.error ?? 'Detection failed';
		} finally {
			detecting = false;
		}
	}

	function toolIcon(s?: ToolStatus | null, key?: string) {
		if (!s) return '○';
		if (s.ok || installResults[key ?? '']) return '✓';
		return '✗';
	}
	function toolClass(s?: ToolStatus | null, key?: string) {
		if (!s) return '';
		if (s.ok || installResults[key ?? '']) return 'ok';
		return 'fail';
	}
</script>

<svelte:head><title>Onboard VPS — mybench</title></svelte:head>

<div class="wizard">
	<h1>Onboard New Cluster</h1>
	<p class="subtitle">Set up two DigitalOcean droplets: one for benchmarks, one for PostgreSQL.</p>

	<!-- ── Step 1: SSH Access ──────────────────────────────────────────────── -->
	<div class="step" class:active={currentStep === 1} class:done={currentStep > 1}>
		<div class="step-header" role="button" tabindex="0"
			onclick={() => { if (currentStep > 1) currentStep = 1; }}
			onkeydown={(e) => { if (e.key === 'Enter' && currentStep > 1) currentStep = 1; }}>
			<span class="step-num" class:step-done={currentStep > 1}>{currentStep > 1 ? '✓' : '1'}</span>
			<span class="step-title">SSH Access</span>
			{#if currentStep > 1}<span class="step-summary">user: {sshUser}</span>{/if}
		</div>
		{#if currentStep === 1}
		<div class="step-body">
			<p class="hint">Paste the SSH private key that grants access to both droplets. This key stays in your browser — it is only sent to mybench server for SSH operations.</p>
			<div class="row" style="align-items:flex-start; gap:16px">
				<div class="form-group" style="flex:0 0 120px">
					<label for="ssh-user">SSH Username</label>
					<input id="ssh-user" bind:value={sshUser} placeholder="root" />
				</div>
				<div class="form-group" style="flex:1">
					<label for="ssh-key">Private Key (PEM)</label>
					<textarea id="ssh-key" class="code" rows="8" bind:value={sshKey} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----&#10;...&#10;-----END OPENSSH PRIVATE KEY-----"></textarea>
					<input type="file" style="display:none" id="key-file-input" accept=".pem,.key"
						onchange={(e) => {
							const f = (e.target as HTMLInputElement).files?.[0];
							if (f) { const r = new FileReader(); r.onload = () => { sshKey = r.result as string; }; r.readAsText(f); }
						}} />
					<button style="margin-top:6px; font-size:12px" onclick={() => document.getElementById('key-file-input')?.click()}>Upload key file</button>
				</div>
			</div>
			<button class="primary" disabled={!step1Done} onclick={() => currentStep = 2}>Next: Connect Droplets →</button>
		</div>
		{/if}
	</div>

	<!-- ── Step 2: Connect ─────────────────────────────────────────────────── -->
	<div class="step" class:active={currentStep === 2} class:done={currentStep > 2} class:locked={currentStep < 2}>
		<div class="step-header" role="button" tabindex="0"
			onclick={() => { if (currentStep > 2) currentStep = 2; }}
			onkeydown={(e) => { if (e.key === 'Enter' && currentStep > 2) currentStep = 2; }}>
			<span class="step-num" class:step-done={currentStep > 2}>{currentStep > 2 ? '✓' : '2'}</span>
			<span class="step-title">Connect Droplets</span>
			{#if currentStep > 2}
				<span class="step-summary">client: {clientHost} · db: {dbHost}</span>
			{/if}
		</div>
		{#if currentStep === 2}
		<div class="step-body">
			<p class="hint">Enter the public IPv4 of each droplet. mybench will SSH in and auto-detect the private IP — you can correct it if needed.</p>
			<div class="droplet-grid">
				<!-- Client -->
				<div class="droplet-card">
					<div class="droplet-label">Client Droplet <span class="badge badge-sql">benchmark runner</span></div>
					<div class="form-group">
						<label for="client-host">Public IPv4</label>
						<input id="client-host" bind:value={clientHost} placeholder="159.x.x.x" />
					</div>
					<button class="primary" disabled={!clientHost.trim() || connectingClient} onclick={() => connectDroplet('client')}>
						{connectingClient ? 'Connecting…' : 'Check'}
					</button>
					{#if clientInfo}
						{#if clientInfo.ok}
							<div class="connect-result ok">
								<div>✓ Connected — <strong>{clientInfo.hostname}</strong></div>
								<div>{clientInfo.os_release}</div>
							</div>
						{:else}
							<div class="connect-result fail">✗ {clientInfo.error}</div>
						{/if}
					{/if}
					{#if clientInfo?.ok}
						<div class="form-group" style="margin-top:10px">
							<label for="client-private-ip">Private IP</label>
							<input id="client-private-ip" bind:value={clientPrivateIp} placeholder="10.x.x.x" />
						</div>
					{/if}
				</div>
				<!-- DB -->
				<div class="droplet-card">
					<div class="droplet-label">DB Droplet <span class="badge badge-pgbench">PostgreSQL</span></div>
					<div class="form-group">
						<label for="db-host">Public IPv4</label>
						<input id="db-host" bind:value={dbHost} placeholder="159.x.x.x" />
					</div>
					<button class="primary" disabled={!dbHost.trim() || connectingDb} onclick={() => connectDroplet('db')}>
						{connectingDb ? 'Connecting…' : 'Check'}
					</button>
					{#if dbInfo}
						{#if dbInfo.ok}
							<div class="connect-result ok">
								<div>✓ Connected — <strong>{dbInfo.hostname}</strong></div>
								<div>{dbInfo.os_release}</div>
							</div>
						{:else}
							<div class="connect-result fail">✗ {dbInfo.error}</div>
						{/if}
					{/if}
					{#if dbInfo?.ok}
						<div class="form-group" style="margin-top:10px">
							<label for="db-private-ip">Private IP</label>
							<input id="db-private-ip" bind:value={dbPrivateIp} placeholder="10.x.x.x" />
						</div>
					{/if}
				</div>
			</div>
			{#if clientInfo?.ok || dbInfo?.ok}
				<div class="form-group" style="max-width:200px; margin-bottom:12px">
					<label for="vpc-tag">VPC Network Tag <span style="color:#888; font-weight:400">(shared)</span></label>
					<input id="vpc-tag" bind:value={vpcTag} placeholder="vpc-abc123" />
					<span style="font-size:11px; color:#888">Both servers must share the same tag for runner→db private routing.</span>
				</div>
			{/if}
			<button class="primary" disabled={!step2Done} onclick={async () => { currentStep = 3; await runInspect(); }}>
				Next: Check Dependencies →
			</button>
		</div>
		{/if}
	</div>

	<!-- ── Step 3: Check & Install ─────────────────────────────────────────── -->
	<div class="step" class:active={currentStep === 3} class:done={currentStep > 3} class:locked={currentStep < 3}>
		<div class="step-header" role="button" tabindex="0"
			onclick={() => { if (currentStep > 3) currentStep = 3; }}
			onkeydown={(e) => { if (e.key === 'Enter' && currentStep > 3) currentStep = 3; }}>
			<span class="step-num" class:step-done={currentStep > 3}>{currentStep > 3 ? '✓' : '3'}</span>
			<span class="step-title">Check &amp; Install Dependencies</span>
		</div>
		{#if currentStep === 3}
		<div class="step-body">
			{#if inspecting}
				<p class="hint">Inspecting both droplets…</p>
			{:else}
				<div class="droplet-grid">
					<!-- Client tools -->
					<div class="droplet-card">
						<div class="droplet-label">Client Droplet</div>
						{#if clientInspect?.ok}
							{#each ['mybench-runner', 'pgbench', 'sysbench'] as tool}
								{@const s = clientInspect.tools?.[tool]}
								{@const key = `client:${tool}`}
								{@const isInstalled = s?.ok || installResults[key]}
								<div class="tool-row">
									<span class="tool-icon {toolClass(s, key)}">{toolIcon(s, key)}</span>
									<span class="tool-name">{tool}</span>
									{#if isInstalled}
										<span class="tool-version">{s?.version ?? 'installed'}</span>
									{:else}
										<button
											disabled={isInstallBlocked(key)}
											onclick={() => installClientTool(tool as 'mybench-runner' | 'pgbench' | 'sysbench')}>
											{installing.has(key) ? 'Installing…' : 'Install'}
										</button>
									{/if}
								</div>
								{#if installOutputs[key]}
									<pre class="output install-out">{installOutputs[key]}</pre>
								{/if}
							{/each}
						{:else if clientInspect && !clientInspect.ok}
							<div class="error">{clientInspect.error}</div>
						{:else}
							<p style="color:#999; font-size:12px">Waiting…</p>
						{/if}
					</div>
					<!-- DB tools -->
					<div class="droplet-card">
						<div class="droplet-label">DB Droplet</div>
						{#if dbInspect?.ok}
							{@const pgKey = 'db:postgresql'}
							{@const pgS = dbInspect.tools?.['postgresql']}
							{@const pgInstalled = pgS?.ok || installResults[pgKey]}
							<div class="tool-row">
								<span class="tool-icon {toolClass(pgS, pgKey)}">{toolIcon(pgS, pgKey)}</span>
								<span class="tool-name">postgresql</span>
								{#if pgInstalled}
									<span class="tool-version">{pgS?.version ?? 'installed'}</span>
								{:else}
									<button disabled={isInstallBlocked(pgKey)} onclick={() => installPostgres()}>
										{installing.has(pgKey) ? 'Installing…' : 'Install PG 18'}
									</button>
								{/if}
							</div>
							{#if installOutputs[pgKey]}
								<pre class="output install-out">{installOutputs[pgKey]}</pre>
							{/if}

							{@const perfKey = 'db:perf'}
							{@const perfS = dbInspect.tools?.['perf']}
							{@const perfInstalled = perfS?.ok || installResults[perfKey]}
							<div class="tool-row">
								<span class="tool-icon {toolClass(perfS, perfKey)}">{toolIcon(perfS, perfKey)}</span>
								<span class="tool-name">perf <span style="color:#888; font-size:11px">(optional)</span></span>
								{#if perfInstalled}
									<span class="tool-version">{perfS?.version ?? 'installed'}</span>
								{:else}
									<button disabled={isInstallBlocked(perfKey)} onclick={() => installPerf()}>
										{installing.has(perfKey) ? 'Installing…' : 'Install'}
									</button>
								{/if}
							</div>
							{#if installOutputs[perfKey]}
								<pre class="output install-out">{installOutputs[perfKey]}</pre>
							{/if}
							{#if dbInspect.perf}
								{@const perf = dbInspect.perf}
								{@const scopeKey = 'db:perf-scope'}
								<div class="perf-capability">
									<div class="perf-capability-row">
										<span>sudo perf</span>
										<strong class:ok={perf.sudo_perf_ok} class:fail={!perf.sudo_perf_ok}>{perf.sudo_perf_ok ? 'usable' : 'unavailable'}</strong>
									</div>
									<div class="perf-capability-row">
										<span>cgroup</span>
										<strong>{perf.cgroup_version}</strong>
									</div>
									<div class="perf-capability-row">
										<span>PostgreSQL service</span>
										<strong>{perf.postgres_service || 'not found'}</strong>
									</div>
									<div class="perf-capability-row">
										<span>perf scope</span>
										<strong class:ok={perf.scope !== 'disabled'} class:fail={perf.scope === 'disabled'}>
											{perf.scope === 'postgres_cgroup' ? 'PostgreSQL service cgroup' : perf.scope === 'system' ? 'System-wide' : 'Unavailable'}
										</strong>
									</div>
									{#if perf.postgres_cgroup}
										<div class="perf-cgroup">{perf.postgres_cgroup}</div>
									{/if}
									{#if perf.warning}
										<div class="warn-text">{perf.warning}</div>
									{/if}
									{#if perf.needs_custom_slice}
										<button disabled={isInstallBlocked(scopeKey)} onclick={configurePerfScope}>
											{installing.has(scopeKey) ? 'Creating scope…' : 'Enable Postgres perf scope'}
										</button>
									{/if}
									{#if installOutputs[scopeKey]}
										<pre class="output install-out">{installOutputs[scopeKey]}</pre>
									{/if}
								</div>
							{/if}
						{:else if dbInspect && !dbInspect.ok}
							<div class="error">{dbInspect.error}</div>
						{:else}
							<p style="color:#999; font-size:12px">Waiting…</p>
						{/if}
					</div>
				</div>
				<div class="row" style="gap:8px; margin-top:12px">
					<button onclick={runInspect} disabled={inspecting || installing !== null}>Re-check</button>
					<button class="primary" disabled={!step3Done} onclick={() => currentStep = 4}>Next: Configure PostgreSQL →</button>
				</div>
			{/if}
		</div>
		{/if}
	</div>

	<!-- ── Step 4: Configure PostgreSQL ───────────────────────────────────── -->
	<div class="step" class:active={currentStep === 4} class:done={currentStep > 4} class:locked={currentStep < 4}>
		<div class="step-header" role="button" tabindex="0"
			onclick={() => { if (currentStep > 4) currentStep = 4; }}
			onkeydown={(e) => { if (e.key === 'Enter' && currentStep > 4) currentStep = 4; }}>
			<span class="step-num" class:step-done={currentStep > 4}>{currentStep > 4 ? '✓' : '4'}</span>
			<span class="step-title">Configure PostgreSQL</span>
		</div>
		{#if currentStep === 4}
		<div class="step-body">
			<details class="transparency">
				<summary>What this will do (click to expand)</summary>
				<ul>
					<li>Find <code>postgresql.conf</code> via <code>SHOW config_file</code> and set <code>listen_addresses = 'localhost,{dbPrivateIp || '&lt;db-private-ip&gt;'}'</code></li>
					<li>Find <code>pg_hba.conf</code> via <code>SHOW hba_file</code> and add: <code>host all all {clientPrivateIp || '&lt;client-private-ip&gt;'}/32 scram-sha-256</code></li>
					{#if tuneConfig.trim()}
						<li>Write performance config to <code>conf.d/mybench-tune.conf</code> (deletable to revert)</li>
					{/if}
					<li>Run <code>sudo systemctl restart postgresql</code></li>
					<li>Run <code>sudo ufw allow from {clientPrivateIp || '&lt;client-private-ip&gt;'} to any port 5432</code> and enable UFW</li>
					<li>Create user <code>{pgUser}</code> (if not exists) with the password below</li>
					<li>Create database <code>{pgDb}</code> owned by <code>{pgUser}</code> (if not exists)</li>
				</ul>
				<p style="font-size:12px; color:#666">All operations are idempotent — safe to run again.</p>
			</details>

			<div class="row" style="gap:16px; align-items:flex-start; margin-top:16px">
				<div class="form-group" style="flex:1">
					<label for="pg-user">Database User</label>
					<input id="pg-user" bind:value={pgUser} placeholder="mybench" />
				</div>
				<div class="form-group" style="flex:1">
					<label for="pg-pass">Password <span style="color:#c00">*</span></label>
					<input id="pg-pass" type="text" bind:value={pgPass} placeholder="strong password" />
				</div>
				<div class="form-group" style="flex:1">
					<label for="pg-db">Database Name</label>
					<input id="pg-db" bind:value={pgDb} placeholder="mybench" />
				</div>
			</div>

			<!-- Auto-tune section -->
			<div class="tune-section">
				<div class="tune-header">
					<strong>PostgreSQL Performance Tuning</strong>
					<span style="color:#666; font-size:12px">Auto-detects RAM, CPUs, storage type, and compiler flags</span>
					<button onclick={detectTune} disabled={detecting} style="margin-left:auto">
						{detecting ? 'Detecting…' : tuneConfig ? 'Re-detect' : 'Detect & Generate Config'}
					</button>
				</div>
				{#if detectError}
					<div style="color:#721c24; font-size:12px; margin-top:6px">{detectError}</div>
				{/if}
				{#if tuneConfig !== '' || detecting}
					<textarea
						class="code tune-editor"
						rows="14"
						bind:value={tuneConfig}
						placeholder="Generated config will appear here — edit or clear to skip tuning"
					></textarea>
					<p style="font-size:11px; color:#888; margin:4px 0 0">Written to <code>conf.d/mybench-tune.conf</code>. Delete that file to revert. Clear the box above to skip.</p>
				{/if}
			</div>

			{#if !configureDone}
				<button class="primary" disabled={configuring || !pgPass.trim()} onclick={runConfigure}>
					{configuring ? 'Configuring…' : 'Configure'}
				</button>
			{/if}

			{#if configureOutput}
				<pre class="output" style="margin-top:12px">{configureOutput}</pre>
			{/if}

			{#if configureDone}
				{#if configureOk}
					<div class="result-banner ok">✓ PostgreSQL configured successfully.</div>
					<button class="primary" style="margin-top:8px" onclick={() => currentStep = 5}>Next: Register &amp; Verify →</button>
				{:else}
					<div class="result-banner fail">✗ Configuration failed — check output above.</div>
					<button style="margin-top:8px" onclick={runConfigure}>Retry</button>
				{/if}
			{/if}
		</div>
		{/if}
	</div>

	<!-- ── Step 5: Register & Verify ─────────────────────────────────────── -->
	<div class="step" class:active={currentStep === 5} class:done={step5Done} class:locked={currentStep < 5}>
		<div class="step-header">
			<span class="step-num" class:step-done={step5Done}>{step5Done ? '✓' : '5'}</span>
			<span class="step-title">Register &amp; Verify</span>
		</div>
		{#if currentStep === 5}
		<div class="step-body">
			<p class="hint">Save both droplets to mybench and run a final end-to-end connectivity test.</p>
			<div class="form-group" style="max-width:300px">
				<label for="cluster-name">Cluster Name</label>
				<input id="cluster-name" bind:value={clusterName} placeholder="DO Singapore" />
			</div>
			{#if !registerResult}
				<button class="primary" disabled={registering || !clusterName.trim()} onclick={runRegister}>
					{registering ? 'Registering…' : 'Register & Test'}
				</button>
			{/if}
			{#if registerResult}
				{#if registerResult.ok}
					<div class="result-banner ok">
						<strong>✓ Cluster registered successfully!</strong><br/>
						PostgreSQL: {registerResult.pg_test?.version}<br/>
						mybench-runner: {registerResult.ec2_test?.binary?.version ?? 'ok'}
					</div>
					<div class="final-actions">
						<a href="/settings" class="btn-link">View in Settings</a>
						<a href="/decisions" class="btn-link primary">Create a Decision →</a>
					</div>
				{:else}
					<div class="result-banner fail">
						<strong>✗ Registration failed.</strong><br/>
						{#if registerResult.pg_test && !registerResult.pg_test.ok}
							PostgreSQL: {registerResult.pg_test.error}<br/>
						{/if}
						{#if registerResult.ec2_test && !registerResult.ec2_test.ok}
							Client SSH: {registerResult.ec2_test.error ?? registerResult.ec2_test.ssh?.ok === false ? 'SSH failed' : 'tools missing'}
						{/if}
					</div>
					<button style="margin-top:8px" onclick={runRegister}>Retry</button>
				{/if}
			{/if}
		</div>
		{/if}
	</div>
</div>

<style>
	.wizard { max-width: 860px; }
	h1 { margin-bottom: 4px; }
	.subtitle { color: #666; margin-bottom: 24px; }

	.step {
		border: 1px solid #e0e0e0;
		border-radius: 6px;
		margin-bottom: 8px;
		background: #fff;
		overflow: hidden;
	}
	.step.active { border-color: #0066cc; }
	.step.locked { opacity: 0.5; pointer-events: none; }

	.step-header {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 12px 16px;
		cursor: default;
		user-select: none;
	}
	.step.done .step-header { cursor: pointer; }
	.step.done .step-header:hover { background: #f8f8f8; }

	.step-num {
		width: 26px; height: 26px;
		border-radius: 50%;
		background: #e0e0e0;
		display: flex; align-items: center; justify-content: center;
		font-size: 12px; font-weight: 700; color: #555;
		flex-shrink: 0;
	}
	.step.active .step-num { background: #0066cc; color: #fff; }
	.step-num.step-done { background: #155724; color: #fff; }

	.step-title { font-weight: 600; font-size: 14px; }
	.step-summary { color: #888; font-size: 12px; margin-left: auto; }

	.step-body { padding: 0 16px 16px; border-top: 1px solid #f0f0f0; }

	.hint { color: #555; font-size: 13px; margin: 12px 0; line-height: 1.5; }

	.droplet-grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 16px;
		margin-bottom: 16px;
	}
	.droplet-card {
		border: 1px solid #e8e8e8;
		border-radius: 6px;
		padding: 14px;
	}
	.droplet-label {
		font-weight: 600;
		font-size: 13px;
		margin-bottom: 10px;
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.connect-result {
		margin-top: 10px;
		padding: 8px 10px;
		border-radius: 4px;
		font-size: 12px;
		line-height: 1.6;
	}
	.connect-result.ok { background: #d4edda; color: #155724; }
	.connect-result.fail { background: #f8d7da; color: #721c24; }

	.tool-row {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 6px 0;
		border-bottom: 1px solid #f5f5f5;
	}
	.tool-row:last-of-type { border-bottom: none; }
	.tool-icon { width: 18px; text-align: center; font-size: 13px; }
	.tool-icon.ok { color: #155724; }
	.tool-icon.fail { color: #721c24; }
	.tool-name { flex: 1; font-size: 13px; font-family: monospace; }
	.tool-version { font-size: 11px; color: #666; font-family: monospace; }

	.install-out { max-height: 200px; font-size: 11px; margin: 6px 0 0; }
	.perf-capability {
		margin-top: 8px;
		padding: 8px;
		border: 1px solid #eee;
		border-radius: 4px;
		background: #fafafa;
		font-size: 12px;
	}
	.perf-capability-row {
		display: flex;
		justify-content: space-between;
		gap: 10px;
		margin-bottom: 4px;
	}
	.perf-capability strong.ok { color: #155724; }
	.perf-capability strong.fail { color: #721c24; }
	.perf-cgroup {
		font-family: monospace;
		font-size: 11px;
		color: #666;
		word-break: break-all;
		margin: 6px 0;
	}
	.warn-text { color: #856404; margin: 6px 0; }

	.transparency {
		background: #f8f9fa;
		border: 1px solid #e0e0e0;
		border-radius: 4px;
		padding: 10px 14px;
		font-size: 13px;
	}
	.transparency summary { cursor: pointer; font-weight: 600; color: #444; }
	.transparency ul { margin: 8px 0 0; padding-left: 20px; line-height: 1.8; }

	.result-banner {
		padding: 10px 14px;
		border-radius: 4px;
		margin-top: 12px;
		font-size: 13px;
		line-height: 1.6;
	}
	.result-banner.ok { background: #d4edda; color: #155724; }
	.result-banner.fail { background: #f8d7da; color: #721c24; }

	.final-actions {
		display: flex;
		gap: 10px;
		margin-top: 14px;
	}
	.btn-link {
		padding: 6px 14px;
		border-radius: 4px;
		border: 1px solid #ccc;
		font-size: 13px;
		text-decoration: none;
		background: #fff;
		color: #333;
	}
	.btn-link.primary { background: #0066cc; color: #fff; border-color: #0066cc; }
	.btn-link:hover { opacity: 0.85; }

	.tune-section {
		margin-top: 16px;
		border: 1px solid #e0e0e0;
		border-radius: 6px;
		padding: 12px 14px;
		background: #fafafa;
	}
	.tune-header {
		display: flex;
		align-items: center;
		gap: 10px;
		flex-wrap: wrap;
	}
	.tune-editor {
		width: 100%;
		margin-top: 10px;
		font-size: 12px;
		line-height: 1.5;
		box-sizing: border-box;
	}
</style>
