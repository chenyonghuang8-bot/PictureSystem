import { describe, expect, it } from "vitest";
import { parseDatabaseUrl } from "../../packages/config/src/index.js";

describe("DEV database configuration", () => {
  it("accepts the isolated DEV database example", () => {
    const url = parseDatabaseUrl(
      "mysql://family_album_dev_user:dev_password@127.0.0.1:3306/family_album_dev",
    );

    expect(url.pathname).toBe("/family_album_dev");
    expect(url.protocol).toBe("mysql:");
  });

  it("rejects a production database name in DEV configuration", () => {
    expect(() =>
      parseDatabaseUrl(
        "mysql://family_album_dev_user:dev_password@127.0.0.1:3306/family_album_prod",
      ),
    ).toThrow(/family_album_dev/);
  });
});
