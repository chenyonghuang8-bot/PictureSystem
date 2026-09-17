import { randomBytes } from "node:crypto";

import argon2 from "argon2";

import { validatePassword } from "./password.js";

export const ARGON2ID_PARAMETERS = Object.freeze({
  type: argon2.argon2id,
  version: 0x13,
  memoryCost: 65_536,
  timeCost: 6,
  parallelism: 1,
  saltLength: 16,
  hashLength: 32,
});

const argon2Options = {
  type: ARGON2ID_PARAMETERS.type,
  version: ARGON2ID_PARAMETERS.version,
  memoryCost: ARGON2ID_PARAMETERS.memoryCost,
  timeCost: ARGON2ID_PARAMETERS.timeCost,
  parallelism: ARGON2ID_PARAMETERS.parallelism,
  hashLength: ARGON2ID_PARAMETERS.hashLength,
} as const;

export async function hashPassword(password: unknown): Promise<string> {
  return argon2.hash(validatePassword(password), {
    ...argon2Options,
    salt: randomBytes(ARGON2ID_PARAMETERS.saltLength),
  });
}

export async function verifyPassword(
  hash: string,
  password: unknown,
): Promise<boolean> {
  return argon2.verify(hash, validatePassword(password));
}

export function passwordHashNeedsRehash(hash: string): boolean {
  return argon2.needsRehash(hash, {
    version: argon2Options.version,
    memoryCost: argon2Options.memoryCost,
    timeCost: argon2Options.timeCost,
    parallelism: argon2Options.parallelism,
  });
}

export function isValidArgon2idPhc(hash: unknown): hash is string {
  if (typeof hash !== "string") return false;
  const match =
    /^\$argon2id\$v=([0-9]+)\$([^$]+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/.exec(
      hash,
    );
  if (!match) return false;
  const [, version, parameterText, salt, digest] = match;
  const parameters = new Map<string, string>();
  for (const item of parameterText!.split(",")) {
    const pair = /^([mtp])=([0-9]+)$/.exec(item);
    if (!pair || parameters.has(pair[1]!)) return false;
    parameters.set(pair[1]!, pair[2]!);
  }
  if (
    version !== "19" ||
    parameters.size !== 3 ||
    !positiveInteger(parameters.get("m")) ||
    !positiveInteger(parameters.get("t")) ||
    !positiveInteger(parameters.get("p"))
  ) {
    return false;
  }
  return canonicalBase64(salt!, 8) && canonicalBase64(digest!, 4);
}

function positiveInteger(value: string | undefined) {
  if (!value || !/^[1-9][0-9]*$/.test(value)) return false;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0;
}

function canonicalBase64(value: string, minimumBytes: number) {
  const decoded = Buffer.from(value, "base64");
  return (
    decoded.byteLength >= minimumBytes &&
    decoded.toString("base64").replace(/=+$/u, "") === value
  );
}
