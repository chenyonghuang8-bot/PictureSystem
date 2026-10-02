import { createRequire } from "node:module";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync, spawn } from "node:child_process";
import {
  chmodSync,
  closeSync,
  readdirSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { freshStorageRootPath } from "../../../tests/fixtures/fresh-storage-root.js";
import { StorageRoot, DerivedStore } from "./index.js";
import { ContentCoordination } from "./phase7-coordination.js";
import { PurgeFilesNative } from "./purge-files.js";
import { PurgeDerivedNative } from "./purge-derived.js";

type Root = {
  handle: object;
  canonicalPath: string;
  markerId: string;
  device: string;
};
type Native = {
  openRoot(path: string, initialize: boolean): Root;
  closeRoot(handle: object): void;
  openCoordination(...args: string[]): object;
  tryAcquireCoordination(handle: object, mode: string): boolean;
  releaseCoordination(handle: object): void;
  closeCoordination(handle: object): void;
  phase7TestMarkerParse(bytes: Buffer): boolean;
  phase7TestLegacyMarkerParse(bytes: Buffer): boolean;
  phase7TestNamespaceBinding(expected: bigint[], actual: bigint[]): boolean;
  phase7TestDirectoryProperties(properties: bigint[]): boolean;
  phase7TestInitBoundaries(): string[];
  phase7TestInitBoundary(
    name: string,
    action: string,
    notify: number,
    control: number,
  ): void;
  phase7TestPreInit1MarkerParse(bytes: Buffer): boolean;
  phase7TestRootLock(path: string, mode: string): number | false;
  phase7TestFenceStatError(enabled: boolean): void;
  createHandoff(handle: object): object;
  closeHandoff(handle: object): void;
  registerHandoffReceiver(handle: object, pid: number): void;
  openOriginalReader(path: string, marker: string): { handle: object };
  closeOriginalReader(handle: object): void;
};
const require = createRequire(import.meta.url);
const addon = resolve(import.meta.dirname, "../build/storage_native.node");
const native = require(addon) as Native;
const testNative = require(
  resolve(import.meta.dirname, "../build/storage_native_test.node"),
) as Native;
const digest = "a".repeat(64);
function openRead(root: Root, kind = "R") {
  return native.openCoordination(
    root.canonicalPath,
    root.markerId,
    "1",
    digest,
    "5",
    kind,
  );
}
function child(root: Root, mode = "X") {
  const result = spawnSync(
    process.execPath,
    [
      "-e",
      `
    const n=require(process.argv[1]);let h;
    try {h=n.openCoordination(process.argv[2],process.argv[3],'1',${JSON.stringify(digest)},'5','R');
      const ok=n.tryAcquireCoordination(h,process.argv[4]);
      if(ok)n.releaseCoordination(h);n.closeCoordination(h);
      process.stdout.write(JSON.stringify({acquired:ok}));
    } catch(e) {if(h)try{n.closeCoordination(h)}catch{};process.stdout.write(JSON.stringify({refused:true,code:e.code}));}
  `,
      addon,
      root.canonicalPath,
      root.markerId,
      mode,
    ],
    { encoding: "utf8" },
  );
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout) as {
    acquired?: boolean;
    refused?: boolean;
    code?: string;
  };
}

describe("Phase 7 persistent V2 coordination namespace", () => {
  it("strictly parses V1/V2, rejects malformed encodings, overflow and trailing data", () => {
    const valid = `FAMILY_ALBUM_STORAGE_V2:${"a".repeat(32)}:1:2:1:3:0:0:1:4:0:999999999:INIT1\n`;
    expect(testNative.phase7TestMarkerParse(Buffer.from(valid))).toBe(true);
    expect(
      testNative.phase7TestMarkerParse(
        Buffer.from(`FAMILY_ALBUM_STORAGE_V1:${"a".repeat(32)}\n`),
      ),
    ).toBe(true);
    const invalid = [
      valid.replace(":INIT1", ""),
      valid.replace(":INIT1", ":INIT2"),
      valid.replace(":INIT1", ":init1"),
      valid.replace(":INIT1", ":INIT1:INIT1"),
      valid.slice(0, -1),
      `${valid}x`,
      `${valid}\n`,
      valid.replace("V2", "V3"),
      valid.replace("a", "A"),
      valid.replace(":1:2:", ":01:2:"),
      valid.replace(":1:2:", ":0:2:"),
      valid.replace(":1:2:", ":1:0:"),
      valid.replace(":1:3:", ":1:0:"),
      valid.replace(":1:4:", ":1:0:"),
      valid.replace(":999999999", ":1000000000"),
      valid.replace(":1:2:", ":18446744073709551616:2:"),
      valid.replace(":3:0:0:", ":3:9223372036854775808:0:"),
      valid.replace(":3:0:0:", ":3:-1:0:"),
      valid.replace(":1:4:", ":1::"),
      valid.replace("\n", ":0\n"),
      valid.replace("\n", "\r\n"),
      `${valid}\0`,
      "x".repeat(513),
    ];
    for (const bytes of invalid)
      expect(testNative.phase7TestMarkerParse(Buffer.from(bytes))).toBe(false);
  });

  it("checks each dev/inode/birthtime field including inode ABA, owner/group/mode", () => {
    const expected = [1n, 2n, 3n, 4n];
    expect(testNative.phase7TestNamespaceBinding(expected, expected)).toBe(
      true,
    );
    for (let i = 0; i < 4; i++) {
      const actual = [...expected];
      actual[i] = actual[i]! + 1n;
      expect(testNative.phase7TestNamespaceBinding(expected, actual)).toBe(
        false,
      );
    }
    const properties = [
      BigInt(process.getuid!()),
      BigInt(process.getgid!()),
      0o40700n,
    ];
    expect(testNative.phase7TestDirectoryProperties(properties)).toBe(true);
    for (let i = 0; i < 3; i++) {
      const changed = [...properties];
      changed[i] = changed[i]! + 1n;
      expect(testNative.phase7TestDirectoryProperties(changed)).toBe(false);
    }
  });

  it("initializes only a nonexistent final root, not an existing empty directory", () => {
    const path = freshStorageRootPath("f1-fresh-");
    mkdirSync(path, { mode: 0o700 });
    try {
      expect(() => native.openRoot(path, true)).toThrow();
      expect(existsSync(join(path, ".storage-root"))).toBe(false);
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  });

  it("gives at most one successful capability to concurrent fresh initializers", () => {
    const path = freshStorageRootPath("f1-race-");
    const result = spawnSync(
      process.execPath,
      [
        "-e",
        `
      const {Worker}=require('node:worker_threads');
      const source=\`const {parentPort,workerData}=require('node:worker_threads');
        const n=require(workerData.addon);parentPort.on('message',()=>{let r;
          try{r=n.openRoot(workerData.path,true);parentPort.postMessage(true);}
          catch{parentPort.postMessage(false);}finally{if(r)n.closeRoot(r.handle);}});parentPort.postMessage('ready');\`;
      const workers=[0,1].map(()=>new Worker(source,{eval:true,workerData:{addon:process.argv[1],path:process.argv[2]}}));
      let ready=0,finished=0,success=0;
      for(const w of workers)w.on('message',m=>{if(m==='ready'){if(++ready===2)workers.forEach(x=>x.postMessage('go'));}
        else{success+=m?1:0;if(++finished===2){process.stdout.write(String(success));workers.forEach(x=>x.terminate());}}});
    `,
        addon,
        path,
      ],
      { encoding: "utf8" },
    );
    try {
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("1");
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  });

  it("keeps stable root multi-process S/S and S/X, pure readers and K unchanged", () => {
    const path = freshStorageRootPath("f1-stable-");
    const root = native.openRoot(path, true);
    const read = openRead(root);
    try {
      native.closeRoot(root.handle);
      expect(native.tryAcquireCoordination(read, "S")).toBe(true);
      expect(child(root, "S")).toEqual({ acquired: true });
      expect(child(root)).toEqual({ acquired: false });
      native.releaseCoordination(read);
      expect(child(root)).toEqual({ acquired: true });
    } finally {
      native.closeCoordination(read);
      rmSync(path, { recursive: true, force: true });
    }
  });

  it("rejects replacement while a separate process keeps the original R-S active", async () => {
    const path = freshStorageRootPath("f1-reader-process-");
    const root = native.openRoot(path, true);
    const processHandle = spawn(
      process.execPath,
      [
        "-e",
        `
      const n=require(process.argv[1]); const h=n.openCoordination(process.argv[2],process.argv[3],'1',${JSON.stringify(digest)},'5','R');
      if(!n.tryAcquireCoordination(h,'S'))process.exit(2);
      process.stdout.write('READY\\n');process.stdin.resume();process.stdin.on('end',()=>{n.releaseCoordination(h);n.closeCoordination(h);});
    `,
        addon,
        path,
        root.markerId,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    const exited = once(processHandle, "close");
    try {
      expect(String((await once(processHandle.stdout!, "data"))[0])).toBe(
        "READY\n",
      );
      expect(child(root)).toEqual({ acquired: false });
      renameSync(join(path, ".coord/v1"), join(path, ".coord/v1-held"));
      mkdirSync(join(path, ".coord/v1"), { mode: 0o700 });
      expect(child(root).refused).toBe(true);
      expect(processHandle.exitCode).toBeNull();
      expect(() => openRead(root, "L")).toThrow();
    } finally {
      processHandle.stdin!.end();
      await exited;
      native.closeRoot(root.handle);
      rmSync(path, { recursive: true, force: true });
    }
  });

  it.each([
    "v1-missing",
    "v1-empty",
    "v1-copy",
    "v1-symlink",
    "coord-missing",
    "coord-empty",
    "coord-copy",
    "coord-symlink",
  ])(
    "%s rejects old/new guards and restarted processes while old R-S stays active",
    (change) => {
      const path = freshStorageRootPath("f1-change-");
      const root = native.openRoot(path, true);
      const held = openRead(root),
        pending = openRead(root, "L");
      try {
        expect(native.tryAcquireCoordination(held, "S")).toBe(true);
        const target = change.startsWith("v1")
          ? join(path, ".coord/v1")
          : join(path, ".coord");
        const moved = `${target}-held`;
        renameSync(target, moved);
        if (change.endsWith("empty")) mkdirSync(target, { mode: 0o700 });
        if (change.endsWith("copy")) cpSync(moved, target, { recursive: true });
        if (change.endsWith("symlink")) symlinkSync(moved, target);
        expect(() => native.tryAcquireCoordination(pending, "X")).toThrow();
        expect(() => openRead(root)).toThrow();
        expect(child(root).refused).toBe(true);
        expect(child(root).refused).toBe(true);
        expect(existsSync(join(path, ".purge"))).toBe(false);
        native.releaseCoordination(held);
        rmSync(target, { recursive: true, force: true });
        renameSync(moved, target);
        expect(native.tryAcquireCoordination(pending, "X")).toBe(true);
        native.releaseCoordination(pending);
      } finally {
        native.closeCoordination(pending);
        native.closeCoordination(held);
        native.closeRoot(root.handle);
        rmSync(path, { recursive: true, force: true });
      }
    },
  );

  it.each([
    "missing",
    "truncated",
    "unknown",
    "trailing",
    "nonregular",
    "mode",
  ])(
    "marker %s rejects runtime and cannot reinitialize an existing root",
    (change) => {
      const path = freshStorageRootPath("f1-marker-");
      const root = native.openRoot(path, true);
      const marker = join(path, ".storage-root"),
        bytes = readFileSync(marker);
      try {
        if (change === "missing") renameSync(marker, `${marker}-held`);
        else if (change === "nonregular") {
          rmSync(marker);
          mkdirSync(marker, { mode: 0o700 });
        } else if (change === "mode") chmodSync(marker, 0o640);
        else
          writeFileSync(
            marker,
            change === "truncated"
              ? bytes.subarray(0, 60)
              : change === "unknown"
                ? bytes.toString().replace("V2", "V9")
                : Buffer.concat([bytes, Buffer.from("x")]),
          );
        expect(() => openRead(root)).toThrow();
        expect(child(root).refused).toBe(true);
        native.closeRoot(root.handle);
        expect(() => native.openRoot(path, false)).toThrow();
        expect(() => native.openRoot(path, true)).toThrow();
      } finally {
        rmSync(path, { recursive: true, force: true });
      }
    },
  );

  it.each(["mode", "acl"])("directory %s changes fail closed", (change) => {
    const path = freshStorageRootPath("f1-attrs-");
    const root = native.openRoot(path, true);
    try {
      if (change === "mode") chmodSync(join(path, ".coord/v1"), 0o750);
      else
        execFileSync("/bin/chmod", [
          "+a",
          "everyone allow read",
          join(path, ".coord/v1"),
        ]);
      expect(() => openRead(root)).toThrow();
      expect(child(root).refused).toBe(true);
    } finally {
      native.closeRoot(root.handle);
      rmSync(path, { recursive: true, force: true });
    }
  });

  it("old strict V1 parser rejects V2; new coordination refuses V1 without creating a lock domain", () => {
    const path = freshStorageRootPath("f1-legacy-");
    const root = native.openRoot(path, true);
    native.closeRoot(root.handle);
    try {
      expect(
        testNative.phase7TestLegacyMarkerParse(
          readFileSync(join(path, ".storage-root")),
        ),
      ).toBe(false);
      expect(
        testNative.phase7TestLegacyMarkerParse(
          Buffer.from(`FAMILY_ALBUM_STORAGE_V1:${root.markerId}\n`),
        ),
      ).toBe(true);
      writeFileSync(
        join(path, ".storage-root"),
        `FAMILY_ALBUM_STORAGE_V1:${root.markerId}\n`,
        { mode: 0o600 },
      );
      rmSync(join(path, ".coord"), { recursive: true });
      const old = native.openRoot(path, false);
      try {
        expect(() => openRead(old)).toThrow();
        expect(existsSync(join(path, ".coord"))).toBe(false);
      } finally {
        native.closeRoot(old.handle);
      }
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  });

  it.each(["namespace", "fence"])(
    "native authority rejects %s immediately before physical quarantine",
    async (change) => {
      const path = freshStorageRootPath("f1-physical-");
      const root = StorageRoot.open(path, { initialize: true });
      mkdirSync(join(path, "derived"), { mode: 0o700 });
      root.provisionDerivedWriterLockForDev();
      const store = DerivedStore.open({ state: "READ_WRITE", root });
      const bytes = Buffer.from("f1 synthetic immutable Original"),
        sha = createHash("sha256").update(bytes).digest("hex");
      root.createUploadPayload("1", "a".repeat(32), bytes);
      root.publishOriginal({
        familyId: "1",
        uploadId: "a".repeat(32),
        sha256Hex: sha,
        byteSize: String(bytes.length),
      });
      const canonical = join(
        path,
        "originals/1",
        sha.slice(0, 2),
        sha.slice(2, 4),
        `${sha}-${bytes.length}`,
      );
      const original = statSync(canonical, { bigint: true });
      const content = new ContentCoordination(root, {
        familyId: "1",
        sha256Hex: sha,
        byteSize: String(bytes.length),
      });
      const life = await content.acquireLifecycle("X", 0),
        read = await content.acquireRead(life, "X", 0);
      try {
        const deadline =
          new PurgeDerivedNative(root, store, read).monotonicClock() + 10_000;
        if (change === "fence")
          writeFileSync(
            join(path, ".storage-root.initializing"),
            "FAMILY_ALBUM_INIT1\n",
            { mode: 0o600 },
          );
        else {
          renameSync(join(path, ".coord/v1"), join(path, ".coord/v1-held"));
          mkdirSync(join(path, ".coord/v1"), { mode: 0o700 });
        }
        expect(() =>
          new PurgeFilesNative(root, store, read).execute(
            {
              id: "1",
              familyId: "1",
              intentId: "1",
              fileKind: "ORIGINAL",
              storageId: "1",
              mediaId: null,
              sha256Hex: sha,
              byteSize: String(bytes.length),
              markerId: root.markerId,
              device: root.device,
              generation: null,
              recipeId: null,
              kind: null,
              jobId: null,
              epoch: null,
              stage: "CATALOGUED",
              slotHex: null,
              quarantineDevice: null,
              quarantineInode: null,
            },
            "QUARANTINE",
            {
              originalSha256Hex: sha,
              originalByteSize: String(bytes.length),
              permitDeadlineMs: deadline,
            },
          ),
        ).toThrow("PURGE_FILESYSTEM_UNCERTAIN");
        expect(readFileSync(canonical)).toEqual(bytes);
        expect(statSync(canonical, { bigint: true }).ino).toBe(original.ino);
        expect(existsSync(join(path, ".purge"))).toBe(false);
      } finally {
        read.close();
        life.close();
        store.close();
        root.close();
        rmSync(path, { recursive: true, force: true });
      }
    },
  );
});

const testAddon = resolve(
  import.meta.dirname,
  "../build/storage_native_test.node",
);
const publicationEvidence: Record<string, unknown>[] = [];
const publicationDirectory = resolve(
  import.meta.dirname,
  "../../../.cache/phase7-f1-design/init-publication",
);
const boundaryInventory = testNative.phase7TestInitBoundaries();
const specialBoundaries = new Set([
  "unlink_response_error",
  "unlink_query_error",
  "post_unlink",
  "post_unlock",
]);
const precommitBoundaries = boundaryInventory.filter(
  (name) => !specialBoundaries.has(name),
);

function productionAdmission(path: string) {
  const result = spawnSync(
    process.execPath,
    [
      "-e",
      `
    const n=require(process.argv[1]),fs=require('node:fs'); const path=process.argv[2];
    let marker='a'.repeat(32);try{marker=fs.readFileSync(path+'/.storage-root','utf8').split(':')[1]}catch{}
    const out={root:false,reader:false,coord:false};
    try{const r=n.openRoot(path,false);out.root=true;n.closeRoot(r.handle)}catch(e){out.rootCode=e.code}
    try{const r=n.openOriginalReader(path,marker);out.reader=true;n.closeOriginalReader(r.handle)}catch(e){out.readerCode=e.code}
    try{const h=n.openCoordination(path,marker,'1','a'.repeat(64),'5','R');out.coord=n.tryAcquireCoordination(h,'X');if(out.coord)n.releaseCoordination(h);n.closeCoordination(h)}catch(e){out.coordCode=e.code}
    process.stdout.write(JSON.stringify(out));
  `,
      addon,
      path,
    ],
    { encoding: "utf8", timeout: 5000 },
  );
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout) as {
    root: boolean;
    reader: boolean;
    coord: boolean;
    rootCode?: string;
  };
}
function initSnapshot(path: string) {
  if (!existsSync(path)) return null;
  const bytes = (name: string) =>
    existsSync(join(path, name))
      ? readFileSync(join(path, name)).toString("hex")
      : null;
  return {
    entries: readdirSync(path).sort(),
    marker: bytes(".storage-root"),
    fence: bytes(".storage-root.initializing"),
  };
}
async function exerciseBoundary(
  boundary: string,
  action: "kill" | "error" | "continue",
) {
  const path = freshStorageRootPath("f1-init1-");
  const owner = dirname(path);
  const processHandle = spawn(
    process.execPath,
    [
      "-e",
      `
    const n=require(process.argv[1]);n.phase7TestInitBoundary(process.argv[3],'pause',3,4);
    let result;try{const r=n.openRoot(process.argv[2],true);result={success:true,marker:r.markerId};n.closeRoot(r.handle)}catch(e){result={success:false,code:e.code}}
    process.stdout.write(JSON.stringify(result));
  `,
      testAddon,
      path,
      boundary,
    ],
    { stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"] },
  );
  const closed = once(processHandle, "close");
  let output = "",
    stderr = "";
  processHandle.stdout!.on("data", (bytes) => (output += String(bytes)));
  processHandle.stderr!.on("data", (bytes) => (stderr += String(bytes)));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const pause = await Promise.race([
      once(processHandle.stdio[3]!, "data"),
      closed.then(() => {
        throw new Error(`INITIALIZER_EXIT_BEFORE_${boundary}:${stderr}`);
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`BOUNDARY_TIMEOUT:${boundary}`)),
          5000,
        );
      }),
    ]);
    clearTimeout(timer);
    expect(String(pause[0]).trim()).toBe(boundary);
    const before = initSnapshot(path),
      concurrent = productionAdmission(path);
    if (boundary === "post_unlock") {
      // The initializer still owns the independent writer; pure admission is
      // available although another writer cannot openRoot yet.
      expect(concurrent.reader).toBe(true);
      expect(concurrent.coord).toBe(true);
    } else
      expect(concurrent).toMatchObject({
        root: false,
        reader: false,
        coord: false,
      });
    expect(initSnapshot(path)).toEqual(before);
    if (boundary === "pre_unlink") {
      const competingInitializer = spawnSync(
        process.execPath,
        [
          "-e",
          `
        const n=require(process.argv[1]);try{const r=n.openRoot(process.argv[2],true);n.closeRoot(r.handle);process.exit(2)}
        catch(e){process.stdout.write(e.code)}
      `,
          addon,
          path,
        ],
        { encoding: "utf8", timeout: 5000 },
      );
      expect(competingInitializer.status).toBe(0);
      expect(competingInitializer.stdout).toBe("STORAGE_ALREADY_EXISTS");
      expect(initSnapshot(path)).toEqual(before);
    }
    if (action === "kill") processHandle.kill("SIGKILL");
    else
      (processHandle.stdio[4] as NodeJS.WritableStream).write(
        action === "error" ? "E" : "C",
      );
    const [code, signal] = await closed;
    const committed =
      boundary === "post_unlink" ||
      boundary === "post_unlock" ||
      action === "continue";
    const after = productionAdmission(path);
    expect(after).toMatchObject({
      root: committed,
      reader: committed,
      coord: committed,
    });
    const response = output
      ? (JSON.parse(output) as { success: boolean; code?: string })
      : null;
    if (action === "kill") {
      expect(code).toBeNull();
      expect(signal).toBe("SIGKILL");
    } else {
      expect(code).toBe(0);
      expect(response?.success).toBe(action === "continue");
    }
    if (existsSync(path)) expect(() => native.openRoot(path, true)).toThrow();
    publicationEvidence.push({
      boundary,
      action,
      concurrent,
      after,
      exit: { code, signal },
      response,
      cleanup: true,
    });
  } finally {
    clearTimeout(timer);
    if (processHandle.exitCode === null && processHandle.signalCode === null)
      processHandle.kill("SIGKILL");
    await closed;
    rmSync(owner, { recursive: true, force: true });
    expect(existsSync(owner)).toBe(false);
  }
}

describe("INIT1 publication and independent production admission", () => {
  it.each(precommitBoundaries)(
    "%s blocks cross-process admission, injected error and SIGKILL before commit",
    async (boundary) => {
      await exerciseBoundary(boundary, "error");
      await exerciseBoundary(boundary, "kill");
      await exerciseBoundary(boundary, "continue");
    },
    20000,
  );

  it.each(["post_unlink", "post_unlock"])(
    "%s survives SIGKILL and unknown response without rollback",
    async (boundary) => {
      await exerciseBoundary(boundary, "kill");
      await exerciseBoundary(boundary, "error");
      await exerciseBoundary(boundary, "continue");
    },
  );

  it.each(["fence_unlink", "unlink_response_error", "unlink_query_error"])(
    "%s classifies commit failure without repair or replay",
    (boundary) => {
      const path = freshStorageRootPath("f1-commit-");
      try {
        const result = spawnSync(
          process.execPath,
          [
            "-e",
            `
        const n=require(process.argv[1]);n.phase7TestInitBoundary(process.argv[3],'error',-1,-1);
        try{const r=n.openRoot(process.argv[2],true);n.closeRoot(r.handle);process.stdout.write(JSON.stringify({success:true}))}
        catch(e){process.stdout.write(JSON.stringify({success:false,code:e.code}))}
      `,
            testAddon,
            path,
            boundary,
          ],
          { encoding: "utf8", timeout: 5000 },
        );
        expect(result.status).toBe(0);
        const response = JSON.parse(result.stdout);
        expect(response.success).toBe(false);
        const committed = boundary !== "fence_unlink";
        if (committed) expect(response.code).toBe("INIT_COMMIT_UNKNOWN");
        expect(existsSync(join(path, ".storage-root.initializing"))).toBe(
          !committed,
        );
        const after = productionAdmission(path);
        expect(after).toMatchObject({
          root: committed,
          reader: committed,
          coord: committed,
        });
        expect(() => native.openRoot(path, true)).toThrow();
        publicationEvidence.push({
          boundary,
          action: "syscall-error",
          response,
          after,
          cleanup: true,
        });
      } finally {
        rmSync(dirname(path), { recursive: true, force: true });
      }
    },
  );

  it("directory flock shares independent OFDs, and closing one read does not release another", () => {
    const path = freshStorageRootPath("f1-dir-flock-");
    const root = native.openRoot(path, true);
    const first = testNative.phase7TestRootLock(path, "S"),
      second = testNative.phase7TestRootLock(path, "S");
    expect(typeof first).toBe("number");
    expect(typeof second).toBe("number");
    const compete = (mode = "X") => {
      const result = spawnSync(
        process.execPath,
        [
          "-e",
          `
        const fs=require('node:fs'),n=require(process.argv[1]);const fd=n.phase7TestRootLock(process.argv[2],process.argv[3]);
        if(fd!==false)fs.closeSync(fd);process.stdout.write(JSON.stringify(fd!==false));
      `,
          testAddon,
          path,
          mode,
        ],
        { encoding: "utf8" },
      );
      expect(result.status).toBe(0);
      return JSON.parse(result.stdout);
    };
    try {
      expect(compete("S")).toBe(true);
      expect(compete()).toBe(false);
      const reader = native.openOriginalReader(path, root.markerId);
      native.closeOriginalReader(reader.handle);
      expect(compete()).toBe(false);
      closeSync(first as number);
      expect(compete()).toBe(false);
      closeSync(second as number);
      expect(compete()).toBe(true);
      const exclusive = testNative.phase7TestRootLock(path, "X");
      expect(typeof exclusive).toBe("number");
      try {
        expect(() => native.openOriginalReader(path, root.markerId)).toThrow();
        expect(compete("S")).toBe(false);
        expect(compete()).toBe(false);
      } finally {
        closeSync(exclusive as number);
      }
      expect(compete()).toBe(true);
    } finally {
      native.closeRoot(root.handle);
      rmSync(dirname(path), { recursive: true, force: true });
    }
  });

  it.each(["file", "empty", "directory", "symlink", "mode"])(
    "rejects reappeared fence %s at every runtime read boundary",
    (kind) => {
      const path = freshStorageRootPath("f1-fence-");
      const root = native.openRoot(path, true);
      native.closeRoot(root.handle);
      try {
        const fence = join(path, ".storage-root.initializing");
        if (kind === "directory") mkdirSync(fence, { mode: 0o700 });
        else if (kind === "symlink") symlinkSync("missing-owned-target", fence);
        else
          writeFileSync(fence, kind === "empty" ? "" : "FAMILY_ALBUM_INIT1\n", {
            mode: kind === "mode" ? 0o644 : 0o600,
          });
        expect(productionAdmission(path)).toMatchObject({
          root: false,
          reader: false,
          coord: false,
        });
        expect(() => native.openRoot(path, true)).toThrow();
      } finally {
        rmSync(dirname(path), { recursive: true, force: true });
      }
    },
  );

  it("rejects old guard acquisition, handoff creation and prepared registration with a reappeared fence", () => {
    const path = freshStorageRootPath("f1-fence-cap-");
    const root = native.openRoot(path, true);
    const read = openRead(root),
      pending = openRead(root, "L");
    expect(native.tryAcquireCoordination(read, "S")).toBe(true);
    const record = native.createHandoff(read);
    try {
      writeFileSync(
        join(path, ".storage-root.initializing"),
        "FAMILY_ALBUM_INIT1\n",
        { mode: 0o600 },
      );
      expect(() => native.tryAcquireCoordination(pending, "X")).toThrow();
      expect(() => native.createHandoff(read)).toThrow();
      expect(() =>
        native.registerHandoffReceiver(record, process.pid),
      ).toThrow();
      expect(productionAdmission(path)).toMatchObject({
        root: false,
        reader: false,
        coord: false,
      });
    } finally {
      native.closeHandoff(record);
      native.releaseCoordination(read);
      native.closeCoordination(read);
      native.closeCoordination(pending);
      native.closeRoot(root.handle);
      rmSync(dirname(path), { recursive: true, force: true });
    }
  });

  it("fails closed on uncertain fence stat without modifying disk", () => {
    const path = freshStorageRootPath("f1-fence-stat-");
    const root = native.openRoot(path, true);
    native.closeRoot(root.handle);
    const before = initSnapshot(path);
    try {
      testNative.phase7TestFenceStatError(true);
      expect(() => testNative.openRoot(path, false)).toThrow();
      expect(initSnapshot(path)).toEqual(before);
    } finally {
      testNative.phase7TestFenceStatError(false);
      rmSync(dirname(path), { recursive: true, force: true });
    }
  });

  it("rejects untagged V2 at runtime and both earlier strict parsers reject INIT1", () => {
    const path = freshStorageRootPath("f1-protocol-");
    const root = native.openRoot(path, true);
    native.closeRoot(root.handle);
    try {
      const marker = join(path, ".storage-root"),
        bytes = readFileSync(marker);
      expect(testNative.phase7TestLegacyMarkerParse(bytes)).toBe(false);
      expect(testNative.phase7TestPreInit1MarkerParse(bytes)).toBe(false);
      const old = Buffer.from(bytes.toString().replace(":INIT1", ""));
      expect(testNative.phase7TestPreInit1MarkerParse(old)).toBe(true);
      expect(testNative.phase7TestMarkerParse(old)).toBe(false);
      writeFileSync(marker, old);
      expect(productionAdmission(path)).toMatchObject({
        root: false,
        reader: false,
        coord: false,
      });
      expect(() => native.openRoot(path, true)).toThrow();
    } finally {
      rmSync(dirname(path), { recursive: true, force: true });
    }
  });

  it("records the complete named hook inventory and outcomes without production exports", () => {
    const required = precommitBoundaries.flatMap((boundary) =>
      ["error", "kill", "continue"].map((action) => ({ boundary, action })),
    );
    for (const item of required)
      expect(publicationEvidence).toContainEqual(expect.objectContaining(item));
    expect(
      Object.getOwnPropertyNames(native).filter((name) =>
        name.startsWith("phase7Test"),
      ),
    ).toEqual([]);
    mkdirSync(publicationDirectory, { recursive: true });
    writeFileSync(
      join(publicationDirectory, "boundary-results.json"),
      JSON.stringify(
        {
          inventory: boundaryInventory,
          results: publicationEvidence,
          physicalPowerLossTested: false,
        },
        null,
        2,
      ),
    );
  });
});
