import { describe, expect, it } from "vitest";

import { OriginalDownloadLimiter } from "./original-download/limiter.js";
import { PreviewDownloadLimiter } from "./preview-download/limiter.js";

describe("Original and Preview limiter isolation", () => {
  it("enforces independent process/member limits without cross-release", () => {
    const originals = new OriginalDownloadLimiter();
    const previews = new PreviewDownloadLimiter();

    const originalMemberOne = originals.tryAcquire("1", "10");
    const previewMemberOneA = previews.tryAcquire("1", "10");
    const previewMemberOneB = previews.tryAcquire("1", "10");
    expect(originalMemberOne).not.toBeNull();
    expect(previewMemberOneA).not.toBeNull();
    expect(previewMemberOneB).not.toBeNull();
    expect(originals.tryAcquire("1", "10")).toBeNull();
    expect(previews.tryAcquire("1", "10")).toBeNull();

    const originalMemberTwo = originals.tryAcquire("1", "11");
    const previewMemberTwoA = previews.tryAcquire("1", "11");
    const previewMemberThree = previews.tryAcquire("1", "12");
    expect(originalMemberTwo).not.toBeNull();
    expect(previewMemberTwoA).not.toBeNull();
    expect(previewMemberThree).not.toBeNull();
    expect(originals.tryAcquire("1", "12")).toBeNull();
    expect(previews.tryAcquire("1", "13")).toBeNull();

    previewMemberOneA!.release();
    expect(originals.snapshot()).toEqual({ active: 2, activeMembers: 2 });
    expect(previews.snapshot()).toEqual({
      active: 3,
      activeMembers: 3,
      memberCounts: [1, 1, 1],
    });

    originalMemberOne!.release();
    expect(previews.snapshot()).toEqual({
      active: 3,
      activeMembers: 3,
      memberCounts: [1, 1, 1],
    });
    expect(originals.snapshot()).toEqual({ active: 1, activeMembers: 1 });

    originalMemberTwo!.release();
    previewMemberOneB!.release();
    previewMemberTwoA!.release();
    previewMemberThree!.release();
    expect(originals.snapshot()).toEqual({ active: 0, activeMembers: 0 });
    expect(previews.snapshot()).toEqual({
      active: 0,
      activeMembers: 0,
      memberCounts: [],
    });
  });
});
