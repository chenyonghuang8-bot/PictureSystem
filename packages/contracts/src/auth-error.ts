import { z } from "zod";

export const authErrorCodeSchema = z.enum([
  "INVALID_REQUEST",
  "INVALID_CREDENTIALS",
  "INVALID_INVITATION",
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "NOT_FOUND",
  "CONFLICT",
  "RATE_LIMITED",
  "SERVICE_UNAVAILABLE",
]);

export type AuthErrorCode = z.infer<typeof authErrorCodeSchema>;

export const authErrorResponseSchema = z
  .object({
    code: authErrorCodeSchema,
    message: z.string().min(1),
    requestId: z.string().min(1),
  })
  .strict();

export type AuthErrorResponse = z.infer<typeof authErrorResponseSchema>;

const PUBLIC_MESSAGES: Readonly<Record<AuthErrorCode, string>> = {
  INVALID_REQUEST: "The request is invalid.",
  INVALID_CREDENTIALS: "Invalid username or password.",
  INVALID_INVITATION: "The invitation is invalid or unavailable.",
  UNAUTHENTICATED: "Authentication is required.",
  FORBIDDEN: "You do not have permission to perform this action.",
  NOT_FOUND: "The requested resource was not found.",
  CONFLICT: "The request conflicts with the current state.",
  RATE_LIMITED: "Too many attempts. Please try again later.",
  SERVICE_UNAVAILABLE: "The service is temporarily unavailable.",
};

export function createAuthErrorResponse(
  code: AuthErrorCode,
  requestId: string,
): AuthErrorResponse {
  return { code, message: PUBLIC_MESSAGES[code], requestId };
}
