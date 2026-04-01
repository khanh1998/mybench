import type { TelemetryValueKind } from '$lib/telemetry/types';

export function formatNumber(value: number, maxFractionDigits = 2): string {
  return value.toLocaleString(undefined, {
    minimumFractionDigits: Number.isInteger(value) ? 0 : Math.min(1, maxFractionDigits),
    maximumFractionDigits: maxFractionDigits
  });
}

export function formatBytes(value: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let current = value;
  let unit = 0;
  while (Math.abs(current) >= 1024 && unit < units.length - 1) {
    current /= 1024;
    unit++;
  }
  const digits = Math.abs(current) >= 10 || unit === 0 ? 0 : 1;
  return `${current.toFixed(digits)} ${units[unit]}`;
}

export function formatDurationMs(value: number): string {
  if (Math.abs(value) >= 1000) return `${(value / 1000).toFixed(2)} s`;
  return `${formatNumber(value, 1)} ms`;
}

export function formatValue(value: unknown, kind: TelemetryValueKind = 'text'): string {
  if (value === null || value === undefined || value === '') return '—';
  if (kind === 'flag') return value ? 'yes' : 'no';
  if (kind === 'text') return String(value);
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return String(value);
  if (kind === 'bytes') return formatBytes(numeric);
  if (kind === 'percent') return `${(numeric * 100).toFixed(1)}%`;
  if (kind === 'duration_ms') return formatDurationMs(numeric);
  if (kind === 'tps') return `${formatNumber(numeric, 2)} TPS`;
  return formatNumber(numeric, 2);
}
