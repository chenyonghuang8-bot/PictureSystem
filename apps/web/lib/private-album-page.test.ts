import { expect, it } from "vitest";
import { privateAlbumPage } from "./private-album-page.js";
it.each(["auth-lost", "hide/restore", "account-mismatch"])(
  "late page across %s cannot repopulate private state",
  async () => {
    let epoch = 1,
      active = true,
      albums = ["old"],
      after: string | null = "50";
    expect(after).toBe("50");
    const controller = new AbortController();
    let release!: (r: Response) => void;
    const pending = privateAlbumPage(
      () => new Promise<Response>((r) => (release = r)),
      () => epoch === 1 && active && !controller.signal.aborted,
      () => {
        albums.push("private second page");
        after = "100";
      },
    );
    epoch++;
    active = false;
    controller.abort();
    albums = [];
    after = null;
    release(
      Response.json({ invalid: "must never parse/apply stale response" }),
    );
    await pending;
    expect(albums).toEqual([]);
    expect(after).toBeNull();
  },
);
it("invalidation during body read also fences page commit", async () => {
  let active = true,
    applied = false;
  const response = Response.json({});
  response.json = async () => {
    active = false;
    return {};
  };
  await privateAlbumPage(
    async () => response,
    () => active,
    () => (applied = true),
  );
  expect(applied).toBe(false);
});
