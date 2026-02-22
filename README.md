# SpeedWatch

Real-time Cloudflare speedtest monitoring dashboard powered by R2 object storage.

## Overview

SpeedWatch reads JSON speedtest result files from an R2 bucket and displays them through a REST API consumed by an interactive Astro UI.

```
Cloudflare Worker (speedwatch)
         │
         ├─► /api/summary → Aggregated KPIs
         ├─► /api/results → Paginated records
         ├─► /llms.txt → AI discovery
         │
         ▼
R2 Bucket
```

## How It Works

1. **Ingestion**: Speedtest agents upload JSON results to R2 bucket
2. **Parsing**: Worker reads R2 files, parses metrics, converts bytes/sec to Mbps
3. **Aggregation**: Summarizes data by time windows, calculates percentiles, groups by endpoint
4. **Anomaly Detection**: Uses IQR (Interquartile Range) to flag statistical outliers
   - Compares values against recent 100 records' median
   - WARN: values outside median ± 3×IQR
   - CRIT: values outside median ± 5×IQR
   - Adapts to sustained issues (e.g., 6h outage windows)
5. **Dashboard**: Renders KPIs, charts, incidents, endpoint breakdown, and results table

## Features

### API Endpoints

- `GET /api/summary?hours={24}` — Aggregated KPIs, percentiles, per-endpoint breakdown, hourly timeline, incidents
- `GET /api/results?limit={100}&cursor={cursor}&endpoint={name}&from={iso}` — Paginated raw test records
- `GET /llms.txt` — AI agent discoverability document

### Dashboard UI

- **KPI Cards** — Average download, upload, latency, jitter with sparklines and p95
- **Incidents Panel** — Automatic degradation detection (warn/crit) with affected metrics
- **Throughput Chart** — Download (orange) and upload (blue) area charts
- **Latency Chart** — Latency line chart
- **Endpoint Breakdown** — Per-endpoint cards with progress bars and metric tiles
- **Results Table** — Paginated table with anomaly highlighting
- **Auto-refresh** — 60-second data refresh
- **Time Range Pills** — 1h, 6h, 24h, 7d, All, Custom date range

## Configuration

### Environment Variables

All configured in `wrangler.jsonc`:

| Variable | Default | Description |
|----------|----------|-------------|
| `R2_PREFIX` | `"speedtest-results/"` | Folder path in R2 bucket |
| `CACHE_TTL_SECONDS` | `"60"` | Response cache duration |
| `MAX_RESULTS_PER_PAGE` | `"200"` | Max records per results page |

### Bindings

| Binding | Type | Value |
|---------|------|--------|
| `R2_BUCKET` | R2 Bucket | Your speedtest results bucket |
| `RATE_LIMITER` | Rate Limit | 60 requests per 60s |

### Anomaly Detection (IQR Configuration)

The dashboard uses IQR-based statistical anomaly detection:

**Recent Results** (individual tests):
- WARN threshold: median ± **3×IQR**
- CRIT threshold: median ± **5×IQR**

**Endpoint Breakdown** (averages):
- WARN threshold: median ± **3×IQR**
- CRIT threshold: median ± **6×IQR**

To adjust sensitivity, edit the multipliers in `ui/src/pages/index.astro`:
```javascript
// Recent Results - isAnomaly() function
const warnLower = stats.median - (iqr * 3);   // change 3 for different sensitivity
const critLower = stats.median - (iqr * 5);   // change 5 for different sensitivity

// Endpoint Breakdown - isEndpointAnomaly() function
const warnLower = stats.median - (iqr * 3);   // change 3 for different sensitivity
const critLower = stats.median - (iqr * 6);   // change 6 for different sensitivity
```

## R2 Bucket Data Format

### File Naming

Supported patterns:
- `speedtest-{timestamp}.json` — Default pattern
- `{timestamp}.json` — Without prefix

### File Content

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

**Note:** API converts bytes/sec to Mbps automatically.

## Deployment

### Prerequisites

- Cloudflare account with Workers enabled
- GitHub account (for Workers Builds integration)
- Existing R2 bucket with speedtest JSON files

### Workers Builds (Recommended)

Workers Builds automatically deploys on push to `main`.

1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. **Workers & Pages** → **Create Application**
3. **Connect to Git** → Authorize GitHub → Select `speedwatch` repo
4. Click **Begin setup**
5. Build settings (pre-configured):
   - Build command: `npm install && npm run build`
   - Deploy command: `npx wrangler deploy`
6. Click **Save and Deploy**

### Local Development

```bash
npm install
npm run dev
```

Dev server runs on `http://localhost:8787/`

## Troubleshooting

| Issue | Fix |
|--------|------|
| Dashboard empty | Upload speedtest JSON files to R2 bucket |
| `R2_BUCKET` binding error | Verify bucket name in `wrangler.jsonc` matches actual bucket |
| API rate limited | Wait 60s or adjust `RATE_LIMITER` |
| Build fails | Run `npm run typecheck` to check for errors |

## License

MIT
