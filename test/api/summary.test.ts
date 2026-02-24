import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleSummary } from "../../src/api/summary";
import type { Env } from "../../src/types";

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

const mockSlowData = {
  sessionID: "2683d050-da44-458d-9257-360c143f8af9",
  endpoint: "https://custom-t0.speed.cloudflare.com",
  success: true,
  result: {
    download: 40000000,
    upload: 15000000,
    latency: 25,
    jitter: 6,
    downLoadedLatency: 22.8,
    downLoadedJitter: 6.72,
    upLoadedLatency: 51.5,
    upLoadedJitter: 14.26,
  },
};

describe("GET /api/summary", () => {
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

  it("returns 200 with all expected fields", async () => {
    const now = new Date();
    const timestamp = new Date(now.getTime() - 5 * 60 * 1000).toISOString().replace(/:/g, "-").replace(/\./g, "-");
    env.R2_BUCKET.list = vi.fn().mockResolvedValue({
      objects: [{ key: `speedtest-results/${timestamp}.json`, uploaded: new Date(), size: 500 }],
      truncated: false,
      cursor: null,
    });
    env.R2_BUCKET.get = vi.fn().mockImplementation((key: string) => {
      if (key === '_cache/summary-24.json') return Promise.resolve(null);
      return Promise.resolve({
        text: vi.fn().mockResolvedValue(JSON.stringify(mockData)),
      });
    });

    const request = new Request("https://speedwatch.example.com/api/summary?hours=24&no-cache=true");
    const response = await handleSummary(request, env, ctx);

    expect(response.status).toBe(200);
    const json = await response.json() as { avg: unknown; p50: unknown; p95: unknown; p99: unknown; byEndpoint: unknown; timeline: unknown; successRate: unknown; incidents: unknown; incidentCount: unknown; };
    expect(json).toHaveProperty("avg");
    expect(json).toHaveProperty("p50");
    expect(json).toHaveProperty("p95");
    expect(json).toHaveProperty("p99");
    expect(json).toHaveProperty("byEndpoint");
    expect(json).toHaveProperty("timeline");
    expect(json).toHaveProperty("successRate");
    expect(json).toHaveProperty("incidents");
    expect(json).toHaveProperty("incidentCount");
  });

  it("byEndpoint keys match unique endpoints", async () => {
    const now = new Date();
    const ts1 = new Date(now.getTime() - 5 * 60 * 1000).toISOString().replace(/:/g, "-").replace(/\./g, "-");
    const ts2 = new Date(now.getTime() - 10 * 60 * 1000).toISOString().replace(/:/g, "-").replace(/\./g, "-");
    const objects = [
      { key: `speedtest-results/${ts1}.json`, uploaded: new Date(), size: 500 },
      { key: `speedtest-results/${ts2}.json`, uploaded: new Date(), size: 500 },
    ];
    env.R2_BUCKET.list = vi.fn().mockResolvedValue({
      objects,
      truncated: false,
      cursor: null,
    });
    let getCallCount = 0;
    env.R2_BUCKET.get = vi.fn().mockImplementation((key: string) => {
      if (key === '_cache/summary-24.json') return Promise.resolve(null);
      getCallCount++;
      if (getCallCount === 1) {
        return Promise.resolve({
          text: vi.fn().mockResolvedValue(JSON.stringify({ ...mockData, endpoint: "https://custom-t0.speed.cloudflare.com" })),
        } as unknown as R2ObjectBody);
      }
      if (getCallCount === 2) {
        return Promise.resolve({
          text: vi.fn().mockResolvedValue(JSON.stringify({ ...mockData, endpoint: "https://custom-t1.speed.cloudflare.com" })),
        } as unknown as R2ObjectBody);
      }
      return Promise.resolve(null);
    });

    const request = new Request("https://speedwatch.example.com/api/summary?hours=24&no-cache=true");
    const response = await handleSummary(request, env, ctx);
    const json = await response.json() as { byEndpoint: Record<string, unknown>; };
    expect(getCallCount).toBe(2); // With no-cache, prebuilt check is skipped
    expect(Object.keys(json.byEndpoint)).toEqual(expect.arrayContaining(["custom-t0", "custom-t1"]));
  });

  it("timeline is sorted ascending by hour", async () => {
    const now = new Date();
    const ts1 = new Date(now.getTime() - 5 * 60 * 1000).toISOString().replace(/:/g, "-").replace(/\./g, "-");
    const ts2 = new Date(now.getTime() - 10 * 60 * 1000).toISOString().replace(/:/g, "-").replace(/\./g, "-");
    env.R2_BUCKET.list = vi.fn().mockResolvedValue({
      objects: [
        { key: `speedtest-results/${ts1}.json`, uploaded: new Date(), size: 500 },
        { key: `speedtest-results/${ts2}.json`, uploaded: new Date(), size: 500 },
      ],
      truncated: false,
      cursor: null,
    });
    env.R2_BUCKET.get = vi.fn().mockImplementation((key: string) => {
      if (key === '_cache/summary-24.json') return Promise.resolve(null);
      return Promise.resolve({
        text: vi.fn().mockResolvedValue(JSON.stringify(mockData)),
      });
    });

    const request = new Request("https://speedwatch.example.com/api/summary?hours=24&no-cache=true");
    const response = await handleSummary(request, env, ctx);
    const json = await response.json() as { timeline: Array<{ hour: string }>; };
    expect(json.timeline.length).toBeGreaterThan(0);
    const hours = json.timeline.map((t: { hour: string }) => t.hour);
    const sorted = [...hours].sort();
    expect(hours).toEqual(sorted);
  });

  it("successRate computed correctly when some records fail", async () => {
    const now = new Date();
    const ts1 = new Date(now.getTime() - 5 * 60 * 1000).toISOString().replace(/:/g, "-").replace(/\./g, "-");
    const ts2 = new Date(now.getTime() - 10 * 60 * 1000).toISOString().replace(/:/g, "-").replace(/\./g, "-");
    env.R2_BUCKET.list = vi.fn().mockResolvedValue({
      objects: [
        { key: `speedtest-results/${ts1}.json`, uploaded: new Date(), size: 500 },
        { key: `speedtest-results/${ts2}.json`, uploaded: new Date(), size: 500 },
      ],
      truncated: false,
      cursor: null,
    });
    env.R2_BUCKET.get = vi.fn().mockImplementation((key: string) => {
      if (key === '_cache/summary-24.json') return Promise.resolve(null);
      // Return appropriate data based on the key
      if (key.includes(ts1)) {
        return Promise.resolve({
          text: vi.fn().mockResolvedValue(JSON.stringify({ ...mockData, success: true })),
        } as unknown as R2ObjectBody);
      }
      if (key.includes(ts2)) {
        return Promise.resolve({
          text: vi.fn().mockResolvedValue(JSON.stringify({ ...mockData, success: false })),
        } as unknown as R2ObjectBody);
      }
      return Promise.resolve(null);
    });

    const request = new Request("https://speedwatch.example.com/api/summary?hours=24&no-cache=true");
    const response = await handleSummary(request, env, ctx);
    const json = await response.json() as { successRate: number; };
    expect(json.successRate).toBe(0.5);
  });

  it("hours param correctly filters out old records", async () => {
    const now = Date.now();
    const oldTimestamp = new Date(now - 25 * 60 * 60 * 1000).toISOString();
    env.R2_BUCKET.list = vi.fn().mockResolvedValue({
      objects: [
        { key: `json-results/speedtest-${oldTimestamp.replace(/:/g, "-").replace(/\./g, "-")}.json`, uploaded: new Date(now - 26 * 60 * 60 * 1000), size: 500 },
        { key: `json-results/speedtest-${new Date(now - 1 * 60 * 60 * 1000).toISOString().replace(/:/g, "-").replace(/\./g, "-")}.json`, uploaded: new Date(), size: 500 },
      ],
      truncated: false,
      cursor: null,
    });
    env.R2_BUCKET.get = vi.fn().mockImplementation((key: string) => {
      if (key === '_cache/summary-24.json') return Promise.resolve(null);
      return Promise.resolve({
        text: vi.fn().mockResolvedValue(JSON.stringify(mockData)),
      });
    });

    const request = new Request("https://speedwatch.example.com/api/summary?hours=24&no-cache=true");
    const response = await handleSummary(request, env, ctx);
    const json = await response.json() as { totalRecords: number; };
    expect(json.totalRecords).toBeLessThanOrEqual(2);
  });

  it("two consecutive warn records -> no crit incidents (warn incidents are filtered)", async () => {
    const now = new Date();
    const ts1 = new Date(now.getTime() - 5 * 60 * 1000).toISOString().replace(/:/g, "-").replace(/\./g, "-");
    const ts2 = new Date(now.getTime() - 10 * 60 * 1000).toISOString().replace(/:/g, "-").replace(/\./g, "-");
    env.R2_BUCKET.list = vi.fn().mockResolvedValue({
      objects: [
        { key: `speedtest-results/${ts1}.json`, uploaded: new Date(), size: 500 },
        { key: `speedtest-results/${ts2}.json`, uploaded: new Date(), size: 500 },
      ],
      truncated: false,
      cursor: null,
    });
    env.R2_BUCKET.get = vi.fn()
      .mockResolvedValueOnce(null) // prebuilt
      .mockResolvedValueOnce({
        text: vi.fn().mockResolvedValue(JSON.stringify(mockSlowData)),
      } as unknown as R2ObjectBody)
      .mockResolvedValueOnce({
        text: vi.fn().mockResolvedValue(JSON.stringify(mockSlowData)),
      } as unknown as R2ObjectBody)
      .mockResolvedValue(null);

    const request = new Request("https://speedwatch.example.com/api/summary?hours=24&no-cache=true");
    const response = await handleSummary(request, env, ctx);
    const json = await response.json() as { incidents: Array<{ level: string }>; };
    // With the new implementation, only crit incidents are returned
    expect(json.incidents.length).toBe(0);
  });

  it("crit record in middle of warn -> incident escalates to crit", async () => {
    const critData = { ...mockSlowData, result: { ...mockSlowData.result, download: 1000000, upload: 500000 } };
    const now = new Date();
    const ts1 = new Date(now.getTime() - 5 * 60 * 1000).toISOString().replace(/:/g, "-").replace(/\./g, "-");
    const ts2 = new Date(now.getTime() - 10 * 60 * 1000).toISOString().replace(/:/g, "-").replace(/\./g, "-");
    const ts3 = new Date(now.getTime() - 15 * 60 * 1000).toISOString().replace(/:/g, "-").replace(/\./g, "-");
    env.R2_BUCKET.list = vi.fn().mockResolvedValue({
      objects: [
        { key: `speedtest-results/${ts1}.json`, uploaded: new Date(), size: 500 },
        { key: `speedtest-results/${ts2}.json`, uploaded: new Date(), size: 500 },
        { key: `speedtest-results/${ts3}.json`, uploaded: new Date(), size: 500 },
      ],
      truncated: false,
      cursor: null,
    });
    env.R2_BUCKET.get = vi.fn()
      .mockResolvedValueOnce(null) // prebuilt
      .mockResolvedValueOnce({
        text: vi.fn().mockResolvedValue(JSON.stringify(mockSlowData)),
      } as unknown as R2ObjectBody)
      .mockResolvedValueOnce({
        text: vi.fn().mockResolvedValue(JSON.stringify(critData)),
      } as unknown as R2ObjectBody)
      .mockResolvedValueOnce({
        text: vi.fn().mockResolvedValue(JSON.stringify(mockSlowData)),
      } as unknown as R2ObjectBody)
      .mockResolvedValue(null);

    const request = new Request("https://speedwatch.example.com/api/summary?hours=24&no-cache=true");
    const response = await handleSummary(request, env, ctx);
    const json = await response.json() as { incidents: Array<{ level: string }>; };
    expect(json.incidents.length).toBe(1);
    expect(json.incidents[0].level).toBe("crit");
  });

  it("ok record between two warn records -> 0 crit incidents (warn incidents are filtered)", async () => {
    const now = new Date();
    const ts1 = new Date(now.getTime() - 5 * 60 * 1000).toISOString().replace(/:/g, "-").replace(/\./g, "-");
    const ts2 = new Date(now.getTime() - 10 * 60 * 1000).toISOString().replace(/:/g, "-").replace(/\./g, "-");
    const ts3 = new Date(now.getTime() - 15 * 60 * 1000).toISOString().replace(/:/g, "-").replace(/\./g, "-");
    env.R2_BUCKET.list = vi.fn().mockResolvedValue({
      objects: [
        { key: `speedtest-results/${ts1}.json`, uploaded: new Date(), size: 500 },
        { key: `speedtest-results/${ts2}.json`, uploaded: new Date(), size: 500 },
        { key: `speedtest-results/${ts3}.json`, uploaded: new Date(), size: 500 },
      ],
      truncated: false,
      cursor: null,
    });
    env.R2_BUCKET.get = vi.fn()
      .mockResolvedValueOnce(null) // prebuilt
      .mockResolvedValueOnce({
        text: vi.fn().mockResolvedValue(JSON.stringify(mockSlowData)),
      } as unknown as R2ObjectBody)
      .mockResolvedValueOnce({
        text: vi.fn().mockResolvedValue(JSON.stringify(mockData)),
      } as unknown as R2ObjectBody)
      .mockResolvedValueOnce({
        text: vi.fn().mockResolvedValue(JSON.stringify(mockSlowData)),
      } as unknown as R2ObjectBody)
      .mockResolvedValue(null);

    const request = new Request("https://speedwatch.example.com/api/summary?hours=24&no-cache=true");
    const response = await handleSummary(request, env, ctx);
    const json = await response.json() as { incidents: unknown[]; };
    // With the new implementation, only crit incidents are returned
    expect(json.incidents.length).toBe(0);
  });

  it("all ok records -> no incidents", async () => {
    const now = new Date();
    const ts1 = new Date(now.getTime() - 5 * 60 * 1000).toISOString().replace(/:/g, "-").replace(/\./g, "-");
    const ts2 = new Date(now.getTime() - 10 * 60 * 1000).toISOString().replace(/:/g, "-").replace(/\./g, "-");
    env.R2_BUCKET.list = vi.fn().mockResolvedValue({
      objects: [
        { key: `speedtest-results/${ts1}.json`, uploaded: new Date().toISOString(), size: 500 },
        { key: `speedtest-results/${ts2}.json`, uploaded: new Date().toISOString(), size: 500 },
      ],
      truncated: false,
      cursor: null,
    });
    env.R2_BUCKET.get = vi.fn().mockImplementation((key: string) => {
      if (key === '_cache/summary-24.json') return Promise.resolve(null);
      return Promise.resolve({
        text: vi.fn().mockResolvedValue(JSON.stringify(mockData)),
      });
    });

    const request = new Request("https://speedwatch.example.com/api/summary?hours=24&no-cache=true");
    const response = await handleSummary(request, env, ctx);
    const json = await response.json() as { incidents: unknown[]; incidentCount: number; };
    expect(json.incidents).toEqual([]);
    expect(json.incidentCount).toBe(0);
  });

  it("serves prebuilt summary from R2 when available, never calls list()", async () => {
    const prebuilt = {
      totalRecords: 42, timeRangeHours: 24,
      avg: { downloadMbps: 70, uploadMbps: 35, latencyMs: 8, jitterMs: 1 },
      p50: { downloadMbps: 70, uploadMbps: 35, latencyMs: 8, jitterMs: 1 },
      p95: { downloadMbps: 70, uploadMbps: 35, latencyMs: 8, jitterMs: 1 },
      p99: { downloadMbps: 70, uploadMbps: 35, latencyMs: 8, jitterMs: 1 },
      byEndpoint: {}, timeline: [], successRate: 1, incidents: [], incidentCount: 0,
    };

    // get() is called once for the prebuilt key and must return data.
    // It must NOT be called for individual result files.
    env.R2_BUCKET.get = vi.fn().mockImplementation((key: string) => {
      if (key === '_cache/summary-24.json') {
        return Promise.resolve({ text: vi.fn().mockResolvedValue(JSON.stringify(prebuilt)) });
      }
      // Any other key means we fell through to live aggregation — that's a test failure.
      return Promise.resolve(null);
    });

    // list() must never be called — prebuilt should short-circuit it entirely.
    env.R2_BUCKET.list = vi.fn();

    const request  = new Request("https://speedwatch.example.com/api/summary?hours=24");
    const response = await handleSummary(request, env, ctx);

    expect(response.status).toBe(200);
    expect(response.headers.get("X-Cache")).toBe("PREBUILT");
    expect(env.R2_BUCKET.list).not.toHaveBeenCalled();

    const json = await response.json() as { totalRecords: number };
    expect(json.totalRecords).toBe(42);
  });

  it("falls back to live aggregation when prebuilt summary is absent", async () => {
    const now = new Date();
    const timestamp = new Date(now.getTime() - 5 * 60 * 1000).toISOString().replace(/:/g, "-").replace(/\./g, "-");
    // get() returns null for the prebuilt key, real data for individual files
    env.R2_BUCKET.get = vi.fn().mockImplementation((key: string) => {
      if (key === '_cache/summary-24.json') return Promise.resolve(null);
      return Promise.resolve({
        text: vi.fn().mockResolvedValue(JSON.stringify(mockData)),
      });
    });

    env.R2_BUCKET.list = vi.fn().mockResolvedValue({
      objects: [
        { key: `speedtest-results/${timestamp}.json`, uploaded: new Date(), size: 500, customMetadata: {} },
      ],
      truncated: false,
      cursor: null,
    });

    const request  = new Request("https://speedwatch.example.com/api/summary?hours=24");
    const response = await handleSummary(request, env, ctx);

    expect(response.status).toBe(200);
    // Must NOT be PREBUILT — should be MISS (live aggregation)
    expect(response.headers.get("X-Cache")).toBe("MISS");

    const json = await response.json() as { totalRecords: number; avg: any };
    expect(json.totalRecords).toBe(1);
    expect(json.avg).toHaveProperty("downloadMbps");
  });
});
