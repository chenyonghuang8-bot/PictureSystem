import type { FastifyRequest } from "fastify";

import { PublicAuthError } from "./service.js";

export const SESSION_COOKIE_NAME = "__Host-family_session";

export function requireTrustedJsonOrigin(
  request: FastifyRequest,
  trustedOrigins: ReadonlySet<string>,
) {
  const originHeader = request.headers.origin;
  if (
    typeof originHeader !== "string" ||
    originHeader === "null" ||
    originHeader.includes(",")
  ) {
    throw new PublicAuthError(403, "FORBIDDEN");
  }
  let origin: string;
  try {
    const url = new URL(originHeader);
    if (url.protocol !== "https:" || url.origin !== originHeader)
      throw new Error();
    origin = url.origin;
  } catch {
    throw new PublicAuthError(403, "FORBIDDEN");
  }
  if (!trustedOrigins.has(origin)) {
    throw new PublicAuthError(403, "FORBIDDEN");
  }

  const contentType = request.headers["content-type"];
  if (
    typeof contentType !== "string" ||
    !/^application\/json(?:\s*;\s*charset=[A-Za-z0-9._-]+)?$/i.test(contentType)
  ) {
    throw new PublicAuthError(415, "INVALID_REQUEST");
  }
}

export function readWebSessionCookie(request: FastifyRequest): string | null {
  if (request.headers.authorization !== undefined) {
    throw new PublicAuthError(401, "UNAUTHENTICATED");
  }
  const header = request.headers.cookie;
  if (!header) return null;
  const values: string[] = [];
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === SESSION_COOKIE_NAME) {
      values.push(part.slice(separator + 1).trim());
    }
  }
  if (values.length > 1) throw new PublicAuthError(401, "UNAUTHENTICATED");
  return values[0] ?? null;
}

export function sessionCookie(token: string, expiresAt: Date, serverNow: Date) {
  const maxAge = Math.max(
    0,
    Math.floor((expiresAt.getTime() - serverNow.getTime()) / 1_000),
  );
  return `${SESSION_COOKIE_NAME}=${token}; Max-Age=${maxAge}; Path=/; Secure; HttpOnly; SameSite=Lax`;
}

export function clearSessionCookie() {
  return `${SESSION_COOKIE_NAME}=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax`;
}
