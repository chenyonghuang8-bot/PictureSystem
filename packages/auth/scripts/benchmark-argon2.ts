import { performance } from "node:perf_hooks";

import { hashPassword } from "../src/password-hash.js";

if (process.env.NODE_ENV === "production") {
  throw new Error("The Argon2 benchmark is DEV-only.");
}

const syntheticPassword = "synthetic-only-argon2-benchmark-password";
const startedAt = performance.now();
await hashPassword(syntheticPassword);
const elapsedMs = performance.now() - startedAt;

process.stdout.write(
  `${JSON.stringify({ benchmark: "argon2id", samples: 1, elapsedMs: Number(elapsedMs.toFixed(1)) })}\n`,
);
