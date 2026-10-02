import {
  appendFileSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import { StorageRoot } from "./index.js";
import { ContentCoordination } from "./phase7-coordination.js";

const sha = "b".repeat(64);
const addon = join(import.meta.dirname, "../build/storage_native.node");
const require = createRequire(import.meta.url);

async function child(root: StorageRoot, stay: boolean) {
  const script = `
    const n=require(${JSON.stringify(addon)});
    const h=n.openCoordination(process.argv[1],process.argv[2],"1",${JSON.stringify(sha)},"5","R");
    if(!n.tryAcquireCoordination(h,"S"))process.exit(2);
    const rec=n.createHandoff(h);
    n.releaseCoordination(h); n.closeCoordination(h); n.closeHandoff(rec);
    process.stdout.write("READY\\n");
    if(${stay}) process.stdin.resume();
  `;
  const processHandle = spawn(
    process.execPath,
    ["-e", script, root.canonicalPath, root.markerId],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let output = "";
  processHandle.stdout.on("data", (bytes) => {
    output += String(bytes);
  });
  await Promise.race([
    new Promise<void>((resolve, reject) => {
      const timer = setInterval(() => {
        if (output.includes("READY")) {
          clearInterval(timer);
          resolve();
        }
        if (processHandle.exitCode !== null) {
          clearInterval(timer);
          reject(new Error("HANDOFF_CHILD_FAILED"));
        }
      }, 5);
    }),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("HANDOFF_CHILD_TIMEOUT")), 3000),
    ),
  ]);
  return processHandle;
}

describe("durable Phase 7 handoff ledger", () => {
  it("rejects cross-K Originals without sending an FD, then sends the registered K through SCM_RIGHTS", async () => {
    const dir = mkdtempSync(join(realpathSync(tmpdir()), "phase7-fd-"));
    const root = StorageRoot.open(dir, { initialize: true });
    const payload = Buffer.from("synthetic Phase 7A handoff bytes");
    const digest = createHash("sha256").update(payload).digest("hex");
    const uploadId = "1".repeat(32);
    root.createUploadPayload("1", uploadId, payload);
    root.publishOriginal({
      familyId: "1",
      uploadId,
      sha256Hex: digest,
      byteSize: String(payload.length),
    });
    const otherPayload = Buffer.from(payload);
    otherPayload[0] = otherPayload[0]! ^ 0xff;
    const otherDigest = createHash("sha256").update(otherPayload).digest("hex");
    root.createUploadPayload("1", "2".repeat(32), otherPayload);
    root.publishOriginal({
      familyId: "1",
      uploadId: "2".repeat(32),
      sha256Hex: otherDigest,
      byteSize: String(otherPayload.length),
    });
    // Same SHA and size in another family must still be a different K.
    root.createUploadPayload("2", "3".repeat(32), payload);
    root.publishOriginal({
      familyId: "2",
      uploadId: "3".repeat(32),
      sha256Hex: digest,
      byteSize: String(payload.length),
    });
    const native = require(addon) as {
      openOriginalReader: (path: string, marker: string) => { handle: object };
      openVerifiedOriginal: (
        reader: object,
        family: string,
        sha: string,
        size: string,
      ) => object;
      closeOriginalHandle: (handle: object) => void;
      closeOriginalReader: (reader: object) => void;
      openCoordination: (...args: string[]) => object;
      tryAcquireCoordination: (handle: object, mode: string) => boolean;
      releaseCoordination: (handle: object) => void;
      closeCoordination: (handle: object) => void;
      createHandoff: (read: object) => object;
      registerHandoffReceiver: (record: object, pid: number) => void;
      sendRegisteredOriginal: (
        record: object,
        original: object,
        socketFd: number,
      ) => void;
      closeHandoff: (record: object) => void;
    };
    const reader = native.openOriginalReader(
      root.canonicalPath,
      root.markerId,
    ).handle;
    const original = native.openVerifiedOriginal(
      reader,
      "1",
      digest,
      String(payload.length),
    );
    const otherOriginal = native.openVerifiedOriginal(
      reader,
      "1",
      otherDigest,
      String(otherPayload.length),
    );
    const otherFamilyOriginal = native.openVerifiedOriginal(
      reader,
      "2",
      digest,
      String(payload.length),
    );
    const read = native.openCoordination(
      root.canonicalPath,
      root.markerId,
      "1",
      digest,
      String(payload.length),
      "R",
    );
    const socketPath = join(dir, "handoff-test.sock");
    const server = createServer();
    server.listen(socketPath);
    await once(server, "listening");
    const childCode = `import socket,sys,array,os,select
s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
s.connect(sys.argv[1])
assert sys.stdin.readline().strip()=='CHECK'
assert not select.select([s],[],[],0)[0], 'mismatched send queued media or an FD'
print('NO_FD',flush=True)
_,anc,_,_=s.recvmsg(1,socket.CMSG_SPACE(array.array('i').itemsize))
fds=array.array('i')
for level,kind,data in anc:
    if level==socket.SOL_SOCKET and kind==socket.SCM_RIGHTS: fds.frombytes(data[:fds.itemsize])
assert len(fds)==1
assert os.read(fds[0],100)==b'synthetic Phase 7A handoff bytes'
os.close(fds[0])
print('OK',flush=True)
`;
    const childProcess = spawn(
      "/usr/bin/python3",
      ["-c", childCode, socketPath],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    const [socket] = await once(server, "connection");
    const socketFd = (socket as { _handle?: { fd: number } })._handle?.fd;
    expect(typeof socketFd).toBe("number");
    let record: object | undefined;
    try {
      expect(native.tryAcquireCoordination(read, "S")).toBe(true);
      record = native.createHandoff(read);
      expect(() =>
        native.sendRegisteredOriginal(record!, original, socketFd!),
      ).toThrow();
      native.registerHandoffReceiver(record, childProcess.pid!);
      for (const mismatch of [otherOriginal, otherFamilyOriginal]) {
        let failure: unknown;
        try {
          native.sendRegisteredOriginal(record, mismatch, socketFd!);
        } catch (error) {
          failure = error;
        }
        expect(failure).toMatchObject({ code: "HANDOFF_CONTENT_MISMATCH" });
      }
      const noFd = once(childProcess.stdout, "data");
      childProcess.stdin.write("CHECK\n");
      expect(String((await noFd)[0]).trim()).toBe("NO_FD");
      const output = once(childProcess.stdout, "data");
      native.sendRegisteredOriginal(record, original, socketFd!);
      expect(String((await output)[0]).trim()).toBe("OK");
      await once(childProcess, "exit");
    } finally {
      if (record) native.closeHandoff(record);
      native.releaseCoordination(read);
      native.closeCoordination(read);
      native.closeOriginalHandle(original);
      native.closeOriginalHandle(otherOriginal);
      native.closeOriginalHandle(otherFamilyOriginal);
      native.closeOriginalReader(reader);
      socket.destroy();
      server.close();
      childProcess.kill();
      root.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("treats a reused PID with a different process start as the old holder gone", () => {
    const testNative = require(
      join(import.meta.dirname, "../build/storage_native_test.node"),
    ) as {
      phase7TestExactProcessIdentity: (
        recordSec: number,
        recordUsec: number,
        currentSec: number,
        currentUsec: number,
      ) => boolean;
    };
    expect(testNative.phase7TestExactProcessIdentity(100, 10, 100, 10)).toBe(
      true,
    );
    expect(testNative.phase7TestExactProcessIdentity(100, 10, 100, 11)).toBe(
      false,
    );
    expect(testNative.phase7TestExactProcessIdentity(100, 10, 101, 10)).toBe(
      false,
    );
  });

  it("requires durable receiver registration before the transfer entry point", async () => {
    const dir = mkdtempSync(join(realpathSync(tmpdir()), "phase7-register-"));
    const root = StorageRoot.open(dir, { initialize: true });
    const native = require(addon) as {
      openCoordination: (...args: string[]) => object;
      tryAcquireCoordination: (handle: object, mode: string) => boolean;
      createHandoff: (handle: object) => object;
      requireRegisteredHandoff: (handle: object) => boolean;
      registerHandoffReceiver: (handle: object, pid: number) => void;
      closeHandoff: (handle: object) => void;
      releaseCoordination: (handle: object) => void;
      closeCoordination: (handle: object) => void;
    };
    const read = native.openCoordination(
      root.canonicalPath,
      root.markerId,
      "1",
      sha,
      "5",
      "R",
    );
    const childProcess = spawn(
      process.execPath,
      ["-e", "process.stdin.resume()"],
      { stdio: ["pipe", "ignore", "ignore"] },
    );
    try {
      expect(native.tryAcquireCoordination(read, "S")).toBe(true);
      const record = native.createHandoff(read);
      try {
        expect(() => native.requireRegisteredHandoff(record)).toThrow();
        native.registerHandoffReceiver(record, childProcess.pid!);
        expect(native.requireRegisteredHandoff(record)).toBe(true);
      } finally {
        native.closeHandoff(record);
      }
      native.releaseCoordination(read);
    } finally {
      native.closeCoordination(read);
      childProcess.stdin.end();
      await once(childProcess, "exit");
      root.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails R-exclusive closed for live unresolved holder and recovers exact dead identity", async () => {
    const dir = mkdtempSync(join(realpathSync(tmpdir()), "phase7-handoff-"));
    const root = StorageRoot.open(dir, { initialize: true });
    let processHandle: Awaited<ReturnType<typeof child>> | undefined;
    try {
      processHandle = await child(root, true);
      const content = new ContentCoordination(root, {
        familyId: "1",
        sha256Hex: sha,
        byteSize: "5",
      });
      const life = await content.acquireLifecycle("X", 0);
      await expect(content.acquireRead(life, "X", 0)).rejects.toThrow(
        "COORD_ACQUIRE_TIMEOUT",
      );
      processHandle.stdin.end();
      await once(processHandle, "exit");
      const exclusive = await content.acquireRead(life, "X", 0);
      exclusive.close();
      const ledger = join(
        dir,
        ".coord",
        "v1",
        readdirSync(join(dir, ".coord", "v1")).find((name) =>
          name.endsWith(".h"),
        )!,
      );
      const record = readdirSync(ledger).find((name) => name.endsWith(".rec"))!;
      appendFileSync(join(ledger, record), Buffer.from([0]));
      await expect(content.acquireRead(life, "X", 0)).rejects.toThrow();
      life.close();
    } finally {
      processHandle?.kill();
      root.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
