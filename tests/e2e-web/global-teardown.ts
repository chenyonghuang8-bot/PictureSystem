import type { FullConfig } from "@playwright/test";

import { cleanupWebAcceptanceStorage } from "./storage-harness.js";

export default function globalTeardown(config: FullConfig) {
  const mediaRoot = config.metadata.phase5WebAcceptanceMediaRoot;
  cleanupWebAcceptanceStorage(
    typeof mediaRoot === "string" ? mediaRoot : undefined,
  );
}
