import { error, json } from '@sveltejs/kit';
import { connectSsh, exec } from '$lib/server/ec2-runner';
import type { RequestHandler } from './$types';

/**
 * POST /api/onboard/detect-tune
 * SSHes into the DB server, detects hardware + PG build flags, and returns
 * a ready-to-apply postgresql.conf snippet with conservative tuning values.
 * Body: { host, user, private_key }
 */
export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json();
	const { host, user, private_key } = body;
	if (!host) throw error(400, 'host is required');
	if (!private_key) throw error(400, 'private_key is required');

	const server = { id: 0, name: '', host, user: user ?? 'root', port: 22, private_key, remote_dir: '~', log_dir: '/tmp', vpc: '' };

	let conn;
	try {
		conn = await connectSsh(server);
	} catch (err) {
		return json({ ok: false, error: err instanceof Error ? err.message : String(err) });
	}

	try {
		// RAM in MB
		const ramRes = await exec(conn, "free -m | awk '/^Mem:/ {print $2}'");
		const ramMb = parseInt(ramRes.stdout.trim(), 10) || 0;

		// CPU count
		const cpuRes = await exec(conn, 'nproc');
		const cpus = parseInt(cpuRes.stdout.trim(), 10) || 1;

		// Storage type detection — works in VMs (virtio-blk) and bare metal alike.
		// /dev/nvme* and the rotational flag are unreliable in VMs (virtio presents NVMe as
		// a virtual block device with rotational=1). discard_granularity > 0 means TRIM-capable
		// = SSD or NVMe-backed, regardless of how the hypervisor exposes it.
		const storageRes = await exec(conn, `
ROOT_DEV=$(lsblk -no pkname $(findmnt -n -o SOURCE /) 2>/dev/null | head -1)
DISC=$(cat /sys/block/$ROOT_DEV/queue/discard_granularity 2>/dev/null || echo 0)
NVME=$(ls /dev/nvme0 2>/dev/null && echo 1 || echo 0)
echo "$DISC $NVME"
`.trim());
		const [discStr, nvmeStr] = storageRes.stdout.trim().split(' ');
		const isNvme = nvmeStr === '1';
		const isSsd = isNvme || parseInt(discStr, 10) > 0;

		// PG compiler flags for optional settings
		const pgConfigRes = await exec(conn, 'pg_config --configure 2>/dev/null || echo ""');
		const pgConfigFlags = pgConfigRes.stdout;
		const hasLz4 = pgConfigFlags.includes('--with-lz4');
		const hasLiburing = pgConfigFlags.includes('--with-liburing');

		const config = buildTuneConfig({ ramMb, cpus, isNvme, isSsd, hasLz4, hasLiburing });
		return json({ ok: true, config, detected: { ramMb, cpus, isNvme, isSsd, hasLz4, hasLiburing } });
	} catch (err) {
		return json({ ok: false, error: err instanceof Error ? err.message : String(err) });
	} finally {
		conn.end();
	}
};

interface HardwareInfo {
	ramMb: number;
	cpus: number;
	isNvme: boolean;
	isSsd: boolean;
	hasLz4: boolean;
	hasLiburing: boolean;
}

function buildTuneConfig(hw: HardwareInfo): string {
	const { ramMb, isNvme, isSsd, hasLz4, hasLiburing } = hw;

	// shared_buffers: 25% of RAM
	const sharedBuffersMb = Math.max(128, Math.floor(ramMb / 4));

	// effective_cache_size: 75% of RAM (planner hint, not allocated)
	const effectiveCacheMb = Math.max(256, Math.floor(ramMb * 3 / 4));

	// maintenance_work_mem: RAM/16, capped at 2048MB
	const maintenanceWorkMemMb = Math.min(2048, Math.max(64, Math.floor(ramMb / 16)));

	// wal_buffers: fixed 16MB when RAM >= 1GB, else 4MB
	const walBuffersMb = ramMb >= 1024 ? 16 : 4;

	const lines: string[] = [
		`# mybench auto-tune — generated from detected hardware`,
		`# RAM: ${ramMb}MB  Storage: ${isNvme ? 'NVMe' : isSsd ? 'NVMe/SSD' : 'HDD'}`,
		`# Delete this file to revert to PostgreSQL defaults`,
		``,
		`shared_buffers = ${sharedBuffersMb}MB`,
		`effective_cache_size = ${effectiveCacheMb}MB`,
		`maintenance_work_mem = ${maintenanceWorkMemMb}MB`,
		`wal_buffers = ${walBuffersMb}MB`,
		`checkpoint_completion_target = 0.9`,
		``,
		`# Storage-tuned`,
		`random_page_cost = ${isNvme || isSsd ? '1.1' : '4.0'}`,
		`effective_io_concurrency = ${isNvme || isSsd ? '1000' : '2'}`,
	];

	if (hasLz4) {
		lines.push(``, `# Compiler-flag-gated`);
		lines.push(`wal_compression = lz4`);
	}
	if (hasLiburing) {
		if (!hasLz4) lines.push(``, `# Compiler-flag-gated`);
		lines.push(`io_method = io_uring`);
	}

	return lines.join('\n');
}
