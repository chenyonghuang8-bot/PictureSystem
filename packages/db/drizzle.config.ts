import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "drizzle-kit";

const rootEnvFile = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
  ".env",
);
if (!process.env.DATABASE_URL && existsSync(rootEnvFile)) {
  process.loadEnvFile(rootEnvFile);
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "DATABASE_URL is required; refusing to use an implicit database target",
  );
}

const parsedDatabaseUrl = new URL(databaseUrl);
if (
  parsedDatabaseUrl.protocol !== "mysql:" ||
  parsedDatabaseUrl.pathname !== "/family_album_dev"
) {
  throw new Error(
    "Drizzle commands are restricted to the family_album_dev database",
  );
}
if (decodeURIComponent(parsedDatabaseUrl.username).toLowerCase() === "root") {
  throw new Error("Drizzle commands refuse to use the MySQL root account");
}

export default defineConfig({
  dialect: "mysql",
  schema: "./src/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: databaseUrl,
  },
  strict: true,
  verbose: true,
});
