export const DEFAULT_PERF_EVENTS =
	'task-clock,cpu-clock,context-switches,cpu-migrations,page-faults,minor-faults,major-faults';

export type PerfScope = 'postgres_cgroup' | 'system' | 'disabled';

export interface PerfInspectResult {
	ok: boolean;
	perf_installed: boolean;
	perf_version: string;
	sudo_perf_ok: boolean;
	cgroup_version: string;
	postgres_service: string;
	postgres_cgroup: string;
	cgroup_perf_ok: boolean;
	scope: PerfScope;
	perf_cgroup: string;
	perf_events: string;
	needs_custom_slice: boolean;
	warning: string;
	error: string;
}

function getValue(lines: string[], key: string): string {
	const prefix = `${key}=`;
	return lines.find((line) => line.startsWith(prefix))?.slice(prefix.length).trim() ?? '';
}

export function parsePerfInspectOutput(output: string): PerfInspectResult {
	const lines = output.split(/\r?\n/).map((line) => line.trim());
	const perfInstalled = getValue(lines, 'PERF_INSTALLED') === '1';
	const sudoPerfOk = getValue(lines, 'SUDO_PERF_OK') === '1';
	const cgroupPerfOk = getValue(lines, 'CGROUP_PERF_OK') === '1';
	const postgresService = getValue(lines, 'POSTGRES_SERVICE');
	const postgresCgroup = getValue(lines, 'POSTGRES_CGROUP');
	const scope = (getValue(lines, 'SCOPE') || 'disabled') as PerfScope;
	return {
		ok: perfInstalled && (scope === 'postgres_cgroup' || scope === 'system'),
		perf_installed: perfInstalled,
		perf_version: getValue(lines, 'PERF_VERSION'),
		sudo_perf_ok: sudoPerfOk,
		cgroup_version: getValue(lines, 'CGROUP_VERSION') || 'unknown',
		postgres_service: postgresService,
		postgres_cgroup: postgresCgroup,
		cgroup_perf_ok: cgroupPerfOk,
		scope,
		perf_cgroup: scope === 'postgres_cgroup' ? postgresCgroup : '',
		perf_events: DEFAULT_PERF_EVENTS,
		needs_custom_slice: getValue(lines, 'NEEDS_CUSTOM_SLICE') === '1',
		warning: getValue(lines, 'WARNING'),
		error: getValue(lines, 'ERROR')
	};
}

export function buildPerfInspectCommand(events = DEFAULT_PERF_EVENTS): string {
	return `
set +e
PERF_VERSION=$(perf --version 2>&1)
PERF_CODE=$?
if [ "$PERF_CODE" -eq 0 ]; then PERF_INSTALLED=1; else PERF_INSTALLED=0; fi

SUDO_OUT=$(sudo -n env LC_ALL=C perf stat -x '\\t' -a -e ${events} -- sleep 0.1 2>&1 >/dev/null)
SUDO_CODE=$?
if [ "$SUDO_CODE" -eq 0 ]; then SUDO_PERF_OK=1; else SUDO_PERF_OK=0; fi

if [ -f /sys/fs/cgroup/cgroup.controllers ]; then CGROUP_VERSION=2; elif [ -d /sys/fs/cgroup ]; then CGROUP_VERSION=1; else CGROUP_VERSION=none; fi

POSTGRES_SERVICE=
POSTGRES_CGROUP=
for svc in $(systemctl list-units 'postgresql*.service' --state=running --no-legend --no-pager 2>/dev/null | awk '{print $1}'); do
  CG=$(systemctl show "$svc" --property=ControlGroup --value 2>/dev/null)
  PID=$(systemctl show "$svc" --property=MainPID --value 2>/dev/null)
  if [ -n "$CG" ] && [ "$PID" != "0" ]; then
    POSTGRES_SERVICE="$svc"
    POSTGRES_CGROUP="$CG"
    break
  fi
done
if [ -z "$POSTGRES_SERVICE" ]; then
  for svc in $(systemctl list-units 'postgresql*.service' --state=active --no-legend --no-pager 2>/dev/null | awk '{print $1}'); do
    CG=$(systemctl show "$svc" --property=ControlGroup --value 2>/dev/null)
    if [ -n "$CG" ]; then
      POSTGRES_SERVICE="$svc"
      POSTGRES_CGROUP="$CG"
      break
    fi
  done
fi

CGROUP_PERF_OK=0
if [ "$SUDO_PERF_OK" -eq 1 ] && [ -n "$POSTGRES_CGROUP" ]; then
  sudo -n env LC_ALL=C perf stat -x '\\t' -a -e ${events} -G "$POSTGRES_CGROUP" -- sleep 1 >/dev/null 2>&1
  if [ "$?" -eq 0 ]; then CGROUP_PERF_OK=1; fi
fi

SCOPE=disabled
NEEDS_CUSTOM_SLICE=0
WARNING=
ERROR=
if [ "$PERF_INSTALLED" -ne 1 ]; then
  ERROR="perf is not installed"
elif [ "$SUDO_PERF_OK" -ne 1 ]; then
  ERROR="sudo perf stat is not usable without an interactive password"
elif [ "$CGROUP_PERF_OK" -eq 1 ]; then
  SCOPE=postgres_cgroup
elif [ -n "$POSTGRES_SERVICE" ]; then
  SCOPE=system
  NEEDS_CUSTOM_SLICE=1
  WARNING="PostgreSQL cgroup perf smoke test failed; system-wide perf is available"
else
  SCOPE=system
  WARNING="PostgreSQL is not systemd-managed or no active service was found; using system-wide perf"
fi

printf 'PERF_INSTALLED=%s\\n' "$PERF_INSTALLED"
printf 'PERF_VERSION=%s\\n' "$PERF_VERSION"
printf 'SUDO_PERF_OK=%s\\n' "$SUDO_PERF_OK"
printf 'CGROUP_VERSION=%s\\n' "$CGROUP_VERSION"
printf 'POSTGRES_SERVICE=%s\\n' "$POSTGRES_SERVICE"
printf 'POSTGRES_CGROUP=%s\\n' "$POSTGRES_CGROUP"
printf 'CGROUP_PERF_OK=%s\\n' "$CGROUP_PERF_OK"
printf 'SCOPE=%s\\n' "$SCOPE"
printf 'NEEDS_CUSTOM_SLICE=%s\\n' "$NEEDS_CUSTOM_SLICE"
printf 'WARNING=%s\\n' "$WARNING"
printf 'ERROR=%s\\n' "$ERROR"
`.trim();
}

export function buildCreatePostgresPerfSliceCommand(sliceName: string): string {
	return `
set -e
case "${sliceName}" in
  mybench-postgres-*.slice) ;;
  *) echo "invalid slice name"; exit 2 ;;
esac
POSTGRES_SERVICE=
for svc in $(systemctl list-units 'postgresql*.service' --state=running --no-legend --no-pager 2>/dev/null | awk '{print $1}'); do
  CG=$(systemctl show "$svc" --property=ControlGroup --value 2>/dev/null)
  PID=$(systemctl show "$svc" --property=MainPID --value 2>/dev/null)
  if [ -n "$CG" ] && [ "$PID" != "0" ]; then POSTGRES_SERVICE="$svc"; break; fi
done
if [ -z "$POSTGRES_SERVICE" ]; then
  echo "No running PostgreSQL systemd service with a usable cgroup found."
  exit 1
fi
DROPIN_DIR="/etc/systemd/system/$POSTGRES_SERVICE.d"
echo "Using PostgreSQL service: $POSTGRES_SERVICE"
echo "Creating mybench slice: ${sliceName}"
sudo mkdir -p "$DROPIN_DIR"
printf '[Service]\\nSlice=${sliceName}\\n' | sudo tee "$DROPIN_DIR/mybench-perf-slice.conf" >/dev/null
sudo systemctl daemon-reload
sudo systemctl restart "$POSTGRES_SERVICE"
systemctl show "$POSTGRES_SERVICE" --property=ControlGroup --value
`.trim();
}
