import {
  createDatabase,
  MySqlAuthRepository,
  MySqlAdminReadRepository,
} from "../../../packages/db/src/index.js";
import { createApp } from "../../../apps/api/src/app.js";
import { AuthService } from "../../../apps/api/src/auth/service.js";
import { loadDeploymentControl } from "../../../apps/worker/src/deployment-control.js";

// Real HTTP command/query entry point. It has no media services, no writer,
// no runtime registration, no owner binding and no coordinator loop. The sole
// existing owner observes the same durable commands through its normal loop.
const db = createDatabase(process.env.DATABASE_URL!);
const control = await loadDeploymentControl(db.pool, {
  APP_ENV: "dev",
  DATABASE_URL: process.env.DATABASE_URL!,
});
const app = createApp({
  authService: await AuthService.create(new MySqlAuthRepository(db.pool)),
  trustedOrigins: new Set(["https://localhost:3000"]),
  controlAdmission: control.admission,
  admin: {
    control: control.repository,
    reads: new MySqlAdminReadRepository(db.pool),
    localDeny: control.locallyDenied,
    configuredRoles: ["API", "DERIVATIVE"],
  },
});
await app.listen({ host: "127.0.0.1", port: Number(process.env.API_PORT) });
let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  await app.close();
  await db.pool.end();
};
process.once("SIGTERM", () => {
  void close();
});
process.once("SIGINT", () => {
  void close();
});
