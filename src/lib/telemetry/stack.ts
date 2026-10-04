import type { TelemetrySeries } from '$lib/telemetry/types';

export interface StackSegment {
  label: string;
  color: string;
  mean: number;
  min: number;
  max: number;
}

export interface StackBar {
  label: string;
  segments: StackSegment[];
}

export function seriesSegment(series: TelemetrySeries, color = series.color): StackSegment | null {
  if (!series.points.length) return null;
  const values = series.points.map((point) => point.v);
  return {
    label: series.label,
    color,
    mean: values.reduce((a, b) => a + b, 0) / values.length,
    min: Math.min(...values),
    max: Math.max(...values)
  };
}
