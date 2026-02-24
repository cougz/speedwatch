import type { Env } from "../types";
import { checkRateLimit } from "../utils/ratelimit";
import { buildCacheKey, getCached, putCache } from "../utils/cache";
import type { SpeedtestRecord } from "../types";
import {
  getClientIP, jsonResponse, stripPrefix,
  filenameToTimestamp, endpointName, toMbps,
  recordFromMetadata,
} from "../utils/helpers";

export async function handleResults(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const startTime = Date.now();
  const url = new URL(request.url);
  const clientIP = getClientIP(request);

  console.log(`[handleResults] START Request from ${clientIP}, URL: ${url.pathname}${url.search}`);
  console.log(`[handleResults] R2_PREFIX: "${env.R2_PREFIX}"`);
  console.log(`[handleResults] MAX_RESULTS_PER_PAGE: "${env.MAX_RESULTS_PER_PAGE}"`);

  const rateLimitResult = await checkRateLimit(env, clientIP);
  if (!rateLimitResult.allowed) {
    const retryAfter = rateLimitResult.retryAfter || 60;
    const duration = Date.now() - startTime;
    console.log(`[handleResults] END Rate limit exceeded after ${duration}ms`);
    return new Response(
      JSON.stringify({ error: "Rate limit exceeded", retryAfter }),
      {
        status: 429,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
          "Retry-After": String(retryAfter),
        },
      }
    );
  }

  const params = new URLSearchParams(url.search);
  const limit = Math.min(
    parseInt(params.get("limit") || "100", 10),
    parseInt(env.MAX_RESULTS_PER_PAGE, 10)
  );
  const cursor = params.get("cursor") || undefined;
  const endpointFilter = params.get("endpoint") || undefined;
  const fromTimestamp = params.get("from") || undefined;
  const noCache = params.get("no-cache") === "true";

  console.log(`[handleResults] Query params: limit=${limit}, cursor=${cursor}, endpoint=${endpointFilter}, from=${fromTimestamp}, noCache=${noCache}`);

  const cacheParams = new URLSearchParams();
  cacheParams.set("path", "/api/results");
  if (limit) cacheParams.set("limit", String(limit));
  if (cursor) cacheParams.set("cursor", cursor);
  if (endpointFilter) cacheParams.set("endpoint", endpointFilter);
  if (fromTimestamp) cacheParams.set("from", fromTimestamp);
  const cacheKey = buildCacheKey(cacheParams);
  console.log(`[handleResults] Cache key: ${cacheKey}`);

  if (!noCache) {
    const cached = await getCached(cacheKey);
    if (cached) {
      const cachedResponse = new Response(cached.body, {
        status: cached.status,
        headers: new Headers(cached.headers),
      });
      cachedResponse.headers.set("X-Cache", "HIT");
      const duration = Date.now() - startTime;
      console.log(`[handleResults] END Cache HIT after ${duration}ms`);
      return cachedResponse;
    }
  }
  console.log(`[handleResults] Cache MISS, proceeding to fetch from R2`);

  try {
    let listOptions: R2ListOptions = { prefix: env.R2_PREFIX, limit: 1000, include: ['customMetadata'] } as any;
    if (cursor) {
      listOptions.cursor = cursor;
    }

    console.log(`[handleResults] Listing R2 objects with prefix: "${env.R2_PREFIX}"`);
    const listed = await env.R2_BUCKET.list(listOptions);
    console.log(`[handleResults] Listed ${listed.objects.length} objects, truncated: ${listed.truncated}`);
    console.log(`[handleResults] First 5 keys:`, listed.objects.slice(0, 5).map(o => o.key));
    let objects = listed.objects;

    if (listed.truncated) {
      let nextCursor: string | undefined = (listed as { truncated: true; cursor: string }).cursor;
      while (nextCursor && objects.length < limit) {
        const listOpts: R2ListOptions = {
          prefix: env.R2_PREFIX,
          cursor: nextCursor,
          limit: 1000,
          include: ['customMetadata'],
        } as any;
        const nextList = await env.R2_BUCKET.list(listOpts);
        objects = objects.concat(nextList.objects);
        if (nextList.truncated) {
          nextCursor = (nextList as { truncated: true; cursor: string }).cursor;
        } else {
          nextCursor = undefined;
        }
        if (!nextList.truncated) break;
      }
    }

    let filteredObjects = objects;
    if (fromTimestamp) {
      filteredObjects = objects.filter((obj) => {
        const filename = stripPrefix(obj.key, env.R2_PREFIX);
        return filenameToTimestamp(filename) >= fromTimestamp;
      });
      console.log(`[handleResults] Filtered by timestamp: ${objects.length} -> ${filteredObjects.length} objects`);
    }

    const records: SpeedtestRecord[] = [];
    const fallbackObjs: R2Object[] = [];

    for (const obj of filteredObjects) {
      const rec = recordFromMetadata(obj.key, env.R2_PREFIX, obj.customMetadata ?? {});
      if (rec) {
        if (!endpointFilter || rec.endpointName === endpointFilter) records.push(rec);
      } else {
        fallbackObjs.push(obj);
      }
    }

    const BATCH_SIZE = 50;
    for (let i = 0; i < fallbackObjs.length; i += BATCH_SIZE) {
      const batch = fallbackObjs.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(
        batch.map(async (obj) => {
          const filename = stripPrefix(obj.key, env.R2_PREFIX);
          try {
            const body = await env.R2_BUCKET.get(obj.key);
            if (!body) {
              console.warn(`[handleResults] Empty body for ${obj.key}`);
              return null;
            }
            const text = await body.text();
            const data = JSON.parse(text);
            const name = endpointName(data.endpoint);
            const rec: SpeedtestRecord = {
              timestamp: filenameToTimestamp(filename),
              sessionID: data.sessionID,
              endpoint: data.endpoint,
              endpointName: name,
              success: data.success,
              download: toMbps(data.result?.download || 0),
              upload: toMbps(data.result?.upload || 0),
              latency: data.result?.latency || 0,
              jitter: data.result?.jitter || 0,
              downLoadedLatency: data.result?.downLoadedLatency || 0,
              downLoadedJitter: data.result?.downLoadedJitter || 0,
              upLoadedLatency: data.result?.upLoadedLatency || 0,
              upLoadedJitter: data.result?.upLoadedJitter || 0,
            };
            if (endpointFilter && rec.endpointName !== endpointFilter) return null;
            return rec;
          } catch (e) {
            console.error(`[handleResults] Error reading ${obj.key}:`, e);
            return null;
          }
        })
      );
      for (const r of results) {
        if (r) records.push(r);
      }
    }

    console.log(`[handleResults] Parsed ${records.length} valid records`);

    records.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

    const paginatedRecords = records.slice(0, limit);

    const response = jsonResponse({
      records: paginatedRecords,
      total: objects.length,
      hasMore: listed.truncated && objects.length > limit,
      cursor: listed.truncated ? (listed as { truncated: true; cursor: string }).cursor : null,
    });

    if (!noCache) {
      const cacheTtl = parseInt(env.CACHE_TTL_SECONDS, 10);
      console.log(`[handleResults] Caching response with TTL: ${cacheTtl}s`);
      putCache(cacheKey, response.clone(), cacheTtl, ctx);
    }

    const duration = Date.now() - startTime;
    response.headers.set("X-Cache", "MISS");
    console.log(`[handleResults] END Success in ${duration}ms, returning ${records.length} records`);
    return response;
  } catch (err) {
    const duration = Date.now() - startTime;
    console.error(`[handleResults] END Error after ${duration}ms:`, err);
    if (err instanceof Error) {
      console.error(`[handleResults] Error stack:`, err.stack);
    }
    return jsonResponse({ error: "Internal server error", message: String(err) }, 500);
  }
}
