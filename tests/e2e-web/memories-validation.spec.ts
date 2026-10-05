import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { readFileSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import type { RowDataPacket } from "../../packages/db/src/index.js";
import { createDatabase } from "../../packages/db/src/index.js";
import { hashPassword } from "../../packages/auth/src/index.js";
import { buildOriginalPath } from "../../packages/storage/src/index.js";
import { MemoriesFixture } from "../fixtures/memories-db.js";
import { syntheticHistoryJpeg } from "../fixtures/location-jpeg.js";
import {
  memoriesPreviewSchema,
  parseMemoryDate,
  isLeapYear,
} from "../../packages/contracts/src/index.js";

process.loadEnvFile(resolve(".env"));
if (
  !process.env.DATABASE_URL ||
  !process.env.PHASE5_WEB_E2E_MEDIA_ROOT ||
  process.env.DEV_MEDIA_PIPELINE_ENABLED !== "1"
)
  throw new Error("MEMORIES_REAL_PIPELINE_ACCEPTANCE_REQUIRED");
const db = createDatabase(process.env.DATABASE_URL),
  f = new MemoriesFixture(db.pool);
const password = "phase9-synthetic-password";
let metadata: ChildProcess | undefined;
test.beforeAll(async () => {
  await f.setup();
  await db.pool.query("UPDATE users SET password_hash=? WHERE id=?", [
    await hashPassword(password),
    f.users[0],
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
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
});
test.afterAll(async () => {
  if (metadata && metadata.exitCode === null && metadata.signalCode === null) {
    const done = once(metadata, "exit");
    metadata.kill("SIGTERM");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        done,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            metadata?.kill("SIGKILL");
            reject(new Error("MEMORIES_METADATA_DRAIN_TIMEOUT"));
          }, 15000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  try {
    await f.cleanup();
  } finally {
    await db.pool.end();
  }
});

test("real HTTPS login and historical EXIF uploads reach native READY, home cards/full page/Viewer without seeded media or clock override", async ({
  page,
}) => {
  test.setTimeout(120000);
  const login = await page.request.post("/api/v1/auth/login", {
    headers: { origin: "https://localhost:3443" },
    data: { username: "p9mem_0" + f.suffix, password },
  });
  expect(login.status()).toBe(204);
  const cookie = (await page.context().cookies()).find(
    (c) => c.name === "__Host-family_session",
  );
  expect(cookie).toMatchObject({
    secure: true,
    httpOnly: true,
    sameSite: "Lax",
  });
  const initial = await page.request.get(
    `/api/v1/families/${f.familyId}/memories/preview`,
  );
  expect(initial.status()).toBe(200);
  const context = memoriesPreviewSchema.parse(await initial.json()).context;
  const anchor = parseMemoryDate(context.anchorDate);
  let prior = anchor.getUTCFullYear() - 1;
  if (anchor.getUTCMonth() === 1 && anchor.getUTCDate() === 29)
    while (!isLeapYear(prior)) prior--;
  const anniversary = String(prior) + context.anchorDate.slice(4);
  const originals: {
    path: string;
    ino: number;
    hash: string;
    mediaId: string;
  }[] = [];
  for (const [index, date] of [anniversary, context.weekStart].entries()) {
    const bytes = syntheticHistoryJpeg(date, "p9-history-" + f.suffix + index),
      hash = createHash("sha256").update(bytes).digest("hex");
    const headers = {
      origin: "https://localhost:3443",
      "tus-resumable": "1.0.0",
    };
    const created = await page.request.post(
      `/api/v1/families/${f.familyId}/uploads/tus`,
      {
        headers: {
          ...headers,
          "upload-length": String(bytes.length),
          "upload-metadata": `filename ${Buffer.from("synthetic-history.jpg").toString("base64")},filetype ${Buffer.from("image/jpeg").toString("base64")}`,
        },
      },
    );
    expect(created.status()).toBe(201);
    const publicId = created.headers().location!.split("/").at(-1)!;
    const patched = await page.request.patch(
      `/api/v1/uploads/tus/${publicId}`,
      {
        headers: {
          ...headers,
          "upload-offset": "0",
          "content-type": "application/offset+octet-stream",
        },
        data: bytes,
      },
    );
    expect(patched.status()).toBe(204);
    const finalized = await page.request.post(
      `/api/v1/uploads/${publicId}/finalize`,
      { headers: { origin: "https://localhost:3443" }, data: {} },
    );
    expect(finalized.status()).toBe(200);
    expect((await finalized.json()).state).toBe("COMPLETE");
    const path = join(
        process.env.PHASE5_WEB_E2E_MEDIA_ROOT!,
        buildOriginalPath(f.familyId, hash, String(bytes.length)),
      ),
      ino = statSync(path).ino;
    let id = "";
    await expect
      .poll(
        async () => {
          if (metadata?.exitCode !== null || metadata?.signalCode !== null)
            throw new Error("REAL_METADATA_EXITED");
          const [rows] = await db.pool.query<RowDataPacket[]>(
            "SELECT CAST(m.id AS CHAR) id,m.processing_state state FROM media_items m JOIN upload_sessions s ON s.family_id=m.family_id AND s.id=m.source_upload_id WHERE s.public_id=UNHEX(?)",
            [publicId],
          );
          id = String(rows[0]?.id ?? "");
          return rows[0]?.state;
        },
        { timeout: 60000, intervals: [100, 250, 500] },
      )
      .toBe("READY");
    const placement = await page.request.post(
      `/api/v1/albums/${f.lowAlbum}/media`,
      { headers: { origin: "https://localhost:3443" }, data: { mediaId: id } },
    );
    expect(placement.status()).toBe(200);
    originals.push({ path, ino, hash, mediaId: id });
  }
  const requests: string[] = [];
  page.on("request", (request) =>
    requests.push(new URL(request.url()).pathname),
  );
  await page.goto("/");
  const home = page.getByRole("region", { name: "家庭回忆", exact: true });
  await expect(
    home.getByRole("heading", { name: "往年今日", exact: true }),
  ).toBeVisible();
  await expect(
    home.getByRole("heading", { name: "一年前的这周", exact: true }),
  ).toBeVisible();
  const today = home.getByRole("region", { name: "往年今日", exact: true });
  await expect(
    today.getByText("拍摄日期 " + anniversary, { exact: true }),
  ).toBeVisible();
  await today.getByRole("link", { name: "查看全部" }).click();
  await expect(page).toHaveURL(/\/memories\?kind=ON_THIS_DAY$/);
  const full = page
    .getByRole("region", { name: "往年今日", exact: true })
    .last();
  await expect(
    full.getByText("拍摄日期 " + anniversary, { exact: true }),
  ).toBeVisible();
  await full.getByRole("button").first().click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect
    .poll(() =>
      requests.some(
        (path) =>
          path ===
          `/api/v1/albums/${f.lowAlbum}/media/${originals[0]!.mediaId}`,
      ),
    )
    .toBe(true);
  await expect
    .poll(() =>
      requests.some(
        (path) =>
          path === `/api/v1/media/${originals[0]!.mediaId}/derived/preview`,
      ),
    )
    .toBe(true);
  const preview = await page.request.get(
    `/api/v1/media/${originals[0]!.mediaId}/derived/preview`,
  );
  expect(preview.status()).toBe(200);
  expect(preview.headers()["cache-control"]).toContain("no-store");
  for (const original of originals) {
    expect(statSync(original.path).ino).toBe(original.ino);
    expect(
      createHash("sha256").update(readFileSync(original.path)).digest("hex"),
    ).toBe(original.hash);
  }
  const result = await page.request.get(
    `/api/v1/families/${f.familyId}/memories?kind=ON_THIS_DAY&limit=48`,
  );
  expect(result.headers()["cache-control"]).toBe("private, no-store");
  expect(JSON.stringify(await result.json())).not.toMatch(
    /gps|storageObject|sha256|originalFilename/i,
  );
  mkdirSync(".cache/phase9", { recursive: true });
  writeFileSync(
    ".cache/phase9/https-upload-proof.json",
    JSON.stringify(
      {
        anchorDate: context.anchorDate,
        historicalDates: [anniversary, context.weekStart],
        actualHttpsLogin: true,
        actualTusFinalize: true,
        actualNativeMetadataAndDerivatives: true,
        manualMediaOrJobSeed: false,
        publicClockOverride: false,
        originalHashAndInodeUnchanged: true,
        homeCards: true,
        fullPage: true,
        viewer: true,
        previewServing: true,
      },
      null,
      2,
    ),
  );
});
