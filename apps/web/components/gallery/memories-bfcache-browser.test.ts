import { createRequire } from "node:module";
import { createServer, type Server, type ServerResponse } from "node:http";
import {
  readFileSync,
  mkdirSync,
  writeFileSync,
  mkdtempSync,
  existsSync,
  rmSync,
} from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { resolve } from "node:path";
import { chromium, type Browser, type Page } from "@playwright/test";
import { beforeAll, afterAll, it, expect } from "vitest";

const root = resolve(import.meta.dirname, "../../../..");
let browser: Browser,
  server: Server,
  origin = "",
  bundle = "";
let requests = 0,
  hold = false,
  htmlNoStore = false;
const pending = new Set<ServerResponse>();
const proof: unknown[] = [];
let chrome: ChildProcess,
  profile = "";
const pixel = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==",
  "base64",
);
const context = (day = "2026-10-05") => ({
  anchorDate: day,
  zone: "Asia/Shanghai",
  policy: "memories-v1",
  serverNow: `${day}T04:00:00.000Z`,
  nextMidnight: `${day}T16:00:00.000Z`,
  weekStart: "2025-09-29",
  weekEnd: "2025-10-06",
});
const item = {
  mediaId: "11",
  albumId: "3",
  timelineKey: "2025-10-05T12:00:00.000Z",
  timelineBasis: "UPLOAD_UTC",
  displayWidth: 1,
  displayHeight: 1,
  isFavorite: false,
  isFamilyFeatured: false,
  thumbnail: { kind: "thumbnail" },
  timelineDate: "2025-10-05",
  dateBasis: "UPLOAD_UTC",
};
function json(res: ServerResponse, status: number, body: unknown) {
  if (res.destroyed) return;
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "private, no-store",
  });
  res.end(JSON.stringify(body));
}
function release(status: number, body: unknown) {
  for (const res of pending) json(res, status, body);
  pending.clear();
}
const instrumentation = `<script>
window.__memoryLifecycle={id:crypto.randomUUID(),events:[],frames:[]};
function sample(){return {cells:document.querySelectorAll('.gallery-cell').length,viewer:document.querySelectorAll('[role="dialog"]').length,images:document.querySelectorAll('.gallery-viewer-image').length,visibility:document.visibilityState};}
for(const name of ['pageshow','pagehide','visibilitychange'])addEventListener(name,e=>{if(name==='pageshow'&&e.persisted)window.__memoryLifecycle.frames=[];const row={name,persisted:e.persisted===true,immediate:sample()};window.__memoryLifecycle.events.push(row);queueMicrotask(()=>row.afterHandlers=sample());});
function frame(){window.__memoryLifecycle.frames.push(sample());requestAnimationFrame(frame);}requestAnimationFrame(frame);
</script>`;
beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const { build } = require(
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
  server = createServer((req, res) => {
    const path = new URL(req.url!, "http://localhost").pathname;
    if (path === "/bundle.js") {
      res.writeHead(200, { "content-type": "application/javascript" });
      res.end(bundle);
      return;
    }
    if (path === "/away") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html><body>Other document</body></html>");
      return;
    }
    if (path === "/") {
      res.writeHead(200, {
        "content-type": "text/html",
        "cache-control": htmlNoStore
          ? "private, no-cache, no-store, max-age=0, must-revalidate"
          : "private, no-cache, max-age=0, must-revalidate",
      });
      res.end(
        `<html><head>${instrumentation}<style>${readFileSync(resolve(root, "apps/web/app/styles.css"), "utf8")}</style></head><body><a id="leave" href="/away">Leave document</a><div id="root"></div><script src="/bundle.js"></script></body></html>`,
      );
      return;
    }
    if (path.endsWith("/memories")) {
      requests++;
      if (hold) {
        pending.add(res);
        res.on("close", () => pending.delete(res));
        return;
      }
      json(res, 200, {
        context: context(),
        kind: "ON_THIS_DAY",
        media: [item],
        nextCursor: null,
      });
      return;
    }
    if (path === "/api/v1/albums/3/media/11") {
      json(res, 200, {
        ...item,
        orientation: 1,
        capturedLocalAt: null,
        cameraMake: null,
        cameraModel: null,
        preview: { kind: "preview" },
        tags: [],
        note: null,
        noteRevision: "1",
        lifecycleRevision: "1",
        commentCount: "0",
        capabilities: {
          canTrash: false,
          canManageFeatured: false,
          canEditTags: false,
          canEditNote: false,
          canComment: false,
          canDownloadOriginal: false,
          canDownloadPreview: false,
        },
      });
      return;
    }
    if (path.endsWith("/albums")) {
      json(res, 200, { albums: [], nextCursor: null });
      return;
    }
    if (/\/(thumbnail|preview)$/.test(path)) {
      res.writeHead(200, {
        "content-type": "image/png",
        "cache-control": "private, no-store",
      });
      res.end(pixel);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("TEST_SERVER_REQUIRED");
  origin = `http://127.0.0.1:${address.port}`;
  // Playwright disables BFCache by default. Use actual Chrome tabs, no routing,
  // no synthetic lifecycle dispatch, and a real same-origin HTTP server.
  profile = mkdtempSync(resolve(tmpdir(), "picture-phase9-native-chrome-"));
  chrome = spawn(
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    [
      "--remote-debugging-port=0",
      "--remote-debugging-address=127.0.0.1",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--disable-extensions",
      "--enable-automation",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  const portFile = resolve(profile, "DevToolsActivePort");
  for (let n = 0; n < 100 && !existsSync(portFile); n++)
    await new Promise((r) => setTimeout(r, 50));
  const port = Number(readFileSync(portFile, "utf8").split("\n")[0]);
  if (!Number.isInteger(port) || port < 1)
    throw new Error("OWNED_CHROME_PORT_REQUIRED");
  // noDefaults skips Playwright's forced focus/visibility override on this
  // owned default context; observe actual OS Chrome tabs, not emulated events.
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, {
    noDefaults: true,
  });
  const cdp = await browser.newBrowserCDPSession();
  const command = await cdp.send("Browser.getBrowserCommandLine");
  expect(command.arguments).not.toContain("--disable-back-forward-cache");
  await cdp.detach();
}, 30000);
afterAll(async () => {
  release(401, {
    code: "UNAUTHENTICATED",
    message: "Unauthorized",
    requestId: "synthetic",
  });
  await browser?.close();
  if (chrome?.exitCode === null) {
    const exited = once(chrome, "exit");
    chrome.kill("SIGTERM");
    await exited;
  }
  if (profile) rmSync(profile, { recursive: true, force: true });
  await new Promise<void>((r) => server?.close(() => r()));
  mkdirSync(resolve(root, ".cache/phase9"), { recursive: true });
  writeFileSync(
    resolve(root, ".cache/phase9/real-bfcache-proof.json"),
    JSON.stringify(
      {
        browser: browser?.version(),
        headless: false,
        disabledBFCacheArgumentRemoved: true,
        playwrightNoDefaults: true,
        requestInterception: false,
        syntheticLifecycleDispatch: false,
        htmlCacheControl:
          "Per case: eligible document omits no-store; production-header fallback retains it. API/images always private, no-store.",
        cases: proof,
      },
      null,
      2,
    ),
  );
});
async function ready(page: Page) {
  page.setDefaultTimeout(5000);
  requests = 0;
  hold = false;
  await page.goto(origin + "/?kind=ON_THIS_DAY");
  await page.locator(".gallery-cell").waitFor();
  console.info("BFCache fixture: grid ready");
  await page.locator(".gallery-cell").click();
  await page.waitForFunction(() => {
    const img = document.querySelector<HTMLImageElement>(
      ".gallery-viewer-image",
    );
    return img?.complete && img.naturalWidth > 0;
  });
  console.info("BFCache fixture: Viewer image ready");
  await page.evaluate("window.__memoryLifecycle.frames=[]");
  return page.evaluate<string>("window.__memoryLifecycle.id");
}
async function blankDuringWait(page: Page) {
  await page.bringToFront();
  await page.waitForFunction(
    () =>
      document.querySelectorAll(
        ".gallery-cell,[role=dialog],.gallery-viewer-image",
      ).length === 0,
  );
  await page.waitForTimeout(200);
  await page.waitForFunction("window.__memoryLifecycle.frames.length>=3");
  const snapshot = await page.evaluate<{
    id: string;
    events: {
      name: string;
      persisted: boolean;
      immediate: { cells: number; viewer: number; images: number };
      afterHandlers: { cells: number; viewer: number; images: number };
    }[];
    frames: {
      cells: number;
      viewer: number;
      images: number;
      visibility: string;
    }[];
  }>("window.__memoryLifecycle");
  const shown = snapshot.events.filter((e) => e.name === "pageshow").at(-1)!;
  expect(shown.immediate).toMatchObject({ cells: 0, viewer: 0, images: 0 });
  expect(shown.afterHandlers).toMatchObject({ cells: 0, viewer: 0, images: 0 });
  // Only frames after leaving/foregrounding are kept by the caller.
  expect(snapshot.frames.length).toBeGreaterThan(1);
  for (const frame of snapshot.frames)
    expect(frame).toMatchObject({ cells: 0, viewer: 0, images: 0 });
  return snapshot;
}
for (const outcome of ["auth", "day"] as const)
  it(`real cross-document BFCache back/forward clears photos and Viewer before held ${outcome} revalidation`, async () => {
    const page = await browser.contexts()[0]!.newPage();
    try {
      const id = await ready(page);
      hold = true;
      await page
        .locator("#leave")
        .evaluate((el: HTMLAnchorElement) => el.click());
      await page.waitForURL(origin + "/away", { waitUntil: "commit" });
      console.info("BFCache fixture: left document");
      await page.goBack({ waitUntil: "commit" });
      console.info("BFCache fixture: back navigation committed");
      console.info(
        "Chrome navigation reasons",
        JSON.stringify(
          await page.evaluate(() =>
            performance.getEntriesByType("navigation").map((e) => e.toJSON()),
          ),
        ),
      );
      await page.waitForFunction(
        "window.__memoryLifecycle?.events.some(e=>e.name==='pageshow'&&e.persisted)",
      );
      // The real pageshow listener starts frame recording synchronously, before
      // the production handler, so the first restored frame remains in evidence.
      const snapshot = await blankDuringWait(page);
      expect(snapshot.id).toBe(id);
      expect(
        snapshot.events.filter((e) => e.name === "pageshow").at(-1)?.persisted,
      ).toBe(true);
      expect(pending.size).toBeGreaterThan(0);
      if (outcome === "auth") {
        release(401, {
          code: "UNAUTHENTICATED",
          message: "Unauthorized",
          requestId: "synthetic",
        });
        await page.getByText("请重新登录查看回忆。").waitFor();
      } else {
        release(409, {
          code: "MEMORIES_ANCHOR_EXPIRED",
          message: "The memories date has expired. Please refresh.",
          requestId: "synthetic",
        });
        await page.waitForTimeout(100);
        expect(pending.size).toBeGreaterThan(0);
        expect(await page.locator(".gallery-cell,[role=dialog]").count()).toBe(
          0,
        );
        release(200, {
          context: context("2026-10-06"),
          kind: "ON_THIS_DAY",
          media: [],
          nextCursor: null,
        });
        await page.getByText("这段时光还没有可查看的照片。").waitFor();
      }
      expect(await page.locator(".gallery-cell,[role=dialog]").count()).toBe(0);
      await page.goForward({ waitUntil: "commit" });
      await page.waitForURL(origin + "/away", { waitUntil: "commit" });
      await page.goBack({ waitUntil: "commit" });
      await page.waitForFunction(
        "window.__memoryLifecycle?.events.filter(e=>e.name==='pageshow'&&e.persisted).length===2",
      );
      const twice = await blankDuringWait(page);
      expect(twice.id).toBe(id);
      proof.push({
        outcome,
        mode: "actual-BFCache-eligible-document",
        requests,
        documentIdUnchanged: true,
        actualPersistedRestorations: 2,
        firstRestore: snapshot,
        secondRestore: twice,
      });
    } finally {
      release(401, {
        code: "UNAUTHENTICATED",
        message: "Unauthorized",
        requestId: "synthetic",
      });
      await page.close();
    }
  }, 30000);
it("actual Chrome foreground/background visibility clears and holds old photos/Viewer until revalidation", async () => {
  const tabs = browser.contexts()[0]!;
  const page = await tabs.newPage(),
    other = await tabs.newPage();
  try {
    await page.bringToFront();
    const id = await ready(page);
    hold = true;
    const cdp = await tabs.newCDPSession(page);
    await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: false });
    const otherCdp = await tabs.newCDPSession(other);
    await otherCdp.send("Emulation.setFocusEmulationEnabled", {
      enabled: false,
    });
    await other.goto(origin + "/away");
    await other.bringToFront();
    const { windowId } = await cdp.send("Browser.getWindowForTarget");
    console.info(
      "Native window",
      await cdp.send("Browser.getWindowBounds", { windowId }),
      await otherCdp.send("Browser.getWindowForTarget"),
    );
    await page.waitForFunction(() => document.visibilityState === "hidden");
    await page.waitForFunction(
      () =>
        document.querySelectorAll(".gallery-cell,[role=dialog]").length === 0,
    );
    await page.evaluate("window.__memoryLifecycle.frames=[]");
    await cdp.send("Browser.setWindowBounds", {
      windowId,
      bounds: { windowState: "normal" },
    });
    await page.bringToFront();
    await cdp.detach();
    await otherCdp.detach();
    await page.waitForFunction(() => document.visibilityState === "visible");
    await page.waitForTimeout(200);
    const snapshot = await page.evaluate<{
      id: string;
      events: unknown[];
      frames: { cells: number; viewer: number; images: number }[];
    }>("window.__memoryLifecycle");
    expect(snapshot.id).toBe(id);
    expect(snapshot.frames.length).toBeGreaterThan(1);
    for (const frame of snapshot.frames)
      expect(frame).toMatchObject({ cells: 0, viewer: 0, images: 0 });
    expect(pending.size).toBeGreaterThan(0);
    release(401, {
      code: "UNAUTHENTICATED",
      message: "Unauthorized",
      requestId: "synthetic",
    });
    await page.getByText("请重新登录查看回忆。").waitFor();
    expect(await page.locator(".gallery-cell,[role=dialog]").count()).toBe(0);
    proof.push({ outcome: "actual-tab-visibility", requests, snapshot });
  } finally {
    release(401, {
      code: "UNAUTHENTICATED",
      message: "Unauthorized",
      requestId: "synthetic",
    });
    await page.close();
    await other.close();
  }
}, 30000);

for (const outcome of ["auth", "day"] as const)
  it(`production no-store document uses conservative real back reload while ${outcome} revalidation is held`, async () => {
    const page = await browser.contexts()[0]!.newPage();
    try {
      htmlNoStore = true;
      const before = await ready(page);
      hold = true;
      await page
        .locator("#leave")
        .evaluate((el: HTMLAnchorElement) => el.click());
      await page.waitForURL(origin + "/away", { waitUntil: "commit" });
      await page.goBack({ waitUntil: "load" });
      const snapshot = await blankDuringWait(page);
      expect(snapshot.id).not.toBe(before);
      expect(
        snapshot.events.filter((e) => e.name === "pageshow").at(-1)?.persisted,
      ).toBe(false);
      const navigation = await page.evaluate(() =>
        performance.getEntriesByType("navigation")[0]?.toJSON(),
      );
      expect(navigation.type).toBe("back_forward");
      expect(
        navigation.notRestoredReasons.reasons.map(
          (r: { reason: string }) => r.reason,
        ),
      ).toContain("response-cache-control-no-store");
      expect(pending.size).toBeGreaterThan(0);
      if (outcome === "auth") {
        release(401, {
          code: "UNAUTHENTICATED",
          message: "Unauthorized",
          requestId: "synthetic",
        });
        await page.getByText("请重新登录查看回忆。").waitFor();
      } else {
        release(409, {
          code: "MEMORIES_ANCHOR_EXPIRED",
          message: "The memories date has expired. Please refresh.",
          requestId: "synthetic",
        });
        await page.waitForTimeout(100);
        expect(pending.size).toBeGreaterThan(0);
        expect(await page.locator(".gallery-cell,[role=dialog]").count()).toBe(
          0,
        );
        release(200, {
          context: context("2026-10-06"),
          kind: "ON_THIS_DAY",
          media: [],
          nextCursor: null,
        });
        await page.getByText("这段时光还没有可查看的照片。").waitFor();
      }
      expect(await page.locator(".gallery-cell,[role=dialog]").count()).toBe(0);
      proof.push({
        outcome,
        mode: "actual-production-header-reload",
        navigation,
        snapshot,
      });
    } finally {
      htmlNoStore = false;
      release(401, {
        code: "UNAUTHENTICATED",
        message: "Unauthorized",
        requestId: "synthetic",
      });
      await page.close();
    }
  }, 30000);
