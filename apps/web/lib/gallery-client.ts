import type { z } from "zod";
import { authErrorResponseSchema } from "@family-album/contracts";

export type GalleryErrorCode =
  | "UNAUTHENTICATED"
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "CONFLICT"
  | "INVALID_REQUEST"
  | "UNAVAILABLE";

export class GalleryClientError extends Error {
  readonly code: GalleryErrorCode;

  constructor(code: GalleryErrorCode) {
    super(code);
    this.name = "GalleryClientError";
    this.code = code;
  }
}

export async function readGalleryResponse<Schema extends z.ZodType>(
  response: Response,
  schema: Schema,
): Promise<z.output<Schema>> {
  if (response.status === 401) throw new GalleryClientError("UNAUTHENTICATED");
  if (response.status === 404) throw new GalleryClientError("NOT_FOUND");
  if (response.status === 403) throw new GalleryClientError("FORBIDDEN");
  if (response.status === 409) throw new GalleryClientError("CONFLICT");
  if (response.status === 400) {
    // Only the API's known invalid-request envelope permits cursor recovery.
    // A generic/proxy 400 must retain the normal unavailable behavior.
    let errorBody: unknown;
    try {
      errorBody = await response.json();
    } catch {
      /* Untrusted failure body. */
    }
    const parsedError = authErrorResponseSchema.safeParse(errorBody);
    if (parsedError.success && parsedError.data.code === "INVALID_REQUEST")
      throw new GalleryClientError("INVALID_REQUEST");
  }
  if (!response.ok) throw new GalleryClientError("UNAVAILABLE");
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new GalleryClientError("UNAVAILABLE");
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new GalleryClientError("UNAVAILABLE");
  return parsed.data;
}

export async function browserGalleryGet<Schema extends z.ZodType>(
  path: string,
  schema: Schema,
  signal?: AbortSignal,
): Promise<z.output<Schema>> {
  if (!path.startsWith("/api/v1/") || path.includes("://")) {
    throw new GalleryClientError("UNAVAILABLE");
  }
  let response: Response;
  try {
    response = await fetch(path, {
      method: "GET",
      headers: { accept: "application/json" },
      credentials: "same-origin",
      cache: "no-store",
      ...(signal ? { signal } : {}),
    });
  } catch {
    throw new GalleryClientError("UNAVAILABLE");
  }
  return readGalleryResponse(response, schema);
}

export async function browserGallerySend<Schema extends z.ZodType>(
  method: "PUT" | "POST" | "DELETE",
  path: string,
  schema: Schema,
  body: unknown,
): Promise<z.output<Schema>> {
  if (!path.startsWith("/api/v1/") || path.includes("://")) {
    throw new GalleryClientError("UNAVAILABLE");
  }
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      credentials: "same-origin",
      cache: "no-store",
      body: JSON.stringify(body),
    });
  } catch {
    throw new GalleryClientError("UNAVAILABLE");
  }
  if (response.status === 204) {
    const parsed = schema.safeParse(undefined);
    if (!parsed.success) throw new GalleryClientError("UNAVAILABLE");
    return parsed.data;
  }
  return readGalleryResponse(response, schema);
}
