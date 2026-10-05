import { resolve } from "node:path";

// Dedicated synthetic Phase 9 acceptance uses the existing owned DEV harness.
process.env.DEV_MEDIA_PIPELINE_ENABLED = "1";
process.env.LOCATION_DATA_DIR = resolve(
  import.meta.dirname,
  "resources/location/2026-10-03",
);
const { default: config } = await import("./playwright.web.config.js");
export default { ...config, testMatch: "memories-validation.spec.ts" };
