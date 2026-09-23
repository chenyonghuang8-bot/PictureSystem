import { describe, expect, it } from "vitest";

import { derivativeFailureDisposition } from "@family-album/db";

import { classifyDerivativeFailure } from "./image-derivative-processor.js";
import { StorageSafetyError } from "@family-album/storage";

describe("derivative failure mapping", () => {
  it("keeps renderer, capability, and resource failures distinct", () => {
    expect(
      classifyDerivativeFailure(
        new StorageSafetyError("RENDERER_RIFF_INVALID"),
      ),
    ).toBe("MALFORMED_MEDIA");
    expect(
      classifyDerivativeFailure(
        new StorageSafetyError("RENDERER_LAUNCH_FAILED"),
      ),
    ).toBe("CAPABILITY_UNAVAILABLE");
    expect(
      classifyDerivativeFailure(new StorageSafetyError("RENDERER_TIMEOUT")),
    ).toBe("PROCESS_TIMEOUT");
    expect(
      classifyDerivativeFailure(new StorageSafetyError("RESOURCE_LIMIT")),
    ).toBe("RESOURCE_LIMIT");
    expect(derivativeFailureDisposition("MALFORMED_MEDIA")).toBe("FAIL");
    expect(derivativeFailureDisposition("CAPABILITY_UNAVAILABLE")).toBe("FAIL");
    expect(derivativeFailureDisposition("PROCESS_TIMEOUT")).toBe("RETRY");
    expect(derivativeFailureDisposition("COMMIT_OUTCOME_UNKNOWN")).toBe("STOP");
  });
});
