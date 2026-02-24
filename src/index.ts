import { handleApiRequest } from "./api/handler";
import { handleLlmsTxt }    from "./api/llmstxt";
import { runCron }          from "./api/cron";
import type { Env }         from "./types";
import { THRESHOLDS }       from "./types";

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const path = decodeURIComponent(new URL(req.url).pathname);
    if (path === "/api/config") return handleConfig(env);
    if (path.startsWith("/api")) return handleApiRequest(req, env, ctx);
    if (path === "/llms.txt")   return handleLlmsTxt();
    return env.ASSETS.fetch(req);
  },

  // ScheduledEvent is a global type from @cloudflare/workers-types — do NOT import it.
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runCron(env));
  },
};

function handleConfig(env: Env): Response {
  return new Response(JSON.stringify({
    ANOMALY_WARN_THRESHOLD: env.ANOMALY_WARN_THRESHOLD,
    ANOMALY_CRIT_THRESHOLD: env.ANOMALY_CRIT_THRESHOLD,
    THRESHOLDS,
  }), {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
