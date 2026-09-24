import {
  hashShareToken,
  createShareToken,
  TokenValidationError,
} from "@family-album/auth";
import {
  AlbumRepositoryError,
  CommitOutcomeUnknownError,
  ShareRepositoryError,
  TransactionRollbackFailedError,
  type ShareRecord,
  type ShareTokenRow,
} from "@family-album/db";
import type { Phase1CActor } from "@family-album/db";

import { PublicAuthError, type AuthContext } from "../auth/service.js";

export type ShareRepository = {
  insertShare(input: {
    actor: Phase1CActor;
    albumId: string;
    tokenHash: Buffer;
    expiresAt: Date;
  }): Promise<ShareRecord>;
  findByTokenHash(tokenHash: Buffer): Promise<ShareTokenRow | null>;
  listShares(input: {
    actor: Phase1CActor;
    familyId: string;
    afterId?: string;
    limit: number;
  }): Promise<ShareRecord[]>;
  revokeShare(input: {
    actor: Phase1CActor;
    shareId: string;
  }): Promise<ShareRecord>;
};

export type ShareCapability = {
  shareId: string;
  familyId: string;
  albumId: string;
  expiresAt: Date;
};

export class ShareService {
  constructor(private readonly repository: ShareRepository) {}

  async createShare(context: AuthContext, albumId: string, expiresAt: Date) {
    if (!(expiresAt instanceof Date) || Number.isNaN(expiresAt.getTime())) {
      throw new PublicAuthError(400, "INVALID_REQUEST");
    }
    const token = createShareToken();
    const created = await this.database(() =>
      this.repository.insertShare({
        actor: actor(context),
        albumId,
        tokenHash: hashShareToken(token),
        expiresAt,
      }),
    );
    return {
      shareId: created.shareId,
      albumId: created.albumId,
      token,
      expiresAt: created.expiresAt,
    };
  }

  async verifyShareToken(token: unknown): Promise<ShareCapability> {
    let tokenHash: Buffer;
    try {
      tokenHash = hashShareToken(token);
    } catch (error) {
      if (error instanceof TokenValidationError) {
        throw new PublicAuthError(404, "NOT_FOUND");
      }
      throw error;
    }
    const row = await this.database(() =>
      this.repository.findByTokenHash(tokenHash),
    );
    if (
      !row ||
      row.revokedAt ||
      row.albumDeleted ||
      row.expiresAt.getTime() <= row.serverNow.getTime()
    ) {
      throw new PublicAuthError(404, "NOT_FOUND");
    }
    return {
      shareId: row.shareId,
      familyId: row.familyId,
      albumId: row.albumId,
      expiresAt: row.expiresAt,
    };
  }

  async revokeShare(context: AuthContext, shareId: string) {
    const revoked = await this.database(() =>
      this.repository.revokeShare({ actor: actor(context), shareId }),
    );
    return {
      shareId: revoked.shareId,
      albumId: revoked.albumId,
      revokedAt: revoked.revokedAt,
    };
  }

  async listShares(
    context: AuthContext,
    input: { familyId: string; afterId?: string; limit: number },
  ) {
    if (
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 100 ||
      (input.afterId !== undefined && !/^[1-9][0-9]*$/u.test(input.afterId))
    ) {
      throw new PublicAuthError(400, "INVALID_REQUEST");
    }
    const shares = await this.database(() =>
      this.repository.listShares({
        actor: actor(context),
        familyId: input.familyId,
        limit: input.limit,
        ...(input.afterId ? { afterId: input.afterId } : {}),
      }),
    );
    return shares.map((share) => ({
      shareId: share.shareId,
      albumId: share.albumId,
      createdAt: share.createdAt,
      expiresAt: share.expiresAt,
      revokedAt: share.revokedAt,
    }));
  }

  private async database<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof PublicAuthError) throw error;
      if (error instanceof CommitOutcomeUnknownError) {
        throw new PublicAuthError(
          503,
          "SERVICE_UNAVAILABLE",
          undefined,
          "COMMIT_OUTCOME_UNKNOWN",
        );
      }
      if (error instanceof TransactionRollbackFailedError) {
        throw new PublicAuthError(
          503,
          "SERVICE_UNAVAILABLE",
          undefined,
          "ROLLBACK_FAILED",
        );
      }
      const reason = repositoryFailureReason(error);
      if (reason) {
        if (reason === "INVALID_EXPIRY") {
          throw new PublicAuthError(400, "INVALID_REQUEST");
        }
        if (reason === "UNAUTHENTICATED") {
          throw new PublicAuthError(401, "UNAUTHENTICATED");
        }
        if (reason === "FORBIDDEN") {
          throw new PublicAuthError(403, "FORBIDDEN");
        }
        if (reason === "NOT_FOUND") {
          throw new PublicAuthError(404, "NOT_FOUND");
        }
        throw new PublicAuthError(409, "CONFLICT");
      }
      throw new PublicAuthError(
        503,
        "SERVICE_UNAVAILABLE",
        undefined,
        "DATABASE_FAILURE",
      );
    }
  }
}

function repositoryFailureReason(error: unknown) {
  if (
    !(error instanceof ShareRepositoryError) &&
    !(error instanceof AlbumRepositoryError) &&
    !namedRepositoryError(error)
  ) {
    return null;
  }
  const reason = (error as { reason?: unknown }).reason;
  return typeof reason === "string" ? reason : null;
}

function namedRepositoryError(error: unknown) {
  if (!error || typeof error !== "object" || !("name" in error)) return false;
  return (
    error.name === "ShareRepositoryError" ||
    error.name === "AlbumRepositoryError"
  );
}

function actor(context: AuthContext) {
  return {
    userId: context.identity.userId,
    sessionId: context.identity.sessionId,
    tokenHash: context.tokenHash,
  };
}
