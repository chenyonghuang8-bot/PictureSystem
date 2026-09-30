import type { FullConfig } from "@playwright/test";

import {
  cleanupWebAcceptanceStorage,
  type WebAcceptanceStorage,
} from "./storage-harness.js";

export default function globalTeardown(config: FullConfig) {
  cleanupWebAcceptanceStorage(
    config.metadata.phase6d5WebAcceptanceStorage as
      WebAcceptanceStorage | undefined,
  );
}
