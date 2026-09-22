import { describe, expect, it } from "vitest";

import {
  isJobIdentityDuplicate,
  MySqlJobRepository,
} from "./job-repository.js";

describe("background job repository primitives", () => {
  it("creates fixed-width random worker identities", () => {
    expect(MySqlJobRepository.createWorkerIdentity()).toHaveLength(16);
    expect(MySqlJobRepository.createWorkerIdentity()).not.toEqual(
      MySqlJobRepository.createWorkerIdentity(),
    );
  });

  it("accepts only the reviewed logical job identity duplicate", () => {
    expect(
      isJobIdentityDuplicate({
        code: "ER_DUP_ENTRY",
        errno: 1062,
        sqlMessage:
          "Duplicate entry for key 'background_jobs.uq_background_jobs_identity'",
      }),
    ).toBe(true);
    expect(
      isJobIdentityDuplicate({
        code: "ER_DUP_ENTRY",
        errno: 1062,
        sqlMessage:
          "Duplicate entry for key 'background_jobs.uq_background_jobs_family_media_id'",
      }),
    ).toBe(false);
  });
});
