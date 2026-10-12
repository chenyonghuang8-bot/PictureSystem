import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createSessionToken } from "@family-album/auth";
import {
  SystemControlError,
  type MySqlAdminReadRepository,
  type MySqlSystemControlRepository,
} from "@family-album/db";
import { createApp } from "../app.js";
import type { AuthService } from "../auth/service.js";

const origin = "https://localhost:3000",
  token = createSessionToken();
const operationId = randomUUID();
const requestBody = {
  operationId,
  expectedRevision: "9007199254740993",
  targetMode: "READ_ONLY",
  reasonCode: "MANUAL_READ_ONLY",
};
function setup() {
  const authenticate = vi.fn(
    async (_token: string, expectedClientType: "WEB" | "ANDROID") => ({
      identity: {
        userId: "9007199254740995",
        sessionId: "9007199254740997",
        clientType: expectedClientType,
      },
      tokenHash: Buffer.alloc(32, 3),
    }),
  );
  const actor = {
    userId: "9007199254740995",
    sessionId: "9007199254740997",
    tokenHash: Buffer.alloc(32, 3),
    expectedClientType: "WEB",
    familyId: "9007199254740999",
  };
  const resolveActor = vi.fn(async () => actor),
    status = vi.fn(async () => ({
      revision: "9007199254740993",
      localDeny: false,
    }));
  const pending = { operationId, status: "PENDING" };
  const requestMode = vi.fn(async () => pending),
    requestRecheck = vi.fn(async () => pending),
    operation = vi.fn(async () => pending);
  const overview = vi.fn(async () => ({
      mediaControl: "WRITABLE",
      photos: "9007199254740993",
    })),
    audit = vi.fn(async () => ({ events: [] }));
  const localDeny = vi.fn(() => false);
  const systemStatus = vi.fn(async () => ({
    revision: "9007199254740993",
    localDeny: false,
    observations: {
      database: { state: "HEALTHY" },
      storage: { state: "UNKNOWN", availableBytes: null },
      lastBackupSuccessAt: null,
    },
  }));
  const app = createApp({
    authService: { authenticate } as unknown as AuthService,
    trustedOrigins: new Set([origin]),
    admin: {
      control: {
        resolveActor,
        status,
        requestMode,
        requestRecheck,
        operation,
      } as unknown as MySqlSystemControlRepository,
      reads: {
        overview,
        audit,
        systemStatus,
      } as unknown as MySqlAdminReadRepository,
      localDeny,
    },
  });
  return {
    app,
    authenticate,
    resolveActor,
    status,
    systemStatus,
    requestMode,
    requestRecheck,
    operation,
    overview,
    audit,
    localDeny,
    actor,
  };
}
const web = {
  cookie: `__Host-family_session=${token}`,
  origin,
  "content-type": "application/json",
};
const native = {
  authorization: `Bearer ${token}`,
  "content-type": "application/json",
};
describe("Phase11 Admin transport and operation observation", () => {
  it.each([
    [web, "WEB"],
    [native, "ANDROID"],
  ] as const)(
    "preserves the selected credential type for current grant resolution (%#)",
    async (headers, type) => {
      const s = setup();
      try {
        const r = await s.app.inject({
          method: "POST",
          url: "/api/v1/admin/system/mode",
          headers,
          payload: requestBody,
        });
        expect(r.statusCode).toBe(202);
        expect(s.authenticate).toHaveBeenCalledWith(token, type);
        expect(s.resolveActor).toHaveBeenCalledWith(
          expect.objectContaining({
            sessionId: "9007199254740997",
            expectedClientType: type,
          }),
        );
        expect(s.requestMode).toHaveBeenCalledWith(s.actor, requestBody);
        expect(r.headers["cache-control"]).toContain("no-store");
      } finally {
        await s.app.close();
      }
    },
  );
  it.each([
    [{ ...web, authorization: `Bearer ${token}` }, 401],
    [{ cookie: web.cookie, "content-type": "application/json" }, 403],
    [{ ...native, origin }, 401],
  ] as const)(
    "rejects mixed credentials or missing/unexpected Origin before creating an operation (%#)",
    async (headers, expectedStatus) => {
      const s = setup();
      try {
        expect(
          (
            await s.app.inject({
              method: "POST",
              url: "/api/v1/admin/system/mode",
              headers,
              payload: requestBody,
            })
          ).statusCode,
        ).toBe(expectedStatus);
        expect(s.requestMode).not.toHaveBeenCalled();
      } finally {
        await s.app.close();
      }
    },
  );
  it("does not accept force/path/family inputs in a deployment mode command", async () => {
    const s = setup();
    try {
      const r = await s.app.inject({
        method: "POST",
        url: "/api/v1/admin/system/mode",
        headers: web,
        payload: { ...requestBody, force: true, path: "/tmp", familyId: "1" },
      });
      expect(r.statusCode).toBe(400);
      expect(s.resolveActor).not.toHaveBeenCalled();
      expect(s.requestMode).not.toHaveBeenCalled();
    } finally {
      await s.app.close();
    }
  });
  it("returns the immutable operation ID for observing an unknown commit without replay", async () => {
    const s = setup();
    s.requestMode.mockRejectedValueOnce(
      new SystemControlError("COMMIT_UNKNOWN"),
    );
    try {
      const r = await s.app.inject({
        method: "POST",
        url: "/api/v1/admin/system/mode",
        headers: web,
        payload: requestBody,
      });
      expect(r.statusCode).toBe(503);
      expect(r.json()).toMatchObject({
        operationId,
        reasonCode: "COMMIT_UNKNOWN",
      });
      expect(s.requestMode).toHaveBeenCalledOnce();
      const observed = await s.app.inject({
        url: `/api/v1/admin/system/operations/${operationId}`,
        headers: { cookie: web.cookie },
      });
      expect(observed.statusCode).toBe(200);
      expect(s.operation).toHaveBeenCalledWith(s.actor, operationId);
      expect(s.resolveActor).toHaveBeenCalledTimes(2);
      expect(s.requestMode).toHaveBeenCalledOnce();
    } finally {
      await s.app.close();
    }
  });
  it("does not let a family administrator obtain deployment status without the independent grant", async () => {
    const s = setup();
    s.resolveActor.mockRejectedValueOnce(new SystemControlError("FORBIDDEN"));
    try {
      expect(
        (
          await s.app.inject({
            url: "/api/v1/admin/system/status",
            headers: { cookie: web.cookie },
          })
        ).statusCode,
      ).toBe(403);
      expect(s.status).not.toHaveBeenCalled();
      expect(s.systemStatus).not.toHaveBeenCalled();
    } finally {
      await s.app.close();
    }
  });
  it.each([
    [web, "WEB"],
    [native, "ANDROID"],
  ] as const)(
    "uses a fresh authorized read snapshot for system observations (%#)",
    async (headers, type) => {
      const s = setup();
      s.localDeny.mockReturnValue(true);
      try {
        const r = await s.app.inject({
          url: "/api/v1/admin/system/status",
          headers,
        });
        expect(r.statusCode).toBe(200);
        expect(r.json()).toMatchObject({
          revision: "9007199254740993",
          localDeny: true,
          observations: { storage: { state: "UNKNOWN", availableBytes: null } },
        });
        expect(s.authenticate).toHaveBeenCalledWith(token, type);
        expect(s.systemStatus).toHaveBeenCalledWith(
          s.actor,
          ["API"],
          expect.any(Function),
        );
        expect(s.status).not.toHaveBeenCalled();
        s.systemStatus.mockRejectedValueOnce(
          new SystemControlError("FORBIDDEN"),
        );
        const revoked = await s.app.inject({
          url: "/api/v1/admin/system/status",
          headers,
        });
        expect(revoked.statusCode).toBe(403);
        expect(revoked.body).not.toContain("9007199254740993");
      } finally {
        await s.app.close();
      }
    },
  );
  it("overlays local deny on family statistics without exposing deployment state", async () => {
    const s = setup();
    s.localDeny.mockReturnValue(true);
    try {
      const r = await s.app.inject({
        url: "/api/v1/families/9007199254740999/admin/overview",
        headers: { cookie: web.cookie },
      });
      expect(r.statusCode).toBe(200);
      expect(r.json()).toEqual({
        mediaControl: "PAUSED",
        photos: "9007199254740993",
      });
      expect(s.resolveActor).not.toHaveBeenCalled();
      expect(s.overview).toHaveBeenCalledWith(
        expect.objectContaining({ expectedClientType: "WEB" }),
        "9007199254740999",
      );
    } finally {
      await s.app.close();
    }
  });
  it("whitelists malformed framework errors instead of returning parser text", async () => {
    const s = setup();
    try {
      const r = await s.app.inject({
        method: "POST",
        url: "/api/v1/admin/system/mode",
        headers: web,
        payload: "{broken",
      });
      expect(r.statusCode).toBe(400);
      expect(r.body).not.toContain("broken");
      expect(s.requestMode).not.toHaveBeenCalled();
    } finally {
      await s.app.close();
    }
  });
});
