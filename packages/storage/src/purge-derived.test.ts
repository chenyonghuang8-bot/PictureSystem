import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  rmdirSync,
  symlinkSync,
  writeFileSync,
  renameSync,
  readFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { StorageRoot, DerivedStore } from "./index.js";
import { ContentCoordination } from "./phase7-coordination.js";
import {
  PurgeDerivedNative,
  planPurgeDerivedNormalization,
  type PurgeNormalizationAsset,
  type PurgeDerivedFact,
} from "./purge-derived.js";
import { purgeBindings } from "./purge-bindings.js";
import { PurgeFilesNative, assertPurgeOwners } from "./purge-files.js";

const sha = createHash("sha256").update("synthetic-purge").digest("hex");
const identity = {
  familyId: "7",
  mediaId: "8",
  generation: "3",
  jobId: "42",
  epoch: "5",
  kind: "THUMBNAIL" as const,
};
const asset: PurgeNormalizationAsset = {
  ...identity,
  state: "RESERVED",
  cleanedAt: null,
  reservedBytes: 524288n,
  byteSize: null,
  sha256Hex: null,
};
const absent: PurgeDerivedFact = {
  fileClass: "ABSENT",
  byteSize: "",
  device: "",
  inode: "",
  mode: "",
  nlink: "",
  sha256Hex: "",
};
const sealed: PurgeDerivedFact = {
  fileClass: "REGULAR",
  byteSize: "15",
  device: "1",
  inode: "2",
  mode: "400",
  nlink: "1",
  sha256Hex: sha,
};

describe("purge-only normalization matrix", () => {
  it.each([
    ["RESERVED", "600", false],
    ["RESERVED", "400", false],
    ["PUBLISHING", "400", false],
    ["PUBLISHING", "400", true],
    ["RESERVED", "400", true],
    ["FAILED", "400", false],
    ["MISSING", "400", true],
  ])("normalizes %s / %s / final=%s", (state, mode, finalOnly) => {
    const current = {
      ...asset,
      state,
      ...(state === "PUBLISHING" ? { sha256Hex: sha, byteSize: 15n } : {}),
    };
    expect(
      planPurgeDerivedNormalization(current, {
        temp: finalOnly ? absent : { ...sealed, mode },
        final: finalOnly ? sealed : absent,
      }),
    ).toEqual([finalOnly ? "FINAL" : "TEMP"]);
  });
  it("allows matching dual sealed and absence convergence but rejects conflicts before any action", () => {
    expect(
      planPurgeDerivedNormalization(asset, { temp: sealed, final: sealed }),
    ).toEqual(["TEMP", "FINAL"]);
    expect(
      planPurgeDerivedNormalization(asset, { temp: absent, final: absent }),
    ).toEqual([]);
    expect(() =>
      planPurgeDerivedNormalization(asset, {
        temp: sealed,
        final: { ...sealed, sha256Hex: "a".repeat(64) },
      }),
    ).toThrow("PURGE_DUAL_CONFLICT");
    expect(() =>
      planPurgeDerivedNormalization(asset, {
        temp: { ...sealed, mode: "600" },
        final: sealed,
      }),
    ).toThrow("PURGE_DUAL_CONFLICT");
  });
  it("preserves READY and rejects READY temp and cleaned residue", () => {
    const ready = { ...asset, state: "READY", sha256Hex: sha, byteSize: 15n };
    expect(
      planPurgeDerivedNormalization(ready, { temp: absent, final: sealed }),
    ).toBe("READY");
    expect(() =>
      planPurgeDerivedNormalization(ready, { temp: sealed, final: sealed }),
    ).toThrow("PURGE_READY_RESIDUE");
    expect(() =>
      planPurgeDerivedNormalization(
        { ...asset, cleanedAt: new Date() },
        { temp: sealed, final: absent },
      ),
    ).toThrow("PURGE_CLEANED_RESIDUE");
  });
});

async function fixture(
  operation: (
    native: PurgeDerivedNative,
    paths: { temp: string; final: string; media: string },
    permit: {
      originalSha256Hex: string;
      originalByteSize: string;
      permitDeadlineMs: number;
    },
    context: {
      root: StorageRoot;
      store: DerivedStore;
      read: Awaited<ReturnType<ContentCoordination["acquireRead"]>>;
    },
  ) => Promise<void>,
) {
  const media = mkdtempSync(join(realpathSync(tmpdir()), "ps7c-native-"));
  chmodSync(media, 0o700);
  mkdirSync(join(media, "derived"), { mode: 0o700 });
  const root = StorageRoot.open(media, { initialize: true });
  root.provisionDerivedWriterLockForDev();
  const store = DerivedStore.open({ state: "READ_WRITE", root });
  const coord = new ContentCoordination(root, {
    familyId: "7",
    sha256Hex: sha,
    byteSize: "15",
  });
  const life = await coord.acquireLifecycle("X", 0);
  const read = await coord.acquireRead(life, "X", 0);
  const directory = (parts: string[]) => {
    let current = media;
    for (const part of parts) {
      current = join(current, part);
      mkdirSync(current, { recursive: true, mode: 0o700 });
      chmodSync(current, 0o700);
    }
    return current;
  };
  const paths = {
    media,
    temp: join(directory(["derived", ".tmp", "42", "e5"]), "thumbnail.part"),
    final: join(directory(["derived", "7", "8", "r1", "g3"]), "thumbnail.webp"),
  };
  try {
    await operation(
      new PurgeDerivedNative(root, store, read),
      paths,
      {
        originalSha256Hex: sha,
        originalByteSize: "15",
        permitDeadlineMs:
          new PurgeDerivedNative(root, store, read).monotonicClock() + 30000,
      },
      { root, store, read },
    );
  } finally {
    read.close();
    life.close();
    store.close();
    root.close();
    rmSync(media, { recursive: true, force: true });
  }
}
function file(path: string, mode = 0o400, bytes = "synthetic-purge") {
  writeFileSync(path, bytes, { mode });
  chmodSync(path, mode);
}

describe("purge exact native identity", () => {
  it.each(["directory", "symlink", "mode", "acl"] as const)(
    "rejects changed named Derived namespace: %s, preserving both directories",
    async (replacement) =>
      fixture(async (native, paths, { ...permit }, context) => {
        file(paths.temp);
        const fact = native.inspect(identity).temp;
        assertPurgeOwners(context.root, context.store);
        const named = join(paths.media, "derived"),
          moved = join(paths.media, "moved-derived");
        if (replacement === "directory" || replacement === "symlink") {
          renameSync(named, moved);
          if (replacement === "symlink") symlinkSync(moved, named);
          else {
            mkdirSync(named, { mode: 0o700 });
            mkdirSync(join(named, ".tmp", "42", "e5"), {
              recursive: true,
              mode: 0o700,
            });
            file(paths.temp);
          }
        } else if (replacement === "mode") chmodSync(named, 0o755);
        else {
          const username = execFileSync("/usr/bin/id", ["-un"], {
            encoding: "utf8",
          }).trim();
          execFileSync("/bin/chmod", [
            "+a",
            `user:${username} allow read`,
            named,
          ]);
        }
        try {
          context.root.assertIdentity();
          expect(() => assertPurgeOwners(context.root, context.store)).toThrow(
            "PURGE_WRITER_REQUIRED",
          );
          expect(() => native.inventory("7", "8", ["42"])).toThrow(
            "PURGE_INVENTORY_INCOMPLETE",
          );
          expect(() => native.inspect(identity)).toThrow();
          expect(() =>
            native.remove(identity, "TEMP", fact, { ...permit }),
          ).toThrow();
          const physical = new PurgeFilesNative(
            context.root,
            context.store,
            context.read,
          );
          expect(() =>
            physical.execute(
              {
                id: "2",
                familyId: "7",
                intentId: "1",
                fileKind: "DERIVED",
                storageId: null,
                mediaId: "8",
                sha256Hex: fact.sha256Hex,
                byteSize: fact.byteSize,
                markerId: context.root.markerId,
                device: context.root.device,
                generation: "3",
                recipeId: 1,
                kind: "THUMBNAIL",
                jobId: "42",
                epoch: "5",
                stage: "CATALOGUED",
                slotHex: null,
                quarantineDevice: null,
                quarantineInode: null,
              },
              "QUARANTINE",
              { ...permit },
            ),
          ).toThrow("PURGE_FILESYSTEM_UNCERTAIN");
          expect(
            existsSync(
              replacement === "directory" || replacement === "symlink"
                ? join(moved, ".tmp", "42", "e5", "thumbnail.part")
                : paths.temp,
            ),
          ).toBe(true);
          if (replacement === "directory")
            expect(readFileSync(paths.temp).toString()).toBe("synthetic-purge");
          expect(existsSync(join(paths.media, ".purge"))).toBe(false);
        } finally {
          if (replacement === "directory" || replacement === "symlink") {
            rmSync(named, { recursive: true, force: true });
            renameSync(moved, named);
          } else if (replacement === "mode") chmodSync(named, 0o700);
          else execFileSync("/bin/chmod", ["-N", named]);
        }
        expect(native.inspect(identity).temp.inode).toBe(fact.inode);
      }),
  );
  it("blocks live writer and sealed handles until native settlement", async () =>
    fixture(async (native, paths, _permit, context) => {
      const addon = createRequire(import.meta.url)(
        join(import.meta.dirname, "../build/storage_native.node"),
      ) as {
        createDerivedTemp(
          store: object,
          job: string,
          epoch: string,
          kind: string,
          family: string,
          media: string,
          generation: string,
          recipe: string,
          reservation: string,
        ): object;
        writeDerivedTemp(writer: object, bytes: Buffer, sha: string): unknown;
        sealDerivedTemp(writer: object): { handle: object };
        consumeSealedOutput(sealed: object, store: object): void;
      };
      const handle = purgeBindings(context.root, context.store).derived;
      const writer = addon.createDerivedTemp(
        handle,
        "42",
        "5",
        "THUMBNAIL",
        "7",
        "8",
        "3",
        "1",
        "9",
      );
      expect(() => native.inspect(identity)).toThrow("PURGE_LIVE_HANDLE");
      addon.writeDerivedTemp(writer, Buffer.from("synthetic-purge"), sha);
      const sealed = addon.sealDerivedTemp(writer);
      try {
        expect(() => native.inspect(identity)).toThrow("PURGE_LIVE_HANDLE");
      } finally {
        addon.consumeSealedOutput(sealed.handle, handle);
      }
      expect(native.inspect(identity).temp.mode).toBe("400");
      expect(existsSync(paths.temp)).toBe(true);
    }));
  it("rejects ACL and root substitution with exact restoration", async () =>
    fixture(async (native, paths) => {
      file(paths.temp);
      const username = execFileSync("/usr/bin/id", ["-un"], {
        encoding: "utf8",
      }).trim();
      execFileSync("/bin/chmod", [
        "+a",
        `user:${username} allow read`,
        paths.temp,
      ]);
      try {
        expect(() => native.inspect(identity)).toThrow(
          "PURGE_FILESYSTEM_UNCERTAIN",
        );
      } finally {
        execFileSync("/bin/chmod", ["-N", paths.temp]);
      }
      const displaced = `${paths.media}-displaced`;
      renameSync(paths.media, displaced);
      mkdirSync(paths.media, { mode: 0o700 });
      try {
        expect(() => native.inspect(identity)).toThrow();
      } finally {
        rmdirSync(paths.media);
        renameSync(displaced, paths.media);
      }
      expect(readFileSync(paths.temp).toString()).toBe("synthetic-purge");
    }));
  it.each([0o600, 0o400])(
    "durably removes exact temp mode %i under exclusive capabilities",
    async (mode) =>
      fixture(async (native, paths, { ...permit }) => {
        file(paths.temp, mode);
        const facts = native.inspect(identity);
        native.remove(identity, "TEMP", facts.temp, { ...permit });
        expect(native.inspect(identity).temp.fileClass).toBe("ABSENT");
      }),
  );
  it("deletes matching dual temp first then final, never READY classification", async () =>
    fixture(async (native, paths, { ...permit }) => {
      file(paths.temp);
      file(paths.final);
      const facts = native.inspect(identity);
      expect(() =>
        native.remove(identity, "FINAL", facts.final, { ...permit }),
      ).toThrow("PURGE_FILESYSTEM_UNCERTAIN");
      native.remove(identity, "TEMP", facts.temp, { ...permit }, facts.final);
      native.remove(identity, "FINAL", facts.final, { ...permit });
      expect(native.inspect(identity)).toMatchObject({
        temp: { fileClass: "ABSENT" },
        final: { fileClass: "ABSENT" },
      });
    }));
  it.each(["inode", "device", "sha256Hex", "byteSize", "mode"] as const)(
    "rejects changed expected %s",
    async (key) =>
      fixture(async (native, paths, { ...permit }) => {
        file(paths.temp);
        const fact = native.inspect(identity).temp;
        expect(() =>
          native.remove(
            identity,
            "TEMP",
            { ...fact, [key]: key === "sha256Hex" ? "a".repeat(64) : "999" },
            { ...permit },
          ),
        ).toThrow("PURGE_FILESYSTEM_UNCERTAIN");
        expect(existsSync(paths.temp)).toBe(true);
      }),
  );
  it("rejects unexpected final after temp inspection", async () =>
    fixture(async (native, paths, { ...permit }) => {
      file(paths.temp);
      const fact = native.inspect(identity).temp;
      file(paths.final);
      expect(() =>
        native.remove(identity, "TEMP", fact, { ...permit }),
      ).toThrow("PURGE_FILESYSTEM_UNCERTAIN");
      expect(existsSync(paths.temp)).toBe(true);
    }));
  it("rejects symlink, hardlink, wrong mode, unsafe parent and expired permit", async () =>
    fixture(async (native, paths, { ...permit }) => {
      file(paths.temp);
      const fact = native.inspect(identity).temp;
      expect(() =>
        native.remove(identity, "TEMP", fact, {
          ...permit,
          permitDeadlineMs: 1,
        }),
      ).toThrow("PURGE_PERMIT_EXPIRED");
      linkSync(paths.temp, paths.final);
      expect(() => native.inspect(identity)).toThrow(
        "PURGE_FILESYSTEM_UNCERTAIN",
      );
      rmSync(paths.final);
      chmodSync(paths.temp, 0o644);
      expect(() => native.inspect(identity)).toThrow(
        "PURGE_FILESYSTEM_UNCERTAIN",
      );
      rmSync(paths.temp);
      symlinkSync(paths.final, paths.temp);
      expect(() => native.inspect(identity)).toThrow(
        "PURGE_FILESYSTEM_UNCERTAIN",
      );
      rmSync(paths.temp);
      rmdirSync(join(paths.media, "derived", ".tmp", "42", "e5"));
      writeFileSync(
        join(paths.media, "derived", ".tmp", "42", "e5"),
        "not-a-directory",
        { mode: 0o600 },
      );
      expect(() => native.inspect(identity)).toThrow(
        "PURGE_FILESYSTEM_UNCERTAIN",
      );
    }));
});
