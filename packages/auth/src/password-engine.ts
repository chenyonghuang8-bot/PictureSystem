import { Argon2Limiter } from "./argon2-limiter.js";
import {
  hashPassword,
  isValidArgon2idPhc,
  passwordHashNeedsRehash,
  verifyPassword,
} from "./password-hash.js";

export type PasswordEngine = {
  verify(hash: string, password: unknown): Promise<boolean>;
  hash(password: unknown): Promise<string>;
  needsRehash(hash: string): boolean;
  isValidHash(hash: unknown): hash is string;
};

export function createPasswordEngine(
  limiter = new Argon2Limiter(2, 10, 5_000),
): PasswordEngine {
  return {
    verify: (hash, password) =>
      limiter.run(() => verifyPassword(hash, password)),
    hash: (password) => limiter.run(() => hashPassword(password)),
    needsRehash: passwordHashNeedsRehash,
    isValidHash: isValidArgon2idPhc,
  };
}
