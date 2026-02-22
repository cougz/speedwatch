export function handleLlmsTxt(): Response {
  return new Response(
    `# SpeedWatch
> Real-time Cloudflare speedtest monitoring dashboard powered by R2 object storage.

## API
GET /api/summary?hours={24}
GET /api/results?limit={100}&cursor={cursor}&endpoint={name}&from={iso}

## Endpoints
- /api/summary — aggregated KPIs, percentiles, per-endpoint breakdown, hourly timeline, performance incidents
- /api/results — paginated raw test records with anomaly detection highlighting

## Anomaly Detection
Uses percentage-of-baseline approach to detect performance deviations:
- Compares values against median baseline from recent records
- WARN: values below 70% of baseline (throughput) or above 142% (latency/jitter)
- CRIT: values below 50% of baseline (throughput) or above 200% (latency/jitter)
- Automatically adapts to each user's actual connection performance

## Rate limit: 60 requests per minute per IP
`,
    {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "public, max-age=86400",
      },
    }
  );
}
