import type { Env, SpeedtestRecord, Incident, DegradationLevel, TimelinePoint } from "../types";
import { checkRateLimit } from "../utils/ratelimit";
import { buildCacheKey, getCached, putCache } from "../utils/cache";
import { classifyRecord, THRESHOLDS } from "../types";
import {
  getClientIP, jsonResponse, stripPrefix,
  filenameToTimestamp, endpointName, toMbps,
  recordFromMetadata,
} from "../utils/helpers";

export function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, index)];
}

export function getBucketKeyUTC(timestamp: string, intervalMinutes: number): string {
  const d = new Date(timestamp);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth();
  const day = d.getUTCDate();
  const hour = d.getUTCHours();
  const minute = d.getUTCMinutes();
  const flooredMinute = Math.floor(minute / intervalMinutes) * intervalMinutes;
  return new Date(Date.UTC(year, month, day, hour, flooredMinute, 0, 0)).toISOString();
}

export function getIntervalMinutes(hours: number): number {
  if (hours <= 1) return 5;
  if (hours <= 6) return 15;
  if (hours <= 24) return 60;
  if (hours <= 168) return 360;
  return 1440;
}

export function buildTimeline(records: SpeedtestRecord[], hours: number): TimelinePoint[] {
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
      uploadMbps:   Math.round((recs.reduce((a, b) => a + b.upload,   0) / recs.length) * 100) / 100,
      latencyMs:    Math.round((recs.reduce((a, b) => a + b.latency,  0) / recs.length) * 100) / 100,
      jitterMs:     Math.round((recs.reduce((a, b) => a + b.jitter,   0) / recs.length) * 100) / 100,
      count: recs.length,
    }))
    .sort((a, b) => a.hour.localeCompare(b.hour));
}

export function buildIncidents(
  records: SpeedtestRecord[],
  thresholds?: { warn: number; crit: number }
): Incident[] {
  const sorted = [...records].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const incidents: Incident[] = [];
  let current: Incident | null = null;

  for (const rec of sorted) {
    const level = classifyRecord(rec, thresholds);
    if (level === "ok") {
      if (current) { incidents.push(current); current = null; }
      continue;
    }

    const critRatio = thresholds?.crit ?? 0.50;
    const baseline  = THRESHOLDS.download.warn;
    const metrics: string[] = [];
    if (rec.download < baseline * critRatio)    metrics.push("download");
    if (rec.upload   < baseline * critRatio)    metrics.push("upload");
    if (rec.latency  > THRESHOLDS.latency.crit) metrics.push("latency");
    if (rec.jitter   > THRESHOLDS.jitter.crit)  metrics.push("jitter");

    if (!current) {
      current = {
        start: rec.timestamp,
        end:   rec.timestamp,
        level,
        affectedMetrics:    metrics,
        recordCount:        1,
        worstDownloadMbps:  rec.download,
        worstUploadMbps:    rec.upload,
        worstLatencyMs:     rec.latency,
        worstJitterMs:      rec.jitter,
      };
    } else {
      current.end = rec.timestamp;
      current.recordCount++;
      if (level === "crit") current.level = "crit";
      for (const m of metrics) {
        if (!current.affectedMetrics.includes(m)) current.affectedMetrics.push(m);
      }
      current.worstDownloadMbps = Math.min(current.worstDownloadMbps, rec.download);
      current.worstUploadMbps   = Math.min(current.worstUploadMbps,   rec.upload);
      current.worstLatencyMs    = Math.max(current.worstLatencyMs,    rec.latency);
      current.worstJitterMs     = Math.max(current.worstJitterMs,     rec.jitter);
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
  const url       = new URL(request.url);
  const clientIP  = getClientIP(request);

  console.log(`[handleSummary] START ${clientIP} ${url.search}`);

  const rateLimitResult = await checkRateLimit(env, clientIP);
  if (!rateLimitResult.allowed) {
    return jsonResponse({ error: "Rate limit exceeded", retryAfter: rateLimitResult.retryAfter }, 429);
  }

  const params  = new URLSearchParams(url.search);
  const hours   = Math.min(parseInt(params.get("hours") || "24", 10), 8760);
  const noCache = params.get("no-cache") === "true";

  // ── Tier 1: Cache API ──────────────────────────────────────────────────────
  const cacheParams = new URLSearchParams();
  cacheParams.set("path", "/api/summary");
  cacheParams.set("hours", String(hours));
  const cacheKey = buildCacheKey(cacheParams);

  if (!noCache) {
    const cached = await getCached(cacheKey);
    if (cached) {
      const cachedResponse = new Response(cached.body, {
        status: cached.status,
        headers: new Headers(cached.headers),
      });
      cachedResponse.headers.set("X-Cache", "HIT");
      console.log(`[handleSummary] Cache HIT in ${Date.now() - startTime}ms`);
      return cachedResponse;
    }
  }

  // ── Tier 2: Prebuilt R2 summary (written by cron every minute) ────────────
  if (!noCache) {
    const prebuiltKey = `_cache/summary-${hours}.json`;
    try {
      const prebuilt = await env.R2_BUCKET.get(prebuiltKey);
      if (prebuilt) {
        const body = await prebuilt.text();
        const response = new Response(body, {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
            "X-Cache": "PREBUILT",
          },
        });
        // Warm Cache API so the next request doesn't hit R2 at all
        putCache(cacheKey, response.clone(), parseInt(env.CACHE_TTL_SECONDS, 10), ctx);
        console.log(`[handleSummary] PREBUILT hit in ${Date.now() - startTime}ms`);
        return response;
      }
    } catch (e) {
      console.warn(`[handleSummary] Prebuilt read failed, falling through to live:`, e);
    }
  }

  // ── Tier 3: Live aggregation ───────────────────────────────────────────────
  console.log(`[handleSummary] Cache MISS — live aggregation`);

  try {
    const cutoffTime = new Date(Date.now() - hours * 3_600_000).toISOString();

    // IMPORTANT: include: ['customMetadata'] is required to receive metadata in list results.
    let allObjects: R2Object[] = [];
    let cursor: string | undefined;
    let iterations = 0;
    while (iterations < 100) {
      const listed = await env.R2_BUCKET.list({
        prefix:  env.R2_PREFIX,
        limit:   1000,
        cursor,
        include: ['customMetadata'],
      } as any);
      allObjects = allObjects.concat(listed.objects);
      cursor     = listed.truncated ? (listed as any).cursor : undefined;
      if (!listed.truncated) break;
      iterations++;
    }

    const objectsInWindow = allObjects.filter(obj => {
      const filename = stripPrefix(obj.key, env.R2_PREFIX);
      return filenameToTimestamp(filename) >= cutoffTime;
    });

    console.log(`[handleSummary] ${objectsInWindow.length} objects in window`);

    // Metadata-first parsing
    const records: SpeedtestRecord[]  = [];
    const fallbackObjs: R2Object[]    = [];

    for (const obj of objectsInWindow) {
      const rec = recordFromMetadata(obj.key, env.R2_PREFIX, obj.customMetadata ?? {});
      if (rec) records.push(rec);
      else     fallbackObjs.push(obj);
    }

    console.log(`[handleSummary] metadata hits: ${records.length}, fallbacks: ${fallbackObjs.length}`);

    // Body fallback for objects without metadata
    const batchSize = 50;
    let parseErrors = 0;
    for (let i = 0; i < fallbackObjs.length; i += batchSize) {
      const batch   = fallbackObjs.slice(i, i + batchSize);
      const results = await Promise.all(batch.map(async obj => {
        const filename = stripPrefix(obj.key, env.R2_PREFIX);
        try {
          const body = await env.R2_BUCKET.get(obj.key);
          if (!body) return null;
          const data = JSON.parse(await body.text());
          return {
            timestamp:         filenameToTimestamp(filename),
            sessionID:         data.sessionID,
            endpoint:          data.endpoint,
            endpointName:      endpointName(data.endpoint),
            success:           data.success,
            download:          toMbps(data.result?.download || 0),
            upload:            toMbps(data.result?.upload   || 0),
            latency:           data.result?.latency           || 0,
            jitter:            data.result?.jitter            || 0,
            downLoadedLatency: data.result?.downLoadedLatency || 0,
            downLoadedJitter:  data.result?.downLoadedJitter  || 0,
            upLoadedLatency:   data.result?.upLoadedLatency   || 0,
            upLoadedJitter:    data.result?.upLoadedJitter    || 0,
          } as SpeedtestRecord;
        } catch (e) {
          console.error(`[handleSummary] parse error ${obj.key}:`, e);
          parseErrors++;
          return null;
        }
      }));
      for (const r of results) if (r) records.push(r);
    }

    console.log(`[handleSummary] ${records.length} records total, ${parseErrors} errors`);
    records.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

    if (records.length === 0) {
      const response = jsonResponse({
        totalRecords: 0, timeRangeHours: hours,
        avg: { downloadMbps: 0, uploadMbps: 0, latencyMs: 0, jitterMs: 0 },
        p50: { downloadMbps: 0, uploadMbps: 0, latencyMs: 0, jitterMs: 0 },
        p95: { downloadMbps: 0, uploadMbps: 0, latencyMs: 0, jitterMs: 0 },
        p99: { downloadMbps: 0, uploadMbps: 0, latencyMs: 0, jitterMs: 0 },
        byEndpoint: {}, timeline: [], successRate: 1.0,
        incidents: [], incidentCount: 0,
      });
      if (!noCache) putCache(cacheKey, response.clone(), parseInt(env.CACHE_TTL_SECONDS, 10), ctx);
      response.headers.set("X-Cache", "MISS");
      return response;
    }

    const downloads = records.map(r => r.download);
    const uploads   = records.map(r => r.upload);
    const latencies = records.map(r => r.latency);
    const jitters   = records.map(r => r.jitter);

    const avg = {
      downloadMbps: Math.round((downloads.reduce((a, b) => a + b, 0) / records.length) * 100) / 100,
      uploadMbps:   Math.round((uploads.reduce((a, b) => a + b, 0)   / records.length) * 100) / 100,
      latencyMs:    Math.round((latencies.reduce((a, b) => a + b, 0) / records.length) * 100) / 100,
      jitterMs:     Math.round((jitters.reduce((a, b) => a + b, 0)   / records.length) * 100) / 100,
    };

    const p50 = { downloadMbps: percentile(downloads, 50), uploadMbps: percentile(uploads, 50), latencyMs: percentile(latencies, 50), jitterMs: percentile(jitters, 50) };
    const p95 = { downloadMbps: percentile(downloads, 95), uploadMbps: percentile(uploads, 95), latencyMs: percentile(latencies, 95), jitterMs: percentile(jitters, 95) };
    const p99 = { downloadMbps: percentile(downloads, 99), uploadMbps: percentile(uploads, 99), latencyMs: percentile(latencies, 99), jitterMs: percentile(jitters, 99) };

    const endpointGroups: Record<string, SpeedtestRecord[]> = {};
    for (const rec of records) {
      if (!endpointGroups[rec.endpointName]) endpointGroups[rec.endpointName] = [];
      endpointGroups[rec.endpointName].push(rec);
    }
    const byEndpoint: Record<string, any> = {};
    for (const [name, recs] of Object.entries(endpointGroups)) {
      const dl = recs.map(r => r.download), ul = recs.map(r => r.upload);
      const lat = recs.map(r => r.latency), jit = recs.map(r => r.jitter);
      byEndpoint[name] = {
        name, count: recs.length,
        avg: {
          downloadMbps: Math.round((dl.reduce((a,b)=>a+b,0)/recs.length)*100)/100,
          uploadMbps:   Math.round((ul.reduce((a,b)=>a+b,0)/recs.length)*100)/100,
          latencyMs:    Math.round((lat.reduce((a,b)=>a+b,0)/recs.length)*100)/100,
          jitterMs:     Math.round((jit.reduce((a,b)=>a+b,0)/recs.length)*100)/100,
        },
      };
    }

    const successRate = records.filter(r => r.success).length / records.length;
    const thresholds  = {
      warn: parseFloat(env.ANOMALY_WARN_THRESHOLD) || 0.70,
      crit: parseFloat(env.ANOMALY_CRIT_THRESHOLD) || 0.50,
    };
    const incidents = buildIncidents(records, thresholds);
    const timeline  = buildTimeline(records, hours);

    const response = jsonResponse({
      totalRecords: records.length, timeRangeHours: hours, records,
      avg, p50, p95, p99, byEndpoint, timeline,
      successRate, incidents, incidentCount: incidents.length,
    });

    if (!noCache) putCache(cacheKey, response.clone(), parseInt(env.CACHE_TTL_SECONDS, 10), ctx);
    response.headers.set("X-Cache", "MISS");
    console.log(`[handleSummary] END ${Date.now() - startTime}ms`);
    return response;

  } catch (err) {
    console.error(`[handleSummary] ERROR:`, err);
    return jsonResponse({ error: "Internal server error", message: String(err) }, 500);
  }
}
