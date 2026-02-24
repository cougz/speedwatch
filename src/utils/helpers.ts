import type { SpeedtestRecord } from '../types';

export function getClientIP(request: Request): string {
  return (
    request.headers.get("CF-Connecting-IP") ??
    request.headers.get("X-Forwarded-For")?.split(",")[0].trim() ??
    "unknown"
  );
}

export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

export function stripPrefix(key: string, prefix: string): string {
  if (prefix && key.startsWith(prefix)) {
    return key.slice(prefix.length);
  }
  return key;
}

export function filenameToTimestamp(filename: string): string {
  let name = filename;
  if (name.endsWith(".json")) {
    name = name.slice(0, -5);
  }
  if (name.startsWith("speedtest-")) {
    name = name.slice(10);
  }
  const [datePart, ...rest] = name.split("T");
  const timePart = rest.join("T");
  let matchCount = 0;
  const fixedTime = timePart.replace(/-/g, () => {
    matchCount++;
    return matchCount <= 2 ? ":" : ".";
  });
  return `${datePart}T${fixedTime}`;
}

export function endpointName(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

export const toMbps = (bps: number) => Math.round((bps / 1_000_000) * 100) / 100;

/**
 * Attempt to construct a SpeedtestRecord purely from R2 custom metadata.
 * R2 lowercases all custom metadata keys automatically.
 * Returns null if any required field is missing — caller must fall back to body fetch.
 *
 * Required metadata keys: download, upload, latency, jitter, endpoint, sessionid, success
 * Optional metadata keys: downloadedlatency, downloadedjitter, uploadedlatency, uploadedjitter
 */
export function recordFromMetadata(
  key: string,
  prefix: string,
  meta: Record<string, string>
): SpeedtestRecord | null {
  if (
    !meta.download  ||
    !meta.upload    ||
    !meta.latency   ||
    !meta.jitter    ||
    !meta.endpoint  ||
    !meta.sessionid
  ) {
    return null;
  }

  const filename = stripPrefix(key, prefix);
  const name = endpointName(meta.endpoint);

  return {
    timestamp:         filenameToTimestamp(filename),
    sessionID:         meta.sessionid,
    endpoint:          meta.endpoint,
    endpointName:      name,
    success:           meta.success === 'true',
    download:          toMbps(parseFloat(meta.download)),
    upload:            toMbps(parseFloat(meta.upload)),
    latency:           parseFloat(meta.latency),
    jitter:            parseFloat(meta.jitter),
    downLoadedLatency: parseFloat(meta.downloadedlatency ?? '0'),
    downLoadedJitter:  parseFloat(meta.downloadedjitter  ?? '0'),
    upLoadedLatency:   parseFloat(meta.uploadedlatency   ?? '0'),
    upLoadedJitter:    parseFloat(meta.uploadedjitter    ?? '0'),
  };
}
