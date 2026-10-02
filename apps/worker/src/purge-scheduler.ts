import type { StorageRoot } from "@family-album/storage";
import { ContentCoordination } from "../../../packages/storage/src/phase7-coordination.js";
import type { PurgeScheduleRepository } from "../../../packages/db/src/purge-scheduler.js";

// Scanner only creates irreversible durable requests. It never acquires R,
// retires references, or invokes a physical deletion primitive.
export class PurgeScheduler {
  constructor(
    private readonly repository: PurgeScheduleRepository,
    private readonly root: StorageRoot,
  ) {}
  async scan(limit = 20, after?: { purgeAfter: Date; mediaId: string }) {
    this.root.assertIdentity();
    const candidates = await this.repository.candidates(limit, after);
    let requested = 0;
    for (const candidate of candidates) {
      const content = new ContentCoordination(this.root, {
        familyId: candidate.familyId,
        sha256Hex: candidate.sha256Hex,
        byteSize: candidate.byteSize,
      });
      const life = await content.acquireLifecycle("X", 0);
      try {
        if (await this.repository.request(candidate)) requested++;
      } finally {
        life.close();
      }
    }
    const last = candidates.at(-1);
    return {
      requested,
      next:
        last && candidates.length === limit
          ? { purgeAfter: last.purgeAfter, mediaId: last.mediaId }
          : null,
    };
  }
}
