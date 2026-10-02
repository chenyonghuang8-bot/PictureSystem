import {
  mkdtempSync,
  readdirSync,
  realpathSync,
  statSync,
  symlinkSync,
  chmodSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { StorageRoot } from "./index.js";
import { ContentCoordination } from "./phase7-coordination.js";

const roots: string[] = [];
const digest = "a".repeat(64);
function setup() {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "phase7-coord-"));
  roots.push(dir);
  const root = StorageRoot.open(dir, { initialize: true });
  return { root, dir };
}
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("Phase 7 per-content coordination", () => {
  it("allows a pure reader to hold R without the global writer lock", async () => {
    const { root } = setup();
    const identity = {
      mediaRoot: root.canonicalPath,
      expectedMarkerId: root.markerId,
    };
    root.close();
    const reader = new ContentCoordination(identity, {
      familyId: "1",
      sha256Hex: digest,
      byteSize: "5",
    });
    const guard = await reader.acquireReadOnly(0);
    guard.close();
  });

  it("allows S/S, conflicts S/X and X/X, and does not conflict across K", async () => {
    const { root } = setup();
    try {
      const a = new ContentCoordination(root, {
        familyId: "1",
        sha256Hex: digest,
        byteSize: "5",
      });
      const b = new ContentCoordination(root, {
        familyId: "1",
        sha256Hex: digest,
        byteSize: "5",
      });
      const other = new ContentCoordination(root, {
        familyId: "2",
        sha256Hex: digest,
        byteSize: "5",
      });
      const aS = await a.acquireLifecycle("S", 0);
      const bS = await b.acquireLifecycle("S", 0);
      await expect(b.acquireLifecycle("X", 0)).rejects.toThrow(
        "COORD_ACQUIRE_TIMEOUT",
      );
      const otherX = await other.acquireLifecycle("X", 0);
      otherX.close();
      bS.close();
      aS.close();
      const aX = await a.acquireLifecycle("X", 0);
      await expect(b.acquireLifecycle("X", 0)).rejects.toThrow(
        "COORD_ACQUIRE_TIMEOUT",
      );
      aX.close();
      const bX = await b.acquireLifecycle("X", 0);
      bX.close();
    } finally {
      root.close();
    }
  });

  it("keeps lock inodes stable while a pure R reader fences R-exclusive", async () => {
    const { root } = setup();
    try {
      const c = new ContentCoordination(root, {
        familyId: "1",
        sha256Hex: digest,
        byteSize: "5",
      });
      const d = new ContentCoordination(root, {
        familyId: "1",
        sha256Hex: digest,
        byteSize: "5",
      });
      const lifecycle = await c.acquireLifecycle("S", 0);
      const read = await c.acquireReadOnly(0);
      lifecycle.close();
      const otherLifecycle = await d.acquireLifecycle("X", 0);
      await expect(d.acquireRead(otherLifecycle, "X", 0)).rejects.toThrow(
        "COORD_ACQUIRE_TIMEOUT",
      );
      const coordDir = join(root.canonicalPath, ".coord", "v1");
      const before = readdirSync(coordDir).map((name) => [
        name,
        statSync(join(coordDir, name)).ino,
      ]);
      read.close();
      const exclusive = await d.acquireRead(otherLifecycle, "X", 0);
      exclusive.close();
      otherLifecycle.close();
      const later = await c.acquireLifecycle("X", 0);
      later.close();
      const after = readdirSync(coordDir).map((name) => [
        name,
        statSync(join(coordDir, name)).ino,
      ]);
      expect(after).toEqual(before);
    } finally {
      root.close();
    }
  });

  it("rejects unsafe lock inode replacement and loose mode", async () => {
    const { root } = setup();
    try {
      const c = new ContentCoordination(root, {
        familyId: "1",
        sha256Hex: digest,
        byteSize: "5",
      });
      const g = await c.acquireLifecycle("S", 0);
      g.close();
      const dir = join(root.canonicalPath, ".coord", "v1");
      const name = readdirSync(dir)[0]!;
      chmodSync(join(dir, name), 0o644);
      await expect(c.acquireLifecycle("S", 0)).rejects.toThrow();
      chmodSync(join(dir, name), 0o600);
      rmSync(join(dir, name));
      symlinkSync(join(root.canonicalPath, ".storage-root"), join(dir, name));
      await expect(c.acquireLifecycle("S", 0)).rejects.toThrow();
    } finally {
      root.close();
    }
  });

  it("uses kernel flock across processes for the same content identity", async () => {
    const { root } = setup();
    const probe = () =>
      execFileSync(
        process.execPath,
        [
          "-e",
          `
      const n=require(${JSON.stringify(join(import.meta.dirname, "../build/storage_native.node"))});
      const h=n.openCoordination(process.argv[1],process.argv[2],"1",${JSON.stringify(digest)},"5","L");
      const ok=n.tryAcquireCoordination(h,"X");
      if(ok)n.releaseCoordination(h);
      n.closeCoordination(h);
      process.stdout.write(ok?"ACQUIRED":"BUSY");
    `,
          root.canonicalPath,
          root.markerId,
        ],
        { encoding: "utf8" },
      );
    try {
      const c = new ContentCoordination(root, {
        familyId: "1",
        sha256Hex: digest,
        byteSize: "5",
      });
      const shared = await c.acquireLifecycle("S", 0);
      expect(probe()).toBe("BUSY");
      shared.close();
      expect(probe()).toBe("ACQUIRED");
    } finally {
      root.close();
    }
  });
});
