import { exec } from '$lib/server/ec2-runner';
import type { Client } from 'ssh2';

/**
 * Detect instance hardware spec over an existing SSH connection.
 * Returns a formatted string like "4 vCPU (Intel Xeon Platinum 8168 @ 2.70GHz), 8 GB RAM, 50 GB SSD".
 */
export async function detectInstanceSpec(conn: Client): Promise<string> {
	const [cpuCountRes, cpuModelRes, ramRes, diskRes] = await Promise.all([
		exec(conn, 'nproc'),
		exec(conn, "grep -m1 'model name' /proc/cpuinfo | cut -d: -f2 | sed 's/(R)//g; s/(TM)//g; s/  */ /g; s/^ //; s/ CPU//' | xargs"),
		exec(conn, "awk '/MemTotal/ {printf \"%.0f\", $2/1024}' /proc/meminfo"),
		exec(conn, [
			'ROOT_DEV=$(lsblk -no pkname $(findmnt -n -o SOURCE /) 2>/dev/null | head -1)',
			'DISC=$(cat /sys/block/$ROOT_DEV/queue/discard_granularity 2>/dev/null || echo 0)',
			'NVME=$(ls /dev/nvme0 2>/dev/null && echo 1 || echo 0)',
			'SIZE=$(lsblk -bdno SIZE /dev/$ROOT_DEV 2>/dev/null || echo 0)',
			'echo "$DISC $NVME $SIZE"'
		].join('\n'))
	]);

	const cpus = parseInt(cpuCountRes.stdout.trim(), 10) || 0;
	const cpuModel = cpuModelRes.stdout.trim();
	const ramMb = parseInt(ramRes.stdout.trim(), 10) || 0;

	const [discStr, nvmeStr, sizeStr] = diskRes.stdout.trim().split(/\s+/);
	const isNvme = nvmeStr === '1';
	const isSsd = isNvme || parseInt(discStr ?? '0', 10) > 0;
	const diskBytes = parseInt(sizeStr ?? '0', 10) || 0;
	const diskGb = diskBytes > 0 ? Math.round(diskBytes / (1024 ** 3)) : 0;

	const storageLabel = isNvme ? 'NVMe' : isSsd ? 'SSD' : 'HDD';

	const parts: string[] = [];
	if (cpus > 0) {
		parts.push(cpuModel ? `${cpus} vCPU (${cpuModel})` : `${cpus} vCPU`);
	}
	if (ramMb > 0) {
		const ramGb = Math.round(ramMb / 1024);
		parts.push(ramGb >= 1 ? `${ramGb} GB RAM` : `${ramMb} MB RAM`);
	}
	if (diskGb > 0) parts.push(`${diskGb} GB ${storageLabel}`);

	return parts.join(', ');
}
