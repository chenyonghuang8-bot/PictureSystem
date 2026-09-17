import { createHash, randomBytes } from "node:crypto";

const TOKEN_BYTES = 32;
const TOKEN_CHARACTERS = 43;
const CANONICAL_BASE64URL = /^[A-Za-z0-9_-]{43}$/;

export class TokenValidationError extends Error {
  readonly code = "INVALID_TOKEN";

  constructor() {
    super("Token is invalid.");
    this.name = "TokenValidationError";
  }
}

function createOpaqueToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

function decodeOpaqueToken(token: unknown): Buffer {
  if (
    typeof token !== "string" ||
    token.length !== TOKEN_CHARACTERS ||
    !CANONICAL_BASE64URL.test(token)
  ) {
    throw new TokenValidationError();
  }

  const raw = Buffer.from(token, "base64url");
  if (raw.byteLength !== TOKEN_BYTES || raw.toString("base64url") !== token) {
    throw new TokenValidationError();
  }

  return raw;
}

function hashRawToken(raw: Buffer): Buffer {
  if (raw.byteLength !== TOKEN_BYTES) throw new TokenValidationError();
  return createHash("sha256").update(raw).digest();
}

export function createSessionToken(): string {
  return createOpaqueToken();
}

export function decodeSessionToken(token: unknown): Buffer {
  return decodeOpaqueToken(token);
}

export function hashSessionToken(token: unknown): Buffer {
  return hashRawToken(decodeSessionToken(token));
}

export function createInvitationToken(): string {
  return createOpaqueToken();
}

export function decodeInvitationToken(token: unknown): Buffer {
  return decodeOpaqueToken(token);
}

export function hashInvitationToken(token: unknown): Buffer {
  return hashRawToken(decodeInvitationToken(token));
}
