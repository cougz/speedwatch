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
    ANOMALY_WARN_THRESHOLD: env.ANOMALY_WARN_THRESHOLD,
    ANOMALY_CRIT_THRESHOLD: env.ANOMALY_CRIT_THRESHOLD,
  };
  return new Response(JSON.stringify(config), {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
