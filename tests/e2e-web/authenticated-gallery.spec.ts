import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";

import {
  expect,
  test,
  type BrowserContext,
  type Locator,
} from "@playwright/test";
import type {
  PoolConnection,
  ResultSetHeader,
  RowDataPacket,
} from "mysql2/promise";

import {
  hashPassword,
  normalizeUsername,
} from "../../packages/auth/src/index.js";
import {
  assertMigrationReadiness,
  createDatabase,
} from "../../packages/db/src/index.js";
import { buildOriginalPath } from "../../packages/storage/src/index.js";

const rootDir = resolve(import.meta.dirname, "../..");
process.loadEnvFile(resolve(rootDir, ".env"));
const databaseUrl = process.env.DATABASE_URL;
const mediaRoot = process.env.PHASE5_WEB_E2E_MEDIA_ROOT;
if (!databaseUrl) throw new Error("PHASE5_WEB_E2E_DATABASE_URL_REQUIRED");
if (!mediaRoot) throw new Error("PHASE5_WEB_E2E_MEDIA_ROOT_REQUIRED");

const database = createDatabase(databaseUrl);
const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
const username = `p5_web_e2e_${suffix}`;
const syntheticPassword = "phase5-web-e2e-synthetic-password";
const familyName = `温暖测试家庭 ${suffix}`;
const albumName = `周末时光 ${suffix}`;
const userIds: string[] = [];
const mediaIds: string[] = [];
let familyId = "";
let memberId = "";
let albumId = "";
let hiddenAlbumId = "";
const viewerUsername = `${username}_viewer`;

type MediaFixture = {
  thumbnail: Buffer;
  preview: Buffer;
  displayWidth: number;
  displayHeight: number;
  timeline: string;
};

const squareWebP = readFileSync(
  resolve(rootDir, "packages/storage/vendor/libwebp/1.6.0/examples/test.webp"),
);
const wideWebP = readFileSync(
  resolve(
    rootDir,
    "packages/storage/vendor/libwebp/1.6.0/webp_js/test_webp_js.webp",
  ),
);

const fixtures: MediaFixture[] = [
  {
    thumbnail: squareWebP,
    preview: wideWebP,
    displayWidth: 1600,
    displayHeight: 900,
    timeline: "2026-09-18 08:00:00.000",
  },
  {
    thumbnail: squareWebP,
    preview: squareWebP,
    displayWidth: 900,
    displayHeight: 1350,
    timeline: "2026-08-11 09:00:00.000",
  },
];

test.describe.serial("Phase 5 authenticated Web UI acceptance", () => {
  test.beforeAll(async () => {
    const connection = await database.pool.getConnection();
    try {
      await assertDevDatabase(connection);
      await assertMigrationReadiness(connection);
      await connection.beginTransaction();
      const passwordHash = await hashPassword(syntheticPassword);
      const [family] = await connection.query<ResultSetHeader>(
        "INSERT INTO families (name) VALUES (?)",
        [familyName],
      );
      familyId = String(family.insertId);
      const [user] = await connection.query<ResultSetHeader>(
        `INSERT INTO users
          (username, username_normalized, password_hash, display_name,
           password_changed_at)
         VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP(3))`,
        [
          username,
          normalizeUsername(username).normalizedBytes,
          passwordHash,
          "验收成员",
        ],
      );
      const userId = String(user.insertId);
      userIds.push(userId);
      const [member] = await connection.query<ResultSetHeader>(
        `INSERT INTO family_members (family_id, user_id, role)
         VALUES (?, ?, 'ADMIN')`,
        [familyId, userId],
      );
      memberId = String(member.insertId);
      const [viewerUser] = await connection.query<ResultSetHeader>(
        `INSERT INTO users (username,username_normalized,password_hash,display_name,password_changed_at)
         VALUES (?,?,?,?,CURRENT_TIMESTAMP(3))`,
        [
          viewerUsername,
          normalizeUsername(viewerUsername).normalizedBytes,
          passwordHash,
          "只读验收成员",
        ],
      );
      userIds.push(String(viewerUser.insertId));
      await connection.query(
        `INSERT INTO family_members (family_id,user_id,role) VALUES (?,?,'MEMBER')`,
        [familyId, String(viewerUser.insertId)],
      );
      const [album] = await connection.query<ResultSetHeader>(
        `INSERT INTO albums (family_id, owner_member_id, name, visibility)
         VALUES (?, ?, ?, 'FAMILY')`,
        [familyId, memberId, albumName],
      );
      albumId = String(album.insertId);
      const [hiddenAlbum] = await connection.query<ResultSetHeader>(
        `INSERT INTO albums (family_id,owner_member_id,name,visibility) VALUES (?,?,?,'CUSTOM')`,
        [familyId, memberId, `隐藏 ${suffix}`],
      );
      hiddenAlbumId = String(hiddenAlbum.insertId);

      for (const fixture of fixtures) {
        const mediaId = await insertMedia(connection, fixture);
        mediaIds.push(mediaId);
        await connection.query(
          `INSERT INTO album_media (family_id, album_id, media_id)
           VALUES (?, ?, ?)`,
          [familyId, albumId, mediaId],
        );
      }
      await connection.query(
        `INSERT INTO album_media (family_id,album_id,media_id) VALUES (?,?,?)`,
        [familyId, hiddenAlbumId, mediaIds[0]],
      );
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }, 60_000);

  test.afterAll(async () => {
    const connection = await database.pool.getConnection();
    try {
      if (familyId) {
        await connection.beginTransaction();
        await connection.query("DELETE FROM share_events WHERE family_id=?", [
          familyId,
        ]);
        await connection.query("DELETE FROM shares WHERE family_id=?", [
          familyId,
        ]);
        for (const table of [
          "comments",
          "media_tags",
          "tags",
          "user_favorites",
          "family_featured",
        ]) {
          await connection.query(`DELETE FROM ${table} WHERE family_id=?`, [
            familyId,
          ]);
        }
        await connection.query("DELETE FROM album_media WHERE family_id=?", [
          familyId,
        ]);
        await connection.query("DELETE FROM derived_assets WHERE family_id=?", [
          familyId,
        ]);
        await connection.query(
          "DELETE FROM background_jobs WHERE family_id=?",
          [familyId],
        );
        await connection.query("DELETE FROM media_items WHERE family_id=?", [
          familyId,
        ]);
        await connection.query(
          "DELETE FROM upload_sessions WHERE family_id=?",
          [familyId],
        );
        await connection.query(
          "DELETE FROM storage_objects WHERE family_id=?",
          [familyId],
        );
        await connection.query("DELETE FROM albums WHERE family_id=?", [
          familyId,
        ]);
        await connection.query("DELETE FROM sessions WHERE user_id IN (?)", [
          userIds,
        ]);
        await connection.query("DELETE FROM family_members WHERE family_id=?", [
          familyId,
        ]);
        await connection.query("DELETE FROM users WHERE id IN (?)", [userIds]);
        await connection.query("DELETE FROM families WHERE id=?", [familyId]);
        await connection.commit();
        const [residue] = await connection.query<RowDataPacket[]>(
          `SELECT
             (SELECT COUNT(*) FROM families WHERE id=?) AS families,
             (SELECT COUNT(*) FROM users WHERE id IN (?)) AS users,
             (SELECT COUNT(*) FROM albums WHERE family_id=?) AS albums,
             (SELECT COUNT(*) FROM media_items WHERE family_id=?) AS media,
             (SELECT COUNT(*) FROM shares WHERE family_id=?) AS shares,
             (SELECT COUNT(*) FROM sessions WHERE user_id IN (?)) AS sessions`,
          [familyId, userIds, familyId, familyId, familyId, userIds],
        );
        expect(Object.values(residue[0] ?? {}).map(String)).toEqual(
          Array(6).fill("0"),
        );
      }
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
      await database.pool.end();
    }
  });

  test("desktop UI uses real login, media, viewer, and share flows", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 1440, height: 1000 },
    });
    try {
      await realLogin(context);
      const cookies = await context.cookies("https://localhost:3443");
      const session = cookies.find(
        (cookie) => cookie.name === "__Host-family_session",
      );
      expect(
        Boolean(
          session &&
          session.secure &&
          session.httpOnly &&
          session.path === "/" &&
          session.sameSite === "Lax",
        ),
      ).toBe(true);

      const page = await context.newPage();
      let originalRequested = false;
      let previewRequested = false;
      let sensitiveResponse = false;
      let derivedResponseFailure = false;
      page.on("request", (request) => {
        const pathname = new URL(request.url()).pathname.toLowerCase();
        if (pathname.includes("/derived/original")) originalRequested = true;
        if (pathname.endsWith("/derived/preview")) previewRequested = true;
      });
      page.on("response", async (response) => {
        const responsePath = new URL(response.url()).pathname;
        if (
          /\/derived\/(?:thumbnail|preview)$/u.test(responsePath) &&
          response.status() !== 200
        ) {
          derivedResponseFailure = true;
        }
        const contentType = response.headers()["content-type"] ?? "";
        if (!contentType.includes("application/json")) return;
        if (responsePath.includes("/share/") || responsePath.endsWith("/share"))
          return;
        const body = await response.text().catch(() => "");
        if (
          /token_hash|storage[_-]?path|gpsLatitude|gpsLongitude/iu.test(body)
        ) {
          sensitiveResponse = true;
        }
      });

      await page.goto("/");
      await expect(
        page.getByRole("heading", { name: familyName }),
      ).toBeVisible();
      await expect(page.getByLabel("主导航")).toBeVisible();
      await expect(page.locator("main.gallery-main")).toBeVisible();
      await expect(page.getByLabel("辅助信息")).toBeVisible();
      await expect(page.getByText("需要登录")).toHaveCount(0);
      expect(
        await page
          .locator(".gallery-shell")
          .evaluate(
            (element) =>
              getComputedStyle(element).gridTemplateColumns.split(" ").length,
          ),
      ).toBe(3);
      await expect(page.locator(".gallery-timeline section")).toHaveCount(2);
      await expect(page.locator(".gallery-cell")).toHaveCount(2);
      expect(
        await page
          .locator(".gallery-grid")
          .first()
          .evaluate((element) => getComputedStyle(element).columnCount),
      ).toBe("4");

      await page.getByRole("link", { name: "相册" }).click();
      await expect(page.getByRole("heading", { name: "相册" })).toBeVisible();
      const albumCard = page.getByRole("link", { name: new RegExp(albumName) });
      await expect(albumCard).toContainText("家庭可见");
      await albumCard.click();
      await expect(
        page.getByRole("heading", { name: albumName }),
      ).toBeVisible();
      await expect(page.locator(".gallery-cell")).toHaveCount(2);
      await clickUntilVisible(
        page.getByRole("button", { name: "分享", exact: true }),
        page.getByRole("region", { name: "分享" }),
      );
      await page.getByRole("button", { name: "关闭", exact: true }).click();

      await clickUntilVisible(
        page.locator(".gallery-cell").first(),
        page.getByRole("dialog", { name: "照片" }),
      );
      await expect(page.locator(".gallery-viewer-stage")).toHaveCSS(
        "background-color",
        /rgba?\(/,
      );
      await expect(page.locator(".gallery-viewer-preview")).toHaveAttribute(
        "data-state",
        "preview",
      );
      await expect(page.locator(".gallery-viewer-preview")).toHaveAttribute(
        "aria-busy",
        "false",
      );
      await expect.poll(() => previewRequested).toBe(true);
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog", { name: "照片" })).toHaveCount(0);
      await clickUntilVisible(
        page.locator(".gallery-cell").first(),
        page.getByRole("dialog", { name: "照片" }),
      );
      await page.getByRole("button", { name: "关闭照片查看器" }).click();

      await page.getByRole("button", { name: "分享", exact: true }).click();
      await page.getByRole("button", { name: "创建分享" }).click();
      const shareLink = await page.locator(".gallery-share-link").textContent();
      expect(
        Boolean(shareLink?.startsWith("https://localhost:3443/share/")),
      ).toBe(true);

      const publicContext = await browser.newContext({
        ignoreHTTPSErrors: true,
        viewport: { width: 1280, height: 900 },
      });
      try {
        expect((await publicContext.cookies()).length).toBe(0);
        const publicPage = await publicContext.newPage();
        let publicOriginalRequested = false;
        let publicDerivedFailure = false;
        publicPage.on("request", (request) => {
          if (new URL(request.url()).pathname.includes("/derived/original")) {
            publicOriginalRequested = true;
          }
        });
        publicPage.on("response", (response) => {
          if (
            /\/derived\/(?:thumbnail|preview)$/u.test(
              new URL(response.url()).pathname,
            ) &&
            response.status() !== 200
          ) {
            publicDerivedFailure = true;
          }
        });
        await publicPage.goto(shareLink!);
        await expect(
          publicPage.getByRole("heading", { name: albumName }),
        ).toBeVisible();
        await expect(publicPage.locator(".gallery-cell")).toHaveCount(2);
        await clickUntilVisible(
          publicPage.locator(".gallery-cell").first(),
          publicPage.getByRole("dialog", { name: "照片" }),
        );
        await expect
          .poll(() =>
            publicPage
              .getByRole("dialog", { name: "照片" })
              .locator("img")
              .evaluate((image: HTMLImageElement) => image.naturalWidth),
          )
          .toBeGreaterThan(0);
        expect(publicOriginalRequested).toBe(false);
        await expect(
          publicPage.getByRole("link", { name: "下载原图" }),
        ).toHaveCount(0);
        await expect(
          publicPage.getByRole("region", { name: "照片详情" }),
        ).toHaveCount(0);
        expect(publicDerivedFailure).toBe(false);
        expect((await publicContext.cookies()).length).toBe(0);
      } finally {
        await publicContext.close();
      }

      await page.goto(shareLink!);
      await expect(
        page.getByRole("heading", { name: albumName }),
      ).toBeVisible();
      expect(originalRequested).toBe(false);
      expect(derivedResponseFailure).toBe(false);
      expect(sensitiveResponse).toBe(false);
      expect(
        await page.evaluate(() => document.cookie.includes("family_session")),
      ).toBe(false);
    } finally {
      await context.close();
    }
  });

  test("Phase 6E owner integrates mutations, CAS conflict and browser attachment downloads", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 1440, height: 1000 },
    });
    try {
      await realLogin(context);
      const page = await context.newPage();
      await page.goto(`/albums/${albumId}`);
      await clickUntilVisible(
        page.locator(".gallery-cell").first(),
        page.getByRole("dialog", { name: "照片" }),
      );
      const panel = page.getByRole("region", { name: "照片详情" });
      await expect(panel).toBeVisible();
      await panel.getByRole("button", { name: "收藏", exact: true }).click();
      await expect(
        panel.getByRole("button", { name: "取消收藏", exact: true }),
      ).toHaveAttribute("aria-pressed", "true");
      await panel
        .getByRole("button", { name: "取消收藏", exact: true })
        .click();
      await expect(
        panel.getByRole("button", { name: "收藏", exact: true }),
      ).toBeEnabled();
      await panel
        .getByRole("button", { name: "设为家庭精选", exact: true })
        .click();
      await expect(
        panel.getByRole("button", { name: "取消家庭精选", exact: true }),
      ).toBeEnabled();
      await panel
        .getByRole("button", { name: "取消家庭精选", exact: true })
        .click();
      await expect(
        panel.getByRole("button", { name: "设为家庭精选", exact: true }),
      ).toBeEnabled();
      await panel.getByLabel("新标签").fill("旅行");
      await panel.getByRole("button", { name: "添加标签" }).click();
      await expect(
        panel.getByRole("button", { name: "移除标签 旅行" }),
      ).toBeVisible();
      await panel.getByRole("button", { name: "移除标签 旅行" }).click();
      await expect(
        panel.getByRole("button", { name: "移除标签 旅行" }),
      ).toHaveCount(0);
      await panel.getByRole("button", { name: "编辑备注" }).click();
      await panel.getByLabel("照片备注").fill("初始备注");
      await panel.getByRole("button", { name: "保存备注" }).click();
      await expect(panel.getByText("初始备注", { exact: true })).toBeVisible();

      // A real concurrent writer updates the revision after this editor opens.
      await panel.getByRole("button", { name: "编辑备注" }).click();
      await panel.getByLabel("照片备注").fill("过期草稿");
      const detailPath = `/api/v1/albums/${albumId}/media/${mediaIds[0]}`;
      const current = (await (
        await context.request.get(detailPath)
      ).json()) as { noteRevision: string };
      const concurrent = await context.request.put(`${detailPath}/note`, {
        headers: { origin: "https://localhost:3443" },
        data: { note: "最新并发备注", expectedRevision: current.noteRevision },
      });
      expect(concurrent.status()).toBe(200);
      let notePuts = 0;
      page.on("request", (request) => {
        if (
          new URL(request.url()).pathname === `${detailPath}/note` &&
          request.method() === "PUT"
        )
          notePuts += 1;
      });
      await panel.getByRole("button", { name: "保存备注" }).click();
      await expect(panel.getByRole("status")).toContainText(
        "备注已被其他人更新",
      );
      await expect(
        panel.getByText("最新并发备注", { exact: true }),
      ).toBeVisible();
      await expect(panel.getByLabel("照片备注")).toHaveCount(0);
      expect(notePuts).toBe(1);
      const latest = (await (await context.request.get(detailPath)).json()) as {
        note: string;
        noteRevision: string;
      };
      expect(latest.note).toBe("最新并发备注");

      await panel.getByRole("button", { name: "查看评论" }).click();
      await expect(
        panel.getByRole("button", { name: "发表评论" }),
      ).toBeEnabled();
      await panel
        .getByLabel("新评论")
        .fill("<script>synthetic-comment</script>");
      let commentPosts = 0;
      let releasePost!: () => void;
      let enteredPost!: () => void;
      const postGate = new Promise<void>((done) => {
        releasePost = done;
      });
      const postEntered = new Promise<void>((done) => {
        enteredPost = done;
      });
      await page.route(`**${detailPath}/comments`, async (route) => {
        if (route.request().method() !== "POST") {
          await route.continue();
          return;
        }
        commentPosts += 1;
        enteredPost();
        await postGate;
        await route.continue();
      });
      try {
        await panel
          .getByLabel("新评论")
          .evaluate((element: HTMLTextAreaElement) => {
            element.form!.requestSubmit();
            element.form!.requestSubmit();
          });
        await postEntered;
        await expect(
          panel.getByRole("button", { name: "发表评论" }),
        ).toBeDisabled();
        expect(commentPosts).toBe(1);
      } finally {
        releasePost();
      }
      await expect(
        panel.getByText("<script>synthetic-comment</script>", { exact: true }),
      ).toBeVisible();
      expect(commentPosts).toBe(1);
      await expect(panel.locator("script")).toHaveCount(0);
      await panel.getByRole("button", { name: "删除评论 验收成员" }).click();
      await expect(
        panel.getByText("<script>synthetic-comment</script>", { exact: true }),
      ).toHaveCount(0);
      await page.unroute(`**${detailPath}/comments`);

      let fetchDownload = false;
      page.on("request", (request) => {
        if (
          /\/download\//u.test(request.url()) &&
          request.resourceType() !== "document"
        )
          fetchDownload = true;
      });
      for (const [label, kind] of [
        ["下载原图", "original"],
        ["下载预览", "preview"],
      ] as const) {
        const link = panel.getByRole("link", { name: label });
        await expect(link).toHaveAttribute(
          "href",
          `${detailPath}/download/${kind}`,
        );
        const event = page.waitForEvent("download");
        await link.click();
        const download = await event;
        expect(new URL(download.url()).pathname).toBe(
          `${detailPath}/download/${kind}`,
        );
        expect(await download.failure()).toBeNull();
      }
      expect(fetchDownload).toBe(false);
      const retained = await context.request.post(`${detailPath}/comments`, {
        headers: { origin: "https://localhost:3443" },
        data: { body: "他人的评论" },
      });
      expect(retained.status()).toBe(201);
      await page.getByRole("button", { name: "下一张" }).click();
      await expect(
        panel.getByText("最新并发备注", { exact: true }),
      ).toHaveCount(0);
      await expect(
        panel.getByRole("link", { name: "下载原图" }),
      ).toHaveAttribute(
        "href",
        `/api/v1/albums/${albumId}/media/${mediaIds[1]}/download/original`,
      );
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog", { name: "照片" })).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test("Phase 6E viewer-only actor receives view capabilities and hidden selected album stays denied", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 390, height: 844 },
    });
    try {
      await realLogin(context, viewerUsername);
      const page = await context.newPage();
      await page.goto(`/albums/${albumId}`);
      await clickUntilVisible(
        page.locator(".gallery-cell").first(),
        page.getByRole("dialog", { name: "照片" }),
      );
      const panel = page.getByRole("region", { name: "照片详情" });
      await expect(panel).toBeVisible();
      await expect(panel.getByRole("button", { name: "编辑备注" })).toHaveCount(
        0,
      );
      await expect(panel.getByRole("button", { name: "添加标签" })).toHaveCount(
        0,
      );
      await expect(
        panel.getByRole("button", { name: "设为家庭精选" }),
      ).toHaveCount(0);
      await panel.getByRole("button", { name: "收藏", exact: true }).click();
      await expect(
        panel.getByRole("button", { name: "取消收藏", exact: true }),
      ).toBeEnabled();
      await panel.getByRole("button", { name: "查看评论" }).click();
      await expect(
        panel.getByRole("button", { name: "发表评论" }),
      ).toBeEnabled();
      await expect(
        panel.getByText("他人的评论", { exact: true }),
      ).toBeVisible();
      await expect(
        panel.getByRole("button", { name: "删除评论 验收成员" }),
      ).toHaveCount(0);
      await panel.getByLabel("新评论").fill("只读成员仍可评论");
      await panel.getByRole("button", { name: "发表评论" }).click();
      await expect(
        panel.getByText("只读成员仍可评论", { exact: true }),
      ).toBeVisible();
      await panel
        .getByRole("button", { name: "删除评论 只读验收成员" })
        .click();
      await expect(
        panel.getByText("只读成员仍可评论", { exact: true }),
      ).toHaveCount(0);
      await expect(panel.getByRole("link", { name: "下载原图" })).toBeVisible();
      await expect(panel.getByRole("link", { name: "下载预览" })).toBeVisible();
      expect(
        await page
          .getByRole("dialog", { name: "照片" })
          .evaluate((element) => element.scrollWidth <= element.clientWidth),
      ).toBe(true);
      const denied = await context.request.get(
        `/api/v1/albums/${hiddenAlbumId}/media/${mediaIds[0]}`,
      );
      expect(denied.status()).toBe(404);
      await page.goto(`/albums/${hiddenAlbumId}`);
      await expect(page.getByRole("region", { name: "照片详情" })).toHaveCount(
        0,
      );
      await expect(page.locator(".gallery-cell")).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test("Phase 6E discards delayed detail from the previous Viewer target", async ({
    browser,
  }) => {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    let release!: () => void;
    try {
      await realLogin(context);
      const page = await context.newPage();
      let entered!: () => void;
      let delivered!: () => void;
      const enteredGate = new Promise<void>((done) => {
        entered = done;
      });
      const deliverGate = new Promise<void>((done) => {
        delivered = done;
      });
      const gate = new Promise<void>((done) => {
        release = done;
      });
      await page.route(
        `**/api/v1/albums/${albumId}/media/${mediaIds[0]}`,
        async (route) => {
          const response = await route.fetch();
          entered();
          await gate;
          await route.fulfill({ response });
          delivered();
        },
      );
      await page.goto(`/albums/${albumId}`);
      await clickUntilVisible(
        page.locator(".gallery-cell").first(),
        page.getByRole("dialog", { name: "照片" }),
      );
      await enteredGate;
      await page.getByRole("button", { name: "下一张" }).click();
      const panel = page.getByRole("region", { name: "照片详情" });
      await expect(
        panel.getByRole("link", { name: "下载原图" }),
      ).toHaveAttribute(
        "href",
        `/api/v1/albums/${albumId}/media/${mediaIds[1]}/download/original`,
      );
      release();
      await deliverGate;
      await expect(
        panel.getByText("最新并发备注", { exact: true }),
      ).toHaveCount(0);
      await expect(
        panel.getByRole("link", { name: "下载原图" }),
      ).toHaveAttribute(
        "href",
        `/api/v1/albums/${albumId}/media/${mediaIds[1]}/download/original`,
      );
    } finally {
      release?.();
      await context.close();
    }
  });

  test("mobile UI collapses sidebars and keeps real navigation and viewer", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 390, height: 844 },
    });
    try {
      await realLogin(context);
      const page = await context.newPage();
      let originalRequested = false;
      page.on("request", (request) => {
        if (new URL(request.url()).pathname.includes("/derived/original")) {
          originalRequested = true;
        }
      });
      await page.goto("/");
      await expect(
        page.getByRole("heading", { name: familyName }),
      ).toBeVisible();
      await expect(page.getByLabel("辅助信息")).toBeHidden();
      expect(
        await page
          .getByLabel("主导航")
          .evaluate((element) => getComputedStyle(element).position),
      ).toBe("fixed");
      expect(
        await page
          .locator(".gallery-grid")
          .first()
          .evaluate((element) => getComputedStyle(element).columnCount),
      ).toBe("2");
      await page.getByRole("link", { name: "相册" }).click();
      await expect(page.getByText(albumName)).toBeVisible();
      await page.getByText(albumName).click();
      await clickUntilVisible(
        page.getByRole("button", { name: "分享", exact: true }),
        page.getByRole("region", { name: "分享" }),
      );
      await page.getByRole("button", { name: "关闭", exact: true }).click();
      await clickUntilVisible(
        page.locator(".gallery-cell").first(),
        page.getByRole("dialog", { name: "照片" }),
      );
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog", { name: "照片" })).toHaveCount(0);
      expect(originalRequested).toBe(false);
    } finally {
      await context.close();
    }
  });
});

async function clickUntilVisible(trigger: Locator, target: Locator) {
  await expect(async () => {
    await trigger.click();
    await expect(target).toBeVisible({ timeout: 750 });
  }).toPass({ timeout: 10_000 });
}

async function realLogin(context: BrowserContext, loginUsername = username) {
  const response = await context.request.post(
    "https://localhost:3443/api/v1/auth/login",
    {
      headers: {
        origin: "https://localhost:3443",
        "content-type": "application/json",
      },
      data: { username: loginUsername, password: syntheticPassword },
    },
  );
  expect(response.status()).toBe(204);
}

async function assertDevDatabase(connection: PoolConnection) {
  await connection.query("SET SESSION time_zone = '+00:00'");
  const [rows] = await connection.query<RowDataPacket[]>(
    `SELECT DATABASE() AS databaseName, VERSION() AS mysqlVersion,
            CURRENT_USER() AS currentUser,
            @@GLOBAL.innodb_native_foreign_keys AS nativeFk,
            @@SESSION.foreign_key_checks AS foreignKeyChecks`,
  );
  const row = rows[0];
  if (
    row?.databaseName !== "family_album_dev" ||
    !String(row.mysqlVersion).startsWith("9.7.2") ||
    String(row.currentUser).toLowerCase().startsWith("root@") ||
    String(row.nativeFk) !== "1" ||
    String(row.foreignKeyChecks) !== "1"
  ) {
    throw new Error("PHASE5_WEB_E2E_DEV_PREFLIGHT_FAILED");
  }
}

async function insertMedia(connection: PoolConnection, fixture: MediaFixture) {
  const original = fixture.preview;
  const objectSha = createHash("sha256").update(original).digest();
  const [object] = await connection.query<ResultSetHeader>(
    `INSERT INTO storage_objects
      (family_id, sha256, byte_size, key_version, state, durable_at, verified_at)
     VALUES (?, ?, ?, 1, 'AVAILABLE', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
    [familyId, objectSha, original.length],
  );
  const objectId = String(object.insertId);
  const [upload] = await connection.query<ResultSetHeader>(
    `INSERT INTO upload_sessions
      (public_id, family_id, created_by_member_id, original_filename,
       declared_size, committed_offset, state, computed_sha256,
       finalize_started_at, storage_object_id, completed_at, expires_at)
     VALUES (?, ?, ?, 'synthetic.webp', ?, ?, 'COMPLETE', ?,
       CURRENT_TIMESTAMP(3), ?, CURRENT_TIMESTAMP(3),
       DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL 1 DAY))`,
    [
      randomBytes(16),
      familyId,
      memberId,
      original.length,
      original.length,
      objectSha,
      objectId,
    ],
  );
  const [media] = await connection.query<ResultSetHeader>(
    `INSERT INTO media_items
      (family_id, storage_object_id, source_upload_id, uploaded_at,
       media_type, detected_mime, processing_state, generation, recipe_id,
       metadata_generation, raw_width, raw_height, display_width, display_height, orientation,
       captured_source, captured_time_status, timeline_key, timeline_basis)
     VALUES (?, ?, ?, ?, 'IMAGE', 'image/webp', 'READY', 1, 1,
       1, ?, ?, ?, ?, 1, 'NONE', 'ABSENT', ?, 'UPLOAD_UTC')`,
    [
      familyId,
      objectId,
      String(upload.insertId),
      fixture.timeline,
      fixture.displayWidth,
      fixture.displayHeight,
      fixture.displayWidth,
      fixture.displayHeight,
      fixture.timeline,
    ],
  );
  const mediaId = String(media.insertId);
  const [job] = await connection.query<ResultSetHeader>(
    `INSERT INTO background_jobs
      (family_id, media_id, generation, recipe_id, job_type, state, available_at)
     VALUES (?, ?, 1, 1, 'IMAGE_DERIVATIVES', 'QUEUED', CURRENT_TIMESTAMP(3))`,
    [familyId, mediaId],
  );
  const jobId = String(job.insertId);
  await insertDerived(
    connection,
    mediaId,
    jobId,
    "THUMBNAIL",
    fixture.thumbnail,
    128,
    128,
  );
  const previewDimensions =
    fixture.preview === wideWebP ? [2048, 396] : [128, 128];
  await insertDerived(
    connection,
    mediaId,
    jobId,
    "PREVIEW",
    fixture.preview,
    previewDimensions[0]!,
    previewDimensions[1]!,
  );
  writeDerivedFiles(mediaId, fixture);
  const originalPath = resolve(
    mediaRoot!,
    buildOriginalPath(
      familyId,
      objectSha.toString("hex"),
      String(original.length),
    ),
  );
  mkdirSync(resolve(originalPath, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(originalPath, original, { flag: "wx", mode: 0o400 });
  return mediaId;
}

async function insertDerived(
  connection: PoolConnection,
  mediaId: string,
  jobId: string,
  kind: "THUMBNAIL" | "PREVIEW",
  bytes: Buffer,
  width: number,
  height: number,
) {
  await connection.query(
    `INSERT INTO derived_assets
      (family_id, media_id, generation, recipe_id, kind, state, reserved_bytes,
       byte_size, sha256, width, height, output_mime, producer_job_id,
       producer_lease_epoch, published_at)
     VALUES (?, ?, 1, 1, ?, 'READY', ?, ?, ?, ?, ?, 'image/webp', ?, 1,
       CURRENT_TIMESTAMP(3))`,
    [
      familyId,
      mediaId,
      kind,
      bytes.length,
      bytes.length,
      createHash("sha256").update(bytes).digest(),
      width,
      height,
      jobId,
    ],
  );
}

function writeDerivedFiles(mediaId: string, fixture: MediaFixture) {
  const directory = resolve(
    mediaRoot!,
    "derived",
    familyId,
    mediaId,
    "r1",
    "g1",
  );
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  let current = resolve(mediaRoot!, "derived", familyId);
  for (const segment of [mediaId, "r1", "g1"]) {
    chmodSync(current, 0o700);
    current = resolve(current, segment);
  }
  chmodSync(directory, 0o700);
  for (const [name, bytes] of [
    ["thumbnail.webp", fixture.thumbnail],
    ["preview.webp", fixture.preview],
  ] as const) {
    const target = resolve(directory, name);
    const source =
      bytes === squareWebP
        ? resolve(
            rootDir,
            "packages/storage/vendor/libwebp/1.6.0/examples/test.webp",
          )
        : resolve(
            rootDir,
            "packages/storage/vendor/libwebp/1.6.0/webp_js/test_webp_js.webp",
          );
    copyFileSync(source, target);
    chmodSync(target, 0o400);
  }
}
