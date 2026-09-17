import { decodeInvitationToken } from "./token.js";

export function createInvitationUrl(origin: string, token: unknown): string {
  decodeInvitationToken(token);
  const parsed = new URL(origin);
  if (parsed.protocol !== "https:" || parsed.origin !== origin) {
    throw new Error("Invitation origin must be an exact HTTPS origin.");
  }
  const url = new URL("/join", parsed);
  url.hash = `token=${String(token)}`;
  return url.toString();
}

export function createInvitationQrPayload(
  origin: string,
  token: unknown,
): string {
  return createInvitationUrl(origin, token);
}
