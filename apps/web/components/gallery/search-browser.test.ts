import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type Browser, type Route } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
const root = resolve(import.meta.dirname, "../../../..");
let browser: Browser, bundle: string;
const item = (mediaId = "11", favorite = false) => ({
  mediaId,
  albumId: "3",
  timelineKey: "2024-02-29T00:00:00.000Z",
  timelineBasis: "UPLOAD_UTC",
  displayWidth: 100,
  displayHeight: 100,
  thumbnail: { kind: "thumbnail" },
  isFavorite: favorite,
  isFamilyFeatured: false,
});
const album = (id: string) => ({
  id,
  familyId: "4",
  ownerMemberId: "7",
  name: `可见相册${id}`,
  description: null,
  visibility: "CUSTOM",
  revision: "1",
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
  effectivePermissions: {
    canView: true,
    canUpload: false,
    canEdit: false,
    canDelete: false,
    canManageMembers: false,
  },
});
beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const { build } = require(
    createRequire(require.resolve("tsup")).resolve("esbuild"),
  ) as {
    build: (
      options: Record<string, unknown>,
    ) => Promise<{ outputFiles: { text: string }[] }>;
  };
  const result = await build({
    entryPoints: [resolve(root, "tests/fixtures/phase8a1-ui.tsx")],
    bundle: true,
    write: false,
    platform: "browser",
    jsx: "automatic",
    nodePaths: [resolve(root, "apps/web/node_modules")],
    define: { "process.env.NODE_ENV": '"development"' },
  });
  bundle = result.outputFiles[0]!.text;
  browser = await chromium.launch({ channel: "chrome", headless: true });
});
afterAll(async () => {
  await browser?.close();
});
async function host(favorites = false, timezoneId = "UTC") {
  const page = await browser.newPage({ timezoneId });
  page.setDefaultTimeout(4000);
  const state = {
    requests: [] as string[],
    hold: false,
    held: null as Route | null,
    actor: "7",
    favorite: favorites,
    status: 200,
    optionStatus: 200,
    mediaId: "13",
    empty: false,
  };
  await page.route("https://phase8a1.local/**", async (route) => {
    const u = new URL(route.request().url()),
      p = u.pathname;
    if (p === "/")
      return route.fulfill({
        contentType: "text/html",
        body: `<html><head><style>${readFileSync(resolve(root, "apps/web/app/styles.css"), "utf8")}</style></head><body><div id="root"></div><script>${bundle}</script></body></html>`,
      });
    if (p === "/api/v1/albums")
      return route.fulfill({
        json: {
          albums: [album(u.searchParams.has("afterId") ? "5" : "3")],
          nextAfterId: u.searchParams.has("afterId") ? null : "4",
        },
      });
    if (p === "/api/v1/families/4/search/options")
      return route.fulfill({
        status: state.optionStatus,
        json:
          state.optionStatus !== 200
            ? {
                error: {
                  code:
                    state.optionStatus === 401
                      ? "UNAUTHENTICATED"
                      : "SERVICE_UNAVAILABLE",
                  requestId: "synthetic",
                },
              }
            : {
                options: [
                  {
                    id: u.searchParams.has("cursor") ? "10" : "9",
                    name:
                      u.searchParams.get("kind") === "tag"
                        ? "可见标签"
                        : "首次来源成员",
                  },
                ],
                nextCursor: u.searchParams.has("cursor")
                  ? null
                  : "synthetic_option_cursor",
              },
      });
    if (p === "/api/v1/families/4/search") {
      state.requests.push(u.search);
      if (state.hold) {
        state.held = route;
        return;
      }
      return route.fulfill({
        status: state.status,
        json:
          state.status === 200
            ? {
                media: state.empty ? [] : [item(state.mediaId, state.favorite)],
                nextCursor: null,
              }
            : { error: { code: "UNAUTHENTICATED", requestId: "test" } },
      });
    }
    if (p === "/api/v1/auth/me")
      return route.fulfill({
        json: {
          user: { id: state.actor, username: "synthetic", displayName: null },
          memberships: [
            { id: "3", familyId: "4", familyName: "Synthetic", role: "MEMBER" },
          ],
        },
      });
    if (p.endsWith("/trash")) {
      state.empty = true;
      return route.fulfill({
        json: {
          mediaId: "11",
          lifecycleRevision: "2",
          state: "TRASHED",
          trashedAt: "2026-10-02T00:00:00.000Z",
          purgeAfter: "2026-11-01T00:00:00.000Z",
        },
      });
    }
    if (p.endsWith("/favorite")) {
      state.favorite = false;
      return route.fulfill({ json: { isFavorite: false } });
    }
    if (/^\/api\/v1\/albums\/3\/media\/[0-9]+$/.test(p))
      return route.fulfill({
        json: {
          ...Object.fromEntries(
            Object.entries(item(p.split("/").at(-1), state.favorite)).filter(
              ([key]) => key !== "albumId",
            ),
          ),
          preview: { kind: "preview" },
          orientation: 1,
          capturedLocalAt: null,
          cameraMake: null,
          cameraModel: null,
          tags: [],
          note: null,
          noteRevision: "1",
          lifecycleRevision: "1",
          commentCount: "0",
          capabilities: {
            canTrash: true,
            canManageFeatured: false,
            canEditTags: false,
            canEditNote: false,
            canComment: false,
            canDownloadOriginal: false,
            canDownloadPreview: false,
          },
        },
      });
    if (p.includes("/derived/"))
      return route.fulfill({
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="green"/></svg>',
      });
    return route.fulfill({ status: 404, json: {} });
  });
  await page.goto(
    `https://phase8a1.local/${favorites ? "?favoritesOnly=true" : ""}`,
  );
  return { page, state };
}
const settle = async (route: Route | null, mediaId = "14", status = 200) => {
  try {
    await route?.fulfill({
      status,
      json: { media: [item(mediaId)], nextCursor: null },
    });
  } catch {
    /* An aborted old request is expected. */
  }
};
describe("8A1 search browser state", () => {
  it("loads authorized album option pages, applies filters, clears and restores browser history", async () => {
    const { page, state } = await host();
    try {
      await page.getByRole("button", { name: "加载更多相册选项" }).click();
      await page.getByLabel("相册", { exact: true }).selectOption("5");
      await page.getByLabel("开始日期").fill("2024-02-29");
      await page.getByLabel("结束日期").fill("2024-03-01");
      await page.getByLabel("仅我的收藏").check();
      await page.getByRole("button", { name: "查找照片", exact: true }).click();
      await page
        .locator('img[src="/api/v1/media/13/derived/thumbnail"]')
        .waitFor();
      expect(state.requests.at(-1)).toContain("albumId=5");
      expect(state.requests.at(-1)).toContain("favoritesOnly=true");
      expect(state.requests.at(-1)).not.toContain("cursor");
      await page.getByRole("button", { name: "清除筛选" }).click();
      await page.locator(".gallery-cell").waitFor();
      expect(new URL(page.url()).search).toBe("");
      await page.goBack();
      await page.waitForFunction(() => location.search.includes("albumId=5"));
      await page.waitForFunction(
        () =>
          document.querySelector<HTMLSelectElement>('select[name="albumId"]')
            ?.value === "5",
      );
      expect(state.requests.at(-1)).toContain("albumId=5");
    } finally {
      await page.close();
    }
  });
  it("hides old rows while loading and ignores stale success/failure/finally after another filter", async () => {
    const { page, state } = await host();
    try {
      state.hold = true;
      await page.getByLabel("开始日期").fill("2024-01-01");
      await page.getByRole("button", { name: "查找照片", exact: true }).click();
      await page
        .getByRole("status", { name: "" })
        .filter({ hasText: "正在查找" })
        .waitFor();
      expect(await page.locator(".gallery-cell").count()).toBe(0);
      await page.waitForFunction(
        () => document.querySelector('input[name="fromDate"]') !== null,
      );
      const old = state.held;
      state.hold = false;
      state.mediaId = "12";
      await page.getByLabel("开始日期").fill("2025-01-01");
      await page.getByRole("button", { name: "查找照片", exact: true }).click();
      await page
        .locator('img[src="/api/v1/media/12/derived/thumbnail"]')
        .waitFor();
      await settle(old, "14", 503);
      expect(
        await page
          .locator('img[src="/api/v1/media/14/derived/thumbnail"]')
          .count(),
      ).toBe(0);
      expect(await page.getByText("暂时无法").count()).toBe(0);
    } finally {
      await page.close();
    }
  });
  it("cancels old loadMore when filters or actor change", async () => {
    const { page, state } = await host();
    try {
      state.hold = true;
      await page.getByRole("button", { name: "加载更多", exact: true }).click();
      await page.waitForFunction(
        () => document.querySelector(".gallery-skeleton-grid") !== null,
      );
      expect(state.requests.at(-1)).toContain("cursor=initial-cursor");
      const old = state.held;
      state.hold = false;
      state.actor = "8";
      await page.locator("#switch-actor").click();
      await page
        .locator('img[src="/api/v1/media/12/derived/thumbnail"]')
        .waitFor();
      await settle(old);
      expect(
        await page
          .locator('img[src="/api/v1/media/14/derived/thumbnail"]')
          .count(),
      ).toBe(0);
      expect(
        await page
          .locator('img[src="/api/v1/media/11/derived/thumbnail"]')
          .count(),
      ).toBe(0);
    } finally {
      await page.close();
    }
  });
  it("clears rows and viewer on 401 while preserving clearable empty results", async () => {
    const { page, state } = await host();
    try {
      state.empty = true;
      await page.getByRole("button", { name: "查找照片", exact: true }).click();
      await page.getByText("还没有照片").waitFor();
      expect(
        await page.getByRole("button", { name: "清除筛选" }).isEnabled(),
      ).toBe(true);
      state.status = 401;
      await page.getByRole("button", { name: "查找照片", exact: true }).click();
      await page.getByText("需要登录").waitFor();
      expect(await page.locator(".gallery-cell").count()).toBe(0);
    } finally {
      await page.close();
    }
  });
  it("refreshes the current favorites filter after cancelling a favorite in Viewer", async () => {
    const { page, state } = await host(true);
    try {
      await page.locator(".gallery-cell").click();
      state.empty = true;
      await page.getByRole("button", { name: "取消收藏", exact: true }).click();
      await page.waitForFunction(
        () => !document.querySelector(".gallery-viewer"),
      );
      expect(state.requests.at(-1)).toContain("favoritesOnly=true");
      expect(state.requests.at(-1)).not.toContain("cursor");
    } finally {
      await page.close();
    }
  });
  it("refreshes the current favorites filter after confirmed Viewer Trash", async () => {
    const { page, state } = await host(true);
    try {
      await page.locator(".gallery-cell").click();
      await page
        .getByRole("button", { name: "移入回收站", exact: true })
        .click();
      await page
        .getByRole("button", { name: "确认移入回收站", exact: true })
        .click();
      await page.waitForFunction(
        () => !document.querySelector(".gallery-viewer"),
      );
      expect(state.requests.at(-1)).toContain("favoritesOnly=true");
      expect(state.requests.at(-1)).not.toContain("cursor");
      await page.getByText("还没有照片", { exact: true }).waitFor();
    } finally {
      await page.close();
    }
  });
  it("uses literal calendar dates across DST device timezones", async () => {
    const paths: string[] = [];
    for (const timezone of ["UTC", "America/New_York"]) {
      const { page, state } = await host(false, timezone);
      try {
        await page.getByLabel("开始日期").fill("2024-03-10");
        await page.getByLabel("结束日期").fill("2024-03-10");
        await page
          .getByRole("button", { name: "查找照片", exact: true })
          .click();
        await page.waitForFunction(
          () => !document.querySelector('[role="status"]'),
        );
        paths.push(state.requests.at(-1)!);
      } finally {
        await page.close();
      }
    }
    expect(paths[0]).toBe(paths[1]);
    expect(paths[0]).toContain("fromDate=2024-03-10&toDate=2024-03-10");
  });
  it("applies the complete filename/member/single-tag batch and restores canonical URLs", async () => {
    const { page, state } = await host();
    try {
      await page.getByLabel("首次上传文件名").fill(" Café%_! ");
      await page.getByLabel("首次上传成员", { exact: true }).selectOption("9");
      await page
        .getByRole("button", { name: "加载更多标签选项", exact: true })
        .click();
      await page.getByLabel("标签", { exact: true }).selectOption("10");
      await page.getByRole("button", { name: "查找照片", exact: true }).click();
      await page.waitForFunction(() => location.search.includes("tagId=10"));
      expect(state.requests.at(-1)).toContain("filename=Caf%C3%A9%25_%21");
      expect(state.requests.at(-1)).toContain("uploaderMemberId=9");
      await page.getByRole("button", { name: "清除筛选", exact: true }).click();
      await page.waitForFunction(() => location.search === "");
      await page.goBack();
      await page.waitForFunction(() => location.search.includes("tagId=10"));
      expect(await page.getByLabel("首次上传文件名").inputValue()).toBe(
        "Café%_!",
      );
    } finally {
      await page.close();
    }
  });
  it("retries failed options pagination without discarding prior candidates", async () => {
    const { page, state } = await host();
    try {
      await page
        .getByRole("button", { name: "加载更多标签选项", exact: true })
        .waitFor();
      state.optionStatus = 503;
      await page
        .getByRole("button", { name: "加载更多标签选项", exact: true })
        .click();
      await page
        .getByRole("button", { name: "重试标签选项", exact: true })
        .waitFor();
      expect(
        await page
          .getByLabel("标签", { exact: true })
          .locator("option")
          .count(),
      ).toBe(2);
      state.optionStatus = 200;
      await page
        .getByRole("button", { name: "重试标签选项", exact: true })
        .click();
      await expect
        .poll(() =>
          page.getByLabel("标签", { exact: true }).locator("option").count(),
        )
        .toBe(3);
    } finally {
      await page.close();
    }
  });
  it("clears visible media and options on options authentication loss", async () => {
    const { page, state } = await host();
    try {
      await page
        .getByRole("button", { name: "加载更多标签选项", exact: true })
        .waitFor();
      state.optionStatus = 401;
      await page
        .getByRole("button", { name: "加载更多标签选项", exact: true })
        .click();
      await page.getByText("需要登录", { exact: true }).waitFor();
      expect(await page.locator(".gallery-cell").count()).toBe(0);
      expect(
        await page
          .getByLabel("标签", { exact: true })
          .locator("option")
          .count(),
      ).toBe(1);
      expect(await page.getByLabel("标签", { exact: true }).isDisabled()).toBe(
        true,
      );
    } finally {
      await page.close();
    }
  });
  it.each(["old-v1", "wrong-scope"])(
    "restarts current filters once after %s pagination rejection and clears Viewer",
    async (mode) => {
      const { page, state } = await host();
      const requests: string[] = [];
      const oldCursor = Buffer.from(
        JSON.stringify({
          version: mode === "old-v1" ? 1 : 2,
          timelineKey: item().timelineKey,
          mediaId: "11",
          scope: createHash("sha256")
            .update(
              mode === "old-v1"
                ? JSON.stringify([
                    "family-search-v1",
                    "4",
                    "7",
                    "2024-02-01",
                    "2024-02-29",
                    "3",
                    true,
                    24,
                  ])
                : "synthetic_wrong_scope",
            )
            .digest("hex"),
        }),
      ).toString("base64url");
      const validCursor = Buffer.from(
        JSON.stringify({
          version: 2,
          timelineKey: item().timelineKey,
          mediaId: "13",
          scope: "b".repeat(64),
        }),
      ).toString("base64url");
      let rejected: Route | undefined, restart: Route | undefined;
      let firstCount = 0;
      try {
        await page.route(
          "https://phase8a1.local/api/v1/families/4/search?**",
          async (route) => {
            const url = new URL(route.request().url());
            requests.push(url.search);
            if (url.searchParams.get("cursor") === oldCursor) {
              rejected = route;
              return;
            }
            if (url.searchParams.get("cursor") === validCursor)
              return route.fulfill({
                json: { media: [item("14")], nextCursor: null },
              });
            firstCount++;
            if (firstCount === 1)
              return route.fulfill({
                json: { media: [item("11")], nextCursor: oldCursor },
              });
            restart = route;
          },
        );
        state.favorite = true;
        await page.getByLabel("首次上传文件名").fill("Café%_!");
        await page.getByLabel("首次上传成员").selectOption("9");
        await page.getByLabel("标签", { exact: true }).selectOption("9");
        await page.getByLabel("开始日期").fill("2024-02-01");
        await page.getByLabel("结束日期").fill("2024-02-29");
        await page.getByLabel("相册", { exact: true }).selectOption("3");
        await page.getByLabel("仅我的收藏").check();
        await page
          .getByRole("button", { name: "查找照片", exact: true })
          .click();
        await page
          .getByRole("button", { name: "加载更多", exact: true })
          .click();
        await expect.poll(() => Boolean(rejected)).toBe(true);
        await page.locator(".gallery-cell").click();
        await page.locator(".gallery-viewer").waitFor();
        await rejected!.fulfill({
          status: 400,
          json: {
            code: "INVALID_REQUEST",
            message: "The request is invalid.",
            requestId: "synthetic",
          },
        });
        await expect.poll(() => Boolean(restart)).toBe(true);
        expect(await page.locator(".gallery-cell").count()).toBe(0);
        expect(await page.locator(".gallery-viewer").count()).toBe(0);
        expect(requests).toHaveLength(3);
        expect(requests[2]).toBe(requests[0]);
        expect(requests[2]).not.toContain("cursor=");
        expect(requests[2]).toContain("filename=Caf%C3%A9%25_%21");
        expect(requests[2]).toContain("uploaderMemberId=9");
        expect(requests[2]).toContain("tagId=9");
        expect(requests[2]).toContain("favoritesOnly=true");
        await restart!.fulfill({
          json: { media: [item("13")], nextCursor: validCursor },
        });
        await page
          .getByRole("button", { name: "加载更多", exact: true })
          .click();
        await expect.poll(() => page.locator(".gallery-cell").count()).toBe(2);
        expect(requests).toHaveLength(4);
        expect(
          requests.filter(
            (r) => new URLSearchParams(r).get("cursor") === oldCursor,
          ),
        ).toHaveLength(1);
        expect(
          await page
            .getByRole("button", { name: "加载更多", exact: true })
            .count(),
        ).toBe(0);
        expect(await page.getByLabel("首次上传文件名").inputValue()).toBe(
          "Café%_!",
        );
      } finally {
        await page.close();
      }
    },
  );
  it("stops after the recovered first page is also invalid; does not loop", async () => {
    const { page } = await host();
    const requests: string[] = [];
    try {
      await page.route(
        "https://phase8a1.local/api/v1/families/4/search?**",
        async (route) => {
          requests.push(new URL(route.request().url()).search);
          return route.fulfill({
            status: 400,
            json: {
              code: "INVALID_REQUEST",
              message: "The request is invalid.",
              requestId: "synthetic",
            },
          });
        },
      );
      await page.getByRole("button", { name: "加载更多", exact: true }).click();
      await page
        .getByRole("button", { name: "重新查找", exact: true })
        .waitFor();
      expect(requests).toHaveLength(2);
      expect(requests[0]).toContain("cursor=");
      expect(requests[1]).not.toContain("cursor=");
      expect(await page.locator(".gallery-cell").count()).toBe(0);
      expect(
        await page
          .getByRole("button", { name: "加载更多", exact: true })
          .count(),
      ).toBe(0);
      await page.waitForTimeout(150);
      expect(requests).toHaveLength(2);
    } finally {
      await page.close();
    }
  });
  it.each(["generic-400", "network-503"])(
    "keeps ordinary retry behavior for %s without a first-page restart",
    async (mode) => {
      const { page } = await host();
      const requests: string[] = [];
      try {
        await page.route(
          "https://phase8a1.local/api/v1/families/4/search?**",
          async (route) => {
            requests.push(new URL(route.request().url()).search);
            return route.fulfill({
              status: mode === "generic-400" ? 400 : 503,
              json: {
                error: {
                  code:
                    mode === "generic-400" ? "OTHER" : "SERVICE_UNAVAILABLE",
                  requestId: "synthetic",
                },
              },
            });
          },
        );
        await page
          .getByRole("button", { name: "加载更多", exact: true })
          .click();
        await page
          .getByText("暂时无法加载", { exact: false })
          .first()
          .waitFor();
        expect(requests).toHaveLength(1);
        expect(await page.locator(".gallery-cell").count()).toBe(1);
        await page
          .getByRole("button", { name: "加载更多", exact: true })
          .click();
        await expect.poll(() => requests.length).toBe(2);
        expect(requests[1]).toBe(requests[0]);
      } finally {
        await page.close();
      }
    },
  );
  it("fits the filter controls on a narrow viewport", async () => {
    const { page } = await host();
    try {
      await page.setViewportSize({ width: 390, height: 844 });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
    } finally {
      await page.close();
    }
  });
});
