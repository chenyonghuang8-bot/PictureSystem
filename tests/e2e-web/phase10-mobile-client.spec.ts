import { test, expect, type Page } from "@playwright/test";
import { resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { createDatabase } from "../../packages/db/src/index.js";
import { hashPassword } from "../../packages/auth/src/index.js";
import { MemoriesFixture } from "../fixtures/memories-db.js";
import { syntheticHistoryJpeg } from "../fixtures/location-jpeg.js";
process.loadEnvFile(resolve(".env"));
if (!process.env.DATABASE_URL || process.env.DEV_MEDIA_PIPELINE_ENABLED !== "1")
  throw new Error("REAL_DEV_PIPELINE_REQUIRED");
const db = createDatabase(process.env.DATABASE_URL),
  f = new MemoriesFixture(db.pool);
const password = "phase10-mobile-synthetic-password";
let metadata: ChildProcess | undefined;
test.beforeAll(async () => {
  await f.setup();
  writeFileSync(
    "/tmp/phase10-client-owned-fixture.json",
    JSON.stringify({ familyId: f.familyId, users: f.users, suffix: f.suffix }),
    { mode: 0o600 },
  );
  await db.pool.query("UPDATE users SET password_hash=? WHERE id=?", [
    await hashPassword(password),
    f.users[0],
  ]);
  await db.pool.query("UPDATE users SET password_hash=? WHERE id=?", [
    await hashPassword(password),
    f.users[1],
  ]);
  metadata = spawn(
    process.execPath,
    ["--env-file=.env", "--import=tsx", "apps/worker/src/metadata-main.ts"],
    {
      env: {
        ...process.env,
        APP_ENV: "dev",
        NODE_ENV: "test",
        LOG_LEVEL: "silent",
        DEV_MEDIA_ROOT: process.env.PHASE5_WEB_E2E_MEDIA_ROOT,
        DEV_STORAGE_MARKER_ID: process.env.PHASE5_WEB_E2E_MARKER_ID,
        LOCATION_DATA_DIR: resolve("resources/location/2026-10-03"),
      },
      stdio: "ignore",
    },
  );
});
test.afterAll(async () => {
  if (metadata && metadata.exitCode === null) {
    const done = once(metadata, "exit");
    metadata.kill("SIGTERM");
    const timer = setTimeout(() => metadata?.kill("SIGKILL"), 10000);
    try {
      await done;
    } finally {
      clearTimeout(timer);
    }
  }
  try {
    await db.pool.query("DELETE FROM upload_album_targets WHERE family_id=?", [
      f.familyId,
    ]);
    await f.cleanup();
  } finally {
    await db.pool.end();
  }
});
test("mobile H5 real Cookie login, durable UUID response-loss/reselect and READY placement", async ({
  page,
}) => {
  test.setTimeout(120000);
  const network: { method: string; path: string; status: number }[] = [];
  page.on("response", (r) => {
    const path = new URL(r.url()).pathname;
    if (path.includes("/uploads/") || path.includes("/auth/"))
      network.push({ method: r.request().method(), path, status: r.status() });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/login");
  await page.getByLabel("账号", { exact: true }).fill("p9mem_0" + f.suffix);
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page).toHaveURL("https://localhost:3443/");
  const album = await page.request.post("/api/v1/albums", {
    headers: { origin: "https://localhost:3443" },
    data: { familyId: f.familyId, name: "手机合成测试", visibility: "FAMILY" },
  });
  expect(album.status()).toBe(201);
  const a = await album.json();
  await page.reload();
  await expect(
    page.locator(".gallery-nav a").filter({ hasText: "我的" }),
  ).toBeVisible();
  await expect(page.locator(".desktop-trash")).toBeHidden();
  let lost = false;
  await page.route(
    `**/api/v1/families/${f.familyId}/uploads/tus`,
    async (route) => {
      if (route.request().method() === "POST" && !lost) {
        lost = true;
        const r = await route.fetch();
        expect(r.status()).toBe(201);
        await route.abort("connectionreset");
      } else await route.continue();
    },
  );
  await page.getByRole("button", { name: "＋ 上传照片" }).click();
  await page.getByLabel("手机合成测试", { exact: true }).check();
  const bytes = await syntheticHistoryJpeg("2020-10-06");
  await page.getByLabel("选择多张照片").setInputFiles({
    name: "mobile-original.jpg",
    mimeType: "image/jpeg",
    buffer: bytes,
  });
  await expect.poll(() => lost).toBe(true);
  await expect(page.locator(".mobile-upload-job")).toHaveCount(1);
  const before = await page.evaluate(
    async () =>
      new Promise<string>((resolve) => {
        const r = indexedDB.open("family-album-upload-v1");
        r.onsuccess = () => {
          const tx = r.result.transaction("jobs", "readonly");
          const q = tx.objectStore("jobs").getAll();
          q.onsuccess = () => {
            resolve(q.result[0].operationId);
            r.result.close();
          };
        };
      }),
  );
  await page.reload();
  await page.locator(".mobile-upload summary").click();
  await expect(page.getByText("请选择原文件", { exact: true })).toBeVisible({
    timeout: 15000,
  });
  await page
    .getByRole("button", { name: "重新选择原文件", exact: true })
    .click();
  await page.getByLabel("重新选择原照片", { exact: true }).setInputFiles({
    name: "different-name-same-content.jpg",
    mimeType: "image/jpeg",
    buffer: bytes,
  });
  try {
    await expect(page.getByText("已加入相册", { exact: true })).toBeVisible({
      timeout: 70000,
    });
  } catch (error) {
    const jobs = await page.evaluate(
      async () =>
        new Promise<unknown>((resolve) => {
          const r = indexedDB.open("family-album-upload-v1");
          r.onsuccess = () => {
            const q = r.result
              .transaction("jobs", "readonly")
              .objectStore("jobs")
              .getAll();
            q.onsuccess = () => {
              resolve(
                q.result.map(
                  (j: {
                    stage: string;
                    failures: number;
                    offset: number;
                    size: number;
                    uploadId?: string;
                  }) => ({
                    stage: j.stage,
                    failures: j.failures,
                    offset: j.offset,
                    size: j.size,
                    uploadId: j.uploadId,
                  }),
                ),
              );
              r.result.close();
            };
          };
        }),
    );
    writeFileSync(
      "/tmp/phase10-h5-upload-diagnostic.json",
      JSON.stringify({ network, jobs }, null, 2),
      { mode: 0o600 },
    );
    throw error;
  }
  const after = await page.evaluate(
    async () =>
      new Promise<string>((resolve) => {
        const r = indexedDB.open("family-album-upload-v1");
        r.onsuccess = () => {
          const q = r.result
            .transaction("jobs", "readonly")
            .objectStore("jobs")
            .getAll();
          q.onsuccess = () => {
            resolve(q.result[0].operationId);
            r.result.close();
          };
        };
      }),
  );
  expect(after).toBe(before);
  const op = await page.request.get(
    `/api/v1/families/${f.familyId}/uploads/operations/${before}`,
  );
  expect(op.status()).toBe(200);
  const status = await op.json();
  const result = await page.request.get(
    `/api/v1/uploads/${status.uploadId}/result`,
  );
  expect(await result.json()).toMatchObject({
    state: "COMPLETE",
    processing: "READY",
    placement: "APPLIED",
    albumId: a.id,
  });
  await page.reload();
  await expect(page.locator(".gallery-grid img").first()).toBeVisible();
  mkdirSync(resolve("docs/progress/phase10-client-artifacts"), {
    recursive: true,
  });
  await page.screenshot({
    path: resolve("docs/progress/phase10-client-artifacts/h5-photos.png"),
  });
  await page
    .locator(".gallery-nav")
    .getByRole("link", { name: "我的", exact: true })
    .click();
  await expect(page.getByText("手机使用", { exact: true })).toBeVisible();
  await page.screenshot({
    path: resolve("docs/progress/phase10-client-artifacts/h5-my.png"),
  });
  await expect(
    page.getByRole("button", { name: "＋ 上传照片", exact: true }),
  ).toBeEnabled();
  const loggedOut = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === "/api/v1/auth/logout" &&
      r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "退出登录", exact: true }).click();
  expect((await loggedOut).status()).toBe(204);
  await expect(page).toHaveURL("https://localhost:3443/login");
  const me = await page.request.get("/api/v1/auth/me");
  expect(me.status()).toBe(401);
});

async function realLogin(page: Page) {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/login");
  await page.getByLabel("账号", { exact: true }).fill("p9mem_0" + f.suffix);
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page).toHaveURL("https://localhost:3443/");
  await expect(
    page.getByRole("button", { name: "＋ 上传照片", exact: true }),
  ).toBeEnabled();
}
test("strict H5 rejects changed-content reselect without sending PATCH", async ({
  page,
}) => {
  await realLogin(page);
  let lost = false,
    patches = 0;
  page.on("request", (r) => {
    if (
      r.method() === "PATCH" &&
      new URL(r.url()).pathname.includes("/uploads/")
    )
      patches++;
  });
  await page.route(
    `**/api/v1/families/${f.familyId}/uploads/tus`,
    async (route) => {
      if (route.request().method() === "POST" && !lost) {
        lost = true;
        expect((await route.fetch()).status()).toBe(201);
        await route.abort("connectionreset");
      } else await route.continue();
    },
  );
  await page.getByRole("button", { name: "＋ 上传照片" }).click();
  await page.getByLabel("Low", { exact: true }).check();
  await page.getByLabel("选择多张照片").setInputFiles({
    name: "wrong-reselect-original.jpg",
    mimeType: "image/jpeg",
    buffer: await syntheticHistoryJpeg("2019-10-06"),
  });
  await expect.poll(() => lost).toBe(true);
  await page.reload();
  await page.locator(".mobile-upload summary").click();
  await expect(page.getByText("请选择原文件", { exact: true })).toBeVisible({
    timeout: 15000,
  });
  await page
    .getByRole("button", { name: "重新选择原文件", exact: true })
    .click();
  await page.getByLabel("重新选择原照片").setInputFiles({
    name: "different-bytes.jpg",
    mimeType: "image/jpeg",
    buffer: Buffer.from("different synthetic bytes"),
  });
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
    "所选照片内容不同",
  );
  expect(patches).toBe(0);
});
test("strict H5 unavailable IndexedDB never starts create and keeps upload disabled", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const open = IDBFactory.prototype.open;
    IDBFactory.prototype.open = function (name, ...args) {
      if (name === "family-album-upload-v1")
        throw new DOMException(
          "Synthetic storage unavailable",
          "QuotaExceededError",
        );
      return open.call(this, name, ...args);
    };
  });
  let creates = 0;
  page.on("request", (r) => {
    if (
      r.method() === "POST" &&
      new URL(r.url()).pathname.endsWith("/uploads/tus")
    )
      creates++;
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/login");
  await page.getByLabel("账号", { exact: true }).fill("p9mem_0" + f.suffix);
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page).toHaveURL("https://localhost:3443/");
  await expect(page.locator(".mobile-upload").getByRole("alert")).toContainText(
    "无法确认账号或保存上传记录",
  );
  await expect(
    page.getByRole("button", { name: "＋ 上传照片" }),
  ).toBeDisabled();
  expect(creates).toBe(0);
});
for (const mode of ["auth-lost", "hide/restore", "account-mismatch"] as const) {
  test(`strict H5 real album page held across ${mode} stays private`, async ({
    page,
  }) => {
    test.setTimeout(60000);
    for (let n = 0; n < 52; n++)
      await f.album(f.memberId, "Late-private-" + mode + "-" + n);
    await realLogin(page);
    let held = false,
      release!: () => void,
      settled = false,
      lateNames: string[] = [];
    await page.route("**/api/v1/albums?*afterId=*", async (route) => {
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      lateNames = (await response.json()).albums.map(
        (a: { name: string }) => a.name,
      );
      expect(lateNames.length).toBeGreaterThan(0);
      held = true;
      await new Promise<void>((r) => (release = r));
      try {
        await route.fulfill({ response });
      } catch {
        // An invalidated fetch may already have been aborted by the actual client.
      } finally {
        settled = true;
      }
    });
    await page.getByRole("button", { name: "＋ 上传照片" }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "更多相册", exact: true })
      .click();
    await expect.poll(() => held).toBe(true);
    if (mode === "account-mismatch") {
      expect(
        (
          await page.request.post("/api/v1/auth/login", {
            headers: { origin: "https://localhost:3443" },
            data: { username: "p9mem_1" + f.suffix, password },
          })
        ).status(),
      ).toBe(204);
      await page.evaluate(() =>
        window.dispatchEvent(
          new PageTransitionEvent("pageshow", { persisted: true }),
        ),
      );
    } else {
      if (mode === "auth-lost")
        expect(
          (
            await page.request.post("/api/v1/auth/logout", {
              headers: { origin: "https://localhost:3443" },
              data: {},
            })
          ).status(),
        ).toBe(204);
      await page.evaluate((mode) => {
        if (mode === "auth-lost")
          window.dispatchEvent(new Event("family-auth-lost"));
        else {
          Object.defineProperty(document, "visibilityState", {
            configurable: true,
            value: "hidden",
          });
          document.dispatchEvent(new Event("visibilitychange"));
        }
      }, mode);
    }
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "＋ 上传照片" }),
    ).toBeDisabled();
    release();
    await expect(page.locator(".mobile-upload-card")).toHaveCount(0);
    await expect.poll(() => settled).toBe(true);
    for (const name of lateNames)
      await expect(
        page.locator(".mobile-upload").getByText(name, { exact: true }),
      ).toHaveCount(0);
    if (mode === "hide/restore") {
      await page.evaluate(() => {
        Object.defineProperty(document, "visibilityState", {
          configurable: true,
          value: "visible",
        });
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await expect(
        page.getByRole("button", { name: "＋ 上传照片" }),
      ).toBeEnabled();
      await page.getByRole("button", { name: "＋ 上传照片" }).click();
      for (const name of lateNames)
        await expect(
          page.getByRole("dialog").getByText(name, { exact: true }),
        ).toHaveCount(0);
    }
  });
}
