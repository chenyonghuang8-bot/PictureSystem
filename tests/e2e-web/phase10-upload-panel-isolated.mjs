/* global document, window, Event, PageTransitionEvent */
// Isolated actual React DOM regression with synthetic transport; not TLS/API acceptance.
import { createRequire } from "node:module";
import { readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { createServer } from "node:http";
const root = resolve(import.meta.dirname, "../..");
const require = createRequire(join(root, "package.json"));
const { chromium } = require("@playwright/test");
const esbuildDir = readdirSync(join(root, "node_modules/.pnpm"))
  .filter((n) => n.startsWith("esbuild@"))
  .sort()
  .at(-1);
const { build } = require(
  join(root, "node_modules/.pnpm", esbuildDir, "node_modules/esbuild"),
);
const mocked = `
const a=(id,name)=>({id,familyId:'8',ownerMemberId:'1',name,description:null,visibility:'FAMILY',revision:'1',createdAt:'2026-10-06T00:00:00.000Z',updatedAt:'2026-10-06T00:00:00.000Z',effectivePermissions:{canView:true,canUpload:true,canEdit:false,canDelete:false,canManageMembers:false}});
window.testState={held:false,mismatch:false,signal:null,reads:0};
export const savedJobs=async()=>[]; export const persistJob=async()=>{}; export const digestFile=async()=>'';
export async function webUploadRequest(path,init,signal){
if(path==='/api/v1/auth/me')return Response.json({user:{id:window.testState.mismatch?'2':'1',username:'synthetic',displayName:null},memberships:[{id:'1',familyId:'8',familyName:'synthetic',role:'MEMBER'}]});
if(path.includes('afterId=')){window.testState.held=true;window.testState.signal=signal;window.testState.reads++;return new Promise(r=>window.testState.release=()=>r(Response.json({albums:[a('2','PRIVATE_LATE_NAME')],nextAfterId:'2'})));}
return Response.json({albums:[a('1','PRIVATE_FIRST_NAME')],nextAfterId:'1'});
}`;
const entry = `import {createElement} from '${join(root, "apps/web/node_modules/react/index.js")}';import {createRoot} from '${join(root, "apps/web/node_modules/react-dom/client.js")}';import {MobileUploadPanel} from '${join(root, "apps/web/components/mobile/upload-panel.tsx")}';createRoot(document.getElementById('root')).render(createElement(MobileUploadPanel,{userId:'1',familyId:'8'}));`;
const result = await build({
  stdin: { contents: entry, loader: "tsx", resolveDir: root },
  bundle: true,
  write: false,
  format: "iife",
  platform: "browser",
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [
    {
      name: "synthetic-upload-transport",
      setup(b) {
        b.onResolve({ filter: /mobile-upload\.js$/ }, () => ({
          path: "synthetic-transport",
          namespace: "test",
        }));
        b.onLoad({ filter: /.*/, namespace: "test" }, () => ({
          contents: mocked,
          loader: "js",
        }));
      },
    },
  ],
});
const server = createServer((req, res) => {
  res.setHeader(
    "content-type",
    req.url === "/bundle.js" ? "text/javascript" : "text/html",
  );
  res.end(
    req.url === "/bundle.js"
      ? result.outputFiles[0].contents
      : '<div id="root"></div><script src="/bundle.js"></script>',
  );
});
await new Promise((r, j) => {
  server.once("error", j);
  server.listen(0, "127.0.0.1", r);
});
let browser;
try {
  browser = await chromium.launch({ channel: "chrome" });
  for (const mode of ["auth-lost", "hide/restore", "account-mismatch"]) {
    const page = await browser.newPage({ ignoreHTTPSErrors: false });
    await page.goto("http://127.0.0.1:" + server.address().port);
    await page.getByRole("button", { name: "＋ 上传照片" }).waitFor();
    await page.waitForFunction(
      () => !document.querySelector(".mobile-upload-fab").disabled,
    );
    await page.getByRole("button", { name: "＋ 上传照片" }).click();
    await page.getByRole("button", { name: "更多相册" }).click();
    await page.waitForFunction(() => window.testState.held);
    await page.evaluate((mode) => {
      if (mode === "auth-lost")
        window.dispatchEvent(new Event("family-auth-lost"));
      else if (mode === "hide/restore") {
        Object.defineProperty(document, "visibilityState", {
          configurable: true,
          value: "hidden",
        });
        document.dispatchEvent(new Event("visibilitychange"));
      } else {
        window.testState.mismatch = true;
        window.dispatchEvent(
          new PageTransitionEvent("pageshow", { persisted: true }),
        );
      }
    }, mode);
    await page.waitForFunction(
      () => document.querySelector(".mobile-upload-fab").disabled,
    );
    const aborted = await page.evaluate(() => window.testState.signal.aborted);
    if (!aborted) throw new Error("PAGE_SIGNAL_NOT_ABORTED");
    await page.evaluate(() => window.testState.release());
    await page.evaluate(() => new Promise((r) => setTimeout(r, 30)));
    if (
      (await page.getByText("PRIVATE_LATE_NAME", { exact: true }).count()) ||
      (await page.getByText("PRIVATE_FIRST_NAME", { exact: true }).count()) ||
      (await page.getByRole("dialog").count())
    )
      throw new Error("STALE_PRIVATE_DOM");
    if (mode === "hide/restore") {
      await page.evaluate(() => {
        Object.defineProperty(document, "visibilityState", {
          configurable: true,
          value: "visible",
        });
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await page.waitForFunction(
        () => !document.querySelector(".mobile-upload-fab").disabled,
      );
      await page.getByRole("button", { name: "＋ 上传照片" }).click();
      if (await page.getByText("PRIVATE_LATE_NAME", { exact: true }).count())
        throw new Error("LATE_DOM_AFTER_REACTIVATION");
    }
    console.log(mode + " ACTUAL_REACT_DOM_PASS");
    await page.close();
  }
  console.log(
    "3 isolated synthetic DOM cases PASS; no TLS/API/device acceptance",
  );
} finally {
  if (browser) await browser.close();
  await new Promise((r) => server.close(r));
}
