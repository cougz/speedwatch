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
