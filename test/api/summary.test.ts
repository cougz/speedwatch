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

  it("returns 200 with all expected fields", async () => {
    env.RESULTS_BUCKET.list = vi.fn().mockResolvedValue({
      objects: [{ key: "json-results/speedtest-2026-02-21T20-48-36-141Z.json", uploaded: new Date(), size: 500 }],
      truncated: false,
      cursor: null,
    });
    env.RESULTS_BUCKET.get = vi.fn().mockResolvedValue({
      text: vi.fn().mockResolvedValue(JSON.stringify(mockData)),
    });

    const request = new Request("https://speedwatch.example.com/api/summary?hours=24");
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
    const objects = [
      { key: "json-results/speedtest-2026-02-21T20-48-36-141Z.json", uploaded: new Date(), size: 500 },
      { key: "json-results/speedtest-2026-02-21T20-49-36-141Z.json", uploaded: new Date(), size: 500 },
    ];
    env.RESULTS_BUCKET.list = vi.fn().mockResolvedValue({
      objects,
      truncated: false,
      cursor: null,
    });
    let getCallCount = 0;
    env.RESULTS_BUCKET.get = vi.fn().mockImplementation((key) => {
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

    const request = new Request("https://speedwatch.example.com/api/summary?hours=24");
    const response = await handleSummary(request, env, ctx);
    const json = await response.json() as { byEndpoint: Record<string, unknown>; };
    expect(getCallCount).toBe(2);
    expect(Object.keys(json.byEndpoint)).toEqual(expect.arrayContaining(["custom-t0", "custom-t1"]));
  });

  it("timeline is sorted ascending by hour", async () => {
    env.RESULTS_BUCKET.list = vi.fn().mockResolvedValue({
      objects: [
        { key: "json-results/speedtest-2026-02-21T20-48-36-141Z.json", uploaded: new Date(), size: 500 },
        { key: "json-results/speedtest-2026-02-21T20-49-36-141Z.json", uploaded: new Date(), size: 500 },
      ],
      truncated: false,
      cursor: null,
    });
    env.RESULTS_BUCKET.get = vi.fn().mockResolvedValue({
      text: vi.fn().mockResolvedValue(JSON.stringify(mockData)),
    });

    const request = new Request("https://speedwatch.example.com/api/summary?hours=24");
    const response = await handleSummary(request, env, ctx);
    const json = await response.json() as { timeline: Array<{ hour: string }>; };
    expect(json.timeline.length).toBeGreaterThan(0);
    const hours = json.timeline.map((t: { hour: string }) => t.hour);
    const sorted = [...hours].sort();
    expect(hours).toEqual(sorted);
  });

  it("successRate computed correctly when some records fail", async () => {
    env.RESULTS_BUCKET.list = vi.fn().mockResolvedValue({
      objects: [
        { key: "json-results/speedtest-2026-02-21T20-48-36-141Z.json", uploaded: new Date(), size: 500 },
        { key: "json-results/speedtest-2026-02-21T20-49-36-141Z.json", uploaded: new Date(), size: 500 },
      ],
      truncated: false,
      cursor: null,
    });
    env.RESULTS_BUCKET.get = vi.fn()
      .mockResolvedValueOnce({
        text: vi.fn().mockResolvedValue(JSON.stringify({ ...mockData, success: true })),
      } as unknown as R2ObjectBody)
      .mockResolvedValueOnce({
        text: vi.fn().mockResolvedValue(JSON.stringify({ ...mockData, success: false })),
      } as unknown as R2ObjectBody)
      .mockResolvedValue(null);

    const request = new Request("https://speedwatch.example.com/api/summary?hours=24");
    const response = await handleSummary(request, env, ctx);
    const json = await response.json() as { successRate: number; };
    expect(json.successRate).toBe(0.5);
  });

  it("hours param correctly filters out old records", async () => {
    const now = Date.now();
    const oldTimestamp = new Date(now - 25 * 60 * 60 * 1000).toISOString();
    env.RESULTS_BUCKET.list = vi.fn().mockResolvedValue({
      objects: [
        { key: `json-results/speedtest-${oldTimestamp.replace(/:/g, "-").replace(/\./g, "-")}.json`, uploaded: new Date(now - 26 * 60 * 60 * 1000), size: 500 },
        { key: `json-results/speedtest-${new Date(now - 1 * 60 * 60 * 1000).toISOString().replace(/:/g, "-").replace(/\./g, "-")}.json`, uploaded: new Date(), size: 500 },
      ],
      truncated: false,
      cursor: null,
    });
    env.RESULTS_BUCKET.get = vi.fn().mockResolvedValue({
      text: vi.fn().mockResolvedValue(JSON.stringify(mockData)),
    });

    const request = new Request("https://speedwatch.example.com/api/summary?hours=24");
    const response = await handleSummary(request, env, ctx);
    const json = await response.json() as { totalRecords: number; };
    expect(json.totalRecords).toBeLessThanOrEqual(2);
  });

  it("two consecutive warn records -> one warn incident", async () => {
    env.RESULTS_BUCKET.list = vi.fn().mockResolvedValue({
      objects: [
        { key: "json-results/speedtest-2026-02-21T20-48-36-141Z.json", uploaded: new Date(), size: 500 },
        { key: "json-results/speedtest-2026-02-21T20-49-36-141Z.json", uploaded: new Date(), size: 500 },
      ],
      truncated: false,
      cursor: null,
    });
    env.RESULTS_BUCKET.get = vi.fn()
      .mockResolvedValueOnce({
        text: vi.fn().mockResolvedValue(JSON.stringify(mockSlowData)),
      } as unknown as R2ObjectBody)
      .mockResolvedValueOnce({
        text: vi.fn().mockResolvedValue(JSON.stringify(mockSlowData)),
      } as unknown as R2ObjectBody)
      .mockResolvedValue(null);

    const request = new Request("https://speedwatch.example.com/api/summary?hours=24");
    const response = await handleSummary(request, env, ctx);
    const json = await response.json() as { incidents: Array<{ level: string }>; };
    expect(json.incidents.length).toBe(1);
    expect(json.incidents[0].level).toBe("warn");
  });

  it("crit record in middle of warn -> incident escalates to crit", async () => {
    const critData = { ...mockSlowData, result: { ...mockSlowData.result, download: 1000000, upload: 500000 } };
    env.RESULTS_BUCKET.list = vi.fn().mockResolvedValue({
      objects: [
        { key: "json-results/speedtest-2026-02-21T20-48-36-141Z.json", uploaded: new Date(), size: 500 },
        { key: "json-results/speedtest-2026-02-21T20-49-36-141Z.json", uploaded: new Date(), size: 500 },
        { key: "json-results/speedtest-2026-02-21T20-50-36-141Z.json", uploaded: new Date(), size: 500 },
      ],
      truncated: false,
      cursor: null,
    });
    env.RESULTS_BUCKET.get = vi.fn()
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

    const request = new Request("https://speedwatch.example.com/api/summary?hours=24");
    const response = await handleSummary(request, env, ctx);
    const json = await response.json() as { incidents: Array<{ level: string }>; };
    expect(json.incidents.length).toBe(1);
    expect(json.incidents[0].level).toBe("crit");
  });

  it("ok record between two warn records -> two separate incidents", async () => {
    env.RESULTS_BUCKET.list = vi.fn().mockResolvedValue({
      objects: [
        { key: "json-results/speedtest-2026-02-21T20-48-36-141Z.json", uploaded: new Date(), size: 500 },
        { key: "json-results/speedtest-2026-02-21T20-49-36-141Z.json", uploaded: new Date(), size: 500 },
        { key: "json-results/speedtest-2026-02-21T20-50-36-141Z.json", uploaded: new Date(), size: 500 },
      ],
      truncated: false,
      cursor: null,
    });
    env.RESULTS_BUCKET.get = vi.fn()
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

    const request = new Request("https://speedwatch.example.com/api/summary?hours=24");
    const response = await handleSummary(request, env, ctx);
    const json = await response.json() as { incidents: unknown[]; };
    expect(json.incidents.length).toBe(2);
  });

  it("all ok records -> no incidents", async () => {
    env.RESULTS_BUCKET.list = vi.fn().mockResolvedValue({
      objects: [
        { key: "json-results/speedtest-2026-02-21T20-48-36-141Z.json", uploaded: new Date().toISOString(), size: 500 },
        { key: "json-results/speedtest-2026-02-21T20-49-36-141Z.json", uploaded: new Date().toISOString(), size: 500 },
      ],
      truncated: false,
      cursor: null,
    });
    env.RESULTS_BUCKET.get = vi.fn().mockResolvedValue({
      text: vi.fn().mockResolvedValue(JSON.stringify(mockData)),
    });

    const request = new Request("https://speedwatch.example.com/api/summary?hours=24");
    const response = await handleSummary(request, env, ctx);
    const json = await response.json() as { incidents: unknown[]; incidentCount: number; };
    expect(json.incidents).toEqual([]);
    expect(json.incidentCount).toBe(0);
  });
});
