import { freshStorageRootPath } from "../../../tests/fixtures/fresh-storage-root.js";
import {
  appendFileSync,
  rmSync,
  readdirSync,
  openSync,
  closeSync,
  renameSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { createInterface } from "node:readline";
import type { Duplex } from "node:stream";
import { setImmediate as nextTurn } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { StorageRoot } from "./index.js";
import { ContentCoordination } from "./phase7-coordination.js";

const sha = "b".repeat(64);
const addon = join(import.meta.dirname, "../build/storage_native.node");
const require = createRequire(import.meta.url);

const coordinatorScript = `
const {spawn}=require('node:child_process');
const {createInterface}=require('node:readline');
const n=require(${JSON.stringify(join(import.meta.dirname, "../build/storage_native_test.node"))});
const build=${JSON.stringify(join(import.meta.dirname, "../build"))};
const profile=${JSON.stringify(join(import.meta.dirname, "../native/original-probe.sb"))};
const [root,marker,sha,size,holdSettlement]=process.argv.slice(1);
const r=n.openCoordination(root,marker,'1',sha,size,'R');
if(!n.tryAcquireCoordination(r,'S'))throw Error('R');
let held=true;
const launch=n.createRegisteredLaunch(r);
const reader=n.openOriginalReader(root,marker).handle;
const original=n.openVerifiedOriginal(reader,'1',sha,size);
const sup=spawn(build+'/original_probe_supervisor_phase7_test',
 [profile,build+'/original_probe_child_phase7_test','/','/','phase7-hold','30000'],
 {stdio:['ignore','pipe','pipe',launch.childFd,'pipe','ignore',6],env:{PATH:'/usr/bin:/bin',LANG:'C',...(holdSettlement==='yes'?{PS_P7_HOLD_SETTLEMENT:'1'}:{})}});
const send=(event,extra={})=>process.stdout.write(JSON.stringify({event,...extra})+'\\n');
let trace='';sup.stderr.on('data',b=>trace+=String(b));
sup.stdio[4].on('data',b=>{if(String(b)==='REAPED\\n')send('REAPED');});
sup.once('close',(code,signal)=>send('SUP_CLOSED',{code,signal,reaps:trace.split('WAITPID_REAPED').length-1}));
try {n.transferRegisteredOriginal(launch.handle,original);throw Error('PREARM_TRANSFER');}
catch(error){if(error.message==='PREARM_TRANSFER')throw error;send('PREARM_DENIED');}
n.registerLaunchSupervisor(launch.handle,sup.pid);
const arm=()=>{
 if(n.pollRegisteredLaunch(launch.handle))send('ARMED',n.phase7TestLaunchSnapshot(launch.handle));
 else setImmediate(arm);
};arm();
createInterface({input:process.stdin}).on('line',line=>{
 if(line==='DENY_DELIVER'){try{n.transferRegisteredOriginal(launch.handle,original);throw Error('UNEXPECTED_TRANSFER');}catch(error){if(error.message==='UNEXPECTED_TRANSFER')throw error;send('TRANSFER_DENIED');}}
 if(line==='DENY_VERIFY'){try{n.verifyRegisteredSettlement(launch.handle);throw Error('UNEXPECTED_SETTLEMENT');}catch(error){if(error.message==='UNEXPECTED_SETTLEMENT')throw error;send('SETTLEMENT_DENIED');}}
 if(line==='DELIVER'){n.transferRegisteredOriginal(launch.handle,original);send('DELIVERED');}
 if(line==='DUPLICATE'){try{n.transferRegisteredOriginal(launch.handle,original);throw Error('DUPLICATE_TRANSFER');}catch(error){if(error.message==='DUPLICATE_TRANSFER')throw error;send('DUPLICATE_DENIED');}}
 if(line==='WITHHOLD'){n.phase7TestTransferNoRelease(launch.handle,original);send('WITHHELD');}
 if(line==='RELEASE_SOURCE'){n.phase7TestSourceReleased(launch.handle);send('RELEASED');}
 if(line==='DROP_R'){n.releaseCoordination(r);n.closeCoordination(r);held=false;send('R_DROPPED');}
 if(line==='KILL_SUP'){sup.kill('SIGKILL');}
 if(line==='SETTLE'){sup.stdio[4].write('S');}
 if(line==='VERIFY'){n.verifyRegisteredSettlement(launch.handle);send('SETTLED');}
 if(line==='EXIT'){
  n.closeOriginalHandle(original);n.closeOriginalReader(reader);n.closeRegisteredLaunch(launch.handle);
  if(held){n.releaseCoordination(r);n.closeCoordination(r);}process.exit(0);
 }
});
`;

function eventQueue(stream: NodeJS.ReadableStream) {
  const buffered: Record<string, unknown>[] = [];
  const waiting: Array<{
    event: string;
    resolve: (value: Record<string, unknown>) => void;
  }> = [];
  createInterface({ input: stream }).on("line", (line) => {
    const value = JSON.parse(line) as Record<string, unknown>;
    const i = waiting.findIndex((entry) => entry.event === value.event);
    if (i >= 0) waiting.splice(i, 1)[0]!.resolve(value);
    else buffered.push(value);
  });
  return (event: string) => {
    const i = buffered.findIndex((entry) => entry.event === event);
    if (i >= 0) return Promise.resolve(buffered.splice(i, 1)[0]!);
    return new Promise<Record<string, unknown>>((resolve) =>
      waiting.push({ event, resolve }),
    );
  };
}

async function registeredFixture(
  operation: (input: {
    processHandle: ReturnType<typeof spawn>;
    event: ReturnType<typeof eventQueue>;
    content: ContentCoordination;
    consumerChannel: NodeJS.ReadWriteStream;
    rootPath: string;
  }) => Promise<void>,
  holdSettlement = false,
) {
  const dir = freshStorageRootPath("phase7-registered-");
  const root = StorageRoot.open(dir, { initialize: true });
  const bytes = Buffer.from("registered synthetic Original");
  const digest = createHash("sha256").update(bytes).digest("hex");
  root.createUploadPayload("1", "4".repeat(32), bytes);
  root.publishOriginal({
    familyId: "1",
    uploadId: "4".repeat(32),
    sha256Hex: digest,
    byteSize: String(bytes.length),
  });
  const processHandle = spawn(
    process.execPath,
    [
      "-e",
      coordinatorScript,
      dir,
      root.markerId,
      digest,
      String(bytes.length),
      holdSettlement ? "yes" : "no",
    ],
    {
      stdio: ["pipe", "pipe", "pipe", "ignore", "ignore", "ignore", "pipe"],
    },
  );
  const closed = once(processHandle, "close");
  const event = eventQueue(processHandle.stdout!);
  const channel = (processHandle.stdio as Array<unknown>)[6] as Duplex;
  channel.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code !== "EPIPE") throw error;
  });
  const content = new ContentCoordination(root, {
    familyId: "1",
    sha256Hex: digest,
    byteSize: String(bytes.length),
  });
  try {
    await event("ARMED");
    await operation({
      processHandle,
      event,
      content,
      consumerChannel: channel,
      rootPath: dir,
    });
  } finally {
    if (!channel.destroyed) channel.write("E");
    if (processHandle.exitCode === null && processHandle.signalCode === null)
      processHandle.stdin!.write("SETTLE\nEXIT\n");
    await closed;
    root.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function waitForExclusive(content: ContentCoordination) {
  const life = await content.acquireLifecycle("X", 0);
  try {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      try {
        const read = await content.acquireRead(life, "X", 0);
        read.close();
        return;
      } catch (error) {
        if (
          !(error instanceof Error) ||
          error.message !== "COORD_ACQUIRE_TIMEOUT"
        )
          throw error;
      }
      await nextTurn();
    }
    throw new Error("EXACT_IDENTITIES_DID_NOT_SETTLE");
  } finally {
    life.close();
  }
}

describe("registered production supervisor ownership", () => {
  it.each(["v1", ".coord", "fence"])(
    "refuses a registered transfer after %s replacement with source R released",
    async (segment) => {
      await registeredFixture(
        async ({
          processHandle,
          event,
          content,
          consumerChannel,
          rootPath,
        }) => {
          processHandle.stdin!.write("DROP_R\n");
          await event("R_DROPPED");
          const target = join(
            rootPath,
            segment === "fence"
              ? ".storage-root.initializing"
              : segment === "v1"
                ? ".coord/v1"
                : ".coord",
          );
          const moved = `${target}-held`;
          const ledger = join(
            rootPath,
            ".coord/v1",
            readdirSync(join(rootPath, ".coord/v1")).find((name) =>
              name.endsWith(".h"),
            )!,
          );
          const record = join(
            ledger,
            readdirSync(ledger).find((name) => name.endsWith(".rec"))!,
          );
          const before = readFileSync(record);
          if (segment === "fence")
            writeFileSync(target, "FAMILY_ALBUM_INIT1\n", { mode: 0o600 });
          else {
            renameSync(target, moved);
            mkdirSync(target, { mode: 0o700 });
          }
          try {
            processHandle.stdin!.write("DENY_DELIVER\nDENY_VERIFY\n");
            await event("TRANSFER_DENIED");
            await event("SETTLEMENT_DENIED");
            await expect(
              content.acquireLifecycle("X", 0),
            ).rejects.toMatchObject({
              code:
                segment === "fence"
                  ? "COORD_ROOT_INVALID"
                  : "COORD_NAMESPACE_UNCERTAIN",
            });
            const movedRecord =
              segment === "fence" ? record : record.replace(target, moved);
            expect(readFileSync(movedRecord)).toEqual(before);
            expect((consumerChannel as Duplex).readableLength).toBe(0);
          } finally {
            rmSync(target, { recursive: true, force: true });
            if (segment !== "fence") renameSync(moved, target);
          }
          const live = once(consumerChannel, "data");
          processHandle.stdin!.write("DELIVER\n");
          expect(String((await live)[0])).toBe("LIVE\n");
          consumerChannel.write("E");
          await event("SUP_CLOSED");
          processHandle.stdin!.write("VERIFY\n");
          await event("SETTLED");
          await waitForExclusive(content);
        },
      );
    },
    10000,
  );

  it("preserves unresolved receiver ledger when namespace moves after real media transfer", async () => {
    await registeredFixture(
      async ({ processHandle, event, content, consumerChannel, rootPath }) => {
        const live = once(consumerChannel, "data");
        processHandle.stdin!.write("DELIVER\n");
        expect(String((await live)[0])).toBe("LIVE\n");
        processHandle.stdin!.write("DROP_R\n");
        await event("R_DROPPED");
        const target = join(rootPath, ".coord/v1"),
          moved = `${target}-held`;
        const ledger = join(
          target,
          readdirSync(target).find((name) => name.endsWith(".h"))!,
        );
        const record = join(
          ledger,
          readdirSync(ledger).find((name) => name.endsWith(".rec"))!,
        );
        const before = readFileSync(record);
        renameSync(target, moved);
        mkdirSync(target, { mode: 0o700 });
        try {
          await expect(content.acquireLifecycle("X", 0)).rejects.toMatchObject({
            code: "COORD_NAMESPACE_UNCERTAIN",
          });
          consumerChannel.write("E");
          expect(await event("SUP_CLOSED")).toMatchObject({ code: 79 });
          processHandle.stdin!.write("DENY_VERIFY\n");
          await event("SETTLEMENT_DENIED");
          expect(readFileSync(record.replace(target, moved))).toEqual(before);
        } finally {
          rmSync(target, { recursive: true, force: true });
          renameSync(moved, target);
        }
        const exited = once(processHandle, "close");
        processHandle.stdin!.write("EXIT\n");
        await exited;
        await waitForExclusive(content);
      },
    );
  }, 10000);

  it("rejects inherited-media launch in every production metadata/renderer supervisor", () => {
    const fd = openSync("/dev/null", "r"),
      build = join(import.meta.dirname, "../build");
    try {
      const metadata = spawnSync(
        join(build, "original_probe_supervisor"),
        [
          join(import.meta.dirname, "../native/original-probe.sb"),
          join(build, "original_probe_child"),
          "/",
          "/",
          "capabilities",
          "1000",
        ],
        { stdio: ["ignore", "pipe", "pipe", fd, "pipe"] },
      );
      expect(metadata.status).toBe(64);
      for (const kind of ["thumbnail", "preview"]) {
        const renderer = spawnSync(
          join(build, `image_renderer_${kind}_supervisor`),
          [],
          { stdio: ["ignore", "pipe", "pipe", fd, "pipe", "pipe"] },
        );
        expect(renderer.status).toBe(64);
      }
    } finally {
      closeSync(fd);
    }
  });
  it("rejects wrong handoff/K/role, extra SCM_RIGHTS descriptors and truncated control messages", () => {
    const result = spawnSync(
      join(
        import.meta.dirname,
        "../build/registered_protocol_harness_phase7_test",
      ),
      [],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("PROTOCOL_FAULTS_REJECTED\n");
  });
  it("keeps R-X blocked after exact consumer reap until durable settlement completes", async () => {
    await registeredFixture(
      async ({ processHandle, event, content, consumerChannel }) => {
        const live = once(consumerChannel, "data");
        processHandle.stdin!.write("DELIVER\n");
        await live;
        consumerChannel.write("E");
        await event("REAPED");
        processHandle.stdin!.write("DROP_R\n");
        await event("R_DROPPED");
        const life = await content.acquireLifecycle("X", 0);
        try {
          await expect(content.acquireRead(life, "X", 0)).rejects.toThrow(
            "COORD_ACQUIRE_TIMEOUT",
          );
        } finally {
          life.close();
        }
        processHandle.stdin!.write("SETTLE\n");
        await event("SUP_CLOSED");
        processHandle.stdin!.write("VERIFY\n");
        await event("SETTLED");
        await waitForExclusive(content);
      },
      true,
    );
  }, 10000);
  it("uses two real transfers and supervisor exact reap, then permits R-X after libuv reaps the supervisor", async () => {
    await registeredFixture(
      async ({ processHandle, event, content, consumerChannel }) => {
        await event("PREARM_DENIED");
        const live = once(consumerChannel, "data");
        processHandle.stdin!.write("DELIVER\n");
        expect(String((await live)[0])).toBe("LIVE\n");
        processHandle.stdin!.write("DUPLICATE\n");
        await event("DUPLICATE_DENIED");
        consumerChannel.write("E");
        expect(await event("SUP_CLOSED")).toMatchObject({
          code: 0,
          signal: null,
          reaps: 1,
        });
        processHandle.stdin!.write("VERIFY\n");
        await event("SETTLED");
        processHandle.stdin!.write("DROP_R\n");
        await event("R_DROPPED");
        await waitForExclusive(content);
      },
    );
  }, 10000);

  it("does not settle or forward before SOURCE_RELEASED", async () => {
    await registeredFixture(
      async ({ processHandle, event, content, consumerChannel }) => {
        processHandle.stdin!.write("WITHHOLD\n");
        await event("WITHHELD");
        processHandle.stdin!.write("DROP_R\n");
        await event("R_DROPPED");
        const life = await content.acquireLifecycle("X", 0);
        try {
          await expect(content.acquireRead(life, "X", 0)).rejects.toThrow(
            "COORD_ACQUIRE_TIMEOUT",
          );
        } finally {
          life.close();
        }
        const live = once(consumerChannel, "data");
        processHandle.stdin!.write("RELEASE_SOURCE\n");
        await event("RELEASED");
        expect(String((await live)[0])).toBe("LIVE\n");
        consumerChannel.write("E");
        await event("SUP_CLOSED");
        processHandle.stdin!.write("VERIFY\n");
        await event("SETTLED");
        await waitForExclusive(content);
      },
    );
  }, 10000);

  it.each(["node", "supervisor-and-node"])(
    "keeps a live consumer recorded after %s crashes, then recovers only after its exact identity disappears",
    async (mode) => {
      await registeredFixture(
        async ({ processHandle, event, content, consumerChannel }) => {
          const live = once(consumerChannel, "data");
          processHandle.stdin!.write("DELIVER\n");
          expect(String((await live)[0])).toBe("LIVE\n");
          if (mode === "supervisor-and-node") {
            processHandle.stdin!.write("DROP_R\n");
            await event("R_DROPPED");
            processHandle.stdin!.write("KILL_SUP\n");
            await event("SUP_CLOSED");
            const life = await content.acquireLifecycle("X", 0);
            try {
              await expect(content.acquireRead(life, "X", 0)).rejects.toThrow(
                "COORD_ACQUIRE_TIMEOUT",
              );
            } finally {
              life.close();
            }
          }
          const exited = once(processHandle, "exit");
          processHandle.kill("SIGKILL");
          await exited;
          const life = await content.acquireLifecycle("X", 0);
          try {
            await expect(content.acquireRead(life, "X", 0)).rejects.toThrow(
              "COORD_ACQUIRE_TIMEOUT",
            );
          } finally {
            life.close();
          }
          consumerChannel.write("E");
          await waitForExclusive(content);
        },
      );
    },
    10000,
  );
});

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
    const dir = freshStorageRootPath("phase7-fd-");
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
    const dir = freshStorageRootPath("phase7-register-");
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
    const dir = freshStorageRootPath("phase7-handoff-");
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
