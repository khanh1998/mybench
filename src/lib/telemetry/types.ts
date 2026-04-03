export type TelemetryPhase = 'pre' | 'bench' | 'post';
export type TelemetryValueKind = 'count' | 'bytes' | 'percent' | 'duration_ms' | 'tps' | 'text' | 'flag';

export interface TelemetryCard {
  key: string;
  label: string;
  kind: TelemetryValueKind;
  value: number | string | boolean | null;
  infoText?: string;
}

export interface TelemetryTableColumn {
  key: string;
  label: string;
  kind?: TelemetryValueKind;
}

export interface TelemetrySeriesPoint {
  t: number;
  v: number;
}

export interface TelemetrySeries {
  label: string;
  color: string;
  points: TelemetrySeriesPoint[];
}

export interface TelemetryChartMetric {
  key: string;
  label: string;
  kind: TelemetryValueKind;
  title: string;
  series: TelemetrySeries[];
}

export interface TelemetryMarker {
  t: number;
  label: string;
  color?: string;
}

export interface TelemetryTableSnapshot {
  t: number;
  rows: Record<string, unknown>[];
}

export interface TelemetrySection {
  key: string;
  label: string;
  status: 'ok' | 'no_data' | 'unsupported';
  reason?: string;
  summary: TelemetryCard[];
  chartTitle: string;
  chartSeries: TelemetrySeries[];
  chartMetrics?: TelemetryChartMetric[];
  defaultChartMetricKey?: string;
  tableTitle: string;
  tableColumns: TelemetryTableColumn[];
  tableRows: Record<string, unknown>[];
  tableSnapshots?: TelemetryTableSnapshot[];
}

export interface RunTelemetry {
  runId: number;
  database: string;
  originTs: string;
  availablePhases: TelemetryPhase[];
  selectedPhases: TelemetryPhase[];
  markers: TelemetryMarker[];
  heroCards: TelemetryCard[];
  sections: TelemetrySection[];
}
