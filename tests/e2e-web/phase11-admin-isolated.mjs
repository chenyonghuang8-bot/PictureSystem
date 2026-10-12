/* global document, window, Event, PageTransitionEvent */
// Actual Admin React DOM with synthetic fetch. This does not claim real API/TLS E2E.
import { createRequire } from "node:module";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
const root = resolve(import.meta.dirname, "../.."),
  require = createRequire(join(root, "package.json"));
const { chromium, expect } = require("@playwright/test");
const esbuild = readdirSync(join(root, "node_modules/.pnpm"))
  .filter((n) => n.startsWith("esbuild@"))
  .sort()
  .at(-1);
const { build } = require(
  join(root, "node_modules/.pnpm", esbuild, "node_modules/esbuild"),
);
const entry = `import {createElement} from '${join(root, "apps/web/node_modules/react/index.js")}';
import {createRoot} from '${join(root, "apps/web/node_modules/react-dom/client.js")}';
import {AdminWorkspace} from '${join(root, "apps/web/components/admin/workspace.tsx")}';
const at='2026-10-07T08:00:00.000Z',obs=(source,state='NOT_CONFIGURED',reasonCode='NOT_CONFIGURED')=>({source,state,reasonCode,observedAt:null,staleAfter:null});
const engines={backups:obs('BACKUP_PROVIDER'),integrity:obs('INTEGRITY_PROVIDER'),lastBackupSuccessAt:null,lastIntegritySuccessAt:null};
window.adminTest={mismatch:false,role:'SUPER_ADMIN',grant:true,hold:false,signal:null,modePosts:0,observations:0,unknown:false,lastId:null,revision:'9007199254740993'};
const t=window.adminTest;
const overview=()=>({familyId:'8',actorMemberId:'1',observedAt:at,scope:'CURRENT_VISIBLE_MEDIA',photos:'9007199254740993',videos:'1',trash:'0',visibleLogicalBytes:'16',visibleReferencedStorageBytes:'16',visibleDerivedBytes:'0',uploaders:[],mediaControl:'PAUSED',...engines});
const member={id:'2',userId:'2',username:'PRIVATE_MEMBER_NAME',displayName:null,role:'MEMBER',disabled:false};
const status=()=>({requestedMode:'READ_ONLY',enforcedMode:'READ_ONLY',transitionState:'STABLE',revision:t.revision,healthGeneration:'1',faultLatched:false,reasonCode:'NONE',activeOperationId:null,observedAt:at,localDeny:false,observations:{observedAt:at,database:obs('CHECKED_DATABASE','HEALTHY','NONE'),storage:{...obs('STORAGE_OWNER','UNKNOWN','WRITER_NOT_READY'),totalBytes:null,availableBytes:null},accounting:{storedOriginalBytes:'16',reservedFutureBytes:'0',retainedStagingBytes:'0',derivedBytes:'0',unsettledDerivedBytes:'0'},workers:[],...engines}});
window.fetch=async(path,init={})=>{
if(path==='/api/v1/auth/me')return Response.json({user:{id:t.mismatch?'3':'1',username:'synthetic',displayName:null},memberships:[{id:'1',familyId:'8',familyName:'synthetic',role:t.role}]});
if(path==='/api/v1/auth/reauth')return new Response(null,{status:204});
if(path.includes('/admin/overview')){if(t.hold){t.signal=init.signal;return new Promise(r=>t.release=()=>r(Response.json(overview())));}return Response.json(overview());}
if(path.endsWith('/members'))return Response.json({members:[member]});
if(path.includes('/members/')&&init.method==='PATCH'){Object.assign(member,JSON.parse(init.body));return Response.json(member);}
if(path.endsWith('/invitations')){if(init.method==='POST')return Response.json({id:'7',role:'MEMBER',expiresAt:at,invitationUrl:'https://synthetic.invalid/invite/SYNTHETIC_ONCE'});return Response.json({invitations:[]});}
if(path.includes('/audit'))return Response.json({source:'management',observedAt:at,events:[],nextCursor:null});
if(path==='/api/v1/admin/system/status')return t.grant?Response.json(status()):new Response(null,{status:403});
if(path==='/api/v1/admin/system/mode'){t.modePosts++;t.lastId=JSON.parse(init.body).operationId;return t.unknown?new Response(null,{status:503}):Response.json({operationId:t.lastId,kind:'MODE',status:'PENDING',targetMode:'READ_ONLY',resultRevision:null,reasonCode:'MANUAL_READ_ONLY',createdAt:at,finishedAt:null},{status:202});}
if(path.includes('/operations/')){t.observations++;return Response.json({operationId:t.lastId,kind:'MODE',status:'PENDING',targetMode:'READ_ONLY',resultRevision:null,reasonCode:'MANUAL_READ_ONLY',createdAt:at,finishedAt:null});}
throw Error('UNEXPECTED_SYNTHETIC_PATH');
};createRoot(document.getElementById('root')).render(createElement(AdminWorkspace,{userId:'1',familyId:'8'}));`;
const result = await build({
  stdin: { contents: entry, loader: "tsx", resolveDir: root },
  bundle: true,
  write: false,
  format: "iife",
  platform: "browser",
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' },
});
const css = readFileSync(join(root, "apps/web/app/styles.css"), "utf8");
const server = createServer((req, res) => {
  res.setHeader(
    "content-type",
    req.url === "/bundle.js" ? "text/javascript" : "text/html",
  );
  res.end(
    req.url === "/bundle.js"
      ? result.outputFiles[0].contents
      : `<meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script src="/bundle.js"></script>`,
  );
});
await new Promise((r, j) => {
  server.once("error", j);
  server.listen(0, "127.0.0.1", r);
});
let browser;
try {
  browser = await chromium.launch({ channel: "chrome" });
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const mode of ["hidden", "auth-lost", "account-mismatch", "role-loss"]) {
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
    });
    await page.goto(base);
    await expect(
      page.getByText("PRIVATE_MEMBER_NAME", { exact: false }),
    ).toBeVisible();
    await expect(
      page.getByText("9007199254740993", { exact: true }),
    ).toBeVisible();
    await page.getByLabel("成员管理验证密码").fill("synthetic-password");
    await page.evaluate(() => {
      window.adminTest.hold = true;
    });
    await page.getByRole("button", { name: "刷新", exact: true }).click();
    await page.waitForFunction(() => !!window.adminTest.signal);
    await page.evaluate((mode) => {
      if (mode === "hidden") {
        Object.defineProperty(document, "hidden", {
          configurable: true,
          value: true,
        });
        document.dispatchEvent(new Event("visibilitychange"));
      }
      if (mode === "auth-lost")
        window.dispatchEvent(new Event("family-auth-lost"));
      if (mode === "account-mismatch") {
        window.adminTest.mismatch = true;
        window.dispatchEvent(
          new PageTransitionEvent("pageshow", { persisted: true }),
        );
      }
      if (mode === "role-loss") {
        window.adminTest.role = "MEMBER";
        window.dispatchEvent(
          new PageTransitionEvent("pageshow", { persisted: true }),
        );
      }
    }, mode);
    await expect(
      page.getByText("PRIVATE_MEMBER_NAME", { exact: false }),
    ).toHaveCount(0);
    if (!(await page.evaluate(() => window.adminTest.signal.aborted)))
      throw Error("ADMIN_STALE_READ_NOT_ABORTED");
    await page.evaluate(() => window.adminTest.release());
    await page.waitForTimeout(30);
    await expect(
      page.getByText("9007199254740993", { exact: true }),
    ).toHaveCount(0);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    console.log(mode + " ADMIN_ACTUAL_DOM_PASS");
    await page.close();
  }
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
  });
  await page.goto(base);
  await expect(
    page.getByRole("button", { name: "切换到只读", exact: true }),
  ).toBeVisible();
  await page.getByLabel("成员管理验证密码").fill("synthetic-password");
  await page.getByRole("button", { name: "邀请成员", exact: true }).click();
  await expect(
    page.getByText("https://synthetic.invalid/invite/SYNTHETIC_ONCE", {
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "关闭链接", exact: true }).click();
  await expect(
    page.getByText("https://synthetic.invalid/invite/SYNTHETIC_ONCE", {
      exact: true,
    }),
  ).toHaveCount(0);
  await page.evaluate(() => (window.adminTest.unknown = true));
  await page.getByRole("button", { name: "切换到只读", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("所有家庭");
  await expect(page.getByRole("dialog")).toContainText("9007199254740993");
  await page.getByLabel("重新验证密码").fill("synthetic-password");
  await page.getByRole("button", { name: "验证并确认", exact: true }).click();
  await page.waitForFunction(() => window.adminTest.observations > 0);
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await page.waitForTimeout(30);
  if ((await page.evaluate(() => window.adminTest.modePosts)) !== 1)
    throw Error("ADMIN_UNKNOWN_REQUEST_REPLAYED");
  console.log("invitation-once-and-unknown-observe ADMIN_ACTUAL_DOM_PASS");
  await page.evaluate(() => (window.adminTest.grant = false));
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "切换到只读", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText("PRIVATE_MEMBER_NAME", { exact: false }),
  ).toBeVisible();
  console.log(
    "system-grant-revocation-preserves-family-scope ADMIN_ACTUAL_DOM_PASS",
  );
  await page.close();
} finally {
  await browser?.close();
  await new Promise((r) => server.close(r));
}
