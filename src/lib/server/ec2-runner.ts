import { Client, type SFTPWrapper } from 'ssh2';
import type { Ec2Server } from '$lib/types';

export function shellQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

export function connectSsh(server: Ec2Server): Promise<Client> {
	return new Promise((resolve, reject) => {
		const conn = new Client();
		conn
			.on('ready', () => resolve(conn))
			.on('error', reject)
			.connect({
				host: server.host,
				port: server.port,
				username: server.user,
				privateKey: server.private_key
			});
	});
}

export function exec(
	conn: Client,
	command: string
): Promise<{ stdout: string; stderr: string; code: number }> {
	return new Promise((resolve, reject) => {
		conn.exec(command, (err, stream) => {
			if (err) return reject(err);
			let stdout = '';
			let stderr = '';
			stream
				.on('close', (code: number) => resolve({ stdout, stderr, code: code ?? 0 }))
				.on('data', (data: Buffer) => { stdout += data.toString(); })
				.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
		});
	});
}

export function execStreaming(
	conn: Client,
	command: string,
	onData: (line: string) => void
): Promise<number> {
	return new Promise((resolve, reject) => {
		conn.exec(command, (err, stream) => {
			if (err) return reject(err);
			let buf = '';
			stream
				.on('close', (code: number) => {
					if (buf.length > 0) onData(buf);
					resolve(code ?? 0);
				})
				.on('data', (data: Buffer) => {
					buf += data.toString();
					const lines = buf.split('\n');
					buf = lines.pop() ?? '';
					for (const line of lines) onData(line);
				})
				.stderr.on('data', (data: Buffer) => {
					buf += data.toString();
					const lines = buf.split('\n');
					buf = lines.pop() ?? '';
					for (const line of lines) onData(line);
				});
		});
	});
}

function getSftp(conn: Client): Promise<SFTPWrapper> {
	return new Promise((resolve, reject) => {
		conn.sftp((err, sftp) => {
			if (err) return reject(err);
			resolve(sftp);
		});
	});
}

export async function uploadFile(
	conn: Client,
	localPath: string,
	remotePath: string
): Promise<void> {
	const sftp = await getSftp(conn);
	return new Promise((resolve, reject) => {
		sftp.fastPut(localPath, remotePath, (err) => {
			if (err) return reject(err);
			resolve();
		});
	});
}

export async function downloadFile(
	conn: Client,
	remotePath: string,
	localPath: string
): Promise<void> {
	const sftp = await getSftp(conn);
	return new Promise((resolve, reject) => {
		sftp.fastGet(remotePath, localPath, (err) => {
			if (err) return reject(err);
			resolve();
		});
	});
}

export interface Ec2TestResult {
	ok: boolean;
	ssh: { ok: boolean; error?: string };
	binary?: { ok: boolean; version?: string; path?: string; error?: string };
	iam?: { ok: boolean; role?: string; error?: string };
}

/**
 * Tests an EC2 SSH connection and verifies mybench-runner binary is present.
 * Returns granular results for each check so the UI can report them separately.
 * Stops after the first failure (no point checking binary if SSH fails).
 */
export async function testEc2Connection(server: Ec2Server): Promise<Ec2TestResult> {
	let conn: Client | undefined;
	try {
		conn = await connectSsh(server);
	} catch (err) {
		return {
			ok: false,
			ssh: { ok: false, error: err instanceof Error ? err.message : String(err) }
		};
	}

	try {
		// SSH succeeded — now check the binary
		const homeResult = await exec(conn, 'echo $HOME');
		const homeDir = homeResult.stdout.trim();
		const remoteDir = server.remote_dir.replace(/^~/, homeDir);
		const binaryPath = `${remoteDir}/mybench-runner`;

		const check = await exec(conn, `test -x ${shellQuote(binaryPath)} && echo ok`);
		if (check.code !== 0 || !check.stdout.trim().startsWith('ok')) {
			return {
				ok: false,
				ssh: { ok: true },
				binary: { ok: false, path: binaryPath, error: `not found or not executable at ${binaryPath}` }
			};
		}

		const ver = await exec(conn, `${shellQuote(binaryPath)} --version 2>&1 || echo unknown`);

		// Stage 3: Check IAM instance profile (required for CloudWatch metrics)
		const iamCmd = `TOKEN=$(curl -s -X PUT 'http://169.254.169.254/latest/api/token' -H 'X-aws-ec2-metadata-token-ttl-seconds: 21600' 2>/dev/null) && curl -s -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/iam/security-credentials/ 2>/dev/null`;
		const iamResult = await exec(conn, iamCmd);
		const role = iamResult.stdout.trim();
		const iamOk = iamResult.code === 0 && role.length > 0 && !role.startsWith('<?xml') && !role.startsWith('<');
		const iam: Ec2TestResult['iam'] = iamOk
			? { ok: true, role }
			: {
					ok: false,
					error:
						'No IAM instance profile found on this EC2 instance. CloudWatch metrics will not be collected. ' +
						'To fix: go to AWS Console → EC2 → select instance → Actions → Security → Modify IAM role, ' +
						'then attach a role with the CloudWatchReadOnlyAccess policy.'
				};

		return {
			ok: true,
			ssh: { ok: true },
			binary: { ok: true, path: binaryPath, version: (ver.stdout || ver.stderr).trim() },
			iam
		};
	} catch (err) {
		return {
			ok: false,
			ssh: { ok: true },
			binary: { ok: false, error: err instanceof Error ? err.message : String(err) }
		};
	} finally {
		conn.end();
	}
}
