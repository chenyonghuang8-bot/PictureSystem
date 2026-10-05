import { it, expect, vi, afterEach } from "vitest";
import { MemoriesSession, type MemoriesData } from "./memories-session.js";
import { GalleryClientError } from "./gallery-client.js";
const page = (duration = 1000, anchor = "2026-10-05"): MemoriesData => ({
  context: {
    anchorDate: anchor,
    zone: "Asia/Shanghai",
    policy: "memories-v1",
    serverNow: "2026-10-05T15:59:59.000Z",
    nextMidnight: new Date(
      Date.parse("2026-10-05T15:59:59.000Z") + duration,
    ).toISOString(),
    weekStart: "2025-09-29",
    weekEnd: "2025-10-06",
  },
  kind: "ON_THIS_DAY",
  media: [],
  nextCursor: null,
});
afterEach(() => vi.useRealTimers());
const settle = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};
it("one shared automatic bootstrap budget covers timer and a late 200 across the same cycle", async () => {
  vi.useFakeTimers();
  let clock = 0;
  const fetch = vi.fn(async () => page());
  const s = new MemoriesSession(
    fetch,
    () => {},
    () => clock,
  );
  s.activate();
  await settle();
  expect(s.state.data).not.toBeNull();
  clock = 1000;
  await vi.advanceTimersByTimeAsync(1000);
  expect(fetch).toHaveBeenCalledTimes(2);
  clock = 2000;
  await vi.advanceTimersByTimeAsync(1000);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(s.state.error).toBe("retry");
  s.activate();
  await settle();
  expect(fetch).toHaveBeenCalledTimes(3);
  s.suspend();
});
it("rejects already late success before exposing data and never loops bootstraps", async () => {
  let clock = 0;
  const fetch = vi.fn(async () => {
    clock += 1001;
    return page();
  });
  const exposed: MemoriesData[] = [];
  const s = new MemoriesSession(
    fetch,
    (state) => {
      if (state.data) exposed.push(state.data);
    },
    () => clock,
  );
  s.activate();
  await settle();
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(exposed).toEqual([]);
  expect(s.state.error).toBe("retry");
  s.suspend();
});
it("409 bootstrap then 409 has the same budget; explicit retry starts a fresh cycle", async () => {
  const fetch = vi.fn(async () => {
    throw new GalleryClientError("MEMORIES_ANCHOR_EXPIRED");
  });
  const s = new MemoriesSession(fetch, () => {});
  s.activate();
  await settle();
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(s.state.error).toBe("retry");
  s.activate();
  await settle();
  expect(fetch).toHaveBeenCalledTimes(4);
  s.suspend();
});
it("epoch rejects a late success after auth loss, suspension or newer activation even if fetch ignores abort", async () => {
  const resolvers: ((v: MemoriesData) => void)[] = [];
  const fetch = vi.fn(
    () => new Promise<MemoriesData>((r) => resolvers.push(r)),
  );
  const s = new MemoriesSession(
    fetch,
    () => {},
    () => 0,
  );
  s.activate();
  s.suspend();
  resolvers[0]!(page());
  await settle();
  expect(s.state.data).toBeNull();
  s.activate();
  s.activate();
  resolvers[1]!(page());
  await settle();
  expect(s.state.data).toBeNull();
  resolvers[2]!(page());
  await settle();
  expect(s.state.data).not.toBeNull();
  s.suspend();
});
it("failed bootstrap clears content and stops; auth failure never retries", async () => {
  const fetch = vi
    .fn()
    .mockRejectedValueOnce(new GalleryClientError("MEMORIES_ANCHOR_EXPIRED"))
    .mockRejectedValueOnce(new Error());
  const s = new MemoriesSession(fetch, () => {});
  s.activate();
  await settle();
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(s.state.error).toBe("retry");
  s.suspend();
  const auth = vi.fn(async () => {
    throw new GalleryClientError("UNAUTHENTICATED");
  });
  const a = new MemoriesSession(auth, () => {});
  a.activate();
  await settle();
  expect(auth).toHaveBeenCalledTimes(1);
  expect(a.state.error).toBe("auth");
  a.suspend();
});
