import { meResponseSchema } from "@family-album/contracts";
import { cookies } from "next/headers";
import type { z } from "zod";

import { GalleryClientError, readGalleryResponse } from "./gallery-client.js";

const SESSION_COOKIE = /^[A-Za-z0-9_-]{43}$/;

function apiOrigin() {
  const configured =
    process.env.FAMILY_ALBUM_API_ORIGIN ?? "http://127.0.0.1:4000";
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw new GalleryClientError("UNAVAILABLE");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new GalleryClientError("UNAVAILABLE");
  }
  return url.origin;
}

export async function serverGalleryGet<Schema extends z.ZodType>(
  path: string,
  schema: Schema,
): Promise<z.output<Schema>> {
  if (!path.startsWith("/api/v1/")) throw new GalleryClientError("UNAVAILABLE");
  const jar = await cookies();
  const token = jar.get("__Host-family_session")?.value;
  if (!token || !SESSION_COOKIE.test(token)) {
    throw new GalleryClientError("UNAUTHENTICATED");
  }
  let response: Response;
  try {
    response = await fetch(new URL(path, apiOrigin()), {
      method: "GET",
      headers: {
        accept: "application/json",
        cookie: `__Host-family_session=${token}`,
      },
      cache: "no-store",
    });
  } catch {
    throw new GalleryClientError("UNAVAILABLE");
  }
  return readGalleryResponse(response, schema);
}

export async function loadFamily() {
  const me = await serverGalleryGet("/api/v1/me", meResponseSchema);
  const membership = me.memberships[0];
  if (!membership) throw new GalleryClientError("NOT_FOUND");
  return {
    familyId: membership.familyId,
    familyName: membership.familyName,
  };
}
