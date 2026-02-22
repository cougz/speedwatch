import type { Env } from "../types";
import { checkRateLimit } from "../utils/ratelimit";
import { buildCacheKey, getCached, putCache } from "../utils/cache";
import type { SpeedtestRecord } from "../types";

function getClientIP(request: Request): string {
  return (
    request.headers.get("CF-Connecting-IP") ??
    request.headers.get("X-Forwarded-For")?.split(",")[0].trim() ??
    "unknown"
  );
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

function stripPrefix(key: string, prefix: string): string {
  if (prefix && key.startsWith(prefix)) {
    return key.slice(prefix.length);
  }
  return key;
}

function filenameToTimestamp(filename: string): string {
  const [datePart, ...rest] = filename.split("T");
  const timePart = rest.join("T");
  const fixedTime = timePart.replace("-", ":").replace("-", ":").replace("-", ".");
  return `${datePart}T${fixedTime}`;
}

function endpointName(url: string): string {
  try {
    return new URL(url).hostname.split(".")[0];
  } catch {
    return url;
  }
}

const toMbps = (bps: number) => Math.round((bps / 1_000_000) * 100) / 100;

export async function handleResults(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const startTime = Date.now();
  const url = new URL(request.url);
  const clientIP = getClientIP(request);

  console.log(`[handleResults] Request from ${clientIP}, URL: ${url.pathname}`);
  console.log(`[handleResults] R2_PREFIX: "${env.R2_PREFIX}"`);

  const rateLimitResult = await checkRateLimit(env, clientIP);
  if (!rateLimitResult.allowed) {
    const retryAfter = rateLimitResult.retryAfter || 60;
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

  console.log(`[handleResults] Query params: limit=${limit}, cursor=${cursor}, endpoint=${endpointFilter}`);

  const cacheParams = new URLSearchParams();
  cacheParams.set("path", "/api/results");
  if (limit) cacheParams.set("limit", String(limit));
  if (cursor) cacheParams.set("cursor", cursor);
  if (endpointFilter) cacheParams.set("endpoint", endpointFilter);
  if (fromTimestamp) cacheParams.set("from", fromTimestamp);
  const cacheKey = buildCacheKey(cacheParams);

  if (!noCache) {
    const cached = await getCached(cacheKey);
    if (cached) {
      const cachedResponse = new Response(cached.body, {
        status: cached.status,
        headers: new Headers(cached.headers),
      });
      cachedResponse.headers.set("X-Cache", "HIT");
      console.log(`[handleResults] Cache HIT`);
      return cachedResponse;
    }
  }

  try {
    let listOptions: R2ListOptions = { prefix: env.R2_PREFIX, limit: 1000 };
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
        };
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
    }

    const records: SpeedtestRecord[] = [];

    for (const obj of filteredObjects) {
      const filename = stripPrefix(obj.key, env.R2_PREFIX);
      const body = await env.R2_BUCKET.get(obj.key);
      if (!body) continue;
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

      if (endpointFilter && rec.endpointName !== endpointFilter) {
        continue;
      }
      records.push(rec);
    }

    records.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

    const response = jsonResponse({
      records,
      total: objects.length,
      hasMore: listed.truncated && objects.length > limit,
      cursor: listed.truncated ? (listed as { truncated: true; cursor: string }).cursor : null,
    });

    if (!noCache) {
      const cacheTtl = parseInt(env.CACHE_TTL_SECONDS, 10);
      console.log(`[handleResults] Caching response with TTL: ${cacheTtl}s`);
      putCache(cacheKey, response.clone(), cacheTtl, ctx);
    }

    response.headers.set("X-Cache", "MISS");
    return response;
  } catch (err) {
    console.error("[handleResults] Error:", err);
    return jsonResponse({ error: "Internal server error", message: String(err) }, 500);
  }
}
