import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    include: ["test/**/*.test.ts"],
    poolOptions: {
      workers: {
        singleWorker: true,
        isolatedStorage: false,
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            R2_PREFIX: "json-results/",
            CACHE_TTL_SECONDS: "60",
            MAX_RESULTS_PER_PAGE: "200",
            ANOMALY_WARN_THRESHOLD: "0.70",
            ANOMALY_CRIT_THRESHOLD: "0.50",
          },
        },
      },
    },
  },
});
