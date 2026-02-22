const CACHE_BASE_URL = "https://speedwatch.example.com/cache/";

export function buildCacheKey(params: URLSearchParams): Request {
  const url = `${CACHE_BASE_URL}?${params.toString()}`;
  return new Request(url);
}

export async function getCached(cacheKey: Request): Promise<Response | undefined> {
  try {
    const cache = caches.default;
    const cached = await cache.match(cacheKey);
    return cached ?? undefined;
  } catch {
    return undefined;
  }
}

export function putCache(
  cacheKey: Request,
  response: Response,
  ttl: number,
  ctx: ExecutionContext
): void {
  try {
    const cacheResponse = new Response(response.clone().body, {
      status: response.status,
      headers: new Headers(response.headers),
    });
    cacheResponse.headers.set("Cache-Control", `public, max-age=${ttl}`);

    ctx.waitUntil(caches.default.put(cacheKey, cacheResponse));
  } catch {}
}
