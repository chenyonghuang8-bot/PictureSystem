import type { MySqlDerivedReadRepository } from "@family-album/db";
import { StorageSafetyError } from "@family-album/storage";

import { PublicAuthError, type AuthContext } from "../auth/service.js";

export type DerivedReadIdentity = {
  familyId: string;
  mediaId: string;
  generation: bigint;
  recipeId: 1;
  kind: "THUMBNAIL" | "PREVIEW";
  sha256Hex: string;
  byteSize: bigint;
};

export type DerivedByteReader = {
  read(identity: DerivedReadIdentity): Promise<Buffer>;
};

const HIDDEN = new Set(["DERIVED_SERVE_ABSENT", "DERIVED_SERVE_MISMATCH"]);

export class DerivedReadService {
  constructor(
    private readonly repository: Pick<
      MySqlDerivedReadRepository,
      "findViewableReadyDerived"
    >,
    private readonly reader: DerivedByteReader,
  ) {}

  async serve(
    context: AuthContext,
    mediaId: string,
    kind: "thumbnail" | "preview",
  ): Promise<{ bytes: Buffer; contentType: "image/webp"; familyId: string }> {
    const assetKind = kind === "thumbnail" ? "THUMBNAIL" : "PREVIEW";
    let view;
    try {
      view = await this.repository.findViewableReadyDerived({
        userId: context.identity.userId,
        mediaId,
        kind: assetKind,
      });
    } catch {
      throw new PublicAuthError(
        503,
        "SERVICE_UNAVAILABLE",
        undefined,
        "DATABASE_FAILURE",
      );
    }
    if (!view) throw new PublicAuthError(404, "NOT_FOUND");
    let bytes: Buffer;
    try {
      bytes = await this.reader.read({
        familyId: view.familyId,
        mediaId: view.mediaId,
        generation: view.generation,
        recipeId: 1,
        kind: view.kind,
        sha256Hex: view.sha256Hex,
        byteSize: view.byteSize,
      });
    } catch (error) {
      if (error instanceof StorageSafetyError && HIDDEN.has(error.reason)) {
        throw new PublicAuthError(404, "NOT_FOUND");
      }
      throw new PublicAuthError(
        503,
        "SERVICE_UNAVAILABLE",
        undefined,
        "DATABASE_FAILURE",
      );
    }
    if (BigInt(bytes.length) !== view.byteSize) {
      throw new PublicAuthError(404, "NOT_FOUND");
    }
    return { bytes, contentType: "image/webp", familyId: view.familyId };
  }
}
