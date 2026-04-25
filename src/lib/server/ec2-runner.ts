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
	pgbench?: { ok: boolean; version?: string; error?: string };
	sysbench?: { ok: boolean; version?: string; error?: string };
	iam?: { ok: boolean; role?: string; error?: string };
}

/**
 * Tests an EC2 SSH connection and verifies mybench-runner, pgbench, and sysbench are present.
 * Returns granular results for each check so the UI can report them separately.
 * Stops after the first failure (no point checking tools if SSH fails).
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
		const homeResult = await exec(conn, 'echo $HOME');
		const homeDir = homeResult.stdout.trim();
		const remoteDir = server.remote_dir.replace(/^~/, homeDir);
		const binaryPath = `${remoteDir}/mybench-runner`;

		// Check mybench-runner binary
		const check = await exec(conn, `test -x ${shellQuote(binaryPath)} && echo ok`);
		const binaryOk = check.code === 0 && check.stdout.trim().startsWith('ok');
		let binary: Ec2TestResult['binary'];
		if (binaryOk) {
			const ver = await exec(conn, `${shellQuote(binaryPath)} --version 2>&1 || echo unknown`);
			binary = { ok: true, path: binaryPath, version: (ver.stdout || ver.stderr).trim() };
		} else {
			binary = { ok: false, path: binaryPath, error: `not found or not executable at ${binaryPath}` };
		}

		// Check pgbench
		const pgbenchRes = await exec(conn, 'which pgbench >/dev/null 2>&1 && pgbench --version 2>&1 || echo NOT_FOUND');
		const pgbenchOut = pgbenchRes.stdout.trim();
		const pgbench: Ec2TestResult['pgbench'] = pgbenchOut === 'NOT_FOUND' || pgbenchRes.code !== 0
			? { ok: false, error: 'not found on PATH' }
			: { ok: true, version: pgbenchOut };

		// Check sysbench
		const sysbenchRes = await exec(conn, 'which sysbench >/dev/null 2>&1 && sysbench --version 2>&1 || echo NOT_FOUND');
		const sysbenchOut = sysbenchRes.stdout.trim();
		const sysbench: Ec2TestResult['sysbench'] = sysbenchOut === 'NOT_FOUND' || sysbenchRes.code !== 0
			? { ok: false, error: 'not found on PATH' }
			: { ok: true, version: sysbenchOut };

		// Check IAM instance profile (required for CloudWatch metrics)
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

		const overallOk = binaryOk && pgbench.ok && sysbench.ok;
		return { ok: overallOk, ssh: { ok: true }, binary, pgbench, sysbench, iam };
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

/** Builds the shell command to install a given tool on the remote server. */
export function buildInstallCommand(tool: 'mybench-runner' | 'pgbench' | 'sysbench', remoteDir: string): string {
	if (tool === 'mybench-runner') {
		return `
set -e
export PATH=$PATH:/usr/local/go/bin:$HOME/go/bin
echo "==> Checking Go..."
if ! command -v go >/dev/null 2>&1; then
  echo "==> Go not found. Installing Go..."
  ARCH=$(uname -m)
  case "$ARCH" in aarch64|arm64) GOARCH="arm64" ;; *) GOARCH="amd64" ;; esac
  GOVERSION="1.24.3"
  curl -fsSL "https://go.dev/dl/go\${GOVERSION}.linux-\${GOARCH}.tar.gz" | sudo tar -C /usr/local -xzf -
  export PATH=$PATH:/usr/local/go/bin
fi
echo "==> Go: $(go version)"
MEM_MB=$(free -m | awk '/^Mem:/{print $2}')
if [ "$MEM_MB" -lt 1024 ] && ! swapon --show | grep -q .; then
  echo "==> Low memory (\${MEM_MB}MB RAM). Creating 2GB swap file to prevent OOM during build..."
  sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
  echo "==> Swap enabled."
fi
mkdir -p ${shellQuote(remoteDir)}
if [ -d ${shellQuote(remoteDir + '/src/.git')} ]; then
  echo "==> Updating mybench source..."
  cd ${shellQuote(remoteDir + '/src')} && git pull
else
  echo "==> Cloning mybench source..."
  git clone https://github.com/khanh1998/mybench ${shellQuote(remoteDir + '/src')}
fi
echo "==> Building mybench-runner..."
cd ${shellQuote(remoteDir + '/src/cli')} && go build -o ${shellQuote(remoteDir + '/mybench-runner')} ./cmd/
echo "==> Done: $(${shellQuote(remoteDir + '/mybench-runner')} --version)"
`.trim();
	}

	if (tool === 'pgbench') {
		return `
set -e
if command -v apt-get >/dev/null 2>&1; then
  echo "==> Detected apt. Setting up pgdg repository..."
  sudo apt-get install -y curl ca-certificates
  sudo install -d /usr/share/postgresql-common/pgdg
  sudo curl -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc --fail \\
    https://www.postgresql.org/media/keys/ACCC4CF8.asc
  . /etc/os-release
  sudo sh -c "echo 'deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt \${VERSION_CODENAME}-pgdg main' > /etc/apt/sources.list.d/pgdg.list"
  sudo apt-get update -y 2>&1 | grep -v "^E:" || true
  echo "==> Installing postgresql-18 (includes pgbench; server will be disabled on this client)..."
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y postgresql-18
  sudo systemctl stop postgresql 2>/dev/null || true
  sudo systemctl disable postgresql 2>/dev/null || true
elif command -v dnf >/dev/null 2>&1; then
  echo "==> Detected dnf. Installing postgresql..."
  sudo dnf install -y postgresql
elif command -v yum >/dev/null 2>&1; then
  echo "==> Detected yum. Installing postgresql..."
  sudo yum install -y postgresql
else
  echo "ERROR: No supported package manager found (apt/dnf/yum)." && exit 1
fi
echo "==> pgbench: $(pgbench --version)"
`.trim();
	}

	// sysbench
	return `
set -e
if command -v apt-get >/dev/null 2>&1; then
  echo "==> Detected apt. Installing sysbench..."
  curl -fsSL https://packagecloud.io/install/repositories/akopytov/sysbench/script.deb.sh | sudo bash
  sudo apt-get install -y sysbench
elif command -v dnf >/dev/null 2>&1; then
  echo "==> Detected dnf. Installing sysbench..."
  curl -fsSL https://packagecloud.io/install/repositories/akopytov/sysbench/script.rpm.sh | sudo bash
  sudo dnf install -y sysbench
elif command -v yum >/dev/null 2>&1; then
  echo "==> Detected yum. Installing sysbench..."
  curl -fsSL https://packagecloud.io/install/repositories/akopytov/sysbench/script.rpm.sh | sudo bash
  sudo yum install -y sysbench
else
  echo "ERROR: No supported package manager found (apt/dnf/yum)." && exit 1
fi
echo "==> sysbench: $(sysbench --version)"
`.trim();
}
