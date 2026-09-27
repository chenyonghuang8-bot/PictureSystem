import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { StorageRoot } from "../../packages/storage/src/index.js";

const ROOT_ENV = "PHASE5_WEB_E2E_MEDIA_ROOT";
const MARKER_ENV = "PHASE5_WEB_E2E_MARKER_ID";

export type WebAcceptanceStorage = {
  mediaRoot: string;
  markerId: string;
};

export function prepareWebAcceptanceStorage(): WebAcceptanceStorage {
  const existingRoot = process.env[ROOT_ENV];
  const existingMarker = process.env[MARKER_ENV];
  if (existingRoot && existingMarker) {
    return { mediaRoot: existingRoot, markerId: existingMarker };
  }

  const mediaRoot = mkdtempSync(
    join(realpathSync(tmpdir()), "picturesystem-phase5-web-e2e-"),
  );
  chmodSync(mediaRoot, 0o700);
  mkdirSync(join(mediaRoot, "derived"), { mode: 0o700 });
  const storage = StorageRoot.open(mediaRoot, { initialize: true });
  try {
    storage.provisionSharedCapacityLockForDev();
    process.env[ROOT_ENV] = storage.canonicalPath;
    process.env[MARKER_ENV] = storage.markerId;
    return {
      mediaRoot: storage.canonicalPath,
      markerId: storage.markerId,
    };
  } finally {
    storage.close();
  }
}

export function cleanupWebAcceptanceStorage(explicitRoot?: string) {
  const mediaRoot = explicitRoot ?? process.env[ROOT_ENV];
  if (!mediaRoot) return;
  const temporaryRoot = realpathSync(tmpdir());
  if (!mediaRoot.startsWith(`${temporaryRoot}/picturesystem-phase5-web-e2e-`)) {
    throw new Error("PHASE5_WEB_E2E_STORAGE_CLEANUP_REFUSED");
  }
  rmSync(mediaRoot, { recursive: true, force: true });
  delete process.env[ROOT_ENV];
  delete process.env[MARKER_ENV];
}
