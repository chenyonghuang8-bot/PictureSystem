import { afterEach, describe, expect, it, vi } from "vitest";
import {
  sendLifecycle,
  newAttempt,
  reauthenticate,
  unknownOutcome,
  purgeMessage,
  readPurge,
} from "./trash-client.js";
import { GalleryClientError } from "./gallery-client.js";
const id = "11111111-1111-4111-8111-111111111111";
const base = {
  familyId: "1",
  mediaId: "9007199254740993",
  revision: "9007199254740994",
  operationId: id,
  action: "trash" as const,
  selectedAlbumId: "3",
};
afterEach(() => vi.unstubAllGlobals());
describe("7D lifecycle client", () => {
  it("keeps exact revision and selected album; one POST per attempt", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({
        mediaId: base.mediaId,
        lifecycleRevision: "9007199254740995",
        state: "TRASHED",
        trashedAt: "2026-10-02T00:00:00.000Z",
        purgeAfter: "2026-11-01T00:00:00.000Z",
      }),
    );
    vi.stubGlobal("fetch", fetch);
    await sendLifecycle(base);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string)).toEqual({
      expectedLifecycleRevision: base.revision,
      operationId: id,
      selectedAlbumId: "3",
    });
  });
  it.each([400, 500, 503, 200, 204])(
    "treats status %s with invalid body as unknown, without replay",
    async (status) => {
      const fetch = vi.fn(
        async () => new Response(status === 204 ? null : "{}", { status }),
      );
      vi.stubGlobal("fetch", fetch);
      const error = await sendLifecycle(base).catch((e) => e);
      expect(unknownOutcome(error)).toBe(true);
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );
  it.each([401, 403, 404, 409])(
    "preserves definite rejection %s",
    async (status) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("{}", { status })),
      );
      expect(unknownOutcome(await sendLifecycle(base).catch((e) => e))).toBe(
        false,
      );
    },
  );
  it.each(["disconnect", "timeout", "abort"])("never replays %s", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("synthetic transport");
    });
    vi.stubGlobal("fetch", fetch);
    await expect(sendLifecycle(base)).rejects.toMatchObject({
      code: "UNAVAILABLE",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("accepts only matching 202 operation and 204 reauth", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ operationId: id }, { status: 202 }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);
    await expect(
      sendLifecycle({ ...base, action: "permanent-delete" }),
    ).resolves.toEqual({ operationId: id });
    await expect(reauthenticate("synthetic")).resolves.toBeUndefined();
    expect(JSON.parse(fetch.mock.calls[0]![1].body)).not.toHaveProperty(
      "selectedAlbumId",
    );
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("does not call a mismatched status response completed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          operationId: "22222222-2222-4222-8222-222222222222",
          executionState: "DONE",
          progress: "COMPLETED",
          completedAt: "2026-10-02T00:00:00.000Z",
          failureCategory: null,
        }),
      ),
    );
    await expect(readPurge("1", id)).rejects.toBeInstanceOf(GalleryClientError);
    expect(
      purgeMessage({
        operationId: id,
        executionState: "DONE",
        progress: "FILES_REMOVED",
        completedAt: null,
        failureCategory: null,
      }),
    ).toBe("无法确认最新状态。");
  });
  it("freezes the operation identity", () =>
    expect(Object.isFrozen(newAttempt("1", "2", "3", "restore"))).toBe(true));
});
