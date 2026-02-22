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

**This is the recommended deployment method** - no manual wrangler commands needed.

#### Step 1: Connect GitHub Repository

1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. Navigate to **Workers & Pages** → **Create Application**
3. Select **Connect to Git**
4. Authorize your GitHub account
5. Select the `speedwatch` repository
6. Click **Begin setup**

#### Step 2: Configure Bindings & Variables

After deployment, configure the required bindings and variables in Cloudflare Dashboard:

**1. R2 Bucket Binding:**
   - Go to your Worker → **Settings** → **Bindings** → **R2 Buckets**
   - Click **Add binding**
   - Variable name: `R2_BUCKET`
   - Select your existing R2 bucket (or create a new one)
   - Click **Save and Deploy**

**2. Rate Limiting Binding:**
   - Go to your Worker → **Settings** → **Bindings** → **Rate Limits**
   - Click **Add binding**
   - Variable name: `RATE_LIMITER`
   - Namespace ID: Enter a unique ID (e.g., `1001`)
   - Limit: `60` requests
   - Period: `60` seconds
   - Click **Save and Deploy**

**3. Environment Variables:**
   - Go to your Worker → **Settings** → **Variables and Secrets**
   - Add the following variables:
     - `R2_PREFIX`: `speedtest-results/` (or your actual folder path)
     - `CACHE_TTL_SECONDS`: `60`
     - `MAX_RESULTS_PER_PAGE`: `200`
   - Click **Save and Deploy**

**Important:** All bindings and variables are managed in Cloudflare Dashboard only. Do NOT edit `wrangler.jsonc` for these configurations.

#### Step 3: Configure Build Settings

In the build configuration, set:

| Setting | Value |
|---------|--------|
| Build command | `npm install && npm run build` |
| Deploy command | `npx wrangler deploy` (default, already filled) |

Click **Save and Deploy**. The first build will start immediately.

### Local Development
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

All bindings and variables are configured in **Cloudflare Dashboard** → **Settings** for your Worker.

### Bindings

| Binding | Type | Description |
|---------|------|-------------|
| `R2_BUCKET` | R2 Bucket | Your R2 bucket containing speedtest JSON files |
| `RATE_LIMITER` | Rate Limit | API rate limiting (namespace_id, limit, period) |

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `R2_PREFIX` | `"speedtest-results/"` | Folder/prefix in R2 bucket where speedtest JSON files are stored |
| `CACHE_TTL_SECONDS` | `"60"` | Cache TTL for API responses (seconds) |
| `MAX_RESULTS_PER_PAGE` | `"200"` | Maximum records per page in results API |

**Important:** The `R2_PREFIX` must match your actual folder structure in R2 bucket:

| Your Bucket Structure | `R2_PREFIX` Value |
|----------------------|-------------------|
| Files in subfolder `speedtest-results/` | `"speedtest-results/"` |
| Files in subfolder `json-results/` | `"json-results/"` |
| Files in subfolder `results/` | `"results/"` |
| Files directly in bucket root | `""` (empty quotes) |
## R2 Bucket Data Format

SpeedWatch expects JSON files in your R2 bucket. The actual file location is determined by the `R2_PREFIX` environment variable in `wrangler.jsonc`.

### File Location

**If `R2_PREFIX` is set to `"speedtest-results/"` (default):**
- Full path: `speedtest-results/speedtest-2026-02-21T20-48-36-141Z.json`

**If `R2_PREFIX` is set to `""` (bucket root):**
- Full path: `speedtest-2026-02-21T20-48-36-141Z.json`

**If `R2_PREFIX` is set to a different subfolder:**
- Update the value to match your actual folder structure

### File Naming

SpeedWatch supports these filename patterns (with and without the `speedtest-` prefix):

| Pattern | Example | Notes |
|--------|---------|-------|
| `speedtest-{timestamp}.json` | `speedtest-2026-02-21T20-48-36-141Z.json` | Default pattern if your files include `speedtest-` in the name |
| `{timestamp}.json` | `2026-02-21T20-48-36-141Z.json` | If files don't have the `speedtest-` prefix |

**Note:** Update `R2_PREFIX` in `wrangler.jsonc` to match your actual file location:
- If files are in a subfolder named `speedtest-results/`, set `R2_PREFIX: "speedtest-results/"`
- If files are directly in bucket root, set `R2_PREFIX: ""`

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
