import type { Env, SpeedtestRecord } from '../types';
import { THRESHOLDS } from '../types';
import {
  stripPrefix, filenameToTimestamp, endpointName,
  toMbps, recordFromMetadata,
} from '../utils/helpers';
import {
  percentile, buildTimeline, buildIncidents,
} from './summary';

const SUMMARY_HOURS = [1, 6, 24, 168, 8760] as const;

/**
 * Computes the same aggregated payload that handleSummary returns,
 * given an already-filtered list of records and the target hour window.
 */
function computeSummary(
  records: SpeedtestRecord[],
  hours: number,
  env: Env
): object {
  if (records.length === 0) {
    return {
      totalRecords: 0, timeRangeHours: hours,
      avg: { downloadMbps: 0, uploadMbps: 0, latencyMs: 0, jitterMs: 0 },
      p50: { downloadMbps: 0, uploadMbps: 0, latencyMs: 0, jitterMs: 0 },
      p95: { downloadMbps: 0, uploadMbps: 0, latencyMs: 0, jitterMs: 0 },
      p99: { downloadMbps: 0, uploadMbps: 0, latencyMs: 0, jitterMs: 0 },
      byEndpoint: {}, timeline: [], successRate: 1.0,
      incidents: [], incidentCount: 0,
    };
  }

  const downloads = records.map(r => r.download);
  const uploads   = records.map(r => r.upload);
  const latencies = records.map(r => r.latency);
  const jitters   = records.map(r => r.jitter);

  const avg = {
    downloadMbps: Math.round((downloads.reduce((a,b)=>a+b,0)/records.length)*100)/100,
    uploadMbps:   Math.round((uploads.reduce((a,b)=>a+b,0)  /records.length)*100)/100,
    latencyMs:    Math.round((latencies.reduce((a,b)=>a+b,0)/records.length)*100)/100,
    jitterMs:     Math.round((jitters.reduce((a,b)=>a+b,0)  /records.length)*100)/100,
  };

  const p50 = { downloadMbps: percentile(downloads,50), uploadMbps: percentile(uploads,50), latencyMs: percentile(latencies,50), jitterMs: percentile(jitters,50) };
  const p95 = { downloadMbps: percentile(downloads,95), uploadMbps: percentile(uploads,95), latencyMs: percentile(latencies,95), jitterMs: percentile(jitters,95) };
  const p99 = { downloadMbps: percentile(downloads,99), uploadMbps: percentile(uploads,99), latencyMs: percentile(latencies,99), jitterMs: percentile(jitters,99) };

  const endpointGroups: Record<string, SpeedtestRecord[]> = {};
  for (const rec of records) {
    if (!endpointGroups[rec.endpointName]) endpointGroups[rec.endpointName] = [];
    endpointGroups[rec.endpointName].push(rec);
  }
  const byEndpoint: Record<string, any> = {};
  for (const [name, recs] of Object.entries(endpointGroups)) {
    const dl  = recs.map(r => r.download), ul  = recs.map(r => r.upload);
    const lat = recs.map(r => r.latency),  jit = recs.map(r => r.jitter);
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

  return {
    totalRecords: records.length, timeRangeHours: hours,
    records,
    avg, p50, p95, p99, byEndpoint, timeline,
    successRate, incidents, incidentCount: incidents.length,
  };
}

export async function runCron(env: Env): Promise<void> {
  console.log('[cron] START');

  // 1. List ALL objects (no time filter — we need everything for the "All" window)
  //    IMPORTANT: include customMetadata so we can avoid body fetches.
  let allObjects: R2Object[] = [];
  let cursor: string | undefined;
  do {
    const listed = await env.R2_BUCKET.list({
      prefix:  env.R2_PREFIX,
      limit:   1000,
      cursor,
      include: ['customMetadata'],
    } as any);
    allObjects = allObjects.concat(listed.objects);
    cursor = listed.truncated ? (listed as any).cursor : undefined;
  } while (cursor);

  console.log(`[cron] ${allObjects.length} total objects`);

  // 2. Parse records — metadata-first, body fallback
  const records: SpeedtestRecord[] = [];
  const fallbackObjs: R2Object[]   = [];

  for (const obj of allObjects) {
    const rec = recordFromMetadata(obj.key, env.R2_PREFIX, obj.customMetadata ?? {});
    if (rec) records.push(rec);
    else     fallbackObjs.push(obj);
  }

  console.log(`[cron] metadata: ${records.length}, fallback: ${fallbackObjs.length}`);

  for (let i = 0; i < fallbackObjs.length; i += 50) {
    const batch   = fallbackObjs.slice(i, i + 50);
    const results = await Promise.all(batch.map(async obj => {
      try {
        const body = await env.R2_BUCKET.get(obj.key);
        if (!body) return null;
        const data     = JSON.parse(await body.text());
        const filename = stripPrefix(obj.key, env.R2_PREFIX);
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
        console.error(`[cron] parse error ${obj.key}:`, e);
        return null;
      }
    }));
    for (const r of results) if (r) records.push(r);
  }

  console.log(`[cron] ${records.length} records parsed`);

  // 3. For each standard time window, filter + aggregate + write to R2
  for (const hours of SUMMARY_HOURS) {
    const cutoff  = new Date(Date.now() - hours * 3_600_000).toISOString();
    const window  = records.filter(r => r.timestamp >= cutoff);
    const summary = computeSummary(window, hours, env);
    const key     = `_cache/summary-${hours}.json`;

    await env.R2_BUCKET.put(key, JSON.stringify(summary), {
      httpMetadata: { contentType: 'application/json' },
    });
    console.log(`[cron] wrote ${key} (${window.length} records)`);
  }

  console.log('[cron] DONE');
}
