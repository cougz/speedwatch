import { handleApiRequest } from "./api/handler";
import { handleLlmsTxt } from "./api/llmstxt";
import type { Env } from "./types";

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const path = decodeURIComponent(new URL(req.url).pathname);
    if (path.startsWith("/api")) return handleApiRequest(req, env, ctx);
    if (path === "/llms.txt") return handleLlmsTxt();
    if (path === "/api/config") return handleConfig(env);
    return env.ASSETS.fetch(req);
  },
};

function handleConfig(env: Env): Response {
  const config = {
    WARN_PERCENTILE: env.WARN_PERCENTILE,
    CRIT_PERCENTILE: env.CRIT_PERCENTILE,
    EMA_ALPHA: env.EMA_ALPHA,
    OUTAGE_THRESHOLD_PCT: env.OUTAGE_THRESHOLD_PCT,
    CONSECUTIVE_LOW_THRESHOLD: env.CONSECUTIVE_LOW_THRESHOLD,
  };
  return new Response(JSON.stringify(config), {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

function handleConfig(env: Env): Response {
  const config = {
    ANOMALY_MIN_IQR: env.ANOMALY_MIN_IQR,
    ANOMALY_WARN_IQR_MULTIPLIER: env.ANOMALY_WARN_IQR_MULTIPLIER,
    ANOMALY_CRIT_IQR_MULTIPLIER: env.ANOMALY_CRIT_IQR_MULTIPLIER,
    ENDPOINT_ANOMALY_MIN_IQR: env.ENDPOINT_ANOMALY_MIN_IQR,
    ENDPOINT_WARN_IQR_MULTIPLIER: env.ENDPOINT_WARN_IQR_MULTIPLIER,
    ENDPOINT_CRIT_IQR_MULTIPLIER: env.ENDPOINT_CRIT_IQR_MULTIPLIER,
  };
  return new Response(JSON.stringify(config), {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
