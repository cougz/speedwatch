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

function keyToTimestamp(key: string): string {
  const name = key.replace(/^speedtest-results\//, "").replace(/\.json$/, "");
  const [datePart, ...rest] = name.split("T");
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
      return cachedResponse;
    }
  }

  try {
    let listOptions: R2ListOptions = { prefix: env.R2_PREFIX, limit: 1000 };
    if (cursor) {
      listOptions.cursor = cursor;
    }

    const listed = await env.RESULTS_BUCKET.list(listOptions);
    let objects = listed.objects;

    if (listed.truncated) {
      let nextCursor: string | undefined = (listed as { truncated: true; cursor: string }).cursor;
      while (nextCursor && objects.length < limit) {
        const listOpts: R2ListOptions = {
          prefix: env.R2_PREFIX,
          cursor: nextCursor,
          limit: 1000,
        };
        const nextList = await env.RESULTS_BUCKET.list(listOpts);
        objects = objects.concat(nextList.objects);
        if (nextList.truncated) {
          nextCursor = (nextList as { truncated: true; cursor: string }).cursor;
        } else {
          nextCursor = undefined;
        }
        if (!nextList.truncated) break;
      }
    }

    let filteredObjects = objects.slice(0, limit);
    if (fromTimestamp) {
      const allFiltered = objects.filter((obj) => {
        const ts = keyToTimestamp(obj.key);
        return ts >= fromTimestamp;
      });
      filteredObjects = allFiltered.slice(0, limit);
    }

    const records: SpeedtestRecord[] = [];
    const batchSize = 50;

    for (let i = 0; i < filteredObjects.length; i += batchSize) {
      const batch = filteredObjects.slice(i, i + batchSize);
      const promises = batch.map(async (obj) => {
        const body = await env.RESULTS_BUCKET.get(obj.key);
        if (!body) return null;
        const text = await body.text();
        const data = JSON.parse(text);
        const name = endpointName(data.endpoint);
        const rec: SpeedtestRecord = {
          timestamp: keyToTimestamp(obj.key),
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
          return null;
        }
        return rec;
      });

      const results = await Promise.all(promises);
      for (const r of results) {
        if (r) records.push(r);
      }
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
      putCache(cacheKey, response.clone(), cacheTtl, ctx);
    }

    response.headers.set("X-Cache", "MISS");
    return response;
  } catch (err) {
    console.error("Error in handleResults:", err);
    return jsonResponse({ error: "Internal server error" }, 500);
  }
}
