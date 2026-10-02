import {
  AlbumRepositoryError,
  CommitOutcomeUnknownError,
  type MySqlTrashRepository,
  type LifecycleMutation,
} from "@family-album/db";
import type { StorageCapability } from "@family-album/storage";
import { ContentCoordination } from "../../../../packages/storage/src/phase7-coordination.js";
import { PublicAuthError, type AuthContext } from "../auth/service.js";

export class TrashService {
  constructor(
    private readonly repository: Pick<
      MySqlTrashRepository,
      "preflight" | "transition" | "list"
    >,
    private readonly storage: StorageCapability,
  ) {}

  async mutate(context: AuthContext, input: Omit<LifecycleMutation, "actor">) {
    return this.safe(async () => {
      const request = { ...input, actor: this.actor(context) };
      const identity = await this.repository.preflight(request);
      if (this.storage.state !== "READ_WRITE")
        throw new PublicAuthError(503, "SERVICE_UNAVAILABLE");
      const content = new ContentCoordination(this.storage.root, identity);
      // The preflight COMMIT precedes every OS-lock wait. The transaction
      // inside transition repeats current authorization under L-X.
      const life = await content.acquireLifecycle("X", 30_000);
      try {
        return await this.repository.transition(request, identity);
      } finally {
        life.close();
      }
    });
  }
  async list(
    context: AuthContext,
    input: { familyId: string; limit: number; cursor?: string },
  ) {
    return this.safe(async () => {
      const cursor = input.cursor ? this.decodeCursor(input.cursor) : undefined;
      const rows = await this.repository.list({
        actor: this.actor(context),
        familyId: input.familyId,
        limit: input.limit,
        ...(cursor ? { cursor } : {}),
      });
      return {
        items: rows.map((row) => ({
          ...row,
          timelineKey: row.timelineKey.toISOString(),
          trashedAt: row.trashedAt.toISOString(),
          purgeAfter: row.purgeAfter.toISOString(),
        })),
        nextCursor:
          rows.length === input.limit ? this.encodeCursor(rows.at(-1)!) : null,
      };
    });
  }
  private actor(context: AuthContext) {
    return {
      userId: context.identity.userId,
      sessionId: context.identity.sessionId,
      tokenHash: context.tokenHash,
    };
  }
  private encodeCursor(input: { trashedAt: Date; mediaId: string }) {
    return Buffer.from(
      JSON.stringify({
        trashedAt: input.trashedAt.toISOString(),
        mediaId: input.mediaId,
      }),
    ).toString("base64url");
  }
  private decodeCursor(value: string) {
    try {
      const row = JSON.parse(
        Buffer.from(value, "base64url").toString("utf8"),
      ) as Record<string, unknown>;
      if (
        Object.keys(row).sort().join(",") !== "mediaId,trashedAt" ||
        typeof row.trashedAt !== "string" ||
        typeof row.mediaId !== "string" ||
        !/^[1-9][0-9]{0,19}$/u.test(row.mediaId) ||
        BigInt(row.mediaId) > 18446744073709551615n
      )
        throw new Error("CURSOR");
      const result = {
        trashedAt: new Date(row.trashedAt),
        mediaId: row.mediaId,
      };
      if (
        result.trashedAt.toISOString() !== row.trashedAt ||
        this.encodeCursor(result) !== value
      )
        throw new Error("CURSOR");
      return result;
    } catch {
      throw new PublicAuthError(400, "INVALID_REQUEST");
    }
  }
  private async safe<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof PublicAuthError) throw error;
      if (error instanceof CommitOutcomeUnknownError)
        throw new PublicAuthError(
          503,
          "SERVICE_UNAVAILABLE",
          undefined,
          "COMMIT_OUTCOME_UNKNOWN",
        );
      if (error instanceof AlbumRepositoryError) {
        const status = {
          UNAUTHENTICATED: 401,
          NOT_FOUND: 404,
          FORBIDDEN: 403,
          CONFLICT: 409,
          SERVICE_UNAVAILABLE: 503,
        }[error.reason];
        throw new PublicAuthError(status, error.reason);
      }
      throw new PublicAuthError(503, "SERVICE_UNAVAILABLE");
    }
  }
}
