import { test, expect, chromium, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  createWriteStream,
  mkdirSync,
  copyFileSync,
  writeFileSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  createDatabase,
  acquireCheckedConnection,
  assertMigrationReadiness,
  type RowDataPacket,
  type ResultSetHeader,
} from "../../packages/db/src/index.js";
import { createPasswordEngine } from "../../packages/auth/src/index.js";
import { DevControlHarness } from "../helpers/dev-control-harness.js";
import {
  prepareWebAcceptanceStorage,
  cleanupWebAcceptanceStorage,
  type WebAcceptanceStorage,
} from "./storage-harness.js";
import { syntheticGpsJpeg } from "../fixtures/location-jpeg.js";
import { assertNoPhase11DevInstances } from "../../packages/db/scripts/phase11-instance-proof.js";
process.loadEnvFile(resolve(".env"));
const tls = "/Users/toby/Library/Application Support/PictureSystem/dev-tls";
// Existence only: the HTTPS service reads the private key. No fixture reads it.
for (const f of ["dev-ca.pem", "dev-server.pem", "dev-server-key.pem"])
  if (!existsSync(join(tls, f))) throw Error("EXISTING_DEV_TLS_FILE_REQUIRED");
const db = createDatabase(process.env.DATABASE_URL!),
  password = "phase11-browser-synthetic-password";
let browserAuthWindow = 0;
let ownedGrantRevoked = false;
const nonce = randomUUID().replaceAll("-", ""),
  usernameB = `p11_https_b_${nonce}`,
  memberAName = `p11_https_member_${nonce}`;
const userIds: string[] = [],
  children: ChildProcess[] = [],
  fixtureFamilies: string[] = [];
let familyB = "",
  memberA = "",
  control: DevControlHarness,
  storage: WebAcceptanceStorage;
const evidence = resolve(".cache/phase11-current");
async function until(fn: () => Promise<boolean>, ms = 60000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await delay(100);
  }
  throw Error("PHASE11_HTTPS_BOUNDED_WAIT_EXPIRED");
}
function launch(args: string[], env: NodeJS.ProcessEnv, name: string) {
  const log = createWriteStream(join(evidence, `https-${nonce}-${name}.log`), {
    mode: 0o600,
  });
  const p = spawn(process.execPath, args, {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(p);
  p.stdout!.pipe(log);
  p.stderr!.pipe(log);
  p.once("close", () => log.end());
  return p;
}
async function stop(p: ChildProcess) {
  if (p.exitCode !== null || p.signalCode !== null) return;
  p.kill("SIGTERM");
  await Promise.race([
    once(p, "close"),
    delay(15000).then(() => {
      throw Error("PHASE11_CHILD_NOT_SETTLED");
    }),
  ]);
}
async function call(page: Page, path: string, method = "GET", body?: unknown) {
  return page.evaluate(
    async ({ path, method, body }) => {
      const r = await fetch(path, {
        method,
        credentials: "same-origin",
        cache: "no-store",
        headers:
          body === undefined ? {} : { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    { path, method, body },
  );
}
async function login(page: Page, username: string) {
  await page.goto("/login");
  await page.getByLabel("账号", { exact: true }).fill(username);
  await page.getByLabel("密码", { exact: true }).fill(password);
  const response = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === "/api/v1/auth/login" &&
      r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "登录", exact: true }).click();
  const result = await response;
  if (result.status() !== 204) {
    const error = await result.json().catch(() => null);
    throw Error(`HTTPS_LOGIN_${result.status()}_${error?.code ?? "UNKNOWN"}`);
  }
  await page.waitForURL("https://localhost:3443/");
  await page.goto("/admin");
  await expect(page.getByRole("heading", { name: "成员与邀请" })).toBeVisible();
}
async function mode(
  page: Page,
  target: "正常" | "只读" | "维护",
  expected: "NORMAL" | "READ_ONLY" | "MAINTENANCE",
) {
  await page
    .getByRole("button", { name: `切换到${target}`, exact: true })
    .click();
  await page.getByLabel("重新验证密码", { exact: true }).fill(password);
  const response = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === "/api/v1/admin/system/mode" &&
      r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "验证并确认", exact: true }).click();
  const receipt = await response;
  expect(receipt.status()).toBe(202);
  const body = await receipt.json();
  await control.captureBrowserOperation(body.operationId);
  await control.waitStable(expected);
  await expect(
    page.getByText(new RegExp(`当前 ${target} · 请求 ${target} · STABLE`)),
  ).toBeVisible({ timeout: 20000 });
  await expect
    .poll(
      async () =>
        (
          await call(
            page,
            `/api/v1/admin/system/operations/${body.operationId}`,
          )
        ).body?.status,
    )
    .toBe("APPLIED");
}
test.describe.serial("Phase11 strict existing DEV HTTPS Admin", () => {
  test.beforeAll(async () => {
    test.setTimeout(90000);
    mkdirSync(evidence, { recursive: true });
    const c = await acquireCheckedConnection(db.pool);
    try {
      await assertMigrationReadiness(c);
      await assertNoPhase11DevInstances(c, process.cwd());
      const [who] = await c.query<RowDataPacket[]>(
        "SELECT DATABASE() db,CURRENT_USER() account",
      );
      expect(who[0]!.db).toBe("family_album_dev");
      expect(String(who[0]!.account).split("@")[0]).not.toBe("root");
      const [f] = await c.query<ResultSetHeader>(
        "INSERT INTO families(name) VALUES(?)",
        [`p11_https_family_b_${nonce}`],
      );
      familyB = String(f.insertId);
      fixtureFamilies.push(familyB);
      const hash = await createPasswordEngine().hash(password);
      for (const name of [usernameB, memberAName]) {
        const [u] = await c.query<ResultSetHeader>(
          "INSERT INTO users(username,username_normalized,password_hash,password_changed_at) VALUES(?,?,?,CURRENT_TIMESTAMP(3))",
          [name, Buffer.from(name!), hash],
        );
        userIds.push(String(u.insertId));
        if (name === usernameB)
          await c.query(
            "INSERT INTO family_members(family_id,user_id,role) VALUES(?,?,'SUPER_ADMIN')",
            [familyB, String(u.insertId)],
          );
      }
      control = await DevControlHarness.create(
        db.pool,
        hash,
        [familyB],
        "API,DERIVATIVE,METADATA",
      );
      const [m] = await c.query<ResultSetHeader>(
        "INSERT INTO family_members(family_id,user_id,role) VALUES(?,?,'MEMBER')",
        [control.syntheticIdentity.familyId, userIds[1]],
      );
      memberA = String(m.insertId);
    } finally {
      c.release();
    }
    process.env.DEV_MEDIA_PIPELINE_ENABLED = "1";
    storage = prepareWebAcceptanceStorage();
    writeFileSync(
      join(evidence, `https-${nonce}-ownership.json`),
      JSON.stringify({
        nonce,
        deploymentId: control.env.DEV_CONTROL_DEPLOYMENT_ID,
        identity: control.syntheticIdentity,
        familyB,
        memberA,
        userIds,
        storage,
      }),
      { mode: 0o600 },
    );
    const env = {
      ...process.env,
      ...control.env,
      NODE_ENV: "test",
      APP_ENV: "dev",
      API_HOST: "127.0.0.1",
      API_PORT: "4400",
      API_PUBLIC_ORIGIN: "https://localhost:3443",
      TRUSTED_WEB_ORIGINS: "https://localhost:3443",
      DEV_MEDIA_ROOT: storage.mediaRoot,
      DEV_STORAGE_MARKER_ID: storage.markerId,
      LOG_LEVEL: "silent",
      LOCATION_DATA_DIR: resolve("resources/location/2026-10-03"),
      PHASE10_CLIENT_TLS_CERT_FILE: join(tls, "dev-server.pem"),
      PHASE10_CLIENT_TLS_KEY_FILE: join(tls, "dev-server-key.pem"),
    };
    launch(["--import", "tsx", "apps/api/dist/index.js"], env, "api");
    await until(async () =>
      fetch("http://127.0.0.1:4400/health")
        .then((r) => r.ok)
        .catch(() => false),
    );
    launch(
      ["--import", "tsx", "apps/worker/dist/metadata-main.js"],
      env,
      "metadata",
    );
    await control.observeRoles(["API", "DERIVATIVE", "METADATA"]);
    await control.waitStable("READ_ONLY");
    await control.request("NORMAL");
    launch(
      ["tests/e2e-web/start-web-https.mjs"],
      { ...env, NODE_ENV: "development" },
      "web",
    );
    await until(async () =>
      fetch("https://localhost:3443/login")
        .then((r) => r.ok)
        .catch(() => false),
    );
  });
  test.afterEach(async ({ page }, info) => {
    if (info.status === info.expectedStatus || !control) return;
    const id = control.syntheticIdentity.familyId;
    const state: Record<string, unknown> = { pageClosed: page.isClosed() };
    for (const [key, sql] of Object.entries({
      media:
        "SELECT CAST(id AS CHAR) id,media_type,processing_state,generation,recipe_id FROM media_items WHERE family_id=?",
      jobs: "SELECT CAST(id AS CHAR) id,job_type,state,last_failure_code FROM background_jobs WHERE family_id=?",
      derived:
        "SELECT CAST(media_id AS CHAR) media_id,kind,state,cleaned_at,published_at FROM derived_assets WHERE family_id=?",
      uploads:
        "SELECT CAST(id AS CHAR) id,state,staging_cleaned_at FROM upload_sessions WHERE family_id=?",
    })) {
      const [rows] = await db.pool.query<RowDataPacket[]>(sql, [id]);
      state[key] = rows;
    }
    writeFileSync(
      join(evidence, `https-${nonce}-failure-state.json`),
      JSON.stringify(state, null, 2),
      { mode: 0o600 },
    );
  });
  test.afterAll(async () => {
    test.setTimeout(60000);
    let cleaned = false;
    try {
      try {
        if (control) {
          if (ownedGrantRevoked) {
            await control.repository.localGrant({
              familyId: control.syntheticIdentity.familyId,
              userId: control.syntheticIdentity.userId,
              enabled: true,
              operationId: randomUUID(),
            });
            ownedGrantRevoked = false;
          }
          await control.reauthenticate(password);
          await control.request("READ_ONLY");
        }
      } finally {
        for (const p of [...children].reverse()) await stop(p);
      }
      if (control) {
        const families = [
          control.syntheticIdentity.familyId,
          ...fixtureFamilies,
        ];
        const c = await acquireCheckedConnection(db.pool);
        try {
          await c.beginTransaction();
          for (const family of families) {
            // Only exact nonce-owned fixture families, after every writer stops.
            const [rows] = await c.query<RowDataPacket[]>(
              "SELECT name FROM families WHERE id=?",
              [family],
            );
            expect(rows[0]!.name).toBe(
              family === familyB
                ? `p11_https_family_b_${nonce}`
                : control.syntheticIdentity.username,
            );
            // Management/control history is append-only. This fixture never
            // performs Trash/purge; unexpected lifecycle history must retain
            // its FK graph rather than being deleted to make cleanup pass.
            const [history] = await c.query<RowDataPacket[]>(
              "SELECT COUNT(*) n FROM audit_logs WHERE family_id=?",
              [family],
            );
            expect(String(history[0]!.n)).toBe("0");
            for (const table of [
              "upload_album_targets",
              "purge_files",
              "media_location_projections",
              "album_media",
              "album_members",
              "invitations",
              "derived_assets",
              "background_jobs",
              "media_items",
              "upload_sessions",
              "storage_objects",
              "purge_intents",
              "albums",
            ])
              await c.query(`DELETE FROM ${table} WHERE family_id=?`, [family]);
          }
          await c.query(
            "DELETE FROM family_members WHERE family_id=? AND id=?",
            [control.syntheticIdentity.familyId, memberA],
          );
          await c.query("DELETE FROM family_members WHERE family_id=?", [
            familyB,
          ]);
          for (const id of userIds) {
            await c.query("DELETE FROM sessions WHERE user_id=?", [id]);
            await c.query(
              "DELETE FROM users WHERE id=? AND username IN (?,?)",
              [id, usernameB, memberAName],
            );
          }
          await c.query("DELETE FROM families WHERE id=? AND name=?", [
            familyB,
            `p11_https_family_b_${nonce}`,
          ]);
          await c.commit();
        } catch (e) {
          await c.rollback();
          throw e;
        } finally {
          c.release();
        }
        await control.cleanup();
        cleaned = true;
      }
    } finally {
      if (storage) {
        for (const name of ["api-observation.log", "web-observation.log"])
          if (existsSync(join(storage.runRoot, name)))
            copyFileSync(
              join(storage.runRoot, name),
              join(evidence, `https-${nonce}-${name}`),
            );
        if (cleaned) cleanupWebAcceptanceStorage(storage);
      }
      await db.pool.end();
    }
  });
  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 390, height: 844 },
  ])
    test(`real Admin login/member/invite/audit/mode and two-family isolation ${viewport.width}`, async ({
      page,
    }) => {
      if (viewport.width === 390) {
        const remaining = Math.max(0, browserAuthWindow + 61000 - Date.now());
        if (remaining) {
          console.log("STRICT_HTTPS_AUTH_RATE_WINDOW_WAIT");
          await delay(remaining);
        }
      }
      browserAuthWindow = Date.now();
      await page.setViewportSize(viewport);
      await login(page, control.syntheticIdentity.username);
      await expect(
        page.getByText("备份：NOT_CONFIGURED", { exact: false }),
      ).toBeVisible();
      await expect(
        page.getByRole("heading", { name: "存储用量" }),
      ).toBeVisible();
      const album = await call(page, "/api/v1/albums", "POST", {
        familyId: control.syntheticIdentity.familyId,
        name: `https_${nonce}_${viewport.width}`,
        visibility: "FAMILY",
      });
      expect(album.status).toBe(201);
      const uploaded = await page.evaluate(
        async ({ familyId, albumId, bytes, clientId }) => {
          const c = await fetch(`/api/v1/families/${familyId}/uploads/tus`, {
            method: "POST",
            headers: {
              "tus-resumable": "1.0.0",
              "upload-length": String(bytes.length),
              "upload-client-id": clientId,
              "upload-target-albums": albumId,
              "upload-metadata": `filename ${btoa("synthetic.jpg")},filetype ${btoa("image/jpeg")}`,
            },
          });
          if (c.status !== 201) return { create: c.status, patch: 0, id: "" };
          const path = new URL(c.headers.get("location")!, location.origin)
            .pathname;
          const p = await fetch(path, {
            method: "PATCH",
            headers: {
              "tus-resumable": "1.0.0",
              "upload-offset": "0",
              "content-type": "application/offset+octet-stream",
            },
            body: new Uint8Array(bytes),
          });
          return {
            create: c.status,
            patch: p.status,
            id: path.split("/").at(-1)!,
          };
        },
        {
          familyId: control.syntheticIdentity.familyId,
          albumId: album.body.id,
          bytes: [...syntheticGpsJpeg()],
          clientId: randomUUID(),
        },
      );
      expect(uploaded.create).toBe(201);
      expect(uploaded.patch).toBe(204);
      expect(
        (
          await call(
            page,
            `/api/v1/uploads/${uploaded.id}/finalize`,
            "POST",
            {},
          )
        ).status,
      ).toBe(200);
      await expect
        .poll(
          async () =>
            (await call(page, `/api/v1/uploads/${uploaded.id}/result`)).body
              ?.processing,
          { timeout: 30000 },
        )
        .toBe("READY");
      expect(
        (
          await call(
            page,
            `/api/v1/uploads/${uploaded.id}/placement`,
            "POST",
            {},
          )
        ).status,
      ).toBe(200);
      await expect
        .poll(
          async () =>
            (
              await call(
                page,
                `/api/v1/families/${control.syntheticIdentity.familyId}/admin/overview`,
              )
            ).body?.photos,
          { timeout: 30000 },
        )
        .toBe("1");

      await page.getByLabel("成员管理验证密码").fill(password);
      const row = page.getByRole("listitem").filter({ hasText: memberAName });
      await row.getByRole("button", { name: "停用成员", exact: true }).click();
      await expect(row).toContainText("已停用");
      await page.getByLabel("成员管理验证密码").fill(password);
      await row.getByRole("button", { name: "恢复成员", exact: true }).click();
      await expect(row).toContainText("启用");
      await page.getByLabel("成员管理验证密码").fill(password);
      await page.getByRole("button", { name: "邀请成员", exact: true }).click();
      await expect(
        page.getByText("一次展示的邀请链接：", { exact: false }),
      ).toBeVisible();
      await page.getByRole("button", { name: "关闭链接", exact: true }).click();
      await page.getByLabel("成员管理验证密码").fill(password);
      await page
        .getByRole("button", { name: "撤销邀请", exact: true })
        .last()
        .click();
      await expect(
        page
          .getByRole("listitem")
          .filter({ hasText: /邀请 \d+ · MEMBER · REVOKED/ })
          .last(),
      ).toBeVisible();
      for (const [target, expected] of [
        ["只读", "READ_ONLY"],
        ["维护", "MAINTENANCE"],
        ["正常", "NORMAL"],
      ] as const) {
        await mode(page, target, expected);
        const upload = await call(
          page,
          `/api/v1/families/${control.syntheticIdentity.familyId}/uploads/tus`,
          "POST",
        );
        expect(upload.status).toBe(expected === "NORMAL" ? 412 : 503);
        expect((await call(page, "/api/v1/auth/me")).status).toBe(200);
      }
      const events = await call(
        page,
        `/api/v1/families/${control.syntheticIdentity.familyId}/admin/audit?source=management&days=7&limit=25`,
      );
      expect(events.status).toBe(200);
      expect(events.body.events.length).toBeGreaterThan(0);
      // Actual auth replaces the account/session. No cookie copying or request routing.
      await page.goto("/my");
      await page.getByRole("button", { name: "退出登录", exact: true }).click();
      await page.waitForURL("**/login");
      await login(page, usernameB);
      await expect(
        page.getByText("当前账号没有系统管理权限。", { exact: true }),
      ).toBeVisible();
      await expect(page.getByText(memberAName, { exact: false })).toHaveCount(
        0,
      );
      expect(
        (
          await call(
            page,
            `/api/v1/families/${control.syntheticIdentity.familyId}/admin/overview`,
          )
        ).status,
      ).toBe(403);
      expect((await call(page, "/api/v1/admin/system/status")).status).toBe(
        403,
      );
      await page.goto("/my");
      await page.getByRole("button", { name: "退出登录", exact: true }).click();
      await page.waitForURL("**/login");
    });
  test("actual Chrome history restores or conservatively reloads private Admin after current system grant revocation", async () => {
    const remaining = Math.max(0, browserAuthWindow + 61000 - Date.now());
    if (remaining) await delay(remaining);
    const browser = await chromium.launch({
      channel: "chrome",
      headless: false,
      ignoreDefaultArgs: ["--disable-back-forward-cache"],
    });
    const context = await browser.newContext({
      baseURL: "https://localhost:3443",
      ignoreHTTPSErrors: false,
    });
    await context.addInitScript(() => {
      const state = {
        documentId: crypto.randomUUID(),
        shows: [] as boolean[],
        frames: [] as number[],
      };
      (window as unknown as { p11History: typeof state }).p11History = state;
      addEventListener("pageshow", (event) => {
        state.shows.push(event.persisted);
        state.frames = [];
      });
      const frame = () => {
        state.frames.push(
          [...document.querySelectorAll("button")].filter(
            (b) => b.textContent === "切换到正常",
          ).length,
        );
        if (state.frames.length > 120) state.frames.shift();
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    });
    const page = await context.newPage();
    let revoked = false;
    try {
      await login(page, control.syntheticIdentity.username);
      await expect(
        page.getByRole("button", { name: "切换到正常", exact: true }),
      ).toBeVisible();
      const before = await page.evaluate(
        () =>
          (window as unknown as { p11History: { documentId: string } })
            .p11History.documentId,
      );
      await page.goto("/my");
      await control.repository.localGrant({
        familyId: control.syntheticIdentity.familyId,
        userId: control.syntheticIdentity.userId,
        enabled: false,
        operationId: randomUUID(),
      });
      revoked = true;
      ownedGrantRevoked = true;
      let validations = 0;
      context.on("response", (r) => {
        if (new URL(r.url()).pathname === "/api/v1/auth/me") validations++;
      });
      // Native BFcache restoration does not emit DOMContentLoaded again.
      // Observe the real history return without awaiting a new-document event.
      await page.evaluate(() => {
        setTimeout(() => history.back(), 0);
      });
      await expect(page).toHaveURL("https://localhost:3443/admin", {
        timeout: 15000,
      });
      await expect(
        page.getByText("当前账号没有系统管理权限。", { exact: true }),
      ).toBeVisible({ timeout: 20000 });
      await expect(
        page.getByRole("button", { name: "切换到正常", exact: true }),
      ).toHaveCount(0);
      await expect(
        page.getByRole("heading", { name: "成员与邀请" }),
      ).toBeVisible();
      const actual = await page.evaluate(() => {
        const state = (
          window as unknown as {
            p11History: {
              documentId: string;
              shows: boolean[];
              frames: number[];
            };
          }
        ).p11History;
        const navigation = performance.getEntriesByType(
          "navigation",
        )[0] as PerformanceNavigationTiming & {
          notRestoredReasons?: { reasons?: { reason: string }[] };
        };
        return {
          ...state,
          notRestoredReasons:
            navigation.notRestoredReasons?.reasons?.map((r) => r.reason) ?? [],
        };
      });
      expect(validations).toBeGreaterThan(0);
      if (actual.shows.at(-1) === true) {
        expect(actual.documentId).toBe(before);
        expect(actual.frames[0]).toBe(0);
      } else expect(actual.documentId).not.toBe(before);
      writeFileSync(
        join(evidence, `https-${nonce}-bfcache.json`),
        JSON.stringify(
          {
            before,
            ...actual,
            freshBrowserAuthReads: validations,
            strictTLS: true,
          },
          null,
          2,
        ),
        { mode: 0o600 },
      );
      console.log(
        actual.shows.at(-1)
          ? "STRICT_HTTPS_NATIVE_BFCACHE_RESTORED_CURRENT_GRANT_RECHECKED"
          : "STRICT_HTTPS_NATIVE_HISTORY_RELOADED_CURRENT_GRANT_RECHECKED",
      );
    } finally {
      if (revoked) {
        await control.repository.localGrant({
          familyId: control.syntheticIdentity.familyId,
          userId: control.syntheticIdentity.userId,
          enabled: true,
          operationId: randomUUID(),
        });
        ownedGrantRevoked = false;
      }
      await context.close();
      await browser.close();
    }
  });
});
