export interface Env {
  ASSETS: Fetcher;
  R2_BUCKET: R2Bucket;
  RATE_LIMITER: RateLimit;
  R2_PREFIX: string;
  CACHE_TTL_SECONDS: string;
  MAX_RESULTS_PER_PAGE: string;
  ANOMALY_WARN_THRESHOLD: string;
  ANOMALY_CRIT_THRESHOLD: string;
}

export interface SpeedtestRecord {
  timestamp: string;
  sessionID: string;
  endpoint: string;
  endpointName: string;
  success: boolean;
  download: number;
  upload: number;
  latency: number;
  jitter: number;
  downLoadedLatency: number;
  downLoadedJitter: number;
  upLoadedLatency: number;
  upLoadedJitter: number;
}

export interface SummaryResponse {
  totalRecords: number;
  timeRangeHours: number;
  records: SpeedtestRecord[];
  avg: MetricSet;
  p50: MetricSet;
  p95: MetricSet;
  p99: MetricSet;
  byEndpoint: Record<string, EndpointSummary>;
  timeline: TimelinePoint[];
  successRate: number;
  incidents: Incident[];
  incidentCount: number;
}

export interface MetricSet {
  downloadMbps: number;
  uploadMbps: number;
  latencyMs: number;
  jitterMs: number;
}

export interface EndpointSummary {
  name: string;
  count: number;
  avg: MetricSet;
}

export interface TimelinePoint {
  hour: string;
  downloadMbps: number;
  uploadMbps: number;
  latencyMs: number;
  jitterMs: number;
  count: number;
}

export const THRESHOLDS = {
  download: { warn: 50, crit: 25 },
  upload: { warn: 20, crit: 10 },
  latency: { warn: 20, crit: 50 },
  jitter: { warn: 5, crit: 15 },
} as const;

export type DegradationLevel = "ok" | "warn" | "crit";

export interface Incident {
  start: string;
  end: string;
  level: DegradationLevel;
  affectedMetrics: string[];
  recordCount: number;
  worstDownloadMbps: number;
  worstUploadMbps: number;
  worstLatencyMs: number;
  worstJitterMs: number;
}

export function classifyRecord(
  r: SpeedtestRecord,
  thresholds?: { warn: number; crit: number }
): DegradationLevel {
  const defaultThresholds = THRESHOLDS;
  const warnThreshold = thresholds?.warn ?? 0.70;
  const critThreshold = thresholds?.crit ?? 0.50;

  const baseline = defaultThresholds.download.warn;
  if (
    r.download < baseline * critThreshold ||
    r.upload < baseline * critThreshold ||
    r.latency > defaultThresholds.latency.crit ||
    r.jitter > defaultThresholds.jitter.crit
  )
    return "crit";
  if (
    r.download < baseline * warnThreshold ||
    r.upload < baseline * warnThreshold ||
    r.latency > defaultThresholds.latency.warn ||
    r.jitter > defaultThresholds.jitter.warn
  )
    return "warn";
  return "ok";
}

export class AppError extends Error {
  constructor(message: string, public readonly statusCode = 500) {
    super(message);
    this.name = "AppError";
  }
}

export class ValidationError extends AppError {
  constructor(m: string) {
    super(m, 400);
  }
}

export class RateLimitError extends AppError {
  constructor(public readonly retryAfter = 60) {
    super("Rate limit exceeded", 429);
  }
}
