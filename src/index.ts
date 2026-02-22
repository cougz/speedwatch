import { handleApiRequest } from "./api/handler";
import { handleLlmsTxt } from "./api/llmstxt";
import type { Env } from "./types";

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const path = decodeURIComponent(new URL(req.url).pathname);
    if (path.startsWith("/api")) return handleApiRequest(req, env, ctx);
    if (path === "/llms.txt") return handleLlmsTxt();
    return env.ASSETS.fetch(req);
  },
};
