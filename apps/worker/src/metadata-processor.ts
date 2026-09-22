import type {
  LeaseFence,
  MetadataCommitResult,
  MetadataOperationalFailure,
  MetadataPreparation,
  MySqlMetadataRepository,
} from "@family-album/db";
import type { NormalizedMetadataResult } from "@family-album/media";
import { StorageSafetyError } from "@family-album/storage";
import type { OriginalReader } from "@family-album/storage";

type MetadataRepository = Pick<
  MySqlMetadataRepository,
  "prepare" | "persistResult" | "persistOperationalFailure"
>;

type ProbeRunner = Readonly<{
  probeMetadata(
    reader: OriginalReader,
    input: Pick<
      MetadataPreparation,
      "familyId" | "sha256Hex" | "byteSize" | "captureUpperBoundUtc"
    >,
  ): Promise<NormalizedMetadataResult>;
}>;

export class MetadataProcessingService {
  constructor(
    private readonly repository: MetadataRepository,
    private readonly runner: ProbeRunner,
    private readonly reader: OriginalReader,
  ) {}

  async process(fence: LeaseFence): Promise<MetadataCommitResult> {
    const preparation = await this.repository.prepare(fence);
    if (preparation === null) return { affectedRows: 0 };

    try {
      const result = await this.runner.probeMetadata(this.reader, {
        familyId: preparation.familyId,
        sha256Hex: preparation.sha256Hex,
        byteSize: preparation.byteSize,
        captureUpperBoundUtc: preparation.captureUpperBoundUtc,
      });
      return await this.repository.persistResult(fence, preparation, result);
    } catch (error) {
      if (!(error instanceof StorageSafetyError)) throw error;
      return this.repository.persistOperationalFailure(
        fence,
        preparation,
        classifyProbeFailure(error.reason),
      );
    }
  }
}

function classifyProbeFailure(reason: string): MetadataOperationalFailure {
  if (reason === "PROBE_TIMEOUT") return "TIMEOUT" as const;
  if (
    reason === "ISOLATED_PROBE_BACKEND_DISABLED" ||
    reason === "ISOLATED_PROBE_DEV_BACKEND_DISABLED" ||
    reason.startsWith("ISOLATION_")
  ) {
    return "CAPABILITY_DISABLED" as const;
  }
  return "PARSER_FAILED" as const;
}
