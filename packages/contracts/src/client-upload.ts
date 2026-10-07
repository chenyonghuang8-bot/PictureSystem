import {
  uploadResultResponseSchema,
  uploadStatusResponseSchema,
  type UploadPublicResult,
} from "./uploads.js";

export class ClientFault extends Error {
  constructor(
    public readonly status: number,
    public readonly code = "UNAVAILABLE",
    public readonly retryAfter = 0,
  ) {
    super(code);
  }
}
export type ClientJob = {
  operationId: string;
  scope: string;
  name: string;
  mime: string;
  size: number;
  digest: string;
  originalTargets: string[];
  targets: string[];
  source: string;
  uploadId?: string;
  offset: number;
  stage: string;
  failures: number;
  nextAttempt: number;
};
export type UploadIO = {
  request(path: string, init?: RequestInit): Promise<Response>;
  save(job: ClientJob): Promise<void>;
  read(start: number, end: number): Promise<Uint8Array>;
  active(): boolean;
};
export function sortedTargets(ids: string[]) {
  if (
    !ids.length ||
    ids.length > 20 ||
    ids.some(
      (x) => !/^[1-9][0-9]{0,19}$/.test(x) || BigInt(x) > 18446744073709551615n,
    )
  )
    throw new ClientFault(400, "TARGETS_INVALID");
  return [...new Set(ids)].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
}
export function apiPath(path: string) {
  if (
    !path.startsWith("/api/v1/") ||
    /[\\#]/.test(path) ||
    path.includes("..") ||
    path.includes("://")
  )
    throw new ClientFault(400, "PATH_INVALID");
  return path;
}
export function offsetFrom(response: Response, size: number) {
  const raw = response.headers.get("upload-offset");
  if (!raw || !/^(0|[1-9][0-9]*)$/.test(raw) || BigInt(raw) > BigInt(size))
    throw new ClientFault(400, "OFFSET_INVALID");
  return Number(raw);
}
export async function checked(response: Response) {
  if (!response.ok) {
    const retry = response.headers.get("retry-after");
    throw new ClientFault(
      response.status,
      response.status === 401 ? "AUTH" : "REQUEST_FAILED",
      retry && /^[0-9]+$/.test(retry)
        ? Math.min(3600, Number(retry)) * 1000
        : 0,
    );
  }
  return response;
}
function metadata(name: string, mime: string) {
  const b64 = (value: string) => {
    const bytes = new TextEncoder().encode(value);
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s);
  };
  return `filename ${b64(name)},filetype ${b64(mime)}`;
}
export function queueFailure(job: ClientJob, error: unknown, now = Date.now()) {
  job.failures++;
  const f = error instanceof ClientFault ? error : new ClientFault(0);
  job.stage =
    f.status === 401
      ? "PAUSED_AUTH"
      : [400, 403, 404, 410, 413].includes(f.status) || job.failures >= 8
        ? "NEEDS_ACTION"
        : "RETRY_WAIT";
  job.nextAttempt =
    now +
    Math.max(
      f.retryAfter,
      Math.min(60000, 1000 * 2 ** Math.min(6, job.failures - 1)) +
        Math.floor(Math.random() * 500),
    );
}
/** One request series per foreground job; each restart begins with authoritative observation. */
export async function uploadStep(
  job: ClientJob,
  io: UploadIO,
): Promise<UploadPublicResult | null> {
  const request = (path: string, init?: RequestInit) => {
    if (!io.active()) throw new ClientFault(0, "SUSPENDED");
    return io.request(path, init);
  };
  const save = async (stage: string) => {
    job.stage = stage;
    await io.save(job);
    if (!io.active()) throw new ClientFault(0, "SUSPENDED");
  };
  if (!io.active()) return null;
  await save("OBSERVING");
  if (!job.uploadId) {
    const r = await request(
      `/api/v1/families/${job.scope.split("|").at(-1)}/uploads/operations/${job.operationId}`,
    );
    if (r.status === 404) {
      const c = await checked(
        await request(
          `/api/v1/families/${job.scope.split("|").at(-1)}/uploads/tus`,
          {
            method: "POST",
            headers: {
              "tus-resumable": "1.0.0",
              "upload-length": String(job.size),
              "upload-metadata": metadata(job.name, job.mime),
              "upload-client-id": job.operationId,
              "upload-target-albums": job.originalTargets.join(","),
            },
          },
        ),
      );
      const location = c.headers.get("location");
      // API may return an absolute Location. Never dispatch it or trust a different path.
      const path = location
        ? new URL(location, "https://local.invalid").pathname
        : "";
      const id = /^\/api\/v1\/uploads\/tus\/([a-f0-9]{32})$/.exec(path)?.[1];
      if (!id) throw new ClientFault(400, "LOCATION_INVALID");
      job.uploadId = id;
    } else {
      const s = uploadStatusResponseSchema.parse(
        await (await checked(r)).json(),
      );
      job.uploadId = s.uploadId;
    }
    await save("WAITING");
  }
  const base = `/api/v1/uploads/${job.uploadId}`;
  let result = uploadResultResponseSchema.parse(
    await (await checked(await request(base + "/result"))).json(),
  );
  if (["FAILED", "ABORTED", "EXPIRED", "RETIRED"].includes(result.state)) {
    await save("NEEDS_ACTION");
    return result;
  }
  if (result.state !== "COMPLETE") {
    const head = await checked(
      await request(`/api/v1/uploads/tus/${job.uploadId}`, {
        method: "HEAD",
        headers: { "tus-resumable": "1.0.0" },
      }),
    );
    job.offset = offsetFrom(head, job.size);
    await save("UPLOADING");
    if (job.offset < job.size) {
      const bytes = await io.read(
        job.offset,
        Math.min(job.size, job.offset + 4 * 1024 * 1024),
      );
      if (!bytes.length || bytes.length > 4 * 1024 * 1024)
        throw new ClientFault(400, "SOURCE_INVALID");
      const response = await request(`/api/v1/uploads/tus/${job.uploadId}`, {
        method: "PATCH",
        headers: {
          "tus-resumable": "1.0.0",
          "upload-offset": String(job.offset),
          "content-type": "application/offset+octet-stream",
        },
        body: bytes as unknown as BodyInit,
      });
      if (response.status === 409) {
        await save("WAITING");
        return null;
      }
      await checked(response);
      job.offset = offsetFrom(response, job.size);
      job.failures = 0;
      await save("WAITING");
      return null;
    }
    if (result.state !== "FINALIZING") {
      await save("FINALIZING");
      await checked(
        await request(base + "/finalize", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        }),
      );
    }
    await save("PROCESSING");
    return null;
  }
  if (
    result.processing === "FAILED" ||
    (result.processing === "UNAVAILABLE" &&
      (!result.retryable || result.placement === "APPLIED")) ||
    result.placement === "NEEDS_ALBUM_ACTION"
  ) {
    await save("NEEDS_ACTION");
    return result;
  }
  if (result.processing !== "READY") {
    await save("PROCESSING");
    return result;
  }
  if (result.placement === "PENDING") {
    await save("PLACING");
    await checked(
      await request(base + "/placement", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );
    result = uploadResultResponseSchema.parse(
      await (await checked(await request(base + "/result"))).json(),
    );
  }
  // Historical APPLIED is never enough to claim viewable success.
  await save(
    result.placement === "APPLIED" && result.mediaId && result.albumId
      ? "DONE"
      : "NEEDS_ACTION",
  );
  job.failures = 0;
  return result;
}

/** Canonical unencoded custom-scheme invitation; never returns URL components to navigation. */
export function invitationToken(url: string): string | null {
  if (
    url.length > 256 ||
    !/^familyalbum:\/\/invite\?token=[A-Za-z0-9_-]{43}$/.test(url)
  )
    return null;
  const token = url.slice("familyalbum://invite?token=".length);
  // 32 bytes => final sextet's low two bits must be zero.
  return "AEIMQUYcgkosw048".includes(token.at(-1)!) ? token : null;
}
