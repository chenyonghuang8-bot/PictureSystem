import { publicSharePageSchema } from "@family-album/contracts";

import { GalleryClientError, readGalleryResponse } from "./gallery-client.js";
import { assertShareToken, publicSharePath } from "./share-client.js";

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

export async function loadPublicShare(
  token: string,
  input: { cursor?: string; limit: number },
) {
  assertShareToken(token);
  let response: Response;
  try {
    response = await fetch(
      new URL(publicSharePath(token, input), apiOrigin()),
      {
        method: "GET",
        headers: { accept: "application/json" },
        cache: "no-store",
      },
    );
  } catch {
    throw new GalleryClientError("UNAVAILABLE");
  }
  return readGalleryResponse(response, publicSharePageSchema);
}
