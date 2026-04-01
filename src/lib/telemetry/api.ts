import type { RunTelemetry, TelemetryPhase } from '$lib/telemetry/types';

export async function fetchRunTelemetry(runId: number, phases: TelemetryPhase[]): Promise<RunTelemetry> {
  const params = new URLSearchParams();
  params.set('phases', phases.join(','));
  const res = await fetch(`/api/runs/${runId}/telemetry?${params.toString()}`);
  const json = await res.json();
  if (!res.ok) {
    throw new Error(json.message ?? `HTTP ${res.status}`);
  }
  return json as RunTelemetry;
}
