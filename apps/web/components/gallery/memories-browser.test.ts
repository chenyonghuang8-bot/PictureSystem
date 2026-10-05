import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type Browser, type Route } from "@playwright/test";
import { beforeAll, afterAll, it, expect } from "vitest";
const root = resolve(import.meta.dirname, "../../../..");
let browser: Browser,
  bundle = "";
beforeAll(async () => {
  const require = createRequire(import.meta.url),
    { build } = require(
      createRequire(require.resolve("tsup")).resolve("esbuild"),
    );
  const result = await build({
    entryPoints: [resolve(root, "tests/fixtures/phase9-memories-ui.tsx")],
    bundle: true,
    write: false,
    platform: "browser",
    jsx: "automatic",
    nodePaths: [resolve(root, "apps/web/node_modules")],
    define: { "process.env.NODE_ENV": '"development"' },
  });
  bundle = result.outputFiles[0].text;
  browser = await chromium.launch({ channel: "chrome", headless: true });
}, 30000);
afterAll(async () => {
  await browser?.close();
});
const context = (duration = 86400000) => ({
  anchorDate: "2026-10-05",
  zone: "Asia/Shanghai",
  policy: "memories-v1",
  serverNow: "2026-10-04T16:00:00.000Z",
  nextMidnight: new Date(
    Date.parse("2026-10-04T16:00:00.000Z") + duration,
  ).toISOString(),
  weekStart: "2025-09-29",
  weekEnd: "2025-10-06",
});
const item = (id = "11") => ({
  mediaId: id,
  albumId: "3",
  timelineKey: "2025-10-05T12:00:00.000Z",
  timelineBasis: "UPLOAD_UTC",
  displayWidth: 100,
  displayHeight: 100,
  isFavorite: false,
  isFamilyFeatured: false,
  thumbnail: { kind: "thumbnail" },
  timelineDate: "2025-10-05",
  dateBasis: "UPLOAD_UTC",
});
type Reply = (route: Route, url: URL, n: number) => Promise<void>;
async function host(query = "", reply?: Reply) {
  const page = await browser.newPage({ timezoneId: "America/New_York" }),
    requests: string[] = [];
  let n = 0;
  await page.route("http://localhost/**", async (route) => {
    const url = new URL(route.request().url());
    requests.push(url.pathname + url.search);
    if (url.pathname === "/bundle.js")
      return route.fulfill({
        contentType: "application/javascript",
        body: bundle,
      });
    if (url.pathname === "/")
      return route.fulfill({
        contentType: "text/html",
        body:
          "<html><head><style>" +
          readFileSync(resolve(root, "apps/web/app/styles.css"), "utf8") +
          '</style></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>',
      });
    if (url.pathname.includes("/memories")) {
      if (reply) return reply(route, url, ++n);
      return route.fulfill({
        json: url.pathname.endsWith("preview")
          ? {
              context: context(),
              cards: [
                { kind: "ON_THIS_DAY", media: [item()], hasMore: false },
                { kind: "LAST_YEAR_WEEK", media: [], hasMore: false },
              ],
            }
          : {
              context: context(),
              kind: url.searchParams.get("kind"),
              media: [item(url.searchParams.has("cursor") ? "12" : "11")],
              nextCursor: url.searchParams.has("cursor") ? null : "next",
            },
      });
    }
    if (url.pathname.includes("/albums/3/media/"))
      return route.fulfill({
        status: 404,
        json: {
          code: "NOT_FOUND",
          message: "Not found.",
          requestId: "synthetic",
        },
      });
    if (url.pathname.includes("/albums"))
      return route.fulfill({ json: { albums: [], nextCursor: null } });
    return route.fulfill({ status: 404 });
  });
  await page.goto("http://localhost/" + query);
  return { page, requests };
}
it("one preview request supplies both compact cards, empty state, literal fallback label and full-page links", async () => {
  const { page, requests } = await host();
  try {
    await page.getByText("上传日期 2025-10-05", { exact: true }).waitFor();
    expect(await page.getByRole("heading").allTextContents()).toEqual([
      "往年今日",
      "一年前的这周",
    ]);
    expect(
      requests.filter((x) => x.endsWith("/memories/preview")),
    ).toHaveLength(1);
    expect(await page.getByRole("link", { name: "查看全部" }).count()).toBe(2);
    expect(await page.getByText("这段时光还没有可查看的照片。").count()).toBe(
      1,
    );
  } finally {
    await page.close();
  }
});
it("pages once with bounded cursor, opens reused Viewer, and denied detail removes stale image/details", async () => {
  const { page, requests } = await host("?kind=ON_THIS_DAY");
  try {
    await page.getByText("上传日期 2025-10-05", { exact: true }).waitFor();
    await page.getByRole("button", { name: "加载更多", exact: true }).click();
    await page.waitForFunction(
      () => document.querySelectorAll(".memories-dates span").length === 2,
    );
    expect(requests.filter((x) => x.includes("cursor=next"))).toHaveLength(1);
    expect(
      await page.getByRole("button", { name: "加载更多", exact: true }).count(),
    ).toBe(0);
    await page.locator(".gallery-cell").first().click();
    await page.getByRole("dialog").waitFor();
    await page.getByText("没有找到这张照片。").first().waitFor();
    expect(await page.locator(".gallery-viewer-image").count()).toBe(0);
  } finally {
    await page.close();
  }
});
it("new actor/kind/family epochs discard old delayed successes and logout clears while a request is held", async () => {
  let release: (() => void) | undefined;
  const held = new Promise<void>((r) => (release = r));
  const { page } = await host("?kind=ON_THIS_DAY", async (route, url, n) => {
    if (n === 1) await held;
    await route
      .fulfill({
        json: {
          context: context(),
          kind: url.searchParams.get("kind"),
          media: [item(String(10 + n))],
          nextCursor: null,
        },
      })
      .catch(() => {});
  });
  try {
    await page.getByRole("button", { name: "切换账号", exact: true }).click();
    await page.waitForFunction(
      () => document.querySelectorAll(".gallery-cell").length === 1,
    );
    release!();
    await page.waitForTimeout(50);
    expect(await page.locator(".gallery-cell").count()).toBe(1);
    await page
      .getByRole("button", { name: "切换回忆类型", exact: true })
      .click();
    await page
      .getByRole("heading", { name: "一年前的这周", exact: true })
      .waitFor();
    await page.getByRole("button", { name: "切换家庭", exact: true }).click();
    await page.waitForFunction(
      () => document.querySelectorAll(".gallery-cell").length === 1,
    );
    await page
      .getByRole("button", { name: "退出测试账号", exact: true })
      .click();
    expect(await page.locator(".gallery-cell").count()).toBe(0);
    expect(await page.getByText("请重新登录查看回忆。").count()).toBe(1);
  } finally {
    release?.();
    await page.close();
  }
});
it("simulated persisted pageshow and same-document history trigger revalidation", async () => {
  const { page, requests } = await host("?kind=ON_THIS_DAY");
  try {
    await page.locator(".gallery-cell").waitFor();
    const before = requests.filter((x) => x.includes("/memories?")).length;
    await page.evaluate(() =>
      window.dispatchEvent(
        new PageTransitionEvent("pageshow", { persisted: true }),
      ),
    );
    await page.waitForFunction(
      () => document.querySelectorAll(".gallery-cell").length === 1,
    );
    expect(requests.filter((x) => x.includes("/memories?")).length).toBe(
      before + 1,
    );
    await page
      .getByRole("button", { name: "切换回忆类型", exact: true })
      .click();
    await page
      .getByRole("heading", { name: "一年前的这周", exact: true })
      .waitFor();
    await page.goBack();
    await page
      .getByRole("heading", { name: "往年今日", exact: true })
      .waitFor();
  } finally {
    await page.close();
  }
});
it("a delayed past-midnight 200 is never displayed, only one shared bootstrap is dispatched", async () => {
  const { page, requests } = await host(
    "?kind=ON_THIS_DAY",
    async (route, url) => {
      await new Promise((r) => setTimeout(r, 75));
      await route
        .fulfill({
          json: {
            context: context(1),
            kind: url.searchParams.get("kind"),
            media: [item()],
            nextCursor: null,
          },
        })
        .catch(() => {});
    },
  );
  try {
    await page.getByRole("alert").waitFor();
    expect(await page.locator(".gallery-cell").count()).toBe(0);
    expect(requests.filter((x) => x.includes("/memories?"))).toHaveLength(2);
    await page.waitForTimeout(150);
    expect(requests.filter((x) => x.includes("/memories?"))).toHaveLength(2);
  } finally {
    await page.close();
  }
});
