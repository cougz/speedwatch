import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleResults } from "../../src/api/results";
import type { Env } from "../../src/types";

const mockObject: Partial<R2Object> = {
  key: "speedtest-results/2026-02-21T20-48-36-141Z.json",
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
      R2_BUCKET: {
        list: vi.fn(),
        get: vi.fn(),
      } as unknown as R2Bucket,
      RATE_LIMITER: {
        limit: vi.fn().mockResolvedValue({ success: true }),
      } as unknown as RateLimit,
      R2_PREFIX: "speedtest-results/",
      CACHE_TTL_SECONDS: "60",
      MAX_RESULTS_PER_PAGE: "200",
      ANOMALY_WARN_THRESHOLD: "0.70",
      ANOMALY_CRIT_THRESHOLD: "0.50",
    };
    ctx = {
      waitUntil: vi.fn(),
    } as unknown as ExecutionContext;

    // Clear any cache from previous tests
    vi.clearAllMocks();
  });

  it("returns 200 with correct records shape", async () => {
    env.R2_BUCKET.list = vi.fn().mockResolvedValue({
      objects: [mockObject],
      truncated: false,
      cursor: null,
    });
    env.R2_BUCKET.get = vi.fn().mockResolvedValue({
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
    env.R2_BUCKET.list = vi.fn().mockResolvedValue({
      objects,
      truncated: false,
    });
    env.R2_BUCKET.get = vi.fn().mockResolvedValue({
      text: vi.fn().mockResolvedValue(JSON.stringify(mockData)),
    });

    const request = new Request("https://speedwatch.example.com/api/results?limit=5");
    const response = await handleResults(request, env, ctx);
    const json = await response.json() as { records: unknown[]; };
    expect(json.records.length).toBeLessThanOrEqual(5);
  });

  it("endpoint filter works", async () => {
    const now = new Date();
    const ts1 = new Date(now.getTime() - 5 * 60 * 1000).toISOString().replace(/:/g, "-").replace(/\./g, "-");
    const ts2 = new Date(now.getTime() - 10 * 60 * 1000).toISOString().replace(/:/g, "-").replace(/\./g, "-");
    env.R2_BUCKET.list = vi.fn().mockResolvedValue({
      objects: [
        { ...mockObject, key: `speedtest-results/${ts1}.json` },
        { ...mockObject, key: `speedtest-results/${ts2}.json` },
      ],
      truncated: false,
      cursor: null,
    });
    env.R2_BUCKET.get = vi.fn().mockImplementation((key: string) => {
      // Match the object keys and return appropriate data
      if (key.includes(ts1)) {
        return Promise.resolve({
          text: vi.fn().mockResolvedValue(JSON.stringify({ ...mockData, endpoint: "https://custom-t0.speed.cloudflare.com" })),
        });
      }
      if (key.includes(ts2)) {
        return Promise.resolve({
          text: vi.fn().mockResolvedValue(JSON.stringify({ ...mockData, endpoint: "https://custom-t1.speed.cloudflare.com" })),
        });
      }
      return Promise.resolve(null);
    });

    const request = new Request("https://speedwatch.example.com/api/results?endpoint=custom-t0&no-cache=true");
    const response = await handleResults(request, env, ctx);
    const json = await response.json() as { records: Array<{ endpointName: string }>; };
    expect(json.records.length).toBe(1);
    expect(json.records[0].endpointName).toBe("custom-t0");
  });

  it("from timestamp filter works", async () => {
    env.R2_BUCKET.list = vi.fn().mockResolvedValue({
      objects: [
        { ...mockObject, key: "speedtest-results/2026-02-21T20-48-36-141Z.json" },
        { ...mockObject, key: "speedtest-results/2026-02-21T21-48-36-141Z.json" },
      ],
      truncated: false,
      cursor: null,
    });
    env.R2_BUCKET.get = vi.fn().mockResolvedValue({
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
    env.R2_BUCKET.list = vi.fn().mockResolvedValue({
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
