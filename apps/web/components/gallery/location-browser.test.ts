import { createRequire } from "node:module";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type Browser, type Page } from "@playwright/test";
import { beforeAll, afterAll, it, expect } from "vitest";
import { familyMapQuerySchema } from "@family-album/contracts";
const root = resolve(import.meta.dirname, "../../../..");
let browser: Browser;
const bundles = new Map<string, string>();
beforeAll(async () => {
  const require = createRequire(import.meta.url),
    { build } = require(
      createRequire(require.resolve("tsup")).resolve("esbuild"),
    );
  for (const provider of [
    "disabled",
    "https://tiles.openfreemap.org/styles/liberty",
    "https://tiles.openfreemap.org/styles/does-not-exist",
  ]) {
    const result = await build({
      entryPoints: [resolve(root, "tests/fixtures/phase8a1-ui.tsx")],
      bundle: true,
      write: false,
      platform: "browser",
      jsx: "automatic",
      nodePaths: [resolve(root, "apps/web/node_modules")],
      define: {
        "process.env.NODE_ENV": '"development"',
        "process.env.NEXT_PUBLIC_MAP_STYLE_URL": JSON.stringify(provider),
      },
    });
    bundles.set(provider, result.outputFiles[0].text);
  }
  browser = await chromium.launch({ channel: "chrome", headless: true });
}, 30000);
afterAll(async () => {
  await browser?.close();
});
const mapPage = {
  resolution: 6,
  clusters: [
    { cell: "86283082fffffff", latitude: 37.77, longitude: -122.41, count: 2 },
  ],
  locatedCount: 2,
  pendingCount: 1,
  noGpsCount: 3,
  polarCount: 1,
};
async function host(
  provider = "disabled",
  testStyle: "empty" | "stalled" | undefined = undefined,
  query = "",
) {
  const page = await browser.newPage();
  page.setDefaultTimeout(5000);
  const requests: string[] = [];
  const diagnostics: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") diagnostics.push(message.text());
  });
  page.on("pageerror", (error) => diagnostics.push(error.message));
  page.on("requestfailed", (request) => {
    if (request.url().startsWith("https://tiles.openfreemap.org"))
      diagnostics.push(request.failure()?.errorText ?? "NETWORK_FAILURE");
  });
  await page.route("http://localhost/**", async (route) => {
    const url = new URL(route.request().url());
    requests.push(url.pathname + url.search);
    const json = (body: unknown) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    if (url.pathname.startsWith("/vendor/maplibre-6.11.2/")) {
      const name = url.pathname.split("/").at(-1)!;
      return route.fulfill({
        contentType: "application/javascript",
        body: readFileSync(
          resolve(root, "apps/web/public/vendor/maplibre-6.11.2", name),
          "utf8",
        ),
      });
    }
    if (url.pathname === "/bundle.js")
      return route.fulfill({
        contentType: "application/javascript",
        body: bundles.get(provider)!,
      });
    if (url.pathname === "/")
      return route.fulfill({
        contentType: "text/html",
        body:
          "<html><head><style>" +
          readFileSync(
            resolve(
              root,
              "apps/web/node_modules/maplibre-gl/dist/maplibre-gl.css",
            ),
            "utf8",
          ) +
          readFileSync(
            resolve(root, "packages/ui-tokens/src/tokens.css"),
            "utf8",
          ) +
          readFileSync(resolve(root, "apps/web/app/styles.css"), "utf8") +
          '</style></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>',
      });
    if (url.pathname.endsWith("/search/map")) {
      if (
        !familyMapQuerySchema.safeParse(Object.fromEntries(url.searchParams))
          .success
      )
        return route.fulfill({
          status: 400,
          contentType: "application/json",
          body: JSON.stringify({ error: { code: "INVALID_REQUEST" } }),
        });
      return json(mapPage);
    }
    if (url.pathname.endsWith("/search/locations"))
      return json({
        options: [
          {
            id:
              url.searchParams.get("kind") === "country"
                ? "country:US"
                : "city:5391959",
            name:
              url.searchParams.get("kind") === "country"
                ? "United States of America"
                : "San Francisco附近",
            count: 2,
          },
        ],
        nextCursor: null,
      });
    if (url.pathname.endsWith("/search/options"))
      return json({ options: [], nextCursor: null });
    if (url.pathname.endsWith("/search"))
      return json({ media: [], nextCursor: null });
    if (url.pathname === "/api/v1/albums")
      return json({ albums: [], nextAfterId: null });
    return route.fulfill({ status: 404 });
  });
  if (testStyle)
    await page.route("https://tiles.openfreemap.org/**", (route) =>
      testStyle === "stalled"
        ? new Promise<void>(() => {})
        : route.fulfill({
            contentType: "application/json",
            body: JSON.stringify({
              version: 8,
              sources: {},
              layers: [
                {
                  id: "background",
                  type: "background",
                  paint: { "background-color": "#f5f3ed" },
                },
              ],
            }),
          }),
    );
  await page.goto("http://localhost/" + query);
  await page.getByRole("button", { name: "地图与地区", exact: true }).click();
  return { page, requests, diagnostics };
}
async function mapRequests(page: Page) {
  await page.getByText(/2 张有当前地点/).waitFor();
}
it("preserves polar regions and count labels with disabled basemap; region clicks update filters and URL", async () => {
  const { page, requests } = await host();
  try {
    await mapRequests(page);
    expect(await page.getByText("底图已禁用，仍可使用地区列表。").count()).toBe(
      1,
    );
    expect(await page.getByText(/Web Mercator/).count()).toBe(1);
    await page
      .getByRole("button", { name: "United States of America · 2 张" })
      .click();
    await page.waitForFunction(() =>
      location.search.includes("location=country%3AUS"),
    );
    expect(
      requests.some(
        (url) =>
          url.includes("/search?") && url.includes("location=country%3AUS"),
      ),
    ).toBe(true);
    await page.evaluate(() => history.back());
    await page.waitForFunction(() => !location.search.includes("location="));
    expect(await page.locator("select[name=location]").inputValue()).toBe("");
  } finally {
    await page.close();
  }
});
it("ignores responses after close, actor changes, or filters supersede an in-flight map request", async () => {
  const { page } = await host();
  try {
    await mapRequests(page);
    let release: () => void = () => {};
    const barrier = new Promise<void>((r) => {
      release = r;
    });
    await page.route("**/search/map?**", async (route) => {
      await barrier;
      await route
        .fulfill({
          contentType: "application/json",
          body: JSON.stringify({ ...mapPage, locatedCount: 9999 }),
        })
        .catch(() => {});
    });
    await page.locator("input[name=filename]").fill("new-filter");
    await page.getByRole("button", { name: "查找照片", exact: true }).click();
    await page.getByRole("button", { name: "关闭地图" }).click();
    release();
    expect(await page.getByText(/9999 张有当前地点/).count()).toBe(0);
    await page.locator("#switch-actor").click();
    expect(
      await page
        .getByRole("button", { name: "地图与地区", exact: true })
        .count(),
    ).toBe(1);
  } finally {
    await page.close();
  }
});
it("clears private map and region state on authentication loss", async () => {
  const { page } = await host();
  try {
    await mapRequests(page);
    await page.route("**/search/map?**", (route) =>
      route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "UNAUTHENTICATED" } }),
      }),
    );
    await page.locator("input[name=filename]").fill("auth-lost");
    await page.getByRole("button", { name: "查找照片", exact: true }).click();
    await page
      .getByText(/请.*登录|登录.*后/)
      .first()
      .waitFor();
    expect(await page.getByRole("region", { name: "地图与地区" }).count()).toBe(
      0,
    );
  } finally {
    await page.close();
  }
});
it("uses real hosted interactive basemap with no private URL, referrer, or authentication data", async () => {
  const { page, diagnostics } = await host(
    "https://tiles.openfreemap.org/styles/liberty",
  );
  const external: {
    url: string;
    status: number;
    referrer: string;
    cookie: boolean;
    authorization: boolean;
  }[] = [];
  page.on("response", (response) => {
    if (new URL(response.url()).origin === "https://tiles.openfreemap.org") {
      const headers = response.request().headers();
      external.push({
        url: response.url(),
        status: response.status(),
        referrer: headers.referer ?? "",
        cookie: !!headers.cookie,
        authorization: !!headers.authorization,
      });
    }
  });
  try {
    await page
      .locator(".maplibregl-ctrl-attrib")
      .waitFor({ state: "attached", timeout: 30000 });
    await page.waitForFunction(
      () => !document.body.textContent?.includes("加载底图…"),
      {},
      { timeout: 30000 },
    );
    expect(await page.getByText(/底图暂不可用/).count()).toBe(0);
    expect(await page.locator(".maplibregl-canvas").count()).toBe(1);
    expect(
      await page.getByRole("button", { name: "粗略地区 2 张照片" }).count(),
    ).toBeGreaterThan(0);
    expect(external.some((r) => r.status === 200)).toBe(true);
    expect(
      external.every(
        (r) =>
          !r.referrer &&
          !r.cookie &&
          !r.authorization &&
          !/filename|location=|familyId|37\.780000|markers|geocoder/.test(
            r.url,
          ),
      ),
    ).toBe(true);
    mkdirSync(".cache/phase8-map/evidence", { recursive: true });
    writeFileSync(
      ".cache/phase8-map/evidence/basemap-requests.json",
      JSON.stringify(external, null, 2),
    );
    await page.screenshot({ path: ".cache/phase8-map/evidence/basemap.png" });
  } finally {
    console.log(JSON.stringify({ basemapDiagnostics: diagnostics }));
    await page.close();
  }
}, 40000);
it("ignores a delayed drag response after zoom changes the viewport", async () => {
  const { page } = await host(
    "https://tiles.openfreemap.org/styles/liberty",
    "empty",
  );
  let release: () => void = () => {};
  const barrier = new Promise<void>((r) => {
    release = r;
  });
  try {
    await page.waitForFunction(
      () => !document.body.textContent?.includes("加载底图…"),
      {},
      { timeout: 30000 },
    );
    await mapRequests(page);
    let calls = 0;
    await page.route("**/search/map?**", async (route) => {
      const sequence = ++calls;
      if (sequence === 1) await barrier;
      await route
        .fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            ...mapPage,
            locatedCount: sequence === 1 ? 9999 : 3,
          }),
        })
        .catch(() => {});
    });
    const canvas = page.locator(".maplibregl-canvas");
    await canvas.scrollIntoViewIfNeeded();
    const box = await canvas.boundingBox();
    if (!box) throw new Error("MAP_CANVAS_REQUIRED");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(
      box.x + box.width / 2 + 100,
      box.y + box.height / 2 + 20,
      { steps: 10 },
    );
    await page.mouse.up();
    await expect.poll(() => calls, { timeout: 5000 }).toBeGreaterThanOrEqual(1);
    await page.getByRole("button", { name: "Zoom in" }).click();
    await page.getByText(/3 张有当前地点/).waitFor();
    release();
    expect(await page.getByText(/9999 张有当前地点/).count()).toBe(0);
  } finally {
    release();
    await page.close();
  }
}, 40000);
it("bounds a stalled basemap and retains region drilldown with explicit retry", async () => {
  const { page } = await host(
    "https://tiles.openfreemap.org/styles/liberty",
    "stalled",
  );
  try {
    await page.getByText(/底图暂不可用/).waitFor({ timeout: 20000 });
    expect(await page.getByRole("button", { name: "重试底图" }).count()).toBe(
      1,
    );
    await page
      .getByRole("button", { name: "United States of America · 2 张" })
      .click();
    await page.waitForFunction(() =>
      location.search.includes("location=country%3AUS"),
    );
  } finally {
    await page.close();
  }
}, 25000);
it("retains usable region drilldown after provider failure, without falling back to public OSM", async () => {
  const { page } = await host(
    "https://tiles.openfreemap.org/styles/does-not-exist",
  );
  try {
    await page.getByText(/底图暂不可用/).waitFor({ timeout: 30000 });
    await page
      .getByRole("button", { name: "San Francisco附近 · 2 张" })
      .click();
    await page.waitForFunction(() =>
      location.search.includes("city%3A5391959"),
    );
    await page.getByText(/底图暂不可用/).waitFor({ timeout: 30000 });
    expect(await page.getByText(/底图暂不可用/).count()).toBe(1);
  } finally {
    await page.close();
  }
}, 40000);

it("moving a synthetic near-zero viewport sends plain decimal bounds accepted by the real API schema", async () => {
  const { page, requests } = await host(
    "https://tiles.openfreemap.org/styles/liberty",
    "empty",
    "?nearZeroBounds=1",
  );
  try {
    await page.waitForFunction(
      () => !document.body.textContent?.includes("加载底图…"),
    );
    await page.getByRole("button", { name: "Zoom in" }).click();
    await expect
      .poll(() => requests.filter((r) => r.includes("/search/map?")).length)
      .toBeGreaterThanOrEqual(2);
    const queries = requests
      .filter((r) => r.includes("/search/map?"))
      .map((r) => Object.fromEntries(new URL(r, "http://local").searchParams));
    expect(
      queries.every((q) => familyMapQuerySchema.safeParse(q).success),
    ).toBe(true);
    expect(queries.some((q) => q.bbox?.includes("-0.0000001"))).toBe(true);
    expect(await page.getByText(/地点暂不可用/).count()).toBe(0);
  } finally {
    await page.close();
  }
}, 20000);
