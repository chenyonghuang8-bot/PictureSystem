import {
  Argon2CapacityError,
  AuthRateLimitCapacityError,
  AuthRateLimiter,
  AuthRateLimitError,
  createSessionToken,
  hashSessionToken,
  normalizeUsername,
  createPasswordEngine,
  type PasswordEngine,
  validatePassword,
} from "@family-album/auth";
import {
  AuthRepositoryStateError,
  CommitOutcomeUnknownError,
  type Membership,
  type MySqlAuthRepository,
  type SessionIdentity,
  type SessionRecord,
  TransactionRollbackFailedError,
} from "@family-album/db";
import type { AuthErrorCode } from "@family-album/contracts";

export type { PasswordEngine } from "@family-album/auth";

const IDLE_TIMEOUT_MS = 7 * 24 * 60 * 60_000;
const RECENT_AUTH_MS = 15 * 60_000;

export class PublicAuthError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: AuthErrorCode,
    readonly retryAfterSeconds?: number,
    readonly errorCategory?: SecurityErrorCategory,
  ) {
    super(code);
    this.name = "PublicAuthError";
  }
}

export type SecurityErrorCategory =
  | "INVALID_PASSWORD"
  | "CREDENTIAL_CORRUPTION"
  | "ARGON2_CAPACITY_EXHAUSTED"
  | "ARGON2_EXECUTION_FAILURE"
  | "COMMIT_OUTCOME_UNKNOWN"
  | "ROLLBACK_FAILED"
  | "DATABASE_FAILURE";

export type AuthContext = {
  identity: SessionIdentity;
  tokenHash: Buffer;
};

export type IssuedWebSession = {
  token: string;
  expiresAt: Date;
  serverNow: Date;
};

export type AuthRepository = Pick<
  MySqlAuthRepository,
  | "findLoginUser"
  | "issueLoginSession"
  | "findSession"
  | "touchSession"
  | "listMemberships"
  | "revokeByToken"
  | "listSessions"
  | "revokeOwnSession"
  | "rotateSession"
  | "revokeAll"
  | "changePassword"
>;

export class AuthService {
  constructor(
    private readonly repository: AuthRepository,
    private readonly passwords: PasswordEngine,
    private readonly rateLimiter: AuthRateLimiter,
    private readonly dummyPasswordHash: string,
  ) {}

  static async create(
    repository: AuthRepository,
    passwords: PasswordEngine = createPasswordEngine(),
  ) {
    const dummyPasswordHash = await passwords.hash("synthetic-dummy-password");
    return new AuthService(
      repository,
      passwords,
      new AuthRateLimiter(),
      dummyPasswordHash,
    );
  }

  async login(input: {
    username: unknown;
    password: unknown;
    deviceLabel: string | null;
    ip: string;
  }): Promise<IssuedWebSession> {
    this.ipAttempt(input.ip);
    const username = normalizeUsername(input.username);
    const lease = this.reserve(username.normalized, input.ip);
    let success = false;
    try {
      const user = await this.database(() =>
        this.repository.findLoginUser(username.normalizedBytes),
      );
      const hash = user?.passwordHash ?? this.dummyPasswordHash;
      const passwordMatches = await this.passwordVerify(hash, input.password);
      if (!user || !passwordMatches || user.disabledAt) {
        throw new PublicAuthError(
          401,
          "INVALID_CREDENTIALS",
          undefined,
          "INVALID_PASSWORD",
        );
      }

      const replacementPasswordHash = this.passwords.needsRehash(hash)
        ? await this.passwordHash(input.password)
        : undefined;
      const token = createSessionToken();
      const tokenHash = hashSessionToken(token);
      const issued = await this.database(() =>
        this.repository.issueLoginSession({
          userId: user.id,
          expectedPasswordHash: hash,
          ...(replacementPasswordHash ? { replacementPasswordHash } : {}),
          tokenHash,
          deviceLabel: input.deviceLabel,
        }),
      );
      success = true;
      return {
        token,
        expiresAt: issued.expiresAt,
        serverNow: issued.serverNow,
      };
    } catch (error) {
      if (
        error instanceof AuthRepositoryStateError &&
        error.reason === "INVALID_CREDENTIALS"
      ) {
        throw new PublicAuthError(
          401,
          "INVALID_CREDENTIALS",
          undefined,
          "INVALID_PASSWORD",
        );
      }
      throw error;
    } finally {
      lease.finish(success);
    }
  }

  async authenticate(token: unknown): Promise<AuthContext> {
    let tokenHash: Buffer;
    try {
      tokenHash = hashSessionToken(token);
    } catch {
      throw new PublicAuthError(401, "UNAUTHENTICATED");
    }
    const identity = await this.database(() =>
      this.repository.findSession(tokenHash),
    );
    if (!identity || !this.isValid(identity)) {
      throw new PublicAuthError(401, "UNAUTHENTICATED");
    }
    await this.database(() =>
      this.repository.touchSession({
        sessionId: identity.sessionId,
        userId: identity.userId,
        tokenHash,
      }),
    );
    return { identity, tokenHash };
  }

  async me(context: AuthContext): Promise<{ memberships: Membership[] }> {
    return {
      memberships: await this.database(() =>
        this.repository.listMemberships(context.identity.userId),
      ),
    };
  }

  async logout(token: unknown): Promise<{ clearCookie: boolean }> {
    let tokenHash: Buffer;
    try {
      tokenHash = hashSessionToken(token);
    } catch {
      return { clearCookie: true };
    }
    const result = await this.database(() =>
      this.repository.revokeByToken(tokenHash),
    );
    return { clearCookie: result.sessionStillAddressable };
  }

  async sessions(context: AuthContext): Promise<SessionRecord[]> {
    return this.database(() =>
      this.repository.listSessions(context.identity.userId),
    );
  }

  async revokeSession(
    context: AuthContext,
    targetSessionId: string,
  ): Promise<{ revokedCurrent: boolean }> {
    return this.database(() =>
      this.repository.revokeOwnSession({
        userId: context.identity.userId,
        callerSessionId: context.identity.sessionId,
        callerTokenHash: context.tokenHash,
        targetSessionId,
      }),
    );
  }

  async reauthenticate(
    context: AuthContext,
    password: unknown,
    ip: string,
  ): Promise<IssuedWebSession> {
    await this.verifyKnownUser(context, password, ip);
    const token = createSessionToken();
    const result = await this.database(() =>
      this.repository.rotateSession({
        userId: context.identity.userId,
        sessionId: context.identity.sessionId,
        oldTokenHash: context.tokenHash,
        newTokenHash: hashSessionToken(token),
        expectedPasswordHash: context.identity.passwordHash,
      }),
    );
    return { token, ...result };
  }

  async logoutAll(context: AuthContext): Promise<void> {
    if (!this.isRecent(context.identity)) {
      throw new PublicAuthError(403, "FORBIDDEN");
    }
    await this.database(() =>
      this.repository.revokeAll({
        userId: context.identity.userId,
        sessionId: context.identity.sessionId,
        tokenHash: context.tokenHash,
      }),
    );
  }

  async changePassword(
    context: AuthContext,
    input: { currentPassword: unknown; newPassword: unknown; ip: string },
  ): Promise<IssuedWebSession> {
    if (!this.isRecent(context.identity)) {
      throw new PublicAuthError(403, "FORBIDDEN");
    }
    await this.verifyKnownUser(context, input.currentPassword, input.ip);
    const newPasswordHash = await this.passwordHash(input.newPassword);
    const token = createSessionToken();
    const result = await this.database(() =>
      this.repository.changePassword({
        userId: context.identity.userId,
        sessionId: context.identity.sessionId,
        oldTokenHash: context.tokenHash,
        replacementTokenHash: hashSessionToken(token),
        expectedPasswordHash: context.identity.passwordHash,
        newPasswordHash,
        deviceLabel: null,
      }),
    );
    return { token, ...result };
  }

  private async verifyKnownUser(
    context: AuthContext,
    password: unknown,
    ip: string,
  ) {
    this.ipAttempt(ip);
    const normalized = normalizeUsername(context.identity.username).normalized;
    const lease = this.reserve(normalized, ip);
    let success = false;
    try {
      if (
        !(await this.passwordVerify(context.identity.passwordHash, password))
      ) {
        throw new PublicAuthError(
          401,
          "INVALID_CREDENTIALS",
          undefined,
          "INVALID_PASSWORD",
        );
      }
      success = true;
    } finally {
      lease.finish(success);
    }
  }

  private isValid(identity: SessionIdentity) {
    const now = identity.serverNow.getTime();
    return (
      identity.clientType === "WEB" &&
      identity.revokedAt === null &&
      identity.disabledAt === null &&
      now < identity.expiresAt.getTime() &&
      now < identity.lastSeenAt.getTime() + IDLE_TIMEOUT_MS
    );
  }

  private isRecent(identity: SessionIdentity) {
    const age =
      identity.serverNow.getTime() - identity.authenticatedAt.getTime();
    return age >= 0 && age < RECENT_AUTH_MS;
  }

  private ipAttempt(ip: string) {
    try {
      this.rateLimiter.recordIpAttempt(ip);
    } catch (error) {
      this.mapCapacity(error);
    }
  }

  private reserve(username: string, ip: string) {
    try {
      return this.rateLimiter.reserveCredentialAttempt(username, ip);
    } catch (error) {
      return this.mapCapacity(error);
    }
  }

  private async passwordVerify(hash: string, password: unknown) {
    try {
      password = validatePassword(password);
    } catch {
      return false;
    }
    if (!this.passwords.isValidHash(hash)) {
      throw new PublicAuthError(
        503,
        "SERVICE_UNAVAILABLE",
        undefined,
        "CREDENTIAL_CORRUPTION",
      );
    }
    try {
      return await this.passwords.verify(hash, password);
    } catch (error) {
      if (error instanceof Argon2CapacityError) {
        throw new PublicAuthError(
          503,
          "SERVICE_UNAVAILABLE",
          undefined,
          "ARGON2_CAPACITY_EXHAUSTED",
        );
      }
      throw new PublicAuthError(
        503,
        "SERVICE_UNAVAILABLE",
        undefined,
        "ARGON2_EXECUTION_FAILURE",
      );
    }
  }

  private async passwordHash(password: unknown) {
    try {
      password = validatePassword(password);
    } catch {
      throw new PublicAuthError(400, "INVALID_REQUEST");
    }
    try {
      return await this.passwords.hash(password);
    } catch (error) {
      if (error instanceof Argon2CapacityError) {
        throw new PublicAuthError(
          503,
          "SERVICE_UNAVAILABLE",
          undefined,
          "ARGON2_CAPACITY_EXHAUSTED",
        );
      }
      throw new PublicAuthError(
        503,
        "SERVICE_UNAVAILABLE",
        undefined,
        "ARGON2_EXECUTION_FAILURE",
      );
    }
  }

  private mapCapacity(error: unknown): never {
    if (error instanceof AuthRateLimitError) {
      throw new PublicAuthError(429, "RATE_LIMITED", error.retryAfterSeconds);
    }
    if (error instanceof AuthRateLimitCapacityError) {
      throw new PublicAuthError(503, "SERVICE_UNAVAILABLE");
    }
    throw error;
  }

  private async database<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
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
      if (error instanceof AuthRepositoryStateError) {
        if (error.reason === "RECENT_AUTH_REQUIRED") {
          throw new PublicAuthError(403, "FORBIDDEN");
        }
        if (error.reason === "INVALID_CREDENTIALS") {
          throw new PublicAuthError(401, "INVALID_CREDENTIALS");
        }
        if (error.reason === "UNAUTHENTICATED") {
          throw new PublicAuthError(401, "UNAUTHENTICATED");
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
