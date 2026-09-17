import { randomUUID } from "node:crypto";

import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  AuthRateLimiter,
  createSessionToken,
  hashPassword,
  hashSessionToken,
  normalizeUsername,
} from "../../packages/auth/src/index.js";
import {
  AuthRepositoryStateError,
  createDatabase,
  MySqlAuthRepository,
} from "../../packages/db/src/index.js";
import { AuthRepositoryStateError as ServiceAuthRepositoryStateError } from "../../packages/db/dist/index.js";
import {
  AuthService,
  type AuthRepository,
  type PasswordEngine,
} from "../../apps/api/src/auth/service.js";

const unusedPasswords: PasswordEngine = {
  verify: async () => false,
  hash: async () => "unused",
  needsRehash: () => false,
  isValidHash: (value): value is string => typeof value === "string",
};

function createAuthenticateService(
  repository: MySqlAuthRepository,
  onSessionRead: () => void,
) {
  const authRepository = {
    findSession: async (tokenHash: Buffer) => {
      const identity = await repository.findSession(tokenHash);
      onSessionRead();
      return identity;
    },
    touchSession: async (input: {
      sessionId: string;
      userId: string;
      tokenHash: Buffer;
    }) => {
      try {
        await repository.touchSession(input);
      } catch (error) {
        // The API imports the built workspace entry while this integration test
        // exercises current DB source. Preserve the production error contract
        // across those two module identities.
        if (error instanceof AuthRepositoryStateError) {
          throw new ServiceAuthRepositoryStateError(error.reason);
        }
        throw error;
      }
    },
  } as unknown as AuthRepository;
  return new AuthService(
    authRepository,
    unusedPasswords,
    new AuthRateLimiter(),
    "unused",
  );
}

const databaseUrl = process.env.DATABASE_URL;
const run = databaseUrl ? describe : describe.skip;

run("Phase 1B MySQL auth repository", () => {
  const database = createDatabase(databaseUrl!);
  const repository = new MySqlAuthRepository(database.pool);
  const suffix = randomUUID().replaceAll("-", "");
  const username = `phase1b_test_${suffix}`;
  const otherUsername = `phase1b_other_${suffix}`;
  let userId = "";
  let otherUserId = "";
  let familyId = "";
  let passwordHash = "";

  beforeAll(async () => {
    passwordHash = await hashPassword("synthetic-password");
    const connection = await database.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [family] = await connection.query<ResultSetHeader>(
        "INSERT INTO families (name) VALUES (?)",
        [`Phase 1B synthetic ${suffix}`],
      );
      familyId = String(family.insertId);
      const [user] = await connection.query<ResultSetHeader>(
        `INSERT INTO users
          (username, username_normalized, password_hash, display_name, password_changed_at)
         VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP(3))`,
        [
          username,
          normalizeUsername(username).normalizedBytes,
          passwordHash,
          "Synthetic",
        ],
      );
      userId = String(user.insertId);
      const [other] = await connection.query<ResultSetHeader>(
        `INSERT INTO users
          (username, username_normalized, password_hash, display_name, password_changed_at)
         VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP(3))`,
        [
          otherUsername,
          normalizeUsername(otherUsername).normalizedBytes,
          passwordHash,
          "Other synthetic",
        ],
      );
      otherUserId = String(other.insertId);
      await connection.query(
        "INSERT INTO family_members (family_id, user_id, role) VALUES (?, ?, 'MEMBER')",
        [familyId, userId],
      );
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }, 20_000);

  afterAll(async () => {
    const connection = await database.pool.getConnection();
    try {
      await connection.beginTransaction();
      if (userId && otherUserId) {
        await connection.query("DELETE FROM sessions WHERE user_id IN (?, ?)", [
          userId,
          otherUserId,
        ]);
        await connection.query(
          "DELETE FROM family_members WHERE user_id IN (?, ?)",
          [userId, otherUserId],
        );
        await connection.query("DELETE FROM users WHERE id IN (?, ?)", [
          userId,
          otherUserId,
        ]);
      }
      if (familyId)
        await connection.query("DELETE FROM families WHERE id = ?", [familyId]);
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
      await database.pool.end();
    }
  });

  it("issues and reads a WEB session with exact string IDs", async () => {
    const token = createSessionToken();
    const issued = await repository.issueLoginSession({
      userId,
      expectedPasswordHash: passwordHash,
      tokenHash: hashSessionToken(token),
      deviceLabel: "Synthetic browser",
    });
    expect(typeof issued.sessionId).toBe("string");
    const session = await repository.findSession(hashSessionToken(token));
    expect(session).toMatchObject({
      userId,
      clientType: "WEB",
      revokedAt: null,
    });
    expect(await repository.listMemberships(userId)).toHaveLength(1);
  });

  it("refuses login session issuance without an active membership", async () => {
    await expect(
      repository.issueLoginSession({
        userId: otherUserId,
        expectedPasswordHash: passwordHash,
        tokenHash: hashSessionToken(createSessionToken()),
        deviceLabel: null,
      }),
    ).rejects.toMatchObject({ reason: "INVALID_CREDENTIALS" });
  });

  it("makes logout revocation idempotent", async () => {
    const logoutToken = createSessionToken();
    await repository.issueLoginSession({
      userId,
      expectedPasswordHash: passwordHash,
      tokenHash: hashSessionToken(logoutToken),
      deviceLabel: null,
    });
    expect(
      await repository.revokeByToken(hashSessionToken(logoutToken)),
    ).toEqual({
      sessionStillAddressable: true,
    });
    const first = await repository.findSession(hashSessionToken(logoutToken));
    expect(
      await repository.revokeByToken(hashSessionToken(logoutToken)),
    ).toEqual({
      sessionStillAddressable: true,
    });
    const second = await repository.findSession(hashSessionToken(logoutToken));
    expect(first?.revokedAt).toBeInstanceOf(Date);
    expect(second?.revokedAt.getTime()).toBe(first?.revokedAt.getTime());
  });

  it("allows only one concurrent reauth rotation for the same old token", async () => {
    const oldToken = createSessionToken();
    const issued = await repository.issueLoginSession({
      userId,
      expectedPasswordHash: passwordHash,
      tokenHash: hashSessionToken(oldToken),
      deviceLabel: null,
    });
    const attempts = await Promise.allSettled([
      repository.rotateSession({
        userId,
        sessionId: issued.sessionId,
        oldTokenHash: hashSessionToken(oldToken),
        newTokenHash: hashSessionToken(createSessionToken()),
        expectedPasswordHash: passwordHash,
      }),
      repository.rotateSession({
        userId,
        sessionId: issued.sessionId,
        oldTokenHash: hashSessionToken(oldToken),
        newTokenHash: hashSessionToken(createSessionToken()),
        expectedPasswordHash: passwordHash,
      }),
    ]);
    expect(
      attempts.filter((attempt) => attempt.status === "fulfilled"),
    ).toHaveLength(1);
    const failure = attempts.find((attempt) => attempt.status === "rejected");
    expect((failure as PromiseRejectedResult).reason).toBeInstanceOf(
      AuthRepositoryStateError,
    );
  });

  it("does not treat a rotated old token as a logout target", async () => {
    const oldToken = createSessionToken();
    const issued = await repository.issueLoginSession({
      userId,
      expectedPasswordHash: passwordHash,
      tokenHash: hashSessionToken(oldToken),
      deviceLabel: null,
    });
    await repository.rotateSession({
      userId,
      sessionId: issued.sessionId,
      oldTokenHash: hashSessionToken(oldToken),
      newTokenHash: hashSessionToken(createSessionToken()),
      expectedPasswordHash: passwordHash,
    });
    expect(await repository.revokeByToken(hashSessionToken(oldToken))).toEqual({
      sessionStillAddressable: false,
    });
  });

  it("cannot revoke another user's session by changing the ID", async () => {
    const callerToken = createSessionToken();
    const caller = await repository.issueLoginSession({
      userId,
      expectedPasswordHash: passwordHash,
      tokenHash: hashSessionToken(callerToken),
      deviceLabel: null,
    });
    const connection = await database.pool.getConnection();
    let targetId: string;
    const targetToken = createSessionToken();
    try {
      const [target] = await connection.query<ResultSetHeader>(
        `INSERT INTO sessions
          (user_id, token_hash, client_type, authenticated_at, last_seen_at, expires_at)
         VALUES (?, ?, 'WEB', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3),
                 DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL 30 DAY))`,
        [otherUserId, hashSessionToken(targetToken)],
      );
      targetId = String(target.insertId);
    } finally {
      connection.release();
    }
    expect(
      await repository.revokeOwnSession({
        userId,
        callerSessionId: caller.sessionId,
        callerTokenHash: hashSessionToken(callerToken),
        targetSessionId: targetId,
      }),
    ).toEqual({ revokedCurrent: false });
    expect(
      (await repository.findSession(hashSessionToken(targetToken)))?.revokedAt,
    ).toBeNull();
  });

  it("changes password, revokes old sessions, and creates one replacement atomically", async () => {
    const oldToken = createSessionToken();
    const issued = await repository.issueLoginSession({
      userId,
      expectedPasswordHash: passwordHash,
      tokenHash: hashSessionToken(oldToken),
      deviceLabel: null,
    });
    const newHash = await hashPassword("new-synthetic-password");
    const replacementToken = createSessionToken();
    await repository.changePassword({
      userId,
      sessionId: issued.sessionId,
      oldTokenHash: hashSessionToken(oldToken),
      replacementTokenHash: hashSessionToken(replacementToken),
      expectedPasswordHash: passwordHash,
      newPasswordHash: newHash,
      deviceLabel: null,
    });
    expect(
      (await repository.findSession(hashSessionToken(oldToken)))?.revokedAt,
    ).not.toBeNull();
    expect(
      await repository.findSession(hashSessionToken(replacementToken)),
    ).toMatchObject({ revokedAt: null, passwordHash: newHash });
    passwordHash = newHash;

    const [rows] = await database.pool.query<RowDataPacket[]>(
      "SELECT COUNT(*) AS active FROM sessions WHERE user_id = ? AND revoked_at IS NULL",
      [userId],
    );
    expect(String(rows[0]?.active)).toBe("1");
  }, 20_000);

  it("throttles last_seen writes and never changes absolute expiry", async () => {
    const activityToken = createSessionToken();
    const issued = await repository.issueLoginSession({
      userId,
      expectedPasswordHash: passwordHash,
      tokenHash: hashSessionToken(activityToken),
      deviceLabel: null,
    });
    const before = await repository.findSession(
      hashSessionToken(activityToken),
    );
    await repository.touchSession({
      sessionId: issued.sessionId,
      userId,
      tokenHash: hashSessionToken(activityToken),
    });
    const throttled = await repository.findSession(
      hashSessionToken(activityToken),
    );
    expect(throttled?.lastSeenAt.getTime()).toBe(before?.lastSeenAt.getTime());
    expect(throttled?.expiresAt.getTime()).toBe(before?.expiresAt.getTime());

    await database.pool.query(
      `UPDATE sessions
          SET created_at = DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL 10 MINUTE),
              last_seen_at = DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL 6 MINUTE)
        WHERE id = ?`,
      [issued.sessionId],
    );
    await repository.touchSession({
      sessionId: issued.sessionId,
      userId,
      tokenHash: hashSessionToken(activityToken),
    });
    const touched = await repository.findSession(
      hashSessionToken(activityToken),
    );
    expect(touched!.lastSeenAt.getTime()).toBeGreaterThan(
      throttled!.lastSeenAt.getTime() - 6 * 60_000,
    );
    expect(touched?.expiresAt.getTime()).toBe(before?.expiresAt.getTime());
  });

  it("rejects authenticate when touch waits across the idle deadline", async () => {
    const activityToken = createSessionToken();
    const tokenHash = hashSessionToken(activityToken);
    const issued = await repository.issueLoginSession({
      userId,
      expectedPasswordHash: passwordHash,
      tokenHash,
      deviceLabel: null,
    });
    await database.pool.query(
      `UPDATE sessions
          SET created_at = DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL 8 DAY),
              last_seen_at = DATE_ADD(
                DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL 7 DAY),
                INTERVAL 1 SECOND
              )
        WHERE id = ?`,
      [issued.sessionId],
    );
    const before = await repository.findSession(tokenHash);
    expect(before).not.toBeNull();
    expect(before!.lastSeenAt.getTime() + 7 * 24 * 60 * 60_000).toBeGreaterThan(
      before!.serverNow.getTime(),
    );
    let signalSessionRead!: () => void;
    const sessionRead = new Promise<void>((resolve) => {
      signalSessionRead = resolve;
    });
    const service = createAuthenticateService(repository, signalSessionRead);

    const barrier = await database.pool.getConnection();
    let barrierCommitted = false;
    try {
      await barrier.beginTransaction();
      await barrier.query(
        "SELECT id FROM sessions WHERE id = ? AND user_id = ? FOR UPDATE",
        [issued.sessionId, userId],
      );
      const authentication = service.authenticate(activityToken);
      const authenticationResult = expect(authentication).rejects.toMatchObject(
        {
          code: "UNAUTHENTICATED",
          statusCode: 401,
        },
      );
      await sessionRead;
      const state = await Promise.race([
        authentication.then(
          () => "settled",
          () => "settled",
        ),
        delay(50).then(() => "waiting"),
      ]);
      expect(state).toBe("waiting");
      await delay(1_100);
      await barrier.commit();
      barrierCommitted = true;
      await authenticationResult;
    } catch (error) {
      if (!barrierCommitted) await barrier.rollback();
      throw error;
    } finally {
      barrier.release();
    }

    const after = await repository.findSession(tokenHash);
    expect(after?.lastSeenAt.getTime()).toBe(before?.lastSeenAt.getTime());
    await expect(service.authenticate(activityToken)).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
      statusCode: 401,
    });
  });

  it("rejects authenticate when touch waits across absolute expiry", async () => {
    const activityToken = createSessionToken();
    const tokenHash = hashSessionToken(activityToken);
    const issued = await repository.issueLoginSession({
      userId,
      expectedPasswordHash: passwordHash,
      tokenHash,
      deviceLabel: null,
    });
    await database.pool.query(
      `UPDATE sessions
          SET created_at = DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL 10 MINUTE),
              last_seen_at = DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL 6 MINUTE),
              expires_at = DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL 1 SECOND)
        WHERE id = ?`,
      [issued.sessionId],
    );
    const before = await repository.findSession(tokenHash);
    expect(before).not.toBeNull();
    expect(before!.expiresAt.getTime()).toBeGreaterThan(
      before!.serverNow.getTime(),
    );
    let signalSessionRead!: () => void;
    const sessionRead = new Promise<void>((resolve) => {
      signalSessionRead = resolve;
    });
    const service = createAuthenticateService(repository, signalSessionRead);

    const barrier = await database.pool.getConnection();
    let barrierCommitted = false;
    try {
      await barrier.beginTransaction();
      await barrier.query(
        "SELECT id FROM sessions WHERE id = ? AND user_id = ? FOR UPDATE",
        [issued.sessionId, userId],
      );
      const authentication = service.authenticate(activityToken);
      const authenticationResult = expect(authentication).rejects.toMatchObject(
        {
          code: "UNAUTHENTICATED",
          statusCode: 401,
        },
      );
      await sessionRead;
      const state = await Promise.race([
        authentication.then(
          () => "settled",
          () => "settled",
        ),
        delay(50).then(() => "waiting"),
      ]);
      expect(state).toBe("waiting");
      await delay(1_100);
      await barrier.commit();
      barrierCommitted = true;
      await authenticationResult;
    } catch (error) {
      if (!barrierCommitted) await barrier.rollback();
      throw error;
    } finally {
      barrier.release();
    }

    const after = await repository.findSession(tokenHash);
    expect(after?.lastSeenAt.getTime()).toBe(before?.lastSeenAt.getTime());
    await expect(service.authenticate(activityToken)).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
      statusCode: 401,
    });
  });

  it("serializes concurrent login and password change without leaving old sessions active", async () => {
    const callerToken = createSessionToken();
    const caller = await repository.issueLoginSession({
      userId,
      expectedPasswordHash: passwordHash,
      tokenHash: hashSessionToken(callerToken),
      deviceLabel: null,
    });
    const nextHash = await hashPassword("next-synthetic-password");
    const replacementToken = createSessionToken();
    const racingToken = createSessionToken();
    const [login, change] = await Promise.allSettled([
      repository.issueLoginSession({
        userId,
        expectedPasswordHash: passwordHash,
        tokenHash: hashSessionToken(racingToken),
        deviceLabel: null,
      }),
      repository.changePassword({
        userId,
        sessionId: caller.sessionId,
        oldTokenHash: hashSessionToken(callerToken),
        replacementTokenHash: hashSessionToken(replacementToken),
        expectedPasswordHash: passwordHash,
        newPasswordHash: nextHash,
        deviceLabel: null,
      }),
    ]);
    expect(change.status).toBe("fulfilled");
    expect(["fulfilled", "rejected"]).toContain(login.status);
    const [rows] = await database.pool.query<RowDataPacket[]>(
      "SELECT COUNT(*) AS active FROM sessions WHERE user_id = ? AND revoked_at IS NULL",
      [userId],
    );
    expect(String(rows[0]?.active)).toBe("1");
    expect(
      await repository.findSession(hashSessionToken(replacementToken)),
    ).toMatchObject({ revokedAt: null, passwordHash: nextHash });
    passwordHash = nextHash;
  }, 20_000);

  it("serializes logout-all with concurrent login using commit-order semantics", async () => {
    const callerToken = createSessionToken();
    const caller = await repository.issueLoginSession({
      userId,
      expectedPasswordHash: passwordHash,
      tokenHash: hashSessionToken(callerToken),
      deviceLabel: null,
    });
    const loginToken = createSessionToken();
    const results = await Promise.allSettled([
      repository.revokeAll({
        userId,
        sessionId: caller.sessionId,
        tokenHash: hashSessionToken(callerToken),
      }),
      repository.issueLoginSession({
        userId,
        expectedPasswordHash: passwordHash,
        tokenHash: hashSessionToken(loginToken),
        deviceLabel: null,
      }),
    ]);
    expect(results.every((result) => result.status === "fulfilled")).toBe(true);
    expect(
      (await repository.findSession(hashSessionToken(callerToken)))?.revokedAt,
    ).not.toBeNull();
    const [rows] = await database.pool.query<RowDataPacket[]>(
      "SELECT COUNT(*) AS active FROM sessions WHERE user_id = ? AND revoked_at IS NULL",
      [userId],
    );
    // Login before logout-all is revoked; login after logout-all is the only survivor.
    expect(Number(rows[0]?.active)).toBeLessThanOrEqual(1);
  });

  it("revokes a login committed before a waiting logout-all", async () => {
    const callerToken = createSessionToken();
    const caller = await repository.issueLoginSession({
      userId,
      expectedPasswordHash: passwordHash,
      tokenHash: hashSessionToken(callerToken),
      deviceLabel: null,
    });
    const loginToken = createSessionToken();
    const barrier = await database.pool.getConnection();
    try {
      await barrier.beginTransaction();
      await barrier.query("SELECT id FROM users WHERE id = ? FOR UPDATE", [
        userId,
      ]);
      await barrier.query(
        `INSERT INTO sessions
          (user_id, token_hash, client_type, authenticated_at, last_seen_at, expires_at)
         VALUES (?, ?, 'WEB', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3),
                 DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL 30 DAY))`,
        [userId, hashSessionToken(loginToken)],
      );
      const waitingLogoutAll = repository.revokeAll({
        userId,
        sessionId: caller.sessionId,
        tokenHash: hashSessionToken(callerToken),
      });
      await delay(30);
      await barrier.commit();
      await waitingLogoutAll;
    } catch (error) {
      await barrier.rollback();
      throw error;
    } finally {
      barrier.release();
    }
    expect(
      (await repository.findSession(hashSessionToken(loginToken)))?.revokedAt,
    ).toBeInstanceOf(Date);
  });

  it("keeps a login issued after a committed revoke-all", async () => {
    const loginToken = createSessionToken();
    const barrier = await database.pool.getConnection();
    try {
      await barrier.beginTransaction();
      await barrier.query("SELECT id FROM users WHERE id = ? FOR UPDATE", [
        userId,
      ]);
      await barrier.query(
        "SELECT id FROM sessions WHERE user_id = ? ORDER BY id ASC FOR UPDATE",
        [userId],
      );
      await barrier.query(
        `UPDATE sessions SET revoked_at = CURRENT_TIMESTAMP(3), revoke_reason = 'LOGOUT_ALL'
          WHERE user_id = ? AND revoked_at IS NULL ORDER BY id ASC`,
        [userId],
      );
      const waitingLogin = repository.issueLoginSession({
        userId,
        expectedPasswordHash: passwordHash,
        tokenHash: hashSessionToken(loginToken),
        deviceLabel: null,
      });
      await delay(30);
      await barrier.commit();
      await waitingLogin;
    } catch (error) {
      await barrier.rollback();
      throw error;
    } finally {
      barrier.release();
    }
    expect(
      await repository.findSession(hashSessionToken(loginToken)),
    ).toMatchObject({ revokedAt: null });
  });

  it("rejects a stale login after a password change wins the user lock", async () => {
    const oldHash = passwordHash;
    const nextHash = await hashPassword("barrier-synthetic-password");
    const replacementToken = createSessionToken();
    const staleLoginToken = createSessionToken();
    const barrier = await database.pool.getConnection();
    try {
      await barrier.beginTransaction();
      await barrier.query("SELECT id FROM users WHERE id = ? FOR UPDATE", [
        userId,
      ]);
      await barrier.query(
        "SELECT id FROM sessions WHERE user_id = ? ORDER BY id ASC FOR UPDATE",
        [userId],
      );
      await barrier.query(
        "UPDATE users SET password_hash = ?, password_changed_at = CURRENT_TIMESTAMP(3) WHERE id = ?",
        [nextHash, userId],
      );
      await barrier.query(
        `UPDATE sessions SET revoked_at = CURRENT_TIMESTAMP(3), revoke_reason = 'PASSWORD_CHANGE'
          WHERE user_id = ? AND revoked_at IS NULL ORDER BY id ASC`,
        [userId],
      );
      await barrier.query(
        `INSERT INTO sessions
          (user_id, token_hash, client_type, authenticated_at, last_seen_at, expires_at)
         VALUES (?, ?, 'WEB', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3),
                 DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL 30 DAY))`,
        [userId, hashSessionToken(replacementToken)],
      );
      const waitingLogin = repository.issueLoginSession({
        userId,
        expectedPasswordHash: oldHash,
        tokenHash: hashSessionToken(staleLoginToken),
        deviceLabel: null,
      });
      await delay(30);
      await barrier.commit();
      await expect(waitingLogin).rejects.toMatchObject({
        reason: "INVALID_CREDENTIALS",
      });
    } catch (error) {
      await barrier.rollback();
      throw error;
    } finally {
      barrier.release();
    }
    passwordHash = nextHash;
    expect(
      await repository.findSession(hashSessionToken(replacementToken)),
    ).toMatchObject({ revokedAt: null, passwordHash: nextHash });
    expect(
      await repository.findSession(hashSessionToken(staleLoginToken)),
    ).toBeNull();
  }, 20_000);

  it("keeps cross-revoke races consistent under the shared lock order", async () => {
    const firstToken = createSessionToken();
    const secondToken = createSessionToken();
    const first = await repository.issueLoginSession({
      userId,
      expectedPasswordHash: passwordHash,
      tokenHash: hashSessionToken(firstToken),
      deviceLabel: null,
    });
    const second = await repository.issueLoginSession({
      userId,
      expectedPasswordHash: passwordHash,
      tokenHash: hashSessionToken(secondToken),
      deviceLabel: null,
    });
    const results = await Promise.allSettled([
      repository.revokeOwnSession({
        userId,
        callerSessionId: first.sessionId,
        callerTokenHash: hashSessionToken(firstToken),
        targetSessionId: second.sessionId,
      }),
      repository.revokeOwnSession({
        userId,
        callerSessionId: second.sessionId,
        callerTokenHash: hashSessionToken(secondToken),
        targetSessionId: first.sessionId,
      }),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
  });

  it("rechecks server time after a user-lock wait crosses absolute expiry", async () => {
    const expiringToken = createSessionToken();
    const issued = await repository.issueLoginSession({
      userId,
      expectedPasswordHash: passwordHash,
      tokenHash: hashSessionToken(expiringToken),
      deviceLabel: null,
    });
    await database.pool.query(
      `UPDATE sessions SET expires_at = DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL 1 SECOND)
        WHERE id = ?`,
      [issued.sessionId],
    );
    const barrier = await database.pool.getConnection();
    try {
      await barrier.beginTransaction();
      await barrier.query("SELECT id FROM users WHERE id = ? FOR UPDATE", [
        userId,
      ]);
      const waiting = repository.revokeAll({
        userId,
        sessionId: issued.sessionId,
        tokenHash: hashSessionToken(expiringToken),
      });
      await delay(1_150);
      await barrier.commit();
      await expect(waiting).rejects.toMatchObject({
        reason: "UNAUTHENTICATED",
      });
    } catch (error) {
      await barrier.rollback();
      throw error;
    } finally {
      barrier.release();
    }
  });

  it("rechecks server time after a user-lock wait crosses idle expiry", async () => {
    const idleToken = createSessionToken();
    const issued = await repository.issueLoginSession({
      userId,
      expectedPasswordHash: passwordHash,
      tokenHash: hashSessionToken(idleToken),
      deviceLabel: null,
    });
    await database.pool.query(
      `UPDATE sessions
          SET created_at = DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL 8 DAY),
              last_seen_at = DATE_ADD(DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL 7 DAY), INTERVAL 1 SECOND)
        WHERE id = ?`,
      [issued.sessionId],
    );
    const barrier = await database.pool.getConnection();
    try {
      await barrier.beginTransaction();
      await barrier.query("SELECT id FROM users WHERE id = ? FOR UPDATE", [
        userId,
      ]);
      const waiting = repository.revokeAll({
        userId,
        sessionId: issued.sessionId,
        tokenHash: hashSessionToken(idleToken),
      });
      await delay(1_150);
      await barrier.commit();
      await expect(waiting).rejects.toMatchObject({
        reason: "UNAUTHENTICATED",
      });
    } catch (error) {
      await barrier.rollback();
      throw error;
    } finally {
      barrier.release();
    }
  });
});

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
