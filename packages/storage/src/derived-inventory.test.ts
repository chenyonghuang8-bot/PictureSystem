import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { CapacityGate, StorageRoot } from "./index.js";

function privateDirectory(path: string) {
  mkdirSync(path, { recursive: true });
  const segments = path.split("/");
  const rootIndex = segments.findIndex((segment) =>
    segment.startsWith("ps4d3b0-"),
  );
  const start = rootIndex >= 0 ? rootIndex : segments.length - 1;
  for (let index = start; index < segments.length; index += 1) {
    chmodSync(segments.slice(0, index + 1).join("/"), 0o700);
  }
}

function privateFile(path: string, contents = "synthetic") {
  writeFileSync(path, contents);
  chmodSync(path, 0o600);
}

function knownPart(
  root: string,
  jobId: string,
  epoch: string,
  filename: "thumbnail.part" | "preview.part",
  contents = "synthetic",
) {
  const derived = join(root, "derived");
  const temp = join(derived, ".tmp");
  const job = join(temp, jobId);
  const epochDirectory = join(job, `e${epoch}`);
  for (const directory of [derived, temp, job, epochDirectory]) {
    privateDirectory(directory);
  }
  privateFile(join(epochDirectory, filename), contents);
}

async function withGate(
  rootPath: string,
  operation: (gate: CapacityGate) => Promise<void> | void,
) {
  const root = StorageRoot.open(rootPath, { initialize: true });
  let gate: CapacityGate | undefined;
  try {
    if (!existsSync(join(rootPath, ".capacity.lock"))) {
      root.provisionSharedCapacityLockForDev();
    }
    gate = CapacityGate.open({
      mediaRoot: rootPath,
      expectedMarkerId: root.markerId,
    });
    await gate.withLock(async () => {
      await operation(gate as CapacityGate);
    });
  } finally {
    gate?.close();
    root.close();
  }
}

describe("derived known-file inventory", () => {
  it("treats an absent or empty derived namespace as complete", async () => {
    const rootPath = mkdtempSync(join(realpathSync(tmpdir()), "ps4d3b0-"));
    try {
      await withGate(rootPath, (gate) => {
        const absent = gate.snapshotLocked();
        expect(absent.derivedInventoryComplete).toBe(true);
        expect(absent.derivedObservations).toEqual([]);
        const page = gate.derivedInventoryPage("");
        expect(page.outcome).toBe("complete");
        expect(page.observations).toEqual([]);
      });
      privateDirectory(join(rootPath, "derived"));
      await withGate(rootPath, (gate) => {
        expect(gate.snapshotLocked().derivedInventoryComplete).toBe(true);
      });
    } finally {
      rmSync(rootPath, { recursive: true, force: true });
    }
  });

  it("accepts only the capacity lock and recognized temp parts", async () => {
    const rootPath = mkdtempSync(join(realpathSync(tmpdir()), "ps4d3b0-"));
    try {
      privateDirectory(join(rootPath, "derived"));
      privateFile(join(rootPath, "derived", ".capacity.lock"), "");
      privateFile(join(rootPath, "derived", ".derived-writer.lock"), "");
      await withGate(rootPath, (gate) => {
        const snapshot = gate.snapshotLocked();
        expect(snapshot.derivedInventoryComplete).toBe(true);
        expect(snapshot.derivedObservations).toEqual([]);
      });
      knownPart(rootPath, "42", "7", "thumbnail.part", "abcd");
      knownPart(rootPath, "42", "7", "preview.part", "preview-bytes");
      knownPart(rootPath, "43", "8", "thumbnail.part", "other");
      knownPart(rootPath, "43", "2", "preview.part", "epoch-two");
      await withGate(rootPath, (gate) => {
        const snapshot = gate.snapshotLocked();
        expect(snapshot.derivedInventoryComplete).toBe(true);
        expect(snapshot.derivedObservations).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              jobId: "42",
              epoch: 7n,
              kind: "THUMBNAIL",
              byteSize: 4n,
            }),
            expect.objectContaining({
              jobId: "42",
              epoch: 7n,
              kind: "PREVIEW",
              byteSize: BigInt("preview-bytes".length),
            }),
            expect.objectContaining({
              jobId: "43",
              epoch: 2n,
              kind: "PREVIEW",
            }),
            expect.objectContaining({
              jobId: "43",
              epoch: 8n,
              kind: "THUMBNAIL",
            }),
          ]),
        );
        expect(snapshot.derivedObservations).toHaveLength(4);
      });
    } finally {
      rmSync(rootPath, { recursive: true, force: true });
    }
  });

  it("pages across 1250 job directories without a 1000-entry hard failure", async () => {
    const rootPath = mkdtempSync(join(realpathSync(tmpdir()), "ps4d3b0-"));
    try {
      for (let job = 1; job <= 1250; job += 1) {
        knownPart(rootPath, String(job), "1", "thumbnail.part", "x");
      }
      await withGate(rootPath, (gate) => {
        const before = readdirSync(join(rootPath, "derived")).sort();
        const first = gate.derivedInventoryPage("");
        expect(first.outcome).toBe("continue");
        expect(first.observations.length).toBeGreaterThan(0);
        expect(first.observations.length).toBeLessThan(1250);
        const seen = new Set(first.observations.map((item) => item.jobId));
        let cursor = first.nextCursor;
        let guard = 0;
        while (cursor !== "") {
          guard += 1;
          expect(guard).toBeLessThan(100);
          const page = gate.derivedInventoryPage(cursor);
          if (page.outcome === "incomplete") {
            throw new Error("Paged inventory failed closed on a known tree.");
          }
          for (const item of page.observations) seen.add(item.jobId);
          cursor = page.outcome === "complete" ? "" : page.nextCursor;
        }
        expect(seen.size).toBe(1250);
        for (let job = 1; job <= 1250; job += 1) {
          expect(seen.has(String(job))).toBe(true);
        }
        const snapshot = gate.snapshotLocked();
        expect(snapshot.derivedInventoryComplete).toBe(true);
        expect(snapshot.derivedObservations).toHaveLength(1250);
        expect(readdirSync(join(rootPath, "derived")).sort()).toEqual(before);
      });
    } finally {
      rmSync(rootPath, { recursive: true, force: true });
    }
  }, 120_000);

  it.each([
    [
      "random root file",
      (root: string) => privateFile(join(root, "derived", ".DS_Store")),
    ],
    [
      "random directory",
      (root: string) => privateDirectory(join(root, "derived", "notes")),
    ],
    [
      "invalid job",
      (root: string) => {
        knownPart(root, "42", "1", "thumbnail.part");
        privateDirectory(join(root, "derived", ".tmp", "01"));
      },
    ],
    [
      "zero job",
      (root: string) =>
        privateDirectory(join(root, "derived", ".tmp", "0", "e1")),
    ],
    [
      "unicode job",
      (root: string) =>
        privateDirectory(join(root, "derived", ".tmp", "１", "e1")),
    ],
    [
      "invalid epoch",
      (root: string) =>
        privateDirectory(join(root, "derived", ".tmp", "42", "e0")),
    ],
    [
      "signed epoch",
      (root: string) =>
        privateDirectory(join(root, "derived", ".tmp", "42", "e-1")),
    ],
    [
      "uppercase epoch",
      (root: string) =>
        privateDirectory(join(root, "derived", ".tmp", "42", "E1")),
    ],
    [
      "random part name",
      (root: string) => {
        const epoch = join(root, "derived", ".tmp", "42", "e1");
        privateDirectory(epoch);
        privateFile(join(epoch, "random.part"));
      },
    ],
    [
      "malformed kind",
      (root: string) => {
        const epoch = join(root, "derived", ".tmp", "42", "e1");
        privateDirectory(epoch);
        privateFile(join(epoch, "thumbnail.xxx"));
      },
    ],
    [
      "old preview name",
      (root: string) => {
        const epoch = join(root, "derived", ".tmp", "42", "e1");
        privateDirectory(epoch);
        privateFile(join(epoch, "preview-old.part"));
      },
    ],
    [
      "extra depth",
      (root: string) => {
        knownPart(root, "42", "1", "thumbnail.part");
        privateDirectory(join(root, "derived", ".tmp", "42", "e1", "nested"));
      },
    ],
    [
      "symlink",
      (root: string) => {
        const epoch = join(root, "derived", ".tmp", "42", "e1");
        privateDirectory(epoch);
        privateFile(join(epoch, "target.part"));
        symlinkSync("target.part", join(epoch, "thumbnail.part"));
      },
    ],
    [
      "fifo",
      (root: string) => {
        const epoch = join(root, "derived", ".tmp", "42", "e1");
        privateDirectory(epoch);
        const created = spawnSync("/usr/bin/mkfifo", [
          join(epoch, "thumbnail.part"),
        ]);
        if (created.status !== 0) {
          throw new Error("mkfifo failed");
        }
      },
    ],
    [
      "wrong mode",
      (root: string) => {
        knownPart(root, "42", "1", "thumbnail.part");
        chmodSync(
          join(root, "derived", ".tmp", "42", "e1", "thumbnail.part"),
          0o644,
        );
      },
    ],
    [
      "wrong directory mode",
      (root: string) => {
        knownPart(root, "42", "1", "thumbnail.part");
        chmodSync(join(root, "derived", ".tmp", "42"), 0o755);
      },
    ],
  ])("fails closed for %s", async (_label, plant) => {
    const rootPath = mkdtempSync(join(realpathSync(tmpdir()), "ps4d3b0-"));
    try {
      privateDirectory(join(rootPath, "derived"));
      plant(rootPath);
      await withGate(rootPath, (gate) => {
        const snapshot = gate.snapshotLocked();
        expect(snapshot.derivedInventoryComplete).toBe(false);
        expect(snapshot.derivedObservations).toEqual([]);
        expect(gate.derivedInventoryPage("").outcome).toBe("incomplete");
      });
    } finally {
      rmSync(rootPath, { recursive: true, force: true });
    }
  });

  it("fails closed for a socket and a second hard link", async () => {
    const rootPath = mkdtempSync(join(realpathSync(tmpdir()), "ps-"));
    const socketPath = join(
      rootPath,
      "derived",
      ".tmp",
      "1",
      "e1",
      "thumbnail.part",
    );
    try {
      privateDirectory(join(rootPath, "derived", ".tmp", "1", "e1"));
      const server = createServer();
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, resolve);
      });
      chmodSync(join(rootPath, "derived"), 0o700);
      chmodSync(join(rootPath, "derived", ".tmp"), 0o700);
      chmodSync(join(rootPath, "derived", ".tmp", "1"), 0o700);
      chmodSync(join(rootPath, "derived", ".tmp", "1", "e1"), 0o700);
      await withGate(rootPath, (gate) => {
        expect(gate.snapshotLocked().derivedInventoryComplete).toBe(false);
      });
      server.close();
      rmSync(socketPath, { force: true });
      knownPart(rootPath, "1", "1", "thumbnail.part");
      const linked = spawnSync("/bin/ln", [
        join(rootPath, "derived", ".tmp", "1", "e1", "thumbnail.part"),
        join(rootPath, "derived", ".tmp", "1", "e1", "preview.part"),
      ]);
      expect(linked.status).toBe(0);
      expect(
        lstatSync(
          join(rootPath, "derived", ".tmp", "1", "e1", "thumbnail.part"),
        ).nlink,
      ).toBeGreaterThan(1);
      await withGate(rootPath, (gate) => {
        expect(gate.snapshotLocked().derivedInventoryComplete).toBe(false);
      });
    } finally {
      rmSync(rootPath, { recursive: true, force: true });
    }
  });

  it("fails closed for an extended ACL", async () => {
    const rootPath = mkdtempSync(join(realpathSync(tmpdir()), "ps4d3b0-"));
    try {
      knownPart(rootPath, "42", "1", "thumbnail.part");
      const file = join(
        rootPath,
        "derived",
        ".tmp",
        "42",
        "e1",
        "thumbnail.part",
      );
      const granted = spawnSync("/bin/chmod", ["+a", "staff allow read", file]);
      expect(granted.status).toBe(0);
      await withGate(rootPath, (gate) => {
        expect(gate.snapshotLocked().derivedInventoryComplete).toBe(false);
        expect(gate.derivedInventoryPage("").outcome).toBe("incomplete");
      });
    } finally {
      rmSync(rootPath, { recursive: true, force: true });
    }
  });

  it("fails closed when a later page contains an unsafe name", async () => {
    const rootPath = mkdtempSync(join(realpathSync(tmpdir()), "ps4d3b0-"));
    try {
      for (let job = 1; job <= 60; job += 1) {
        knownPart(rootPath, String(job), "1", "thumbnail.part");
      }
      privateDirectory(join(rootPath, "derived", ".tmp", "zz"));
      await withGate(rootPath, (gate) => {
        const first = gate.derivedInventoryPage("");
        expect(first.outcome).toBe("continue");
        expect(first.observations.length).toBeGreaterThan(0);
        const later = gate.derivedInventoryPage(first.nextCursor);
        expect(later.outcome).toBe("incomplete");
        expect(gate.snapshotLocked().derivedInventoryComplete).toBe(false);
      });
    } finally {
      rmSync(rootPath, { recursive: true, force: true });
    }
  });

  it("fails closed when a parent directory is replaced between pages", async () => {
    const rootPath = mkdtempSync(join(realpathSync(tmpdir()), "ps4d3b0-"));
    try {
      for (let job = 1; job <= 60; job += 1) {
        knownPart(rootPath, String(job), "1", "thumbnail.part");
      }
      await withGate(rootPath, (gate) => {
        const first = gate.derivedInventoryPage("");
        expect(first.outcome).toBe("continue");
        renameSync(join(rootPath, "derived"), join(rootPath, "derived.old"));
        privateDirectory(join(rootPath, "derived"));
        const second = gate.derivedInventoryPage(first.nextCursor);
        expect(second.outcome).toBe("incomplete");
        expect(second.observations).toEqual([]);
      });
    } finally {
      rmSync(rootPath, { recursive: true, force: true });
    }
  });

  it("fails closed when another process mutates the namespace during the scan", async () => {
    const rootPath = mkdtempSync(join(realpathSync(tmpdir()), "ps4d3b0-"));
    try {
      for (let job = 1; job <= 80; job += 1) {
        knownPart(rootPath, String(job), "1", "thumbnail.part");
      }
      const target = join(rootPath, "derived", ".tmp");
      const child = spawn(
        process.execPath,
        [
          "-e",
          "const fs=require('node:fs'); const target=process.argv[1]; const until=Date.now()+5000; while (Date.now()<until) { try { fs.utimesSync(target, new Date(), new Date()); } catch {} }",
          target,
        ],
        { stdio: "ignore" },
      );
      let sawIncomplete = false;
      try {
        for (let attempt = 0; attempt < 10 && !sawIncomplete; attempt += 1) {
          await withGate(rootPath, (gate) => {
            const page = gate.derivedInventoryPage("");
            if (
              page.outcome === "incomplete" ||
              gate.snapshotLocked().derivedInventoryComplete === false
            ) {
              sawIncomplete = true;
            }
          });
        }
      } finally {
        child.kill();
      }
      expect(sawIncomplete).toBe(true);
    } finally {
      rmSync(rootPath, { recursive: true, force: true });
    }
  }, 30_000);

  it("fails closed when another process replaces the temp namespace between pages", async () => {
    const rootPath = mkdtempSync(join(realpathSync(tmpdir()), "ps4d3b0-"));
    try {
      for (let job = 1; job <= 60; job += 1) {
        knownPart(rootPath, String(job), "1", "thumbnail.part");
      }
      await withGate(rootPath, (gate) => {
        const first = gate.derivedInventoryPage("");
        expect(first.outcome).toBe("continue");
        const moved = join(rootPath, "derived", ".tmp.moved");
        const replaced = spawnSync("/bin/mv", [
          join(rootPath, "derived", ".tmp"),
          moved,
        ]);
        expect(replaced.status).toBe(0);
        privateDirectory(join(rootPath, "derived", ".tmp"));
        const second = gate.derivedInventoryPage(first.nextCursor);
        expect(second.outcome).toBe("incomplete");
      });
    } finally {
      rmSync(rootPath, { recursive: true, force: true });
    }
  });
});
