import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import type { Readable } from "node:stream";

import { DataStore, Server, Upload } from "@tus/server";

import type { AuthContext } from "../auth/service.js";
import { UploadServiceError, type UploadService } from "./service.js";
import { UploadMutex } from "./mutex.js";

export type TusRequestContext = {
  auth: AuthContext;
  familyId?: string;
};

export class Phase3TusDataStore extends DataStore {
  extensions = ["creation", "expiration"];

  constructor(
    private readonly service: UploadService,
    private readonly contexts: AsyncLocalStorage<TusRequestContext>,
  ) {
    super();
  }

  override async create(upload: Upload) {
    const context = this.requiredContext();
    if (!context.familyId || upload.size === undefined) {
      throw new UploadServiceError(400, "INVALID_REQUEST");
    }
    const created = await this.service.create(context.auth, {
      familyId: context.familyId,
      publicId: Buffer.from(upload.id, "hex"),
      declaredSize: BigInt(upload.size),
      filename: upload.metadata?.filename,
      reportedMime: upload.metadata?.filetype,
    });
    return toTusUpload(created);
  }

  override async getUpload(id: string) {
    const context = this.requiredContext();
    return toTusUpload(await this.service.head(context.auth, parseId(id)));
  }

  override async write(stream: Readable, id: string, offset: number) {
    const context = this.requiredContext();
    const upload = await this.service.patch(
      context.auth,
      parseId(id),
      BigInt(offset),
      stream,
    );
    return safeNumber(upload.committedOffset);
  }

  override getExpiration() {
    return 7 * 24 * 60 * 60_000;
  }

  private requiredContext() {
    const context = this.contexts.getStore();
    if (!context) throw new UploadServiceError(401, "NOT_FOUND");
    return context;
  }
}

export function createTusProtocol(input: {
  service: UploadService;
  trustedOrigins: ReadonlySet<string>;
  publicApiOrigin: string;
  mutex?: UploadMutex;
}) {
  const contexts = new AsyncLocalStorage<TusRequestContext>();
  const mutex = input.mutex ?? new UploadMutex();
  const datastore = new Phase3TusDataStore(input.service, contexts);
  const server = new Server({
    path: "/api/v1/uploads/tus",
    datastore,
    locker: mutex,
    maxSize: safeNumber(input.service.maxFileSize),
    allowedOrigins: [...input.trustedOrigins],
    allowedCredentials: true,
    respectForwardedHeaders: false,
    namingFunction: () => randomUploadId(),
    getFileIdFromRequest: (_request, lastPath) =>
      typeof lastPath === "string" && /^[0-9a-f]{32}$/u.test(lastPath)
        ? lastPath
        : undefined,
    generateUrl: (_request, { id }) =>
      `${input.publicApiOrigin}/api/v1/uploads/tus/${id}`,
    onResponseError: (_request, error) => {
      if (error instanceof UploadServiceError) {
        return { status_code: error.status_code, body: error.body };
      }
      if (
        typeof error === "object" &&
        error !== null &&
        "status_code" in error &&
        typeof error.status_code === "number" &&
        "body" in error &&
        typeof error.body === "string"
      ) {
        return {
          status_code: error.status_code,
          body: sanitizeTusBody(error.status_code),
        };
      }
      return { status_code: 503, body: "STORAGE_UNAVAILABLE\n" };
    },
  });
  return { server, contexts, mutex };
}

function toTusUpload(upload: {
  publicId: string;
  declaredSize: bigint;
  committedOffset: bigint;
  createdAt: Date;
}) {
  return new Upload({
    id: upload.publicId,
    size: safeNumber(upload.declaredSize),
    offset: safeNumber(upload.committedOffset),
    creation_date: upload.createdAt.toISOString(),
    storage: { type: "family-album-db", path: "" },
  });
}

function randomUploadId() {
  return randomBytes(16).toString("hex");
}

function parseId(id: string) {
  if (!/^[0-9a-f]{32}$/u.test(id)) {
    throw new UploadServiceError(404, "NOT_FOUND");
  }
  return Buffer.from(id, "hex");
}

function safeNumber(value: bigint) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new UploadServiceError(400, "INVALID_REQUEST");
  }
  return number;
}

function sanitizeTusBody(status: number) {
  if (status === 404) return "NOT_FOUND\n";
  if (status === 409) return "OFFSET_MISMATCH\n";
  if (status === 410) return "UPLOAD_EXPIRED\n";
  if (status === 412) return "TUS_VERSION_UNSUPPORTED\n";
  if (status === 413) return "UPLOAD_TOO_LARGE\n";
  if (status === 415) return "INVALID_REQUEST\n";
  if (status === 429) return "RATE_LIMITED\n";
  return status >= 500 ? "STORAGE_UNAVAILABLE\n" : "INVALID_REQUEST\n";
}
