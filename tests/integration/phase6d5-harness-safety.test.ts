import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  cleanupWebAcceptanceStorage,
  prepareWebAcceptanceStorage,
  type WebAcceptanceStorage,
} from "../e2e-web/storage-harness.js";
import {
  assertSensitiveCategoryAbsent,
  assertSensitiveProjectionEqual,
  assertSensitiveValuesEqual,
  parseSessionCookie,
} from "../helpers/security-assertions.js";

const environmentNames = [
  "PHASE5_WEB_E2E_MEDIA_ROOT",
  "PHASE5_WEB_E2E_MARKER_ID",
  "PHASE6D5_API_OBSERVATION_LOG",
  "PHASE6D5_HTTPS_CERTIFICATE_DIRECTORY",
  "PHASE6D5_WEB_E2E_RUN_ROOT",
  "PHASE6D5_WEB_E2E_OWNERSHIP_NONCE",
] as const;
const temporaryParent = realpathSync(tmpdir());
const testOwnedRoots = new Set<string>();

afterEach(() => {
  for (const name of environmentNames) delete process.env[name];
  for (const root of testOwnedRoots) {
    if (existsSync(root)) rmSync(root, { recursive: true, force: true });
  }
  testOwnedRoots.clear();
});

describe.sequential("Phase 6D5 harness ownership safety", () => {
  it("removes only the exact current-run storage, log and certificate tree", () => {
    const current = createRun();
    writeFileSync(current.apiObservationLog, "synthetic", { mode: 0o600 });
    // The HTTPS launcher owns creation; emulate its exact owned directory.
    const certificate = current.certificateDirectory;
    mkdirSync(certificate, { mode: 0o700 });
    writeFileSync(join(certificate, "localhost-cert.pem"), "synthetic", {
      mode: 0o600,
    });
    cleanupWebAcceptanceStorage(current);
    expect(existsSync(current.runRoot)).toBe(false);
    testOwnedRoots.delete(current.runRoot);
  });

  it("refuses traversal, normalized escape and sibling prefix collisions", () => {
    const current = createRun();
    const outside = makeOwnedTemporary("phase6d5-outside-");
    const sibling = mkdtempSync(`${current.runRoot}-evil-`);
    testOwnedRoots.add(sibling);
    for (const runRoot of [
      `${current.runRoot}/../${outside.split("/").at(-1)}`,
      sibling,
    ]) {
      const candidate = { ...current, runRoot };
      expectCleanupRefused(candidate);
      expect(existsSync(outside)).toBe(true);
      expect(existsSync(sibling)).toBe(true);
    }
    cleanupCurrent(current);
  });

  it("refuses a symlink entry without touching its outside target", () => {
    const current = createRun();
    const outside = makeOwnedTemporary("phase6d5-symlink-target-");
    symlinkSync(outside, current.certificateDirectory, "dir");
    expectCleanupRefused(current);
    expect(lstatSync(current.certificateDirectory).isSymbolicLink()).toBe(true);
    expect(existsSync(outside)).toBe(true);
    unlinkSync(current.certificateDirectory);
    cleanupCurrent(current);
  });

  it("refuses a symlink cleanup target without following it", () => {
    const current = createRun();
    const outside = makeOwnedTemporary("phase6d5-root-symlink-target-");
    const link = join(
      temporaryParent,
      `picturesystem-phase5-web-e2e-symlink-${randomUUID()}`,
    );
    symlinkSync(outside, link, "dir");
    const candidate = {
      ...current,
      runRoot: link,
      mediaRoot: join(link, "media"),
      apiObservationLog: join(link, "api-observation.log"),
      certificateDirectory: join(link, "https-cert"),
    };
    expectCleanupRefused(candidate);
    expect(existsSync(outside)).toBe(true);
    unlinkSync(link);
    cleanupCurrent(current);
  });

  it("refuses preexisting same-prefix and arbitrary env-provided roots", () => {
    const preexisting = makeOwnedTemporary("picturesystem-phase5-web-e2e-");
    const arbitrary = makeOwnedTemporary("phase6d5-arbitrary-");
    process.env.PHASE6D5_WEB_E2E_RUN_ROOT = preexisting;
    process.env.PHASE5_WEB_E2E_MEDIA_ROOT = arbitrary;
    let refused = false;
    try {
      prepareWebAcceptanceStorage();
    } catch {
      refused = true;
    }
    expect(refused).toBe(true);
    expect(existsSync(preexisting)).toBe(true);
    expect(existsSync(arbitrary)).toBe(true);
  });

  it("refuses certificate and log paths outside the registered run root", () => {
    const current = createRun();
    const outside = makeOwnedTemporary("phase6d5-child-outside-");
    for (const candidate of [
      { ...current, certificateDirectory: outside },
      { ...current, apiObservationLog: join(outside, "log") },
      { ...current, mediaRoot: outside },
    ]) {
      expectCleanupRefused(candidate);
      expect(existsSync(outside)).toBe(true);
    }
    cleanupCurrent(current);
  });
});

describe("Phase 6D5 sensitive assertion safety", () => {
  it("reports only a safe category when a synthetic sentinel is detected", () => {
    const sentinel = `synthetic-${randomUUID()}`;
    let message = "";
    try {
      assertSensitiveCategoryAbsent(`captured:${sentinel}`, {
        category: "session-cookie",
        secret: sentinel,
      });
    } catch (error) {
      message = error instanceof Error ? error.message : "unknown-safe-error";
    }
    expect(message.includes(sentinel)).toBe(false);
    expect(message).toBe(
      "Sensitive category unexpectedly present: session-cookie",
    );

    let mismatchMessage = "";
    try {
      assertSensitiveValuesEqual("share-token", sentinel, "different");
    } catch (error) {
      mismatchMessage =
        error instanceof Error ? error.message : "unknown-safe-error";
    }
    expect(mismatchMessage.includes(sentinel)).toBe(false);
    expect(mismatchMessage).toBe(
      "Sensitive category did not match: share-token",
    );
  });

  it("parses cookie attributes without exposing the cookie value in safe facts", () => {
    const sentinel = `synthetic-${randomUUID()}`;
    const parsed = parseSessionCookie(
      `__Host-family_session=${sentinel}; Path=/; Secure; HttpOnly; SameSite=Lax`,
    );
    expect(parsed.safe).toEqual({
      nameIsExpected: true,
      valueIsNonEmpty: true,
      secure: true,
      httpOnly: true,
      sameSiteLax: true,
      pathIsRoot: true,
      domainAbsent: true,
    });
    expect(JSON.stringify(parsed.safe).includes(sentinel)).toBe(false);
  });

  it("reports only a safe category when unrelated projected metadata differs", () => {
    const sentinel = `synthetic-${randomUUID()}`;
    const internal = {
      shareId: "unexpected",
      albumId: "9",
      token: sentinel,
    };
    const projected = {
      shareId: internal.shareId,
      albumId: internal.albumId,
    };
    expect(Object.keys(projected).sort()).toEqual(["albumId", "shareId"]);
    expect(Object.hasOwn(projected, "token")).toBe(false);

    let message = "";
    try {
      assertSensitiveProjectionEqual(
        "share-create-metadata",
        internal,
        { shareId: "15", albumId: "9" },
        ({ shareId, albumId }) => ({ shareId, albumId }),
      );
    } catch (error) {
      message = error instanceof Error ? error.message : "unknown-safe-error";
    }
    expect(message.includes(sentinel)).toBe(false);
    expect(message).toBe(
      "Sensitive projection did not match: share-create-metadata",
    );
  });
});

function createRun() {
  const current = prepareWebAcceptanceStorage();
  testOwnedRoots.add(current.runRoot);
  return current;
}

function cleanupCurrent(current: WebAcceptanceStorage) {
  cleanupWebAcceptanceStorage(current);
  testOwnedRoots.delete(current.runRoot);
}

function expectCleanupRefused(candidate: WebAcceptanceStorage) {
  let refused = false;
  try {
    cleanupWebAcceptanceStorage(candidate);
  } catch {
    refused = true;
  }
  expect(refused).toBe(true);
}

function makeOwnedTemporary(prefix: string) {
  const root = mkdtempSync(join(temporaryParent, prefix));
  testOwnedRoots.add(root);
  return root;
}
