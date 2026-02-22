import type { Env } from "../types";

export interface RateLimitResult {
  allowed: boolean;
  retryAfter?: number;
}

export async function checkRateLimit(env: Env, clientIP: string): Promise<RateLimitResult> {
  try {
    const { success } = await env.RATE_LIMITER.limit({ key: clientIP });
    if (!success) {
      return { allowed: false, retryAfter: 60 };
    }
    return { allowed: true };
  } catch {
    return { allowed: true };
  }
}
