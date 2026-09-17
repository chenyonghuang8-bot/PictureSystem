import { describe, expect, it } from "vitest";

import {
  authErrorResponseSchema,
  createAuthErrorResponse,
} from "./auth-error.js";

describe("auth error contract", () => {
  it("exposes only a stable code, safe message, and requestId", () => {
    const response = createAuthErrorResponse(
      "INVALID_CREDENTIALS",
      "request-123",
    );
    expect(authErrorResponseSchema.parse(response)).toEqual({
      code: "INVALID_CREDENTIALS",
      message: "Invalid username or password.",
      requestId: "request-123",
    });
    expect(response).not.toHaveProperty("stack");
    expect(response).not.toHaveProperty("database");
  });

  it("uses the same public response for all credential failures", () => {
    expect(createAuthErrorResponse("INVALID_CREDENTIALS", "a").message).toBe(
      createAuthErrorResponse("INVALID_CREDENTIALS", "b").message,
    );
  });
});
