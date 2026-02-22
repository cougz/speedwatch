import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleResults } from "../../src/api/results";
import type { Env } from "../../src/types";

const mockObject: Partial<R2Object> = {
  key: "json-results/speedtest-2026-02-21T20-48-36-141Z.json",
  uploaded: new Date(),
  size: 500,
};

const mockData = {
  sessionID: "2683d050-da44-458d-9257-360c143f8af8",
  endpoint: "https://custom-t0.speed.cloudflare.com",
  success: true,
  result: {
    download: 71965572.58,
    upload: 35293340.94,
    latency: 7.5,
    jitter: 1.21,
    downLoadedLatency: 22.8,
    downLoadedJitter: 6.72,
    upLoadedLatency: 51.5,
    upLoadedJitter: 14.26,
  },
};

describe("GET /api/results", () => {
  let env: Env;
  let ctx: ExecutionContext;

  beforeEach(() => {
    env = {
      ASSETS: {} as Fetcher,
      RESULTS_BUCKET: {
        list: vi.fn(),
        get: vi.fn(),
      } as unknown as R2Bucket,
      RATE_LIMITER: {
        limit: vi.fn().mockResolvedValue({ success: true }),
      } as unknown as RateLimit,
      R2_PREFIX: "json-results/",
      CACHE_TTL_SECONDS: "60",
      MAX_RESULTS_PER_PAGE: "200",
    };
    ctx = {
      waitUntil: vi.fn(),
    } as unknown as ExecutionContext;
  });

  it("returns 200 with correct records shape", async () => {
    env.RESULTS_BUCKET.list = vi.fn().mockResolvedValue({
      objects: [mockObject],
      truncated: false,
      cursor: null,
    });
    env.RESULTS_BUCKET.get = vi.fn().mockResolvedValue({
      text: vi.fn().mockResolvedValue(JSON.stringify(mockData)),
    });

    const request = new Request("https://speedwatch.example.com/api/results?limit=10");
    const response = await handleResults(request, env, ctx);

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/json");
    const json = await response.json() as { records: unknown[]; total: number; };
    expect(json).toHaveProperty("records");
    expect(json.records).toBeInstanceOf(Array);
    expect(json.total).toBe(1);
  });

  it("limit param caps results", async () => {
    interface ResultsResponse { records: unknown[]; total: number; }
    const objects = Array.from({ length: 10 }, (_, i) => ({
      ...mockObject,
      key: `json-results/speedtest-2026-02-21T20-${i}-36-141Z.json`,
    }));
    env.RESULTS_BUCKET.list = vi.fn().mockResolvedValue({
      objects,
      truncated: false,
    });
    env.RESULTS_BUCKET.get = vi.fn().mockResolvedValue({
      text: vi.fn().mockResolvedValue(JSON.stringify(mockData)),
    });

    const request = new Request("https://speedwatch.example.com/api/results?limit=5");
    const response = await handleResults(request, env, ctx);
    const json = await response.json() as { records: unknown[]; };
    expect(json.records.length).toBeLessThanOrEqual(5);
  });

  it("endpoint filter works", async () => {
    env.RESULTS_BUCKET.list = vi.fn().mockResolvedValue({
      objects: [
        { ...mockObject, key: "json-results/speedtest-2026-02-21T20-48-36-141Z.json" },
        { ...mockObject, key: "json-results/speedtest-2026-02-21T20-49-36-141Z.json" },
      ],
      truncated: false,
      cursor: null,
    });
    env.RESULTS_BUCKET.get = vi.fn()
      .mockResolvedValueOnce({
        text: vi.fn().mockResolvedValue(JSON.stringify({ ...mockData, endpoint: "https://custom-t0.speed.cloudflare.com" })),
      })
      .mockResolvedValueOnce({
        text: vi.fn().mockResolvedValue(JSON.stringify({ ...mockData, endpoint: "https://custom-t1.speed.cloudflare.com" })),
      });

    const request = new Request("https://speedwatch.example.com/api/results?endpoint=custom-t0");
    const response = await handleResults(request, env, ctx);
    const json = await response.json() as { records: Array<{ endpointName: string }>; };
    expect(json.records.length).toBe(1);
    expect(json.records[0].endpointName).toBe("custom-t0");
  });

  it("from timestamp filter works", async () => {
    env.RESULTS_BUCKET.list = vi.fn().mockResolvedValue({
      objects: [
        { ...mockObject, key: "json-results/speedtest-2026-02-21T20-48-36-141Z.json" },
        { ...mockObject, key: "json-results/speedtest-2026-02-21T21-48-36-141Z.json" },
      ],
      truncated: false,
      cursor: null,
    });
    env.RESULTS_BUCKET.get = vi.fn().mockResolvedValue({
      text: vi.fn().mockResolvedValue(JSON.stringify(mockData)),
    });

    const request = new Request("https://speedwatch.example.com/api/results?from=2026-02-21T21:00:00.000Z");
    const response = await handleResults(request, env, ctx);
    const json = await response.json() as { records: unknown[]; };
    expect(json.records.length).toBe(1);
  });

  it("rate limit 429 with Retry-After header", async () => {
    env.RATE_LIMITER.limit = vi.fn().mockResolvedValue({ success: false });

    const request = new Request("https://speedwatch.example.com/api/results");
    const response = await handleResults(request, env, ctx);

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("60");
    const json = await response.json() as { error: string; };
    expect(json.error).toBe("Rate limit exceeded");
  });

  it("empty bucket returns empty array", async () => {
    env.RESULTS_BUCKET.list = vi.fn().mockResolvedValue({
      objects: [],
      truncated: false,
      cursor: null,
    });

    const request = new Request("https://speedwatch.example.com/api/results");
    const response = await handleResults(request, env, ctx);
    const json = await response.json() as { records: unknown[]; total: number; };
    expect(json.records).toEqual([]);
    expect(json.total).toBe(0);
  });
});
