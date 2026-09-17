import { describe, expect, it, vi } from "vitest";

import {
  AuthRateLimiter,
  createSessionToken,
  hashSessionToken,
} from "@family-album/auth";
import {
  AuthRepositoryStateError,
  type SessionIdentity,
} from "@family-album/db";

import {
  AuthService,
  type AuthContext,
  type AuthRepository,
  type PasswordEngine,
} from "./service.js";

const now = new Date("2026-01-10T00:00:00.000Z");
const token = createSessionToken();

function identity(overrides: Partial<SessionIdentity> = {}): SessionIdentity {
  return {
    sessionId: "9007199254740993",
    userId: "9007199254740995",
    username: "Dad",
    displayName: "Dad",
    passwordHash: "phc",
    clientType: "WEB",
    authenticatedAt: new Date(now.getTime() - 60_000),
    createdAt: new Date(now.getTime() - 60_000),
    lastSeenAt: new Date(now.getTime() - 60_000),
    expiresAt: new Date(now.getTime() + 60_000),
    revokedAt: null,
    disabledAt: null,
    serverNow: now,
    ...overrides,
  };
}

function setup(
  options: { user?: "valid" | "unknown" | "disabled"; password?: boolean } = {},
) {
  const repository = {
    findLoginUser: vi.fn(async () =>
      options.user === "unknown"
        ? null
        : {
            id: "9007199254740995",
            passwordHash: "phc",
            disabledAt: options.user === "disabled" ? now : null,
          },
    ),
    issueLoginSession: vi.fn(async () => ({
      sessionId: "9007199254740993",
      expiresAt: new Date(now.getTime() + 60_000),
      serverNow: now,
    })),
    findSession: vi.fn(async () => identity()),
    touchSession: vi.fn(async () => undefined),
    listMemberships: vi.fn(async () => []),
    revokeByToken: vi.fn(async () => undefined),
    listSessions: vi.fn(async () => []),
    revokeOwnSession: vi.fn(async () => ({ revokedCurrent: false })),
    rotateSession: vi.fn(async () => ({
      expiresAt: new Date(now.getTime() + 60_000),
      serverNow: now,
    })),
    revokeAll: vi.fn(async () => undefined),
    changePassword: vi.fn(async () => ({
      expiresAt: new Date(now.getTime() + 60_000),
      serverNow: now,
    })),
  } as unknown as AuthRepository;
  const passwords: PasswordEngine = {
    verify: vi.fn(async (hash, candidate) =>
      hash === "dummy"
        ? false
        : options.password !== false && candidate === "password1",
    ),
    hash: vi.fn(async () => "new-phc"),
    needsRehash: vi.fn(() => false),
    isValidHash: (hash): hash is string => hash !== "bad-phc",
  };
  return {
    repository,
    passwords,
    service: new AuthService(
      repository,
      passwords,
      new AuthRateLimiter(),
      "dummy",
    ),
  };
}

describe("AuthService", () => {
  it("normalizes usernames and creates a fresh hashed session", async () => {
    const { service, repository } = setup();
    const result = await service.login({
      username: " Ｄａｄ ",
      password: "password1",
      deviceLabel: null,
      ip: "127.0.0.1",
    });
    expect(repository.findLoginUser).toHaveBeenCalledWith(Buffer.from("dad"));
    expect(repository.issueLoginSession).toHaveBeenCalledWith(
      expect.objectContaining({ tokenHash: hashSessionToken(result.token) }),
    );
  });

  it.each(["unknown", "disabled"] as const)(
    "uses one verify and a uniform response for %s users",
    async (user) => {
      const { service, passwords } = setup({ user });
      await expect(
        service.login({
          username: "Dad",
          password: "password1",
          deviceLabel: null,
          ip: `127.0.0.${user === "unknown" ? "2" : "3"}`,
        }),
      ).rejects.toMatchObject({ code: "INVALID_CREDENTIALS", statusCode: 401 });
      expect(passwords.verify).toHaveBeenCalledTimes(1);
      if (user === "unknown")
        expect(passwords.verify).toHaveBeenCalledWith("dummy", "password1");
    },
  );

  it("rejects wrong passwords without issuing a session", async () => {
    const { service, repository } = setup({ password: false });
    await expect(
      service.login({
        username: "Dad",
        password: "password1",
        deviceLabel: null,
        ip: "127.0.0.4",
      }),
    ).rejects.toMatchObject({
      code: "INVALID_CREDENTIALS",
      statusCode: 401,
      errorCategory: "INVALID_PASSWORD",
    });
    expect(repository.issueLoginSession).not.toHaveBeenCalled();
  });

  it("classifies a malformed stored PHC without exposing parser details", async () => {
    const { service, repository, passwords } = setup();
    vi.mocked(repository.findLoginUser).mockResolvedValue({
      id: "9007199254740995",
      passwordHash: "bad-phc",
      disabledAt: null,
    });
    await expect(
      service.login({
        username: "Dad",
        password: "password1",
        deviceLabel: null,
        ip: "127.0.0.44",
      }),
    ).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      statusCode: 503,
      errorCategory: "CREDENTIAL_CORRUPTION",
      message: "SERVICE_UNAVAILABLE",
    });
    expect(passwords.verify).not.toHaveBeenCalled();
  });

  it("classifies an Argon2 execution failure separately from corruption", async () => {
    const { service, passwords } = setup();
    vi.mocked(passwords.verify).mockRejectedValue(new Error("native failure"));
    await expect(
      service.login({
        username: "Dad",
        password: "password1",
        deviceLabel: null,
        ip: "127.0.0.45",
      }),
    ).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      errorCategory: "ARGON2_EXECUTION_FAILURE",
    });
  });

  it("classifies an Argon2 hashing failure separately from corruption", async () => {
    const { service, passwords } = setup();
    vi.mocked(passwords.needsRehash).mockReturnValue(true);
    vi.mocked(passwords.hash).mockRejectedValue(new Error("native failure"));
    await expect(
      service.login({
        username: "Dad",
        password: "password1",
        deviceLabel: null,
        ip: "127.0.0.46",
      }),
    ).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      errorCategory: "ARGON2_EXECUTION_FAILURE",
    });
  });

  it.each([
    ["expired", { expiresAt: now }],
    ["idle", { lastSeenAt: new Date(now.getTime() - 7 * 24 * 60 * 60_000) }],
    ["revoked", { revokedAt: now }],
    ["disabled", { disabledAt: now }],
  ] as const)("rejects %s sessions", async (_label, override) => {
    const { service, repository } = setup();
    vi.mocked(repository.findSession).mockResolvedValue(identity(override));
    await expect(service.authenticate(token)).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });
    expect(repository.touchSession).not.toHaveBeenCalled();
  });

  it("rejects authentication when the locked touch finds an expired session", async () => {
    const { service, repository } = setup();
    vi.mocked(repository.touchSession).mockRejectedValue(
      new AuthRepositoryStateError("UNAUTHENTICATED"),
    );
    await expect(service.authenticate(token)).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
      statusCode: 401,
    });
  });

  it("rejects an ANDROID session presented through the WEB Cookie path", async () => {
    const { service, repository } = setup();
    vi.mocked(repository.findSession).mockResolvedValue(
      identity({ clientType: "ANDROID" }),
    );
    await expect(service.authenticate(token)).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });
  });

  it("fails closed when the database is unavailable", async () => {
    const { service, repository } = setup();
    vi.mocked(repository.findSession).mockRejectedValue(new Error("offline"));
    await expect(service.authenticate(token)).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      statusCode: 503,
    });
  });

  it("requires recent auth for logout-all and password change", async () => {
    const { service, repository } = setup();
    const stale: AuthContext = {
      identity: identity({
        authenticatedAt: new Date(now.getTime() - 15 * 60_000),
      }),
      tokenHash: hashSessionToken(token),
    };
    await expect(service.logoutAll(stale)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(
      service.changePassword(stale, {
        currentPassword: "password1",
        newPassword: "new-password",
        ip: "127.0.0.5",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(repository.revokeAll).not.toHaveBeenCalled();
  });
});
