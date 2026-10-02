import { describe, expect, it } from "vitest";
import { permanentDeleteEligibility } from "./trash-repository.js";
const now = new Date("2026-10-02T12:00:00.000Z");
describe("7D read-only eligibility precedence", () => {
  for (const role of ["MEMBER", "ADMIN", "SUPER_ADMIN"])
    for (const canRestore of [true, false])
      for (const retention of [-1, 0, 1])
        for (const age of [-1, 0, 899999, 900000, 900001]) {
          it(`${role} delete=${canRestore} retention=${retention} age=${age}`, () => {
            const input = {
              role,
              canRestore,
              revision: "9007199254740993",
              now,
              purgeAfter: new Date(now.getTime() + retention),
              authenticatedAt: new Date(now.getTime() - age),
            };
            const expected =
              role === "MEMBER" || !canRestore
                ? "NOT_ALLOWED"
                : retention > 0
                  ? "RETENTION_PENDING"
                  : age < 0 || age >= 900000
                    ? "REAUTH_REQUIRED"
                    : "READY";
            expect(permanentDeleteEligibility(input)).toBe(expected);
          });
        }
  it("fails closed at uint64 maximum even for fresh administrator", () => {
    expect(
      permanentDeleteEligibility({
        role: "SUPER_ADMIN",
        canRestore: true,
        revision: "18446744073709551615",
        now,
        purgeAfter: now,
        authenticatedAt: now,
      }),
    ).toBe("NOT_ALLOWED");
  });
});
