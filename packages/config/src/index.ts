import { isIP } from "node:net";

import { z } from "zod";

const environmentSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  APP_ENV: z.enum(["dev", "prod"]).default("dev"),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
});

const apiEnvironmentSchema = environmentSchema.extend({
  API_HOST: z.string().min(1).default("127.0.0.1"),
  API_PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
  API_PUBLIC_ORIGIN: z
    .string()
    .default("https://localhost:4000")
    .refine((value) => {
      try {
        const url = new URL(value);
        return url.protocol === "https:" && url.origin === value;
      } catch {
        return false;
      }
    }, "API_PUBLIC_ORIGIN must be an exact HTTPS origin"),
  DEV_MEDIA_ROOT: z.string().min(1).default("./data/dev/media"),
  DEV_STORAGE_MARKER_ID: z
    .string()
    .default("")
    .refine((value) => value === "" || /^[0-9a-f]{32}$/u.test(value), {
      message: "DEV_STORAGE_MARKER_ID must be 32 lowercase hex characters",
    }),
  DATABASE_URL: z
    .string()
    .min(1)
    .transform((value, context) => {
      try {
        const url = parseDatabaseUrl(value);
        if (decodeURIComponent(url.username).toLowerCase() === "root") {
          throw new Error("DATABASE_URL must not use root");
        }
        return value;
      } catch (error) {
        context.addIssue({
          code: "custom",
          message:
            error instanceof Error ? error.message : "Invalid DATABASE_URL",
        });
        return z.NEVER;
      }
    }),
  TRUSTED_WEB_ORIGINS: z
    .string()
    .default("https://localhost:3000")
    .transform((value, context) => {
      const origins = value.split(",").map((origin) => origin.trim());
      if (
        origins.length === 0 ||
        origins.some((origin) => {
          try {
            const url = new URL(origin);
            return url.protocol !== "https:" || url.origin !== origin;
          } catch {
            return true;
          }
        })
      ) {
        context.addIssue({
          code: "custom",
          message:
            "TRUSTED_WEB_ORIGINS must be exact comma-separated HTTPS origins",
        });
        return z.NEVER;
      }
      return origins;
    }),
  TRUSTED_PROXY_CIDRS: z
    .string()
    .default("")
    .transform((value, context) => {
      const entries = value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
      if (entries.some((entry) => !isValidProxyAddress(entry))) {
        context.addIssue({
          code: "custom",
          message:
            "TRUSTED_PROXY_CIDRS must contain exact IP addresses or CIDR ranges",
        });
        return z.NEVER;
      }
      return entries;
    }),
});

export function loadApiEnv(input: NodeJS.ProcessEnv = process.env) {
  return apiEnvironmentSchema.parse(input);
}

export function loadWorkerEnv(input: NodeJS.ProcessEnv = process.env) {
  return environmentSchema.parse(input);
}

export function parseDatabaseUrl(value: string) {
  const url = new URL(value);

  if (url.protocol !== "mysql:") {
    throw new Error("DATABASE_URL must use the mysql protocol");
  }

  if (url.pathname !== "/family_album_dev") {
    throw new Error("DEV configuration must target family_album_dev");
  }

  return url;
}

export function createLoggerOptions() {
  const { LOG_LEVEL: level } = environmentSchema.parse(process.env);

  return {
    level,
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        "req.headers.upload-metadata",
        "password",
        "currentPassword",
        "newPassword",
        "passwordHash",
        "sessionToken",
        "tokenHash",
        "invitationToken",
        "invitationUrl",
        "uploadMetadata",
        "originalFilename",
        "reportedMime",
        "storagePath",
        "computedSha256",
        "token",
        "body.password",
        "body.currentPassword",
        "body.newPassword",
        "body.sessionToken",
        "body.tokenHash",
        "body.token",
        "body.invitationToken",
        "body.invitationUrl",
        "body.uploadMetadata",
        "body.originalFilename",
        "body.reportedMime",
        "body.storagePath",
        "body.computedSha256",
        "req.body.password",
        "req.body.currentPassword",
        "req.body.newPassword",
        "req.body.sessionToken",
        "req.body.tokenHash",
        "req.body.token",
        "req.body.invitationToken",
        "req.body.invitationUrl",
        "req.body.uploadMetadata",
        "req.body.originalFilename",
        "req.body.reportedMime",
        "req.body.storagePath",
        "req.body.computedSha256",
        "*.password",
        "*.currentPassword",
        "*.newPassword",
        "*.token",
        "*.tokenHash",
        "*.invitationToken",
        "*.invitationUrl",
        "*.uploadMetadata",
        "*.originalFilename",
        "*.reportedMime",
        "*.storagePath",
        "*.computedSha256",
      ],
      censor: "[REDACTED]",
    },
  };
}

function isValidProxyAddress(value: string) {
  const parts = value.split("/");
  if (parts.length === 1) return isIP(value) !== 0;
  if (parts.length !== 2) return false;
  const address = parts[0]!;
  const prefix = parts[1]!;
  const family = isIP(address);
  if (family === 0 || !/^(0|[1-9][0-9]*)$/u.test(prefix)) return false;
  const bits = Number(prefix);
  return Number.isInteger(bits) && bits <= (family === 4 ? 32 : 128);
}
