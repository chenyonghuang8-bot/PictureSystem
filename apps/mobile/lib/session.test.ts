/// <reference types="node" />
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll } from "vitest";
import { beforeEach, describe, it, expect, vi } from "vitest";
const mock = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  del: vi.fn(),
  fetch: vi.fn(),
}));
vi.mock("expo-secure-store", () => ({
  getItemAsync: mock.get,
  setItemAsync: mock.set,
  deleteItemAsync: mock.del,
}));
vi.mock("expo/fetch", () => ({ fetch: mock.fetch }));
const root = fs.mkdtempSync(
  path.join(os.tmpdir(), "phase10-session-regression-"),
);
vi.mock("expo-file-system", async () => {
  const { TestFile } = await import("./filesystem-test-adapter.js");
  return { File: TestFile, Paths: { document: root } };
});
afterAll(() => fs.rmSync(root, { recursive: true }));
const record = {
  token: "A".repeat(43),
  expiresAt: "2027-01-01T00:00:00.000Z",
  serverNow: "2026-10-06T00:00:00.000Z",
};
const me = {
  user: { id: "1", username: "synthetic", displayName: null },
  memberships: [
    { id: "1", familyId: "8", familyName: "合成家庭", role: "MEMBER" },
    { id: "2", familyId: "9", familyName: "另一个合成家庭", role: "MEMBER" },
  ],
};
beforeEach(() => {
  fs.rmSync(root, { recursive: true });
  fs.mkdirSync(root);
  vi.resetModules();
  vi.clearAllMocks();
  mock.get.mockResolvedValue(JSON.stringify(record));
  mock.set.mockResolvedValue(undefined);
  mock.del.mockResolvedValue(undefined);
  mock.fetch.mockImplementation(async () => Response.json(me));
});
describe("native credential lifecycle (mock transport/storage, not emulator acceptance)", () => {
  it("validates SecureStore session on startup, omits Cookies and refuses redirects", async () => {
    const { session } = await import("./session.js");
    await session.restore();
    expect(session.get().me?.user.id).toBe("1");
    const [url, init] = mock.fetch.mock.calls[0]!;
    expect(url).toBe("https://10.0.2.2:3443/api/v1/auth/me");
    expect(init).toMatchObject({ credentials: "omit", redirect: "error" });
    expect(init.headers.has("cookie")).toBe(false);
    expect(init.headers.has("origin")).toBe(false);
    expect(init.headers.get("authorization")).toBe(`Bearer ${record.token}`);
    await session.logout(false);
  });
  it("SecureStore write failure leaves login unauthenticated and never dispatches me", async () => {
    const { session } = await import("./session.js");
    mock.fetch.mockResolvedValue(Response.json(record));
    mock.set.mockRejectedValue(new Error("STORAGE_FAILED"));
    await expect(
      session.login("synthetic", "synthetic-password"),
    ).rejects.toThrow("LOGIN_FAILED");
    expect(session.get().me).toBeNull();
    expect(mock.fetch).toHaveBeenCalledTimes(1);
    expect(mock.del).toHaveBeenCalled();
  });
  it("family switch fences a late response even when transport ignores abort", async () => {
    const { session, request } = await import("./session.js");
    await session.restore();
    let resolve!: (r: Response) => void;
    mock.fetch.mockImplementation(
      () =>
        new Promise<Response>((r) => {
          resolve = r;
        }),
    );
    const old = request("/api/v1/albums");
    session.selectFamily("9");
    resolve(Response.json({ albums: [] }));
    await expect(old).rejects.toThrow("STALE");
    expect(session.get().familyId).toBe("9");
    await session.logout(false);
  });
  it("401 revokes local private context and stored credential", async () => {
    const { session, request } = await import("./session.js");
    await session.restore();
    mock.fetch.mockResolvedValue(new Response(null, { status: 401 }));
    await expect(request("/api/v1/albums")).rejects.toThrow("AUTH");
    expect(session.get().me).toBeNull();
    expect(mock.del).toHaveBeenCalled();
  });
  it("body consumption remains epoch fenced after headers have arrived", async () => {
    const { session, request } = await import("./session.js");
    await session.restore();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    mock.fetch.mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            controller = c;
          },
        }),
      ),
    );
    const r = await request("/api/v1/albums");
    const pending = r.json();
    session.selectFamily("9");
    controller.enqueue(new TextEncoder().encode('{"albums":[]}'));
    controller.close();
    await expect(pending).rejects.toThrow("STALE");
    await session.logout(false);
  });
  it("delete failure plus offline logout stays denied across a fresh module restore", async () => {
    const { session } = await import("./session.js");
    await session.restore();
    mock.del.mockRejectedValue(new Error("delete failed"));
    mock.fetch.mockRejectedValue(new Error("offline"));
    await expect(session.logout()).rejects.toThrow("delete failed");
    vi.resetModules();
    mock.fetch.mockResolvedValue(Response.json(me));
    mock.fetch.mockClear();
    const fresh = (await import("./session.js")).session;
    await fresh.restore();
    expect(fresh.get().me).toBeNull();
    expect(mock.fetch).not.toHaveBeenCalled();
  });
  it.each(["login", "rotation", "background"])(
    "delayed %s credential write cannot survive invalidation/cold restart",
    async (mode) => {
      const { session } = await import("./session.js");
      if (mode !== "login") await session.restore();
      let release!: () => void;
      let entered!: () => void;
      const started = new Promise<void>((r) => (entered = r));
      mock.set.mockImplementation(() => {
        entered();
        return new Promise<void>((r) => (release = r));
      });
      mock.fetch.mockResolvedValue(Response.json(record));
      const pending = (
        mode === "login" || mode === "background"
          ? session.login("test", "password")
          : session.rotate("password")
      ).catch((e) => e);
      await started;
      const revoke =
        mode === "background"
          ? session.foreground(false)
          : session.logout(false);
      release();
      await pending;
      await revoke;
      vi.resetModules();
      mock.fetch.mockResolvedValue(Response.json(me));
      mock.fetch.mockClear();
      const fresh = (await import("./session.js")).session;
      await fresh.restore();
      expect(fresh.get().me).toBeNull();
      expect(mock.fetch).not.toHaveBeenCalled();
    },
  );
  it("ordered failed cleanup cannot erase a later successful login", async () => {
    let stored = JSON.stringify(record);
    mock.get.mockImplementation(async () => stored);
    mock.set.mockImplementation(async (_k, v) => {
      stored = v;
    });
    const { session } = await import("./session.js");
    await session.restore();
    mock.del.mockRejectedValueOnce(new Error("failed"));
    await expect(session.logout(false)).rejects.toThrow();
    mock.fetch.mockImplementation(async (u: string) =>
      Response.json(u.endsWith("/login") ? record : me),
    );
    await session.login("test", "password");
    vi.resetModules();
    const fresh = (await import("./session.js")).session;
    await fresh.restore();
    expect(fresh.get().me?.user.id).toBe("1");
  });
});

it("startup active event cannot cancel pending SecureStore restoration", async () => {
  let release!: (value: string) => void;
  mock.get.mockImplementationOnce(
    () =>
      new Promise<string>((resolve) => {
        release = resolve;
      }),
  );
  const { session } = await import("./session.js");
  const restoring = session.restore();
  await vi.waitFor(() => expect(mock.get).toHaveBeenCalledTimes(1));
  await session.foreground(true);
  release(JSON.stringify(record));
  await restoring;
  expect(session.get().me?.user.id).toBe("1");
  expect(mock.fetch).toHaveBeenCalledTimes(1);
});
it("foreground retries superseded startup restore through server validation", async () => {
  let release!: (value: string) => void;
  mock.get.mockImplementationOnce(
    () =>
      new Promise<string>((resolve) => {
        release = resolve;
      }),
  );
  const { session } = await import("./session.js");
  const restoring = session.restore();
  await vi.waitFor(() => expect(mock.get).toHaveBeenCalledTimes(1));
  await session.foreground(false);
  const resumed = session.foreground(true);
  release(JSON.stringify(record));
  await restoring;
  await resumed;
  expect(mock.get).toHaveBeenCalledTimes(2);
  expect(mock.fetch).toHaveBeenCalledTimes(1);
  expect(session.get().me?.user.id).toBe("1");
  await session.logout(false);
  await session.foreground(false);
  await session.foreground(true);
  expect(session.get().me).toBeNull();
  expect(mock.fetch).toHaveBeenCalledTimes(1);
});
