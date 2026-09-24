import type { z } from "zod";

export type GalleryErrorCode =
  "UNAUTHENTICATED" | "NOT_FOUND" | "FORBIDDEN" | "UNAVAILABLE";

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
    });
  } catch {
    throw new GalleryClientError("UNAVAILABLE");
  }
  return readGalleryResponse(response, schema);
}
