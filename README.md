# SpeedWatch

Real-time Cloudflare speedtest monitoring dashboard powered by R2 object storage.

## Overview

SpeedWatch reads JSON speedtest result files from an R2 bucket and exposes them through a REST API consumed by an interactive Astro static UI. The dashboard displays KPI cards, performance timeline with degradation detection, throughput charts, endpoint breakdown, and a paginated results table.

## Architecture

```
                    ┌─────────────────────────────────────────────┐
                    │      Single Cloudflare Worker            │
                    │             (speedwatch)               │
                    │                                             │
   UI ──────────► │  /              → Astro Static UI      │
                    │                  (Workers Assets)          │
                    │                                             │
   API ─────────► │  /api/summary  → Aggregated KPIs       │
   Agents ───────► │  /api/results   → Paginated records      │
                    │  /llms.txt      → AI discovery         │
                    │                                             │
                    │         ┌─────────────────────┐          │
                    │         │   R2 Integration  │          │
                    │         │  • List objects   │          │
                    │         │  • Read JSON     │          │
                    │         │  • Parse & agg   │          │
                    │         └─────────────────────┘          │
                    └─────────────────────────────────────────────┘
                                       │
                                       ▼
                              R2 Bucket (speedtest-results)
```

## Features

### API Endpoints

- **`GET /api/summary?hours={24}`** — Aggregated KPIs, percentiles, per-endpoint breakdown, hourly timeline, and incidents
- **`GET /api/results?limit={100}&cursor={cursor}&endpoint={name}&from={iso}`** — Paginated raw test records
- **`GET /llms.txt`** — AI agent discoverability document

### Dashboard UI

- **KPI Cards** — Real-time average download, upload, latency, jitter with sparklines and p95 comparisons
- **Performance Timeline** — Individual-test granularity heatmap with hover details and incident grouping
- **Incidents Panel** — Automatic detection of performance degradation (warn/crit) with affected metrics
- **Throughput Chart** — Dual-line area chart showing download (orange) and upload (blue) over time
- **Latency Chart** — Bar chart showing latency trends per hour
- **Endpoint Breakdown** — Per-endpoint statistics with visual bar comparisons
- **Results Table** — Paginated table with status badges (✓ OK, ⚠ Slow, ✗ Fail)
- **Auto-refresh** — 60-second automatic data refresh without page flicker
- **Time Range Pills** — Switch between 1h, 6h, 24h, 7d views
- **Endpoint Filters** — Filter table by specific speedtest endpoints

### Degradation Detection

SpeedWatch automatically detects performance incidents with configurable thresholds:

| Metric | Warning | Critical |
|--------|----------|----------|
| Download | < 50 Mbps | < 25 Mbps |
| Upload | < 20 Mbps | < 10 Mbps |
| Latency | > 20 ms | > 50 ms |
| Jitter | > 5 ms | > 15 ms |

Consecutive degraded tests are grouped into incidents. A single critical test in a warning period escalates the entire incident to critical.

## Getting Started

### Prerequisites

- Cloudflare account with Workers enabled
- GitHub account (for Cloudflare Workers Builds integration)
- Existing R2 bucket named `speedtest-results` with speedtest JSON files

### Deployment via Cloudflare Workers Builds

Workers Builds automatically deploys your application on every push to the `main` branch.

#### Step 1: Connect GitHub Repository

1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. Navigate to **Workers & Pages** → **Create Application**
3. Select **Connect to Git**
4. Authorize your GitHub account
5. Select the `speedwatch` repository
6. Click **Begin setup**

#### Step 2: Configure Build Settings

In the build configuration, set:

| Setting | Value |
|---------|--------|
| Build command | `npm install && npm run build` |
| Deploy command | `npx wrangler deploy` (default, already filled) |

Click **Save and Deploy**. The first build will start immediately.

#### Step 3: Verify R2 Bucket Binding

After the first deployment:

1. Go to your Worker → **Settings** → **Variables and Secrets**
2. Verify the **R2 Buckets** section shows:
   ```
   Binding: RESULTS_BUCKET
   Bucket Name: grainau-speedtest-results
   ```

**Note:** The R2 bucket must already exist and contain speedtest JSON files in the `speedtest-results/` subfolder.

### Local Development

To run the Worker locally (requires `wrangler dev` with real R2 bucket access):

```bash
npm install
npm run dev
```

The dev server runs on `http://localhost:8787/`. Use `--remote` flag for real R2 bucket access:

```bash
wrangler dev --remote
```

### Running Tests

```bash
npm test           # Run all tests once
npm run test:watch  # Watch mode for development
npm run typecheck   # TypeScript type checking
```

## Configuration

### Environment Variables (`wrangler.jsonc`)

| Variable | Default | Description |
|----------|---------|-------------|
| `R2_PREFIX` | `"speedtest-results/"` | Prefix in R2 bucket where speedtest files are stored |
| `CACHE_TTL_SECONDS` | `"60"` | Cache TTL for API responses (seconds) |
| `MAX_RESULTS_PER_PAGE` | `"200"` | Maximum records per page in results API |

### Rate Limiting

- **Limit:** 60 requests per minute per IP
- **Binding Name:** `RATE_LIMITER`
- **Namespace:** `1001`

Adjust in `wrangler.jsonc` under `ratelimits` if needed.

## R2 Bucket Data Format

SpeedWatch expects JSON files in the `speedtest-results/` subfolder of your R2 bucket.

File naming pattern:
- With speedtest prefix: `speedtest-results/speedtest-2026-02-21T20-48-36-141Z.json`
- Without prefix: `speedtest-results/2026-02-21T20-48-36-141Z.json`

Both formats are supported. The timestamp is extracted from the filename.

### File Content Shape

```json
{
  "sessionID": "2683d050-da44-458d-9257-360c143f8af8",
  "endpoint": "https://custom-t0.speed.cloudflare.com",
  "success": true,
  "result": {
    "download": 71965572.58,      // bytes/sec
    "upload": 35293340.94,        // bytes/sec
    "latency": 7.50,              // ms
    "jitter": 1.21,               // ms
    "downLoadedLatency": 22.80,    // ms
    "downLoadedJitter": 6.72,      // ms
    "upLoadedLatency": 51.50,      // ms
    "upLoadedJitter": 14.26        // ms
  }
}
```

**Important:** The API converts bytes/sec to Mbps automatically for UI display.

## API Response Examples

### `/api/summary`

```json
{
  "totalRecords": 847,
  "timeRangeHours": 24,
  "successRate": 1.0,
  "avg": {
    "downloadMbps": 74.2,
    "uploadMbps": 34.1,
    "latencyMs": 7.8,
    "jitterMs": 1.04
  },
  "p50": { "downloadMbps": 72.5, ... },
  "p95": { "downloadMbps": 85.3, ... },
  "p99": { "downloadMbps": 92.1, ... },
  "byEndpoint": {
    "custom-t0": { "name": "custom-t0", "count": 283, "avg": { ... } },
    "custom-t2": { "name": "custom-t2", "count": 281, "avg": { ... } }
  },
  "timeline": [
    {
      "hour": "2026-02-21T00:00:00.000Z",
      "downloadMbps": 72.1,
      "uploadMbps": 33.8,
      "latencyMs": 7.6,
      "jitterMs": 1.1,
      "count": 35
    }
  ],
  "incidents": [
    {
      "start": "2026-02-21T14:30:00.000Z",
      "end": "2026-02-21T15:15:00.000Z",
      "level": "crit",
      "affectedMetrics": ["download", "latency"],
      "recordCount": 12,
      "worstDownloadMbps": 15.2,
      "worstUploadMbps": 18.5,
      "worstLatencyMs": 68.4,
      "worstJitterMs": 14.2
    }
  ],
  "incidentCount": 3
}
```

### `/api/results`

```json
{
  "records": [
    {
      "timestamp": "2026-02-21T20:48:36.141Z",
      "sessionID": "2683d050-...",
      "endpoint": "https://custom-t0.speed.cloudflare.com",
      "endpointName": "custom-t0",
      "success": true,
      "download": 71.97,      // Mbps
      "upload": 35.29,        // Mbps
      "latency": 7.50,        // ms
      "jitter": 1.21,
      "downLoadedLatency": 22.80,
      "downLoadedJitter": 6.72,
      "upLoadedLatency": 51.50,
      "upLoadedJitter": 14.26
    }
  ],
  "total": 847,
  "hasMore": true,
  "cursor": "eyJh...truncated..."
}
```

## Troubleshooting

### Worker Fails to Deploy

- **Error:** "The directory specified by 'assets.directory' does not exist"
- **Cause:** `ui/dist/` wasn't built before deployment
- **Fix:** Ensure build command is `npm install && npm run build` in Workers Builds settings

### Empty Dashboard

- **Cause:** R2 bucket has no files under `json-results/` prefix
- **Fix:** Upload speedtest JSON files to the R2 bucket:
  ```bash
  npx wrangler r2 object put speedtest-results/json-results/speedtest-$(date -u +"%Y-%m-%dT%H-%M-%S-000Z").json --file=your-result.json
  ```

### R2 Binding Not Working

- **Cause:** Bucket name mismatch in `wrangler.jsonc`
- **Fix:** Verify `bucket_name: "speedtest-results"` matches your actual bucket

### Tests Fail with Transform Errors

- **Cause:** Type errors or syntax issues
- **Fix:** Run `npm run typecheck` to identify and fix TypeScript errors

## License

MIT
