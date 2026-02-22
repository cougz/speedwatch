import { handleSummary } from "./summary";
import { handleResults } from "./results";
import type { Env } from "../types";

export async function handleApiRequest(
  req: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const path = new URL(req.url).pathname;
  if (path === "/api/summary") return handleSummary(req, env, ctx);
  if (path === "/api/results") return handleResults(req, env, ctx);
  return new Response(JSON.stringify({ error: "Not found" }), {
    status: 404,
    headers: { "Content-Type": "application/json" },
  });
}
