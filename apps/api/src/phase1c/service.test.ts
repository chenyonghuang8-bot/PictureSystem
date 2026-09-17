import { describe, expect, it, vi } from "vitest";

import {
  createInvitationToken,
  hashInvitationToken,
  type PasswordEngine,
} from "@family-album/auth";
import {
  CommitOutcomeUnknownError,
  Phase1CRepositoryError,
} from "@family-album/db";

import { PublicAuthError, type AuthContext } from "../auth/service.js";
import { Phase1CService, type Phase1CRepository } from "./service.js";

const now = new Date("2026-01-01T00:00:00.000Z");
const context = {
  identity: {
    userId: "9007199254740993",
    sessionId: "9007199254740995",
  },
  tokenHash: Buffer.alloc(32, 1),
} as AuthContext;

function setup() {
  const repository = {
    createInvitation: vi.fn(async () => ({
      id: "9007199254740997",
      expiresAt: now,
      actorMemberId: "9007199254740999",
    })),
    listInvitations: vi.fn(async () => []),
    revokeInvitation: vi.fn(async () => ({ actorMemberId: "4" })),
    findInvitationByHash: vi.fn(async () => ({
      id: "1",
      familyId: "2",
      creatorMemberId: "3",
      creatorUserId: "4",
    })),
    previewInvitation: vi.fn(async () => ({
      familyName: "Synthetic family",
      role: "MEMBER" as const,
      expiresAt: now,
    })),
    consumeInvitation: vi.fn(async () => ({
      familyId: "2",
      userId: "5",
      memberId: "6",
    })),
    listMembers: vi.fn(async () => []),
    updateMember: vi.fn(async () => ({
      actorMemberId: "3",
      member: {
        id: "6",
        userId: "5",
        username: "newmember",
        displayName: null,
        role: "MEMBER" as const,
        disabledAt: null,
      },
    })),
  } satisfies Phase1CRepository;
  const passwords = {
    hash: vi.fn(async () => "$argon2id$synthetic"),
    verify: vi.fn(async () => true),
    needsRehash: vi.fn(() => false),
    isValidHash: (hash: unknown): hash is string => typeof hash === "string",
  } satisfies PasswordEngine;
  return {
    repository,
    passwords,
    service: new Phase1CService(
      repository,
      passwords,
      "https://album.example",
      () => now.getTime(),
    ),
  };
}

describe("Phase1CService", () => {
  it("returns the raw invitation only inside a one-time fragment URL", async () => {
    const { service, repository } = setup();
    const result = await service.createInvitation(context, {
      familyId: "2",
      role: "MEMBER",
      expiresInHours: 48,
    });
    const token = new URL(result.invitationUrl).hash.slice("#token=".length);
    expect(token).toHaveLength(43);
    expect(repository.createInvitation).toHaveBeenCalledWith(
      expect.objectContaining({ tokenHash: hashInvitationToken(token) }),
    );
    expect(
      JSON.stringify(repository.createInvitation.mock.calls),
    ).not.toContain(token);
  });

  it("hashes the password outside the consume transaction after token lookup", async () => {
    const { service, repository, passwords } = setup();
    const order: string[] = [];
    repository.findInvitationByHash.mockImplementation(async () => {
      order.push("lookup");
      return {
        id: "1",
        familyId: "2",
        creatorMemberId: "3",
        creatorUserId: "4",
      };
    });
    passwords.hash.mockImplementation(async () => {
      order.push("argon");
      return "$argon2id$synthetic";
    });
    repository.consumeInvitation.mockImplementation(async () => {
      order.push("transaction");
      return { familyId: "2", userId: "5", memberId: "6" };
    });
    await expect(
      service.consumeInvitation(
        {
          token: createInvitationToken(),
          username: "NewMember",
          password: "synthetic-password",
        },
        "127.0.0.1",
      ),
    ).resolves.toEqual({ familyId: "2", userId: "5", memberId: "6" });
    expect(order).toEqual(["lookup", "argon", "transaction"]);
  });

  it("does no Argon work for malformed or nonexistent tokens", async () => {
    const { service, repository, passwords } = setup();
    await expect(
      service.consumeInvitation(
        { token: "bad", username: "member", password: "password1" },
        "127.0.0.1",
      ),
    ).rejects.toMatchObject({ code: "INVALID_INVITATION" });
    repository.findInvitationByHash.mockResolvedValueOnce(null as never);
    await expect(
      service.consumeInvitation(
        {
          token: createInvitationToken(),
          username: "member",
          password: "password1",
        },
        "127.0.0.1",
      ),
    ).rejects.toMatchObject({ code: "INVALID_INVITATION" });
    expect(passwords.hash).not.toHaveBeenCalled();
  });

  it("maps authorization and uncertain commits without exposing internals", async () => {
    const { service, repository } = setup();
    repository.revokeInvitation.mockRejectedValueOnce(
      new Phase1CRepositoryError("FORBIDDEN"),
    );
    await expect(
      service.revokeInvitation(context, "2", "3"),
    ).rejects.toMatchObject({ statusCode: 403, code: "FORBIDDEN" });
    repository.revokeInvitation.mockRejectedValueOnce(
      new CommitOutcomeUnknownError(),
    );
    await expect(
      service.revokeInvitation(context, "2", "3"),
    ).rejects.toMatchObject({
      statusCode: 503,
      code: "SERVICE_UNAVAILABLE",
      errorCategory: "COMMIT_OUTCOME_UNKNOWN",
    });
  });

  it("shares one bounded preview/consume IP budget", async () => {
    const { service } = setup();
    const token = createInvitationToken();
    for (let index = 0; index < 30; index += 1) {
      await service.previewInvitation(token, "192.0.2.1");
    }
    await expect(
      service.consumeInvitation(
        { token, username: "member", password: "password1" },
        "192.0.2.1",
      ),
    ).rejects.toBeInstanceOf(PublicAuthError);
  });
});
