export function handleLlmsTxt(): Response {
  return new Response(
    `# SpeedWatch
> Real-time Cloudflare speedtest monitoring dashboard powered by R2 object storage.

## API
GET /api/summary?hours={24}
GET /api/results?limit={100}&cursor={cursor}&endpoint={name}&from={iso}

## Endpoints
- /api/summary — aggregated KPIs, percentiles, per-endpoint breakdown, hourly timeline
- /api/results — paginated raw test records

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
