import { describe, expect, it } from 'vitest';
import { buildCreatePostgresPerfSliceCommand, buildPerfInspectCommand, DEFAULT_PERF_EVENTS, parsePerfInspectOutput } from './perf-inspect';

describe('perf inspect helpers', () => {
	it('parses postgres cgroup capability', () => {
		const result = parsePerfInspectOutput(`
PERF_INSTALLED=1
PERF_VERSION=perf version 6.8
SUDO_PERF_OK=1
CGROUP_VERSION=2
POSTGRES_SERVICE=postgresql.service
POSTGRES_CGROUP=/system.slice/postgresql.service
CGROUP_PERF_OK=1
SCOPE=postgres_cgroup
NEEDS_CUSTOM_SLICE=0
WARNING=
ERROR=
`);
		expect(result.ok).toBe(true);
		expect(result.scope).toBe('postgres_cgroup');
		expect(result.perf_cgroup).toBe('/system.slice/postgresql.service');
		expect(result.needs_custom_slice).toBe(false);
	});

	it('marks system fallback as needing a custom slice when postgres is systemd-managed', () => {
		const result = parsePerfInspectOutput(`
PERF_INSTALLED=1
PERF_VERSION=perf version 6.8
SUDO_PERF_OK=1
CGROUP_VERSION=2
POSTGRES_SERVICE=postgresql.service
POSTGRES_CGROUP=/system.slice/postgresql.service
CGROUP_PERF_OK=0
SCOPE=system
NEEDS_CUSTOM_SLICE=1
WARNING=PostgreSQL cgroup perf smoke test failed; system-wide perf is available
ERROR=
`);
		expect(result.ok).toBe(true);
		expect(result.scope).toBe('system');
		expect(result.needs_custom_slice).toBe(true);
	});

	it('builds a systemd drop-in command for a mybench slice', () => {
		const cmd = buildCreatePostgresPerfSliceCommand('mybench-postgres-a7k3p9q2.slice');
		expect(cmd).toContain('Slice=mybench-postgres-a7k3p9q2.slice');
		expect(cmd).toContain('systemctl restart "$POSTGRES_SERVICE"');
	});

	it('uses software counters for perf smoke tests', () => {
		const cmd = buildPerfInspectCommand();
		expect(DEFAULT_PERF_EVENTS).toBe('task-clock,cpu-clock,context-switches,cpu-migrations,page-faults,minor-faults,major-faults');
		expect(cmd).toContain(`-e ${DEFAULT_PERF_EVENTS}`);
	});
});
