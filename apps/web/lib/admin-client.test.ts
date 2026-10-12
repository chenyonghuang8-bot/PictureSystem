import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AdminActivation,
  adminSend,
  controlAttempt,
  exactBytes,
  observeControl,
  requireAdminIdentity,
  sendControl,
} from "./admin-client.js";
import { z } from "zod";
const operation = {
  operationId: "11111111-1111-4111-8111-111111111111",
  kind: "MODE",
  status: "PENDING",
  targetMode: "READ_ONLY",
  resultRevision: null,
  reasonCode: "MANUAL_READ_ONLY",
  createdAt: "2026-10-07T00:00:00.000Z",
  finishedAt: null,
};
const me = {
  user: { id: "1", username: "synthetic", displayName: null },
  memberships: [
    { id: "2", familyId: "3", familyName: "Synthetic", role: "ADMIN" },
  ],
};
afterEach(() => vi.unstubAllGlobals());
describe("Admin current scope and immutable control attempt", () => {
  it("hiding or a new activation aborts the previous request and rejects its late response", () => {
    const scope = new AdminActivation(),
      old = scope.begin();
    expect(scope.current(old)).toBe(true);
    scope.clear();
    expect(old.signal.aborted).toBe(true);
    expect(scope.current(old)).toBe(false);
    const fresh = scope.begin();
    expect(scope.current(fresh)).toBe(true);
    expect(scope.current(old)).toBe(false);
  });
  it.each(["MEMBER", "ADMIN"])(
    "rechecks current user, family and role %s",
    async (role) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          Response.json({
            ...me,
            memberships: [{ ...me.memberships[0], role }],
          }),
        ),
      );
      if (role === "MEMBER")
        await expect(requireAdminIdentity("1", "3")).rejects.toMatchObject({
          code: "FORBIDDEN",
        });
      else expect((await requireAdminIdentity("1", "3")).role).toBe("ADMIN");
      await expect(requireAdminIdentity("other", "3")).rejects.toMatchObject({
        code: "UNAUTHENTICATED",
      });
      await expect(requireAdminIdentity("1", "4")).rejects.toMatchObject({
        code: "UNAUTHENTICATED",
      });
    },
  );
  it("preserves uint64 bytes without floating point conversion", () => {
    expect(exactBytes("9007199254740993")).toContain("9007199254740993 bytes");
    expect(exactBytes("18446744073709551615")).toBe(
      "17179869183.99 GiB (18446744073709551615 bytes)",
    );
  });
  it("creates immutable UUID/revision attempts and refuses extra force or source paths", () => {
    const attempt = controlAttempt("9007199254740993", "READ_ONLY", "MODE");
    expect(Object.isFrozen(attempt)).toBe(true);
    expect(attempt.expectedRevision).toBe("9007199254740993");
    expect(Object.keys(attempt).sort()).toEqual([
      "expectedRevision",
      "kind",
      "operationId",
      "targetMode",
    ]);
  });
  it("an unknown POST is sent once, then only the known operation is observed", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ code: "SERVICE_UNAVAILABLE" }, { status: 503 }),
      )
      .mockResolvedValueOnce(Response.json(operation));
    vi.stubGlobal("fetch", fetch);
    const attempt = {
      ...operation,
      expectedRevision: "1",
      kind: "MODE" as const,
      targetMode: "READ_ONLY" as const,
    };
    await expect(sendControl(attempt)).rejects.toMatchObject({
      code: "UNAVAILABLE",
    });
    expect((await observeControl(attempt.operationId)).status).toBe("PENDING");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0]![1]).toMatchObject({
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
    });
    expect(fetch.mock.calls[1]![0]).toBe(
      `/api/v1/admin/system/operations/${attempt.operationId}`,
    );
    expect(fetch.mock.calls[1]![1]).toMatchObject({ method: "GET" });
    expect(JSON.parse(fetch.mock.calls[0]![1].body)).toEqual({
      operationId: attempt.operationId,
      expectedRevision: "1",
      targetMode: "READ_ONLY",
      reasonCode: "MANUAL_READ_ONLY",
    });
  });
  it.each([200, 201])(
    "does not treat PENDING with unexpected HTTP %s as accepted",
    async (status) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json(operation, { status })),
      );
      await expect(
        sendControl({
          operationId: operation.operationId,
          expectedRevision: "1",
          targetMode: "READ_ONLY",
          kind: "MODE",
        }),
      ).rejects.toMatchObject({ code: "UNAVAILABLE" });
    },
  );
  it("the accepted 202 response must match the exact operation and target", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(operation, { status: 202 })),
    );
    expect(
      (
        await sendControl({
          operationId: operation.operationId,
          expectedRevision: "1",
          targetMode: "READ_ONLY",
          kind: "MODE",
        })
      ).status,
    ).toBe("PENDING");
    await expect(
      sendControl({
        operationId: "22222222-2222-4222-8222-222222222222",
        expectedRevision: "1",
        targetMode: "READ_ONLY",
        kind: "MODE",
      }),
    ).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });
  it("refuses an external mutation path before fetch", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(
      adminSend(
        "https://example.test/api/v1/admin/system/mode",
        z.undefined(),
        {},
      ),
    ).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(fetch).not.toHaveBeenCalled();
  });
});
