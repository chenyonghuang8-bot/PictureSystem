import { defineConfig } from "@playwright/test";
// New client acceptance cannot inherit the legacy self-signed TLS bypass or
// generate a private key. Supply an existing, browser-trusted DEV pair locally.
if (
  !process.env.PHASE10_CLIENT_TLS_CERT_FILE ||
  !process.env.PHASE10_CLIENT_TLS_KEY_FILE
)
  throw new Error("PHASE10_EXISTING_TRUSTED_DEV_TLS_PAIR_REQUIRED");
const { default: existing } = await import("./playwright.web.config.js");
export default defineConfig({
  ...existing,
  use: { ...existing.use, ignoreHTTPSErrors: false },
  webServer: Array.isArray(existing.webServer)
    ? existing.webServer.map((server) => ({
        ...server,
        ignoreHTTPSErrors: false,
      }))
    : existing.webServer,
});
