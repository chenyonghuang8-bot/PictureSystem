import {
  chmodSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { OperationGate, type OperationLock } from "./operation-gate.js";

import {
  StorageRoot,
  OriginalReader,
  runApprovedOriginalProbe,
  renderUnverifiedCandidate,
} from "./index.js";
import { syntheticGpsJpeg } from "../../../tests/fixtures/location-jpeg.js";

const roots: string[] = [],
  locks: OperationLock[] = [];
afterEach(() => {
  for (const lock of locks.splice(0)) lock.close();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const path = mkdtempSync(join(realpathSync(tmpdir()), "phase11-control-"));
  chmodSync(path, 0o700);
  roots.push(path);
  const namespace = { path, deploymentId: randomUUID() };
  return { path, namespace, gate: OperationGate.provisionDev(namespace) };
}
async function hold(gate: OperationGate, mode: "S" | "X") {
  const l = await gate.acquire(mode, 0);
  locks.push(l);
  return l;
}
describe("dedicated native deployment OperationGate", () => {
  it("requires a live exact run coordinator and never substitutes kernel busy for identity", async () => {
    const { gate, path } = fixture();
    const r = await gate.acquireRun();
    locks.push(r);
    const owner = r.registerRunOwner(randomUUID());
    expect(gate.verifyRunOwner(owner)).toBe(true);
    expect(gate.verifyRunOwner({ ...owner, processId: randomUUID() })).toBe(
      false,
    );
    expect(
      gate.verifyRunOwner({
        ...owner,
        startSec: String(BigInt(owner.startSec) + 1n),
      }),
    ).toBe(false);
    expect(gate.runIdentity()).not.toBe((await hold(gate, "S")).identity());
    await expect(gate.acquireRun()).rejects.toThrow("OPERATION_GATE_BUSY");
    r.close();
    expect(gate.verifyRunOwner(owner)).toBe(false);
    unlinkSync(join(path, "run.lock"));
    expect(() => gate.runIdentity()).toThrow();
  });
  it("bridges real metadata and renderer launches until the entire admitted unit settles", async () => {
    const { gate, path } = fixture();
    const mediaRoot = join(path + "-media");
    roots.push(mediaRoot);
    // Media namespace is separate from control namespace; the latter is not scanned recursively.
    const root = StorageRoot.open(mediaRoot, { initialize: true });
    const bytes = syntheticGpsJpeg();
    const identity = {
      familyId: "1",
      sha256Hex: createHash("sha256").update(bytes).digest("hex"),
      byteSize: String(bytes.length),
    };
    root.createUploadPayload("1", "a".repeat(32), bytes);
    root.publishOriginal({ ...identity, uploadId: "a".repeat(32) });
    const reader = OriginalReader.open({
      mediaRoot,
      expectedMarkerId: root.markerId,
    });
    const s = await hold(gate, "S");
    try {
      await s.run(async () => {
        await reader.withVerifiedOriginal(identity, (h) =>
          runApprovedOriginalProbe(h, "capabilities"),
        );
        const candidate = await reader.withVerifiedOriginal(identity, (h) =>
          renderUnverifiedCandidate(h, "THUMBNAIL"),
        );
        expect(candidate.bytes.length).toBeGreaterThan(0);
        expect(
          readdirSync(path).filter((n) => n.startsWith("bridge.")),
        ).toHaveLength(2);
        await expect(gate.acquire("X", 0)).rejects.toThrow(
          "OPERATION_GATE_BUSY",
        );
      });
      s.close();
      const x = await hold(gate, "X");
      expect(x.drained).toBe(true);
      x.recoverBridges();
      expect(
        readdirSync(path).filter((n) => n.startsWith("bridge.")),
      ).toHaveLength(0);
    } finally {
      reader.close();
      root.close();
    }
  });
  it("persists monotone protection and clears only exact marker under X plus latch", async () => {
    const { gate } = fixture();
    const s = await hold(gate, "S");
    const l = await gate.acquireLatch(0);
    locks.push(l);
    const first = l.latchDeny("DB_UNAVAILABLE");
    expect(s.readDeny()).toEqual(first);
    expect(l.latchDeny("STORAGE_UNAVAILABLE")).toEqual(first);
    expect(() => s.clearDenyWith(l, first.token)).toThrow(
      "Fenced recovery is required",
    );
    s.close();
    const x = await hold(gate, "X");
    expect(() => x.clearDenyWith(l, "0".repeat(64))).toThrow(
      "Protection changed during recovery",
    );
    expect(x.readDeny()).toEqual(first);
    x.clearDenyWith(l, first.token);
    expect(x.readDeny()).toBeNull();
  });
  it("refuses malformed persisted marker without treating it as absent", async () => {
    const { gate, path } = fixture();
    writeFileSync(join(path, "deny"), "not-a-marker", { mode: 0o600 });
    const s = await hold(gate, "S");
    expect(() => s.readDeny()).toThrow("Durable protection is unavailable");
  });
  it("allows concurrent S permits but never X before all units settle", async () => {
    const { gate } = fixture();
    const a = await hold(gate, "S"),
      b = await hold(gate, "S");
    await expect(gate.acquire("X", 0)).rejects.toThrow("OPERATION_GATE_BUSY");
    a.close();
    await expect(gate.acquire("X", 0)).rejects.toThrow("OPERATION_GATE_BUSY");
    b.close();
    const x = await hold(gate, "X");
    expect(x.identity()).toMatch(/^[a-f0-9]{64}$/u);
    await expect(gate.acquire("S", 0)).rejects.toThrow("OPERATION_GATE_BUSY");
    x.close();
    await hold(gate, "S");
  });
  it("uses a separate latch and fails closed on lock replacement", async () => {
    const { gate, path } = fixture();
    const s = await hold(gate, "S");
    const latch = await gate.acquireLatch(0);
    locks.push(latch);
    renameSync(join(path, "operation.lock"), join(path, "old.lock"));
    writeFileSync(join(path, "operation.lock"), "", { mode: 0o600 });
    expect(() => s.identity()).toThrow("Control identity changed");
  });
  it("does not create missing identity or lock files during admission", async () => {
    const { gate, path } = fixture();
    unlinkSync(join(path, "operation.lock"));
    await expect(gate.acquire("S", 0)).rejects.toThrow(
      "Control lock is unavailable",
    );
    unlinkSync(join(path, "identity"));
    await expect(gate.acquire("X", 0)).rejects.toThrow(
      "Control namespace is unavailable",
    );
  });
  it("binds deployment identity and rejects writable namespace", async () => {
    const { gate, path, namespace } = fixture();
    await expect(
      new OperationGate({ ...namespace, deploymentId: randomUUID() }).acquire(
        "S",
        0,
      ),
    ).rejects.toThrow("Control namespace is unavailable");
    chmodSync(path, 0o755);
    await expect(gate.acquire("S", 0)).rejects.toThrow(
      "Control namespace is unavailable",
    );
  });
});
