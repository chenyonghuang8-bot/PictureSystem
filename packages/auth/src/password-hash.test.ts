import { describe, expect, it } from "vitest";

import {
  ARGON2ID_PARAMETERS,
  hashPassword,
  isValidArgon2idPhc,
  passwordHashNeedsRehash,
  verifyPassword,
} from "./password-hash.js";

describe("Argon2id password hashing", () => {
  it("uses the reviewed PHC parameters without embedding plaintext", async () => {
    const password = "synthetic benchmark-safe password";
    const hash = await hashPassword(password);

    expect(hash).toMatch(/^\$argon2id\$v=19\$m=65536,(?:t=6,p=1|p=1,t=6)\$/);
    expect(hash).not.toContain(password);
    expect(await verifyPassword(hash, password)).toBe(true);
    expect(await verifyPassword(hash, `${password}!`)).toBe(false);
    expect(await hashPassword(password)).not.toBe(hash);
    expect(passwordHashNeedsRehash(hash)).toBe(false);
    expect(ARGON2ID_PARAMETERS).toMatchObject({
      memoryCost: 65_536,
      timeCost: 6,
      parallelism: 1,
      hashLength: 32,
      saltLength: 16,
      version: 19,
    });
  });

  it("classifies only structurally valid Argon2id v19 PHC strings", async () => {
    const hash = await hashPassword("synthetic-password");
    expect(isValidArgon2idPhc(hash)).toBe(true);
    expect(isValidArgon2idPhc("not-a-phc")).toBe(false);
    expect(isValidArgon2idPhc(hash.replace("$argon2id$", "$argon2i$"))).toBe(
      false,
    );
    expect(isValidArgon2idPhc(hash.replace("v=19", "v=18"))).toBe(false);
  });
  it("marks the former timeCost=3 parameters for rehash", async () => {
    const hash = await hashPassword("synthetic-rehash-password");
    expect(passwordHashNeedsRehash(hash.replace("t=6", "t=3"))).toBe(true);
  });
});
