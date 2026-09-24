import type {
  MySqlDerivedReadRepository,
  MySqlShareRepository,
} from "@family-album/db";
import { StorageSafetyError } from "@family-album/storage";

import {
  decodeGalleryCursor,
  encodeGalleryCursor,
  galleryMediaItem,
} from "../albums/service.js";
import { PublicAuthError } from "../auth/service.js";
import type { DerivedByteReader } from "../derived-serving/service.js";
import type { ShareService } from "./service.js";

const HIDDEN = new Set(["DERIVED_SERVE_ABSENT", "DERIVED_SERVE_MISMATCH"]);

export class PublicShareService {
  constructor(
    private readonly shares: Pick<ShareService, "verifyShareToken">,
    private readonly pages: Pick<
      MySqlShareRepository,
      "readSharedAlbum" | "recordAccess"
    >,
    private readonly derived: Pick<
      MySqlDerivedReadRepository,
      "findReadyDerivedInAlbum"
    >,
    private readonly reader: DerivedByteReader,
  ) {}

  async openAlbum(token: unknown, input: { limit: number; cursor?: string }) {
    const capability = await this.notFound(() =>
      this.shares.verifyShareToken(token),
    );
    const cursor = input.cursor ? this.cursor(input.cursor) : undefined;
    const page = await this.notFound(() =>
      this.pages.readSharedAlbum({
        familyId: capability.familyId,
        albumId: capability.albumId,
        limit: input.limit,
        ...(cursor ? { cursor } : {}),
      }),
    );
    if (!page) throw new PublicAuthError(404, "NOT_FOUND");
    await this.notFound(() =>
      this.pages.recordAccess({
        familyId: capability.familyId,
        shareId: capability.shareId,
      }),
    );
    const media = page.media.map((item) =>
      galleryMediaItem({
        ...item,
        orientation: null,
        capturedLocalAt: null,
        cameraMake: null,
        cameraModel: null,
      }),
    );
    return {
      shareId: capability.shareId,
      album: { name: page.name },
      media,
      nextCursor:
        media.length === input.limit
          ? encodeGalleryCursor(media.at(-1)!)
          : null,
    };
  }

  async openDerived(
    token: unknown,
    mediaId: string,
    kind: string,
  ): Promise<{ bytes: Buffer; contentType: "image/webp" }> {
    const capability = await this.notFound(() =>
      this.shares.verifyShareToken(token),
    );
    if (
      (kind !== "thumbnail" && kind !== "preview") ||
      !/^[1-9][0-9]*$/u.test(mediaId)
    ) {
      throw new PublicAuthError(404, "NOT_FOUND");
    }
    const assetKind = kind === "thumbnail" ? "THUMBNAIL" : "PREVIEW";
    const view = await this.notFound(() =>
      this.derived.findReadyDerivedInAlbum({
        familyId: capability.familyId,
        albumId: capability.albumId,
        mediaId,
        kind: assetKind,
      }),
    );
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
      throw new PublicAuthError(404, "NOT_FOUND");
    }
    if (BigInt(bytes.length) !== view.byteSize) {
      throw new PublicAuthError(404, "NOT_FOUND");
    }
    return { bytes, contentType: "image/webp" };
  }

  private cursor(value: string) {
    try {
      return decodeGalleryCursor(value);
    } catch {
      throw new PublicAuthError(404, "NOT_FOUND");
    }
  }

  private async notFound<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof PublicAuthError && error.statusCode === 404) {
        throw error;
      }
      if (error instanceof PublicAuthError) {
        throw new PublicAuthError(404, "NOT_FOUND");
      }
      throw new PublicAuthError(404, "NOT_FOUND");
    }
  }
}
