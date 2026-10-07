import type { File } from "expo-file-system";
/// <reference types="node" />
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, afterAll, expect, it, vi } from "vitest";
import { ContentSha256, type ClientJob } from "@family-album/contracts";
const mock = vi.hoisted(() => ({
  rows: [] as ClientJob[],
  pick: vi.fn(),
  request: vi.fn(),
  ranged: vi.fn(),
  failWaiting: false,
  scope: "https://example.test|1|8" as string | null,
  active: true,
  ready: true,
  space: 4 * 1024 ** 3,
}));
const root = fs.mkdtempSync(
  path.join(os.tmpdir(), "phase10-queue-regression-"),
);
const document = path.join(root, "document"),
  cache = path.join(root, "cache"),
  outside = path.join(root, "external.jpg");
vi.mock("expo-file-system", async () => {
  const { TestFile, TestDirectory } =
    await import("./filesystem-test-adapter.js");
  return {
    File: TestFile,
    Directory: TestDirectory,
    Paths: {
      document,
      cache,
      get availableDiskSpace() {
        return mock.space;
      },
    },
  };
});
vi.mock("expo-file-system/legacy", () => ({
  readAsStringAsync: mock.ranged,
  EncodingType: { Base64: "base64" },
}));
vi.mock("expo-document-picker", () => ({ getDocumentAsync: mock.pick }));
vi.mock("expo-crypto", () => ({
  randomUUID: () => "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
}));
vi.mock("./session", () => ({
  session: {
    scope: () => mock.scope,
    get: () => ({ epoch: 1, ready: mock.ready }),
    active: () => mock.active,
  },
  queueRequest: mock.request,
}));
vi.mock("expo-sqlite", () => ({
  openDatabaseAsync: async () => ({
    execAsync: async () => {},
    getAllAsync: async () =>
      mock.rows.map((j) => ({ data: JSON.stringify(j) })),
    withExclusiveTransactionAsync: async (f: (tx: unknown) => Promise<void>) =>
      f({
        runAsync: async (
          _sql: string,
          _id: string,
          _scope: string,
          data: string,
        ) => {
          const j = JSON.parse(data) as ClientJob;
          if (mock.failWaiting && j.stage === "WAITING") {
            mock.failWaiting = false;
            throw new Error("persist failure");
          }
          const n = mock.rows.findIndex((x) => x.operationId === j.operationId);
          if (n < 0) mock.rows.push(j);
          else mock.rows[n] = j;
        },
      }),
    runAsync: async () => {},
  }),
}));
function job(
  stage = "WAITING",
  id = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb",
): ClientJob {
  return {
    operationId: id,
    scope: "https://example.test|1|8",
    source: id + ".source",
    name: "test.jpg",
    mime: "image/jpeg",
    size: 4,
    digest: new ContentSha256().update(new Uint8Array([1, 2, 3, 4])).hex(),
    originalTargets: ["1"],
    targets: ["1"],
    uploadId: "a".repeat(32),
    offset: 0,
    stage,
    failures: 0,
    nextAttempt: 0,
  };
}
function file(j: ClientJob) {
  return path.join(document, "upload-queue", j.source);
}
beforeEach(() => {
  mock.scope = "https://example.test|1|8";
  mock.active = true;
  mock.ready = true;
  vi.resetModules();
  vi.clearAllMocks();
  fs.rmSync(root, { recursive: true });
  fs.mkdirSync(document, { recursive: true });
  fs.mkdirSync(cache);
  fs.writeFileSync(outside, new Uint8Array([1, 2, 3, 4]));
  mock.rows = [];
  mock.failWaiting = false;
  mock.space = 4 * 1024 ** 3;
  mock.pick.mockResolvedValue({
    canceled: false,
    assets: [{ uri: outside, name: "test.jpg", mimeType: "image/jpeg" }],
  });
  mock.request.mockResolvedValue(new Response(null, { status: 200 }));
});
afterAll(() => fs.rmSync(root, { recursive: true }));
it("restart removes DONE/COPYING/orphan/partial files and retains other-account unfinished sources", async () => {
  const done = job("DONE"),
    copy = job("COPYING", "cccccccc-cccc-4ccc-cccc-cccccccccccc"),
    other = job("WAITING", "dddddddd-dddd-4ddd-dddd-dddddddddddd");
  other.scope = "https://example.test|2|9";
  mock.rows = [done, copy, other];
  fs.mkdirSync(path.dirname(file(done)));
  for (const j of mock.rows) fs.writeFileSync(file(j), "data");
  const orphan = job("DONE", "eeeeeeee-eeee-4eee-eeee-eeeeeeeeeeee");
  fs.writeFileSync(file(orphan), "orphan");
  fs.writeFileSync(file(copy).replace(".source", ".partial"), "partial");
  fs.mkdirSync(path.join(cache, "DocumentPicker"));
  fs.writeFileSync(path.join(cache, "DocumentPicker", "owned.jpg"), "legacy");
  const q = await import("./queue.js");
  await q.openQueue();
  expect(fs.readdirSync(path.dirname(file(done)))).toEqual([other.source]);
  expect(fs.existsSync(outside)).toBe(true);
  expect(fs.existsSync(path.join(cache, "DocumentPicker"))).toBe(false);
  expect(mock.rows.find((j) => j.operationId === copy.operationId)?.stage).toBe(
    "NEEDS_ACTION",
  );
});
it("picker never pre-copies; task-count rejection leaves no queue copy or external deletion", async () => {
  mock.rows = Array.from({ length: 50 }, () => job());
  const q = await import("./queue.js");
  await q.openQueue();
  await expect(q.selectPhotos(["1"])).rejects.toThrow("50");
  expect(mock.pick).toHaveBeenCalledWith(
    expect.objectContaining({ copyToCacheDirectory: false }),
  );
  expect(fs.readdirSync(path.join(document, "upload-queue"))).toEqual([]);
  expect(fs.existsSync(outside)).toBe(true);
});
it("actual hidden disk occupancy and free-space floor reject before copy", async () => {
  const q = await import("./queue.js");
  await q.openQueue();
  const hidden = path.join(document, "upload-queue", "unmanaged.synthetic");
  fs.writeFileSync(hidden, "");
  fs.truncateSync(hidden, 2 * 1024 ** 3);
  await expect(q.selectPhotos(["1"])).rejects.toThrow("限制");
  fs.unlinkSync(hidden);
  mock.space = 128 * 1024 ** 2;
  await expect(q.selectPhotos(["1"])).rejects.toThrow("限制");
  expect(fs.existsSync(outside)).toBe(true);
});
it("copy then failed WAITING persist removes moved source and partial", async () => {
  const q = await import("./queue.js");
  await q.openQueue();
  mock.failWaiting = true;
  await expect(q.selectPhotos(["1"])).rejects.toThrow("persist failure");
  expect(fs.readdirSync(path.join(document, "upload-queue"))).toEqual([]);
  expect(mock.rows[0]?.stage).toBe("NEEDS_ACTION");
});
it("success and repeated reselect keep one bounded private source and no picker cache", async () => {
  const q = await import("./queue.js");
  await q.openQueue();
  await q.selectPhotos(["1"]);
  const j = mock.rows[0]!;
  await q.reselectJob(j);
  await q.reselectJob(j);
  expect(fs.readdirSync(path.dirname(file(j)))).toEqual([j.source]);
  expect(fs.statSync(file(j)).size).toBe(4);
  expect(fs.readFileSync(outside)).toEqual(Buffer.from([1, 2, 3, 4]));
  expect(
    mock.pick.mock.calls.every(([x]) => x.copyToCacheDirectory === false),
  ).toBe(true);
});
it.each([403, 404, 409])(
  "target PUT %s preserves local targets and stage",
  async (status) => {
    const q = await import("./queue.js");
    await q.openQueue();
    const j = job("NEEDS_ACTION");
    mock.request.mockResolvedValue(new Response(null, { status }));
    await expect(q.changeTargets(j, ["2"])).rejects.toThrow();
    expect(j.targets).toEqual(["1"]);
    expect(j.stage).toBe("NEEDS_ACTION");
    expect(mock.rows).toHaveLength(0);
  },
);
it("lost target response preserves local targets; 200 alone allows persistence", async () => {
  const q = await import("./queue.js");
  await q.openQueue();
  const j = job("NEEDS_ACTION");
  mock.request.mockRejectedValueOnce(new Error("lost"));
  await expect(q.changeTargets(j, ["2"])).rejects.toThrow("lost");
  expect(j.targets).toEqual(["1"]);
  await q.changeTargets(j, ["2"]);
  expect(mock.rows[0]?.targets).toEqual(["2"]);
});

it("OS picker waits for same-scope foreground validation before creating a job", async () => {
  const q = await import("./queue.js");
  await q.openQueue();
  mock.pick.mockImplementationOnce(async () => {
    mock.scope = null;
    mock.active = false;
    mock.ready = false;
    setTimeout(() => {
      mock.scope = "https://example.test|1|8";
      mock.active = true;
      mock.ready = true;
    }, 60);
    return {
      canceled: false,
      assets: [{ uri: outside, name: "same.jpg", mimeType: "image/jpeg" }],
    };
  });
  await q.selectPhotos(["2"]);
  expect(mock.rows).toHaveLength(1);
  expect(mock.rows[0]!.stage).toBe("WAITING");
});
it("OS picker cannot create a task under a changed account scope", async () => {
  const q = await import("./queue.js");
  await q.openQueue();
  mock.pick.mockImplementationOnce(async () => {
    mock.scope = "https://example.test|9|8";
    return {
      canceled: false,
      assets: [{ uri: outside, name: "same.jpg", mimeType: "image/jpeg" }],
    };
  });
  await expect(q.selectPhotos(["2"])).rejects.toThrow();
  expect(mock.rows).toHaveLength(0);
  mock.scope = "https://example.test|1|8";
});

it("content provider reads are bounded ranges without seekable handles", async () => {
  const q = await import("./queue.js");
  mock.ranged.mockResolvedValue("AQIDBA==");
  const file = {
    uri: "content://synthetic/document/1",
    open: () => {
      throw new Error("must not seek");
    },
  } as unknown as File;
  expect(Array.from(await q.readSourceRange(file, 7, 4))).toEqual([1, 2, 3, 4]);
  expect(mock.ranged).toHaveBeenCalledWith(file.uri, {
    encoding: "base64",
    position: 7,
    length: 4,
  });
  await expect(q.readSourceRange(file, 0, 1024 * 1024 + 1)).rejects.toThrow();
  mock.ranged.mockResolvedValue("AQIDBA==");
  await expect(q.readSourceRange(file, 0, 2)).rejects.toThrow();
});

it("native bounded base64 decoding matches independent binary vectors without browser atob", async () => {
  const q = await import("./queue.js");
  for (const n of [0, 1, 2, 3, 255, 1024 * 1024]) {
    const golden = Buffer.from(Array.from({ length: n }, (_, i) => i % 256));
    expect(
      Buffer.from(q.decodeSourceBase64(golden.toString("base64"), n)),
    ).toEqual(golden);
  }
  expect(() => q.decodeSourceBase64("AQIDBA==", 2)).toThrow();
  expect(() => q.decodeSourceBase64("!!!!", 4)).toThrow();
});
