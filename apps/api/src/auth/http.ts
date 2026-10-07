import type { FastifyRequest } from "fastify";

import { hashSessionToken } from "@family-album/auth";

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

export type SessionCredential = {
  token: string;
  expectedClientType: "WEB" | "ANDROID";
};

export function readSessionCredential(
  request: FastifyRequest,
): SessionCredential | null {
  const authorization = request.headers.authorization;
  if (authorization !== undefined) {
    const raw = request.raw.rawHeaders ?? [];
    const count = raw.filter(
      (_, index) =>
        index % 2 === 0 && raw[index]!.toLowerCase() === "authorization",
    ).length;
    if (
      request.headers.cookie !== undefined ||
      request.headers.origin !== undefined ||
      count > 1 ||
      typeof authorization !== "string" ||
      !/^Bearer [A-Za-z0-9_-]{43}$/u.test(authorization)
    ) {
      throw new PublicAuthError(401, "UNAUTHENTICATED");
    }
    const token = authorization.slice(7);
    try {
      hashSessionToken(token);
    } catch {
      throw new PublicAuthError(401, "UNAUTHENTICATED");
    }
    return { token, expectedClientType: "ANDROID" };
  }
  const token = readWebSessionCookie(request);
  return token ? { token, expectedClientType: "WEB" } : null;
}

export function requireNativeJson(request: FastifyRequest) {
  if (
    request.headers.cookie !== undefined ||
    request.headers.origin !== undefined ||
    request.headers.authorization !== undefined
  )
    throw new PublicAuthError(400, "INVALID_REQUEST");
  requireJson(request);
}

function requireJson(request: FastifyRequest) {
  const value = request.headers["content-type"];
  if (
    typeof value !== "string" ||
    !/^application\/json(?:\s*;\s*charset=[A-Za-z0-9._-]+)?$/i.test(value)
  )
    throw new PublicAuthError(415, "INVALID_REQUEST");
}

export function requireSessionJsonMutation(
  request: FastifyRequest,
  trustedOrigins: ReadonlySet<string>,
) {
  const credential = readSessionCredential(request);
  if (credential?.expectedClientType === "ANDROID") requireJson(request);
  else requireTrustedJsonOrigin(request, trustedOrigins);
}
