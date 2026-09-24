import { GalleryClientError } from "../../lib/gallery-client.js";
import { NotFoundState, SignedOut, UnavailableState } from "./states.js";

export function GalleryFallback({ error }: { error: unknown }) {
  if (error instanceof GalleryClientError && error.code === "UNAUTHENTICATED") {
    return <SignedOut />;
  }
  if (error instanceof GalleryClientError && error.code === "NOT_FOUND") {
    return <NotFoundState />;
  }
  return <UnavailableState />;
}
