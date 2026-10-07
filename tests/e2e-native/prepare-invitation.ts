import { createDatabase } from "../../packages/db/src/index.js";
import { resolve } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
const file = new URL(
  "../../.cache/phase10-native-tests/runtime.json",
  import.meta.url,
);
const fixture = JSON.parse(readFileSync(file, "utf8"));
// Complete only this owned synthetic fixture's required active-super-admin state.
process.loadEnvFile(resolve(".env"));
const target = new URL(process.env.DATABASE_URL!);
if (
  target.pathname !== "/family_album_dev" ||
  target.username.toLowerCase() === "root"
)
  throw new Error("SYNTHETIC_DEV_ONLY");
const database = createDatabase(process.env.DATABASE_URL!);
try {
  await database.pool.query(
    "UPDATE family_members SET role='SUPER_ADMIN' WHERE family_id=? AND user_id=?",
    [fixture.familyId, fixture.users[1]],
  );
} finally {
  await database.pool.end();
}

async function call(path: string, body: unknown, token?: string) {
  const response = await fetch("https://127.0.0.1:3443" + path, {
    method: "POST",
    redirect: "error",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: "Bearer " + token } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    const value =
      typeof payload.error === "string"
        ? payload.error
        : (payload.error?.code ?? payload.code);
    const code =
      typeof value === "string" && /^[A-Z_]{1,60}$/.test(value)
        ? value
        : "UNCLASSIFIED";
    throw new Error(
      "SYNTHETIC_NATIVE_INVITATION_STATUS_" + response.status + "_" + code,
    );
  }
  return response.json();
}
const credential = await call("/api/v1/auth/android/login", {
  username: fixture.username,
  password: fixture.password,
  deviceLabel: "SDK synthetic invitation setup",
});
const issued = await call(
  `/api/v1/families/${fixture.familyId}/invitations`,
  { role: "MEMBER" },
  credential.token,
);
const token = new URLSearchParams(
  new URL(issued.invitationUrl).hash.slice(1),
).get("token");
if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token))
  throw new Error("SYNTHETIC_INVITATION_TOKEN_INVALID");
fixture.invitationURL = "familyalbum://invite?token=" + token;
fixture.invitedUsername = "phase10_invited_" + randomUUID().replaceAll("-", "");
writeFileSync(file, JSON.stringify(fixture), { mode: 0o600 });
console.log(
  "REAL_NATIVE_INVITATION_CREATED; protected synthetic fixture metadata only",
);
