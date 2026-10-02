import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  chromium,
  type Browser,
  type Page,
  type Route,
} from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
const root = resolve(import.meta.dirname, "../../../..");
let browser: Browser, bundle: string;
const item = {
  mediaId: "11",
  lifecycleRevision: "1",
  mediaType: "IMAGE",
  timelineKey: "2026-09-18T00:00:00.000Z",
  trashedAt: "2026-09-01T00:00:00.000Z",
  purgeAfter: "2026-10-01T00:00:00.000Z",
  capabilities: { canRestore: true, permanentDeleteEligibility: "READY" },
};
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
    entryPoints: [resolve(root, "tests/fixtures/phase7d-ui.tsx")],
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
async function host(viewer = false) {
  const page = await browser.newPage();
  page.setDefaultTimeout(3000);
  let notifyDispatch: (route: Route) => void = () => {};
  const dispatched = new Promise<Route>((resolve) => {
    notifyDispatch = resolve;
  });
  const state = {
    dispatched,
    meStatus: 200,
    actor: "7",
    membership: true,
    posts: 0,
    reauths: 0,
    reads: 0,
    hold: false,
    held: null as Route | null,
    eligibility: "READY",
  };
  const style = readFileSync(resolve(root, "apps/web/app/styles.css"), "utf8");
  await page.route("https://phase7d.local/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/")
      return route.fulfill({
        contentType: "text/html",
        body: `<html><head><style>${style}</style></head><body><div id="root"></div><script>${bundle}</script></body></html>`,
      });
    if (path === "/api/v1/auth/me") {
      state.reads++;
      if (state.meStatus !== 200)
        return route.fulfill({ status: state.meStatus, json: {} });
      return route.fulfill({
        json: {
          user: { id: state.actor, username: "synthetic", displayName: null },
          memberships: state.membership
            ? [
                {
                  id: "3",
                  familyId: "4",
                  familyName: "Synthetic",
                  role: "ADMIN",
                },
              ]
            : [],
        },
      });
    }
    if (path === "/api/v1/auth/reauth") {
      state.reauths++;
      state.eligibility = "READY";
      return route.fulfill({ status: 204 });
    }
    if (path === "/api/v1/albums/3/media/11")
      return route.fulfill({
        json: await page
          .locator("#synthetic-detail")
          .textContent()
          .then((text) => JSON.parse(text!)),
      });
    if (route.request().method() === "POST") {
      state.posts++;
      if (state.hold) {
        state.held = route;
        notifyDispatch(route);
        return;
      }
      return settle(route, viewer);
    }
    return route.fulfill({
      json: {
        items: [item, { ...item, mediaId: "12" }].map((i) => ({
          ...i,
          capabilities: {
            ...i.capabilities,
            permanentDeleteEligibility: state.eligibility,
          },
        })),
        nextCursor: null,
      },
    });
  });
  await page.goto(`https://phase7d.local/${viewer ? "?viewer=1" : ""}`);
  await page
    .getByRole("button", {
      name: viewer ? "移入回收站" : "永久删除",
      exact: true,
    })
    .first()
    .waitFor();
  return { page, state };
}
async function settle(route: Route, viewer: boolean) {
  const body = route.request().postDataJSON();
  return route.fulfill(
    viewer
      ? {
          json: {
            mediaId: "11",
            lifecycleRevision: "2",
            state: "TRASHED",
            trashedAt: item.trashedAt,
            purgeAfter: item.purgeAfter,
          },
        }
      : { status: 202, json: { operationId: body.operationId } },
  );
}
async function ask(page: Page, viewer: boolean) {
  await page
    .getByRole("button", {
      name: viewer ? "移入回收站" : "永久删除",
      exact: true,
    })
    .first()
    .click();
  await page
    .getByRole("dialog", { name: viewer ? "移入回收站确认" : "永久删除确认" })
    .waitFor();
}
async function cleared(page: Page, viewer: boolean) {
  await page
    .getByText(
      viewer
        ? "身份已变化，旧查看器已清空。"
        : "请重新登录或返回当前家庭；旧操作不会自动重发。",
    )
    .waitFor();
  expect(await page.getByRole("dialog").count()).toBe(0);
  if (!viewer) {
    expect(await page.locator(".trash-list li").count()).toBe(0);
    expect(await page.locator(".trash-status").count()).toBe(0);
  }
}
describe("7D F1/F2 synthetic browser regressions", () => {
  for (const viewer of [false, true])
    for (const when of ["before-ask", "before-confirm"])
      for (const membership of [false, true]) {
        it(`${viewer ? "Viewer" : "Trash"}: actor B membership=${membership} ${when} cancels old target without POST`, async () => {
          const { page, state } = await host(viewer);
          try {
            if (when === "before-confirm") await ask(page, viewer);
            state.actor = "8";
            state.membership = membership;
            await page
              .getByRole("button", {
                name:
                  when === "before-confirm"
                    ? viewer
                      ? "确认移入回收站"
                      : "确认请求永久删除"
                    : viewer
                      ? "移入回收站"
                      : "永久删除",
                exact: true,
              })
              .first()
              .click();
            await cleared(page, viewer);
            expect(state.posts).toBe(0);
          } finally {
            await page.close();
          }
        });
      }
  for (const viewer of [false, true])
    for (const failure of ["membership", "401"])
      it(`${viewer ? "Viewer" : "Trash"}: ${failure} before final confirmation clears identity without POST`, async () => {
        const { page, state } = await host(viewer);
        try {
          await ask(page, viewer);
          if (failure === "membership") state.membership = false;
          else state.meStatus = 401;
          await page
            .getByRole("button", {
              name: viewer ? "确认移入回收站" : "确认请求永久删除",
              exact: true,
            })
            .click();
          await cleared(page, viewer);
          expect(state.posts).toBe(0);
        } finally {
          await page.close();
        }
      });
  for (const viewer of [false, true])
    it(`${viewer ? "Viewer" : "Trash"}: actor changes during failed POST, stale unknown state is discarded`, async () => {
      const { page, state } = await host(viewer);
      try {
        await ask(page, viewer);
        state.hold = true;
        await page
          .getByRole("button", {
            name: viewer ? "确认移入回收站" : "确认请求永久删除",
            exact: true,
          })
          .click();
        const held = await state.dispatched;
        state.actor = "8";
        await held.fulfill({ status: 503, json: {} });
        await cleared(page, viewer);
        expect(state.posts).toBe(1);
      } finally {
        await page.close();
      }
    });
  for (const viewer of [false, true])
    it(`${viewer ? "Viewer" : "Trash"}: identity change while POST pending discards late acknowledgement`, async () => {
      const { page, state } = await host(viewer);
      try {
        await ask(page, viewer);
        state.hold = true;
        await page
          .getByRole("button", {
            name: viewer ? "确认移入回收站" : "确认请求永久删除",
            exact: true,
          })
          .click();
        await page.waitForFunction(
          () =>
            document.querySelector("dialog")?.getAttribute("aria-busy") ===
            "true",
        );
        // Mutation dispatch is the explicit barrier; changing actor afterwards
        // cannot undo that POST, but must suppress stale success/card callbacks.
        await state.dispatched;
        expect(state.posts).toBe(1);
        expect(state.held).not.toBeNull();
        state.actor = "8";
        await settle(state.held!, viewer);
        await cleared(page, viewer);
        expect(
          await page.getByText("已移入回收站。", { exact: true }).count(),
        ).toBe(0);
        expect(state.posts).toBe(1);
      } finally {
        await page.close();
      }
    });
  it("native modal isolates background, keeps target/action, and traps busy Tab/Shift+Tab", async () => {
    const { page, state } = await host();
    try {
      await ask(page, false);
      const dialog = page.getByRole("dialog", { name: "永久删除确认" });
      const button = page
          .getByRole("button", { name: "恢复", exact: true })
          .nth(1),
        box = await button.boundingBox();
      expect(box).not.toBeNull();
      expect(
        await page.evaluate(
          ({ x, y }) => document.elementFromPoint(x, y)?.tagName,
          { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 },
        ),
      ).toBe("DIALOG");
      await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
      expect(await dialog.count()).toBe(1);
      expect(await page.getByRole("dialog", { name: "恢复媒体" }).count()).toBe(
        0,
      );
      state.hold = true;
      await page.getByRole("button", { name: "确认请求永久删除" }).click();
      await page.waitForFunction(
        () =>
          document.querySelector("dialog")?.getAttribute("aria-busy") ===
          "true",
      );
      await state.dispatched;
      for (const key of ["Tab", "Shift+Tab", "Tab", "Shift+Tab"]) {
        await page.keyboard.press(key);
        expect(await page.evaluate(() => document.activeElement?.tagName)).toBe(
          "DIALOG",
        );
      }
      await page.keyboard.press("Escape");
      expect(await dialog.count()).toBe(1);
      expect(state.held).not.toBeNull();
      await state.held!.fulfill({ status: 503, json: {} });
      await dialog.waitFor({ state: "detached" });
      expect(state.posts).toBe(1);
    } finally {
      await page.close();
    }
  });
  it("same-user reauth rotates the simulated session, requires second confirmation and restores modal focus", async () => {
    const { page, state } = await host();
    try {
      state.eligibility = "REAUTH_REQUIRED";
      await ask(page, false);
      await page.getByLabel("验证当前密码").fill("synthetic-password");
      await page.getByRole("button", { name: "验证身份", exact: true }).click();
      await page.getByRole("button", { name: "确认请求永久删除" }).waitFor();
      expect(state.reauths).toBe(1);
      expect(state.posts).toBe(0);
      expect(
        await page.evaluate(() => !!document.activeElement?.closest("dialog")),
      ).toBe(true);
      expect(await page.getByLabel("验证当前密码").count()).toBe(0);
      await page.getByRole("button", { name: "确认请求永久删除" }).click();
      await page.getByText("永久删除请求已接受，等待后台处理。").waitFor();
      expect(state.posts).toBe(1);
    } finally {
      await page.close();
    }
  });
});
