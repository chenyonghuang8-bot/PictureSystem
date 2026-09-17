import { describe, expect, it } from "vitest";
import { loadApiEnv, parseDatabaseUrl } from "./index.js";

describe("environment validation", () => {
  it("loads safe DEV defaults", () => {
    expect(
      loadApiEnv({
        DATABASE_URL:
          "mysql://family_album_dev_user:password@127.0.0.1:3306/family_album_dev",
      }),
    ).toMatchObject({
      APP_ENV: "dev",
      API_HOST: "127.0.0.1",
      API_PORT: 4000,
      TRUSTED_WEB_ORIGINS: ["https://localhost:3000"],
      TRUSTED_PROXY_CIDRS: [],
    });
  });

  it("validates explicit trusted proxy IP and CIDR configuration", () => {
    const base = {
      DATABASE_URL:
        "mysql://family_album_dev_user:password@127.0.0.1:3306/family_album_dev",
    };
    expect(
      loadApiEnv({
        ...base,
        TRUSTED_PROXY_CIDRS: "127.0.0.1,10.0.0.0/8,::1/128",
      }).TRUSTED_PROXY_CIDRS,
    ).toEqual(["127.0.0.1", "10.0.0.0/8", "::1/128"]);
    expect(() =>
      loadApiEnv({ ...base, TRUSTED_PROXY_CIDRS: "any-proxy" }),
    ).toThrow(/TRUSTED_PROXY_CIDRS/);
  });

  it("rejects missing database configuration and root", () => {
    expect(() => loadApiEnv({})).toThrow();
    expect(() =>
      loadApiEnv({
        DATABASE_URL: "mysql://root:password@127.0.0.1/family_album_dev",
      }),
    ).toThrow(/root/);
  });

  it("rejects non-MySQL database URLs", () => {
    expect(() =>
      parseDatabaseUrl("postgres://localhost/family_album_dev"),
    ).toThrow(/mysql/);
  });
});
