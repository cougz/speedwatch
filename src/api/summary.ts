import type { Env, SpeedtestRecord, Incident, DegradationLevel, TimelinePoint } from "../types";
import { checkRateLimit } from "../utils/ratelimit";
import { buildCacheKey, getCached, putCache } from "../utils/cache";
import { classifyRecord, THRESHOLDS } from "../types";
import { getClientIP, jsonResponse, stripPrefix, filenameToTimestamp, endpointName, toMbps } from "../utils/helpers";

function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, index)];
}

function getBucketKeyUTC(timestamp: string, intervalMinutes: number): string {
  const d = new Date(timestamp);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth();
  const day = d.getUTCDate();
  const hour = d.getUTCHours();
  const minute = d.getUTCMinutes();
  const flooredMinute = Math.floor(minute / intervalMinutes) * intervalMinutes;
  return new Date(Date.UTC(year, month, day, hour, flooredMinute, 0, 0)).toISOString();
}

function getIntervalMinutes(hours: number): number {
  if (hours <= 1) return 5;
  if (hours <= 6) return 15;
  if (hours <= 24) return 60;
  if (hours <= 168) return 360;
  return 1440;
}

function buildTimeline(records: SpeedtestRecord[], hours: number): TimelinePoint[] {
  if (records.length === 0) return [];

  const interval = getIntervalMinutes(hours);
  const groups: Record<string, SpeedtestRecord[]> = {};

  for (const rec of records) {
    const bucketKey = getBucketKeyUTC(rec.timestamp, interval);
    if (!groups[bucketKey]) groups[bucketKey] = [];
    groups[bucketKey].push(rec);
  }

  return Object.entries(groups)
    .map(([hour, recs]) => ({
      hour,
      downloadMbps: Math.round((recs.reduce((a, b) => a + b.download, 0) / recs.length) * 100) / 100,
      uploadMbps: Math.round((recs.reduce((a, b) => a + b.upload, 0) / recs.length) * 100) / 100,
      latencyMs: Math.round((recs.reduce((a, b) => a + b.latency, 0) / recs.length) * 100) / 100,
      jitterMs: Math.round((recs.reduce((a, b) => a + b.jitter, 0) / recs.length) * 100) / 100,
      count: recs.length,
    }))
    .sort((a, b) => a.hour.localeCompare(b.hour));
}

function groupByHour(records: SpeedtestRecord[]): Record<string, SpeedtestRecord[]> {
  const groups: Record<string, SpeedtestRecord[]> = {};
  for (const rec of records) {
    const date = new Date(rec.timestamp);
    const hourKey = new Date(
      Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), date.getUTCHours())
    ).toISOString();
    if (!groups[hourKey]) groups[hourKey] = [];
    groups[hourKey].push(rec);
  }
  return groups;
}

function buildIncidents(records: SpeedtestRecord[], thresholds?: { warn: number; crit: number }): Incident[] {
  const sorted = [...records].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const incidents: Incident[] = [];
  let current: Incident | null = null;

  for (const rec of sorted) {
    const level = classifyRecord(rec, thresholds);
    if (level === "ok") {
      if (current) {
        incidents.push(current);
        current = null;
      }
      continue;
    }

    const critRatio = thresholds?.crit ?? 0.50;
    const baseline = THRESHOLDS.download.warn;
    const metrics: string[] = [];
    if (rec.download < baseline * critRatio)    metrics.push("download");
    if (rec.upload   < baseline * critRatio)    metrics.push("upload");
    if (rec.latency  > THRESHOLDS.latency.crit) metrics.push("latency");
    if (rec.jitter   > THRESHOLDS.jitter.crit)  metrics.push("jitter");

    if (!current) {
      current = {
        start: rec.timestamp,
        end: rec.timestamp,
        level,
        affectedMetrics: metrics,
        recordCount: 1,
        worstDownloadMbps: rec.download,
        worstUploadMbps: rec.upload,
        worstLatencyMs: rec.latency,
        worstJitterMs: rec.jitter,
      };
    } else {
      current.end = rec.timestamp;
      current.recordCount++;
      if (level === "crit") current.level = "crit";
      for (const m of metrics) {
        if (!current.affectedMetrics.includes(m)) current.affectedMetrics.push(m);
      }
      current.worstDownloadMbps = Math.min(current.worstDownloadMbps, rec.download);
      current.worstUploadMbps = Math.min(current.worstUploadMbps, rec.upload);
      current.worstLatencyMs = Math.max(current.worstLatencyMs, rec.latency);
      current.worstJitterMs = Math.max(current.worstJitterMs, rec.jitter);
    }
  }

  if (current) incidents.push(current);
  return incidents.filter(i => i.level === "crit").reverse();
}

export async function handleSummary(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const startTime = Date.now();
  const url = new URL(request.url);
  const clientIP = getClientIP(request);

  console.log(`[handleSummary] START Request from ${clientIP}, URL: ${url.pathname}${url.search}`);
  console.log(`[handleSummary] R2_PREFIX: "${env.R2_PREFIX}"`);
  console.log(`[handleSummary] CACHE_TTL_SECONDS: "${env.CACHE_TTL_SECONDS}"`);
  console.log(`[handleSummary] MAX_RESULTS_PER_PAGE: "${env.MAX_RESULTS_PER_PAGE}"`);

  const rateLimitResult = await checkRateLimit(env, clientIP);
  if (!rateLimitResult.allowed) {
    const duration = Date.now() - startTime;
    console.log(`[handleSummary] END Rate limit exceeded after ${duration}ms`);
    return jsonResponse(
      { error: "Rate limit exceeded", retryAfter: rateLimitResult.retryAfter },
      429
    );
  }

  const params = new URLSearchParams(url.search);
  const hours = Math.min(parseInt(params.get("hours") || "24", 10), 8760);
  const noCache = params.get("no-cache") === "true";

  console.log(`[handleSummary] Query params: hours=${hours}, noCache=${noCache}`);

  const cacheParams = new URLSearchParams();
  cacheParams.set("path", "/api/summary");
  cacheParams.set("hours", String(hours));
  const cacheKey = buildCacheKey(cacheParams);
  console.log(`[handleSummary] Cache key: ${cacheKey}`);

  if (!noCache) {
    const cached = await getCached(cacheKey);
    if (cached) {
      const cachedResponse = new Response(cached.body, {
        status: cached.status,
        headers: new Headers(cached.headers),
      });
      cachedResponse.headers.set("X-Cache", "HIT");
      const duration = Date.now() - startTime;
      console.log(`[handleSummary] END Cache HIT after ${duration}ms`);
      return cachedResponse;
    }
  }
  console.log(`[handleSummary] Cache MISS, proceeding to fetch from R2`);

  try {
    const cutoffTime = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
    console.log(`[handleSummary] cutoffTime: ${cutoffTime}`);

    let allObjects: R2Object[] = [];
    let cursor: string | undefined = undefined;
    let iterations = 0;

    while (iterations < 100) {
      const listed = await env.R2_BUCKET.list({
        prefix: env.R2_PREFIX,
        limit: 1000,
        cursor,
      });
      console.log(`[handleSummary] List iteration ${iterations}: ${listed.objects.length} objects, truncated: ${listed.truncated}`);
      allObjects = allObjects.concat(listed.objects);
      cursor = listed.truncated ? (listed as { truncated: true; cursor: string }).cursor : undefined;
      if (!listed.truncated) break;
      iterations++;
    }
    console.log(`[handleSummary] Total objects fetched: ${allObjects.length}`);

    const objectsInWindow = allObjects.filter((obj) => {
      const filename = stripPrefix(obj.key, env.R2_PREFIX);
      return filenameToTimestamp(filename) >= cutoffTime;
    });

    console.log(`[handleSummary] Objects in time window: ${objectsInWindow.length}`);

    const records: SpeedtestRecord[] = [];
    const batchSize = 50;
    let parseErrors = 0;

    for (let i = 0; i < objectsInWindow.length; i += batchSize) {
      const batch = objectsInWindow.slice(i, i + batchSize);
      const promises = batch.map(async (obj) => {
        const filename = stripPrefix(obj.key, env.R2_PREFIX);
        try {
          const body = await env.R2_BUCKET.get(obj.key);
          if (!body) return null;
          const text = await body.text();
          const data = JSON.parse(text);
          return {
            timestamp: filenameToTimestamp(filename),
            sessionID: data.sessionID,
            endpoint: data.endpoint,
            endpointName: endpointName(data.endpoint),
            success: data.success,
            download: toMbps(data.result?.download || 0),
            upload: toMbps(data.result?.upload || 0),
            latency: data.result?.latency || 0,
            jitter: data.result?.jitter || 0,
            downLoadedLatency: data.result?.downLoadedLatency || 0,
            downLoadedJitter: data.result?.downLoadedJitter || 0,
            upLoadedLatency: data.result?.upLoadedLatency || 0,
            upLoadedJitter: data.result?.upLoadedJitter || 0,
          } as SpeedtestRecord;
        } catch (e) {
          console.error(`[handleSummary] Error parsing ${obj.key}:`, e);
          parseErrors++;
          return null;
        }
      });

      const results = await Promise.all(promises);
      for (const r of results) {
        if (r) records.push(r);
      }
    }

    console.log(`[handleSummary] Parsed ${records.length} records, ${parseErrors} parse errors`);

    records.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

    if (records.length === 0) {
      console.log(`[handleSummary] No records found, returning empty response`);
      const response = jsonResponse({
        totalRecords: 0,
        timeRangeHours: hours,
        avg: { downloadMbps: 0, uploadMbps: 0, latencyMs: 0, jitterMs: 0 },
        p50: { downloadMbps: 0, uploadMbps: 0, latencyMs: 0, jitterMs: 0 },
        p95: { downloadMbps: 0, uploadMbps: 0, latencyMs: 0, jitterMs: 0 },
        p99: { downloadMbps: 0, uploadMbps: 0, latencyMs: 0, jitterMs: 0 },
        byEndpoint: {},
        timeline: [],
        successRate: 1.0,
        incidents: [],
        incidentCount: 0,
      });

      if (!noCache) {
        const cacheTtl = parseInt(env.CACHE_TTL_SECONDS, 10);
        console.log(`[handleSummary] Caching empty response with TTL: ${cacheTtl}s`);
        putCache(cacheKey, response.clone(), cacheTtl, ctx);
      }

      const duration = Date.now() - startTime;
      response.headers.set("X-Cache", "MISS");
      console.log(`[handleSummary] END Empty response in ${duration}ms`);
      return response;
    }

    const downloads = records.map((r) => r.download);
    const uploads = records.map((r) => r.upload);
    const latencies = records.map((r) => r.latency);
    const jitters = records.map((r) => r.jitter);

    const avg = {
      downloadMbps: Math.round((downloads.reduce((a, b) => a + b, 0) / records.length) * 100) / 100,
      uploadMbps: Math.round((uploads.reduce((a, b) => a + b, 0) / records.length) * 100) / 100,
      latencyMs: Math.round((latencies.reduce((a, b) => a + b, 0) / records.length) * 100) / 100,
      jitterMs: Math.round((jitters.reduce((a, b) => a + b, 0) / records.length) * 100) / 100,
    };

    const p50 = {
      downloadMbps: percentile(downloads, 50),
      uploadMbps: percentile(uploads, 50),
      latencyMs: percentile(latencies, 50),
      jitterMs: percentile(jitters, 50),
    };

    const p95 = {
      downloadMbps: percentile(downloads, 95),
      uploadMbps: percentile(uploads, 95),
      latencyMs: percentile(latencies, 95),
      jitterMs: percentile(jitters, 95),
    };

    const p99 = {
      downloadMbps: percentile(downloads, 99),
      uploadMbps: percentile(uploads, 99),
      latencyMs: percentile(latencies, 99),
      jitterMs: percentile(jitters, 99),
    };

    const byEndpoint: Record<string, { name: string; count: number; avg: { downloadMbps: number; uploadMbps: number; latencyMs: number; jitterMs: number } }> = {};
    const endpointGroups: Record<string, SpeedtestRecord[]> = {};
    for (const rec of records) {
      if (!endpointGroups[rec.endpointName]) endpointGroups[rec.endpointName] = [];
      endpointGroups[rec.endpointName].push(rec);
    }

    for (const [name, recs] of Object.entries(endpointGroups)) {
      const dl = recs.map((r) => r.download);
      const ul = recs.map((r) => r.upload);
      const lat = recs.map((r) => r.latency);
      const jit = recs.map((r) => r.jitter);
      byEndpoint[name] = {
        name,
        count: recs.length,
        avg: {
          downloadMbps: Math.round((dl.reduce((a, b) => a + b, 0) / recs.length) * 100) / 100,
          uploadMbps: Math.round((ul.reduce((a, b) => a + b, 0) / recs.length) * 100) / 100,
          latencyMs: Math.round((lat.reduce((a, b) => a + b, 0) / recs.length) * 100) / 100,
          jitterMs: Math.round((jit.reduce((a, b) => a + b, 0) / recs.length) * 100) / 100,
        },
      };
    }

    const successCount = records.filter((r) => r.success).length;
    const successRate = records.length > 0 ? successCount / records.length : 1.0;

    const thresholds = {
      warn: parseFloat(env.ANOMALY_WARN_THRESHOLD) || 0.70,
      crit: parseFloat(env.ANOMALY_CRIT_THRESHOLD) || 0.50,
    };
    const incidents = buildIncidents(records, thresholds);
    console.log(`[handleSummary] Built ${incidents.length} incidents`);

    const timeline = buildTimeline(records, hours);
    console.log(`[handleSummary] Built ${timeline.length} timeline points`);

    const response = jsonResponse({
      totalRecords: records.length,
      timeRangeHours: hours,
      records,
      avg,
      p50,
      p95,
      p99,
      byEndpoint,
      timeline,
      successRate,
      incidents,
      incidentCount: incidents.length,
    });

    if (!noCache) {
      const cacheTtl = parseInt(env.CACHE_TTL_SECONDS, 10);
      console.log(`[handleSummary] Caching response with TTL: ${cacheTtl}s`);
      putCache(cacheKey, response.clone(), cacheTtl, ctx);
    }

    const duration = Date.now() - startTime;
    response.headers.set("X-Cache", "MISS");
    console.log(`[handleSummary] END Success in ${duration}ms, ${records.length} records, ${incidents.length} incidents`);
    return response;
  } catch (err) {
    const duration = Date.now() - startTime;
    console.error(`[handleSummary] END Error after ${duration}ms:`, err);
    if (err instanceof Error) {
      console.error(`[handleSummary] Error stack:`, err.stack);
    }
    return jsonResponse({ error: "Internal server error", message: String(err) }, 500);
  }
}
