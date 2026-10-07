import { readAsStringAsync, EncodingType } from "expo-file-system/legacy";
import * as SQLite from "expo-sqlite";
import { File, Directory, Paths } from "expo-file-system";
import * as DocumentPicker from "expo-document-picker";
import { randomUUID } from "expo-crypto";
import {
  ContentSha256,
  ClientFault,
  sortedTargets,
  uploadStep,
  queueFailure,
  checked,
  type ClientJob,
} from "@family-album/contracts";
import { session, queueRequest } from "./session";
const directory = new Directory(Paths.document, "upload-queue");
let db: SQLite.SQLiteDatabase;
let running = false;
let copying = false;
const verified = new Set<string>();
const notify = new Set<() => void>();
const emit = () => {
  for (const f of notify) f();
};
export const onQueue = (f: () => void) => {
  notify.add(f);
  return () => {
    notify.delete(f);
  };
};
export async function openQueue() {
  db = await SQLite.openDatabaseAsync("upload-queue.db");
  await db.execAsync(
    "PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, scope TEXT NOT NULL, data TEXT NOT NULL);",
  );
  directory.create({ intermediates: true, idempotent: true });
  const rows = await db.getAllAsync<{ data: string }>("SELECT data FROM jobs");
  const keep = new Set<string>();
  for (const row of rows) {
    const job = JSON.parse(row.data) as ClientJob;
    if (job.stage === "COPYING" || job.stage === "DONE") {
      const unfinished = source(job);
      if (unfinished.exists) unfinished.delete();
      if (job.stage === "COPYING") {
        job.stage = "NEEDS_ACTION";
        await saveJob(job);
      }
    } else keep.add(job.source);
  }
  // Only our UUID-named copies in our private directory; preserve all accounts.
  for (const entry of directory.list()) {
    if (
      entry instanceof File &&
      /^[0-9a-f-]{36}\.(partial|source)$/.test(entry.name) &&
      !keep.has(entry.name)
    )
      entry.delete();
  }
  // Legacy picker copies are owned by this app's dedicated Expo picker cache.
  const pickerCache = new Directory(Paths.cache, "DocumentPicker");
  if (pickerCache.exists) pickerCache.delete();
}
export async function listJobs() {
  if (!db || !session.scope()) return [];
  return (
    await db.getAllAsync<{ data: string }>(
      "SELECT data FROM jobs WHERE scope=? ORDER BY rowid",
      session.scope()!,
    )
  ).map((r) => JSON.parse(r.data) as ClientJob);
}
async function saveJob(job: ClientJob) {
  await db.withExclusiveTransactionAsync(async (tx) => {
    await tx.runAsync(
      "INSERT INTO jobs(id,scope,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      job.operationId,
      job.scope,
      JSON.stringify(job),
    );
  });
  emit();
}
function source(job: ClientJob) {
  if (!/^[0-9a-f-]{36}\.source$/.test(job.source))
    throw new ClientFault(400, "SOURCE_INVALID");
  return new File(directory, job.source);
}
const base64Alphabet =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
export function decodeSourceBase64(encoded: string, limit: number) {
  if (encoded.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded))
    throw new ClientFault(400, "SOURCE_INVALID");
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  const size = (encoded.length / 4) * 3 - padding;
  if (size > limit) throw new ClientFault(400, "SOURCE_INVALID");
  const out = new Uint8Array(size);
  for (let i = 0, at = 0; i < encoded.length; i += 4) {
    const value =
      (base64Alphabet.indexOf(encoded[i]!) << 18) |
      (base64Alphabet.indexOf(encoded[i + 1]!) << 12) |
      ((encoded[i + 2] === "=" ? 0 : base64Alphabet.indexOf(encoded[i + 2]!)) <<
        6) |
      (encoded[i + 3] === "=" ? 0 : base64Alphabet.indexOf(encoded[i + 3]!));
    if (at < size) out[at++] = (value >>> 16) & 255;
    if (at < size) out[at++] = (value >>> 8) & 255;
    if (at < size) out[at++] = value & 255;
  }
  return out;
}
// Android document providers may return non-seekable streams. The SDK's
// legacy ranged reader uses InputStream.skip/read, never FileChannel.size.
export async function readSourceRange(file: File, at: number, length: number) {
  if (
    length <= 0 ||
    length > 1024 * 1024 ||
    at < 0 ||
    !Number.isSafeInteger(at)
  )
    throw new ClientFault(400, "SOURCE_INVALID");
  if (file.uri.startsWith("content://")) {
    let encoded: string;
    try {
      encoded = await readAsStringAsync(file.uri, {
        encoding: EncodingType.Base64,
        position: at,
        length,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      const category = /permission|denied/i.test(message)
        ? "PERMISSION"
        : /seek|ESPIPE/i.test(message)
          ? "NON_SEEKABLE"
          : /closed|EBADF|file descriptor/i.test(message)
            ? "HANDLE_CLOSED"
            : /not found|does not exist/i.test(message)
              ? "UNAVAILABLE"
              : /deprecated|not available|not supported/i.test(message)
                ? "SDK_UNSUPPORTED"
                : "NATIVE_READ";
      console.warn(
        JSON.stringify({ event: "native_source_read_failed", category }),
      );
      throw new ClientFault(400, "SOURCE_READ_FAILED");
    }
    if (encoded.length > Math.ceil(length / 3) * 4)
      throw new ClientFault(400, "SOURCE_INVALID");
    return decodeSourceBase64(encoded, length);
  }
  const handle = file.open();
  try {
    handle.offset = at;
    return handle.readBytes(length);
  } finally {
    handle.close();
  }
}
export async function fileDigest(file: File) {
  const hash = new ContentSha256();
  for (let at = 0; at < file.size; at += 1024 * 1024) {
    const bytes = await readSourceRange(
      file,
      at,
      Math.min(1024 * 1024, file.size - at),
    );
    if (!bytes.length) throw new ClientFault(400, "SOURCE_INVALID");
    hash.update(bytes);
  }
  return hash.hex();
}
// The OS picker suspends the activity. Resume only after the existing /me
// lifecycle validation has restored this same actor/family scope.
async function awaitPickerScope(scope: string) {
  const until = Date.now() + 10000;
  while (Date.now() < until) {
    const current = session.scope();
    if (current && current !== scope) throw new ClientFault(0, "STALE");
    if (current === scope && session.active()) return;
    if (session.get().ready) throw new ClientFault(0, "STALE");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new ClientFault(0, "STALE");
}
export async function selectPhotos(targets: string[]) {
  if (copying) throw new ClientFault(0, "BUSY");
  const scope = session.scope();
  if (!scope) throw new ClientFault(401);
  copying = true;

  try {
    const ids = sortedTargets(targets);
    const result = await DocumentPicker.getDocumentAsync({
      type: "image/*",
      multiple: true,
      copyToCacheDirectory: false,
    });
    if (result.canceled) return;

    await awaitPickerScope(scope);

    const all = (
      await db.getAllAsync<{ data: string }>("SELECT data FROM jobs")
    )
      .map((x) => JSON.parse(x.data) as ClientJob)
      .filter((x) => x.stage !== "DONE");
    let total = all.reduce((n, j) => n + j.size, 0);
    if (all.length + result.assets.length > 50)
      throw new ClientFault(400, "最多保留50个上传任务");
    for (const asset of result.assets) {
      if (session.scope() !== scope) throw new ClientFault(0, "STALE");

      const input = new File(asset.uri);
      const size = input.size;
      const occupied = directory
        .list()
        .reduce((n, f) => n + (f instanceof File ? f.size : 0), 0);
      if (
        size <= 0 ||
        size > 256 * 1024 * 1024 ||
        Math.max(total, occupied) + size > 2 * 1024 ** 3 ||
        Paths.availableDiskSpace < size + 128 * 1024 ** 2
      )
        throw new ClientFault(413, "照片或剩余空间超出限制");
      const id = randomUUID();
      const job: ClientJob = {
        scope,
        operationId: id,
        source: id + ".source",
        name: asset.name.normalize("NFC").slice(0, 255),
        mime: asset.mimeType ?? "application/octet-stream",
        size,
        digest: "",
        originalTargets: ids,
        targets: ids,
        offset: 0,
        stage: "COPYING",
        failures: 0,
        nextAttempt: 0,
      };

      await saveJob(job);

      const partial = new File(directory, id + ".partial");
      try {
        partial.create();

        const write = partial.open();
        const hash = new ContentSha256();
        try {
          let at = 0;
          while (at < size) {
            const bytes = await readSourceRange(
              input,
              at,
              Math.min(1024 * 1024, size - at),
            );
            if (!bytes.length) throw new ClientFault(400, "SOURCE_INVALID");

            hash.update(bytes);

            write.writeBytes(bytes);
            at += bytes.length;
          }
        } finally {
          write.close();
        }

        job.digest = hash.hex();
        if (
          partial.size !== size ||
          (await fileDigest(partial)) !== job.digest ||
          (await fileDigest(input)) !== job.digest
        )
          throw new ClientFault(400, "SOURCE_CHANGED");

        partial.move(source(job));
        job.stage = "WAITING";
        await saveJob(job);
        total += size;
      } catch (e) {
        if (partial.exists) partial.delete();
        const dest = source(job);
        if (dest.exists) dest.delete();
        job.stage = "NEEDS_ACTION";
        await saveJob(job);
        throw e;
      }
    }
  } finally {
    copying = false;
  }
}
export async function retryJob(job: ClientJob) {
  if (!/^[a-f0-9]{64}$/.test(job.digest))
    throw new ClientFault(400, "复制被中断，请移除任务并重新选择照片");
  if (job.scope !== session.scope()) return;
  job.stage = "WAITING";
  job.failures = 0;
  job.nextAttempt = 0;
  await saveJob(job);
}
export async function deleteJob(job: ClientJob) {
  if (job.scope !== session.scope() || running)
    throw new ClientFault(0, "BUSY");
  if (job.uploadId && !["DONE", "NEEDS_ACTION"].includes(job.stage))
    await queueRequest(`/api/v1/uploads/tus/${job.uploadId}`, {
      method: "DELETE",
      headers: { "tus-resumable": "1.0.0" },
    }).catch(() => {});
  const file = source(job);
  if (file.exists) file.delete();
  await db.runAsync(
    "DELETE FROM jobs WHERE id=? AND scope=?",
    job.operationId,
    job.scope,
  );
  emit();
}
export async function changeTargets(job: ClientJob, targets: string[]) {
  if (job.scope !== session.scope() || running || !job.uploadId)
    throw new ClientFault(0, "BUSY");
  const ids = sortedTargets(targets);
  const epoch = session.get().epoch;
  await checked(
    await queueRequest(`/api/v1/uploads/${job.uploadId}/targets`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ albumIds: ids }),
    }),
  );
  if (epoch !== session.get().epoch || job.scope !== session.scope())
    throw new ClientFault(0, "STALE");
  job.targets = ids;
  await retryJob(job);
}
export async function pumpQueue() {
  if (running || copying || !session.active()) return;
  running = true;
  const epoch = session.get().epoch,
    scope = session.scope();
  try {
    const jobs = await listJobs();
    const job = jobs.find(
      (j) =>
        !["DONE", "NEEDS_ACTION", "PAUSED_USER", "COPYING"].includes(j.stage) &&
        j.nextAttempt <= Date.now(),
    );
    if (!job) return;
    try {
      const result = await uploadStep(job, {
        request: queueRequest,
        save: saveJob,
        active: () =>
          session.active() &&
          epoch === session.get().epoch &&
          scope === session.scope(),
        read: async (start, end) => {
          const file = source(job);
          if (
            !file.exists ||
            file.size !== job.size ||
            (!verified.has(`${epoch}:${job.operationId}`) &&
              (await fileDigest(file)) !== job.digest)
          )
            throw new ClientFault(400, "SOURCE_MISSING_OR_CHANGED");
          verified.add(`${epoch}:${job.operationId}`);
          const h = file.open();
          try {
            h.offset = start;
            return h.readBytes(end - start);
          } finally {
            h.close();
          }
        },
      });
      if (result && job.stage === "DONE") {
        const f = source(job);
        if (f.exists) f.delete();
        await db.runAsync(
          "DELETE FROM jobs WHERE scope=? AND id IN (SELECT id FROM jobs WHERE scope=? AND json_extract(data,'$.stage')='DONE' ORDER BY rowid DESC LIMIT -1 OFFSET 100)",
          job.scope,
          job.scope,
        );
      }
      job.nextAttempt =
        Date.now() +
        (job.stage === "PROCESSING"
          ? Math.min(30000, Math.max(2000, job.failures * 2000))
          : 2000);
      await saveJob(job);
    } catch (e) {
      queueFailure(job, e);
      await saveJob(job);
    }
  } finally {
    running = false;
  }
}

export async function reselectJob(job: ClientJob) {
  if (
    job.scope !== session.scope() ||
    running ||
    copying ||
    job.stage === "DONE"
  )
    throw new ClientFault(0, "BUSY");
  copying = true;
  try {
    const picked = await DocumentPicker.getDocumentAsync({
      type: "image/*",
      multiple: false,
      copyToCacheDirectory: false,
    });
    if (picked.canceled) return;
    await awaitPickerScope(job.scope);
    const input = new File(picked.assets[0]!.uri);
    if (input.size !== job.size || (await fileDigest(input)) !== job.digest)
      throw new ClientFault(400, "请选择内容完全相同的原照片");
    const occupied = directory
      .list()
      .reduce((n, f) => n + (f instanceof File ? f.size : 0), 0);
    if (
      occupied + job.size > 2 * 1024 ** 3 ||
      Paths.availableDiskSpace < job.size + 128 * 1024 ** 2
    )
      throw new ClientFault(413, "空间不足");
    const temp = new File(directory, job.operationId + ".partial");
    if (temp.exists) temp.delete();
    temp.create();
    const write = temp.open();
    try {
      let at = 0;
      while (at < job.size) {
        const bytes = await readSourceRange(
          input,
          at,
          Math.min(1024 * 1024, job.size - at),
        );
        if (!bytes.length) throw new ClientFault(400, "SOURCE_INVALID");
        write.writeBytes(bytes);
        at += bytes.length;
      }
    } finally {
      write.close();
    }
    if (temp.size !== job.size || (await fileDigest(temp)) !== job.digest) {
      temp.delete();
      throw new ClientFault(400, "SOURCE_CHANGED");
    }
    const dest = source(job);
    if (dest.exists) dest.delete();
    temp.move(dest);
    await retryJob(job);
  } finally {
    const temp = new File(directory, job.operationId + ".partial");
    if (temp.exists) temp.delete();
    copying = false;
  }
}
