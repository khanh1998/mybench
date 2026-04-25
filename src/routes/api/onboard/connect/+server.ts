import { error, json } from '@sveltejs/kit';
import { Client } from 'ssh2';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json();
	const { host, user, private_key } = body;
	if (!host) throw error(400, 'host is required');
	if (!private_key) throw error(400, 'private_key is required');

	const conn = new Client();
	try {
		await new Promise<void>((resolve, reject) => {
			conn
				.on('ready', () => resolve())
				.on('error', reject)
				.connect({ host, port: 22, username: user ?? 'root', privateKey: private_key });
		});

		const exec = (cmd: string): Promise<string> =>
			new Promise((resolve, reject) => {
				conn.exec(cmd, (err, stream) => {
					if (err) return reject(err);
					let out = '';
					stream.on('data', (d: Buffer) => { out += d.toString(); });
					stream.stderr.on('data', (d: Buffer) => { out += d.toString(); });
					stream.on('close', () => resolve(out.trim()));
				});
			});

		const [hostnameOut, allIps, osRelease, metadataIp] = await Promise.all([
			exec('hostname'),
			exec('hostname -I'),
			exec('lsb_release -d 2>/dev/null | cut -f2 || cat /etc/os-release | grep PRETTY_NAME | cut -d= -f2 | tr -d \'"\''),
			// DigitalOcean metadata service — most reliable source of private VPC IP
			exec('curl -sf --connect-timeout 3 http://169.254.169.254/metadata/v1/interfaces/private/0/ipv4/address 2>/dev/null || echo ""')
		]);

		// Prefer DO metadata, fall back to scanning hostname -I for 10.x.x.x
		const metaIp = metadataIp.trim();
		const privateIp = metaIp.length > 0
			? metaIp
			: (allIps.split(/\s+/).find(ip => /^10\./.test(ip)) ?? null);

		return json({
			ok: true,
			hostname: hostnameOut,
			all_ips: allIps,
			private_ip: privateIp,
			os_release: osRelease
		});
	} catch (err) {
		return json({
			ok: false,
			error: err instanceof Error ? err.message : String(err)
		});
	} finally {
		conn.end();
	}
};
