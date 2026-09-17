import {
  Argon2CapacityError,
  createInvitationToken,
  createInvitationUrl,
  countCodePoints,
  hashInvitationToken,
  hasMalformedUnicode,
  normalizeUsername,
  type PasswordEngine,
  validatePassword,
} from "@family-album/auth";
import {
  CommitOutcomeUnknownError,
  type InvitationRecord,
  type MemberRecord,
  type MySqlPhase1CRepository,
  Phase1CRepositoryError,
  TransactionRollbackFailedError,
} from "@family-album/db";
import type {
  InvitationRole,
  UpdateMemberRequest,
} from "@family-album/contracts";

import { PublicAuthError, type AuthContext } from "../auth/service.js";

export type Phase1CRepository = Pick<
  MySqlPhase1CRepository,
  | "createInvitation"
  | "listInvitations"
  | "revokeInvitation"
  | "findInvitationByHash"
  | "previewInvitation"
  | "consumeInvitation"
  | "listMembers"
  | "updateMember"
>;

export class Phase1CService {
  private readonly invitationAttempts = new Map<
    string,
    { startedAt: number; count: number }
  >();

  constructor(
    private readonly repository: Phase1CRepository,
    private readonly passwords: PasswordEngine,
    private readonly invitationOrigin: string,
    private readonly now: () => number = Date.now,
  ) {}

  async createInvitation(
    context: AuthContext,
    input: {
      familyId: string;
      role: InvitationRole;
      expiresInHours: number;
    },
  ) {
    this.recordManagementAttempt(context.identity.userId, input.familyId);
    const token = createInvitationToken();
    const created = await this.database(() =>
      this.repository.createInvitation({
        actor: actor(context),
        ...input,
        tokenHash: hashInvitationToken(token),
      }),
    );
    return {
      id: created.id,
      role: input.role,
      expiresAt: created.expiresAt,
      invitationUrl: createInvitationUrl(this.invitationOrigin, token),
      actorMemberId: created.actorMemberId,
    };
  }

  async listInvitations(context: AuthContext, familyId: string) {
    const rows = await this.database(() =>
      this.repository.listInvitations(actor(context), familyId),
    );
    return rows.map((row) => ({ ...row, status: invitationStatus(row) }));
  }

  async revokeInvitation(
    context: AuthContext,
    familyId: string,
    invitationId: string,
  ) {
    this.recordManagementAttempt(context.identity.userId, familyId);
    return this.database(() =>
      this.repository.revokeInvitation({
        actor: actor(context),
        familyId,
        invitationId,
      }),
    );
  }

  async previewInvitation(token: unknown, ip: string) {
    this.recordInvitationAttempt(ip);
    let tokenHash: Buffer;
    try {
      tokenHash = hashInvitationToken(token);
    } catch {
      throw new PublicAuthError(400, "INVALID_INVITATION");
    }
    return this.database(() => this.repository.previewInvitation(tokenHash));
  }

  async consumeInvitation(
    input: {
      token: unknown;
      username: unknown;
      password: unknown;
      displayName?: unknown;
    },
    ip: string,
  ) {
    this.recordInvitationAttempt(ip);
    let tokenHash: Buffer;
    try {
      tokenHash = hashInvitationToken(input.token);
    } catch {
      throw new PublicAuthError(400, "INVALID_INVITATION");
    }
    const username = normalizeUsername(input.username);
    const password = validatePassword(input.password);
    const displayName = validateDisplayName(input.displayName);
    const locator = await this.database(() =>
      this.repository.findInvitationByHash(tokenHash),
    );
    if (!locator) throw new PublicAuthError(400, "INVALID_INVITATION");

    let passwordHash: string;
    try {
      passwordHash = await this.passwords.hash(password);
    } catch (error) {
      if (error instanceof Argon2CapacityError) {
        throw new PublicAuthError(503, "SERVICE_UNAVAILABLE");
      }
      throw new PublicAuthError(
        503,
        "SERVICE_UNAVAILABLE",
        undefined,
        "ARGON2_EXECUTION_FAILURE",
      );
    }
    return this.database(() =>
      this.repository.consumeInvitation({
        locator,
        tokenHash,
        username: username.display,
        usernameNormalized: username.normalizedBytes,
        passwordHash,
        displayName,
      }),
    );
  }

  async listMembers(context: AuthContext, familyId: string) {
    return this.database(() =>
      this.repository.listMembers(actor(context), familyId),
    );
  }

  async updateMember(
    context: AuthContext,
    familyId: string,
    targetMemberId: string,
    input: UpdateMemberRequest,
  ) {
    this.recordManagementAttempt(context.identity.userId, familyId);
    return this.database(() =>
      this.repository.updateMember({
        actor: actor(context),
        familyId,
        targetMemberId,
        mutation:
          "role" in input
            ? { kind: "ROLE", role: input.role }
            : { kind: "DISABLED", disabled: input.disabled },
      }),
    );
  }

  private recordInvitationAttempt(ip: string) {
    const now = this.now();
    const previous = this.invitationAttempts.get(ip);
    const bucket =
      !previous || now - previous.startedAt >= 15 * 60_000
        ? { startedAt: now, count: 0 }
        : previous;
    if (bucket.count >= 30) {
      throw new PublicAuthError(
        429,
        "RATE_LIMITED",
        Math.max(1, Math.ceil((bucket.startedAt + 15 * 60_000 - now) / 1_000)),
      );
    }
    bucket.count += 1;
    this.invitationAttempts.set(ip, bucket);
    if (this.invitationAttempts.size > 10_000) {
      for (const [key, value] of this.invitationAttempts) {
        if (now - value.startedAt >= 15 * 60_000) {
          this.invitationAttempts.delete(key);
        }
      }
      if (this.invitationAttempts.size > 10_000) {
        this.invitationAttempts.delete(ip);
        throw new PublicAuthError(503, "SERVICE_UNAVAILABLE");
      }
    }
  }

  private recordManagementAttempt(userId: string, familyId: string) {
    this.recordInvitationAttempt(`management:${userId}:${familyId}`);
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
      if (error instanceof Phase1CRepositoryError) {
        if (error.reason === "INVALID_INVITATION") {
          throw new PublicAuthError(400, "INVALID_INVITATION");
        }
        if (error.reason === "UNAUTHENTICATED") {
          throw new PublicAuthError(401, "UNAUTHENTICATED");
        }
        if (error.reason === "FORBIDDEN") {
          throw new PublicAuthError(403, "FORBIDDEN");
        }
        if (error.reason === "NOT_FOUND") {
          throw new PublicAuthError(404, "FORBIDDEN");
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

function actor(context: AuthContext) {
  return {
    userId: context.identity.userId,
    sessionId: context.identity.sessionId,
    tokenHash: context.tokenHash,
  };
}

function invitationStatus(
  row: InvitationRecord,
): "PENDING" | "USED" | "REVOKED" | "EXPIRED" | "INVALIDATED" {
  if (row.usedAt) return "USED";
  if (row.revokedAt) return "REVOKED";
  if (row.serverNow.getTime() >= row.expiresAt.getTime()) return "EXPIRED";
  if (!row.creatorValid) return "INVALIDATED";
  return "PENDING";
}

function validateDisplayName(input: unknown): string | null {
  if (input === undefined) return null;
  if (typeof input !== "string" || hasMalformedUnicode(input)) {
    throw new PublicAuthError(400, "INVALID_REQUEST");
  }
  const value = input.trim();
  if (countCodePoints(value) < 1 || countCodePoints(value) > 128) {
    throw new PublicAuthError(400, "INVALID_REQUEST");
  }
  return value;
}

export type { MemberRecord };
