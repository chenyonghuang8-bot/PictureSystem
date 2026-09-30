/** Internal test seam. Deliberately not re-exported by the package entrypoint. */
export type AlbumRepositoryTestOperation =
  | "TAG_CREATE_APPLY"
  | "TAG_APPLY_EXISTING"
  | "TAG_REMOVE"
  | "NOTE_UPDATE"
  | "COMMENT_CREATE"
  | "COMMENT_DELETE"
  | "ORIGINAL_DOWNLOAD_PREPARE"
  | "ORIGINAL_DOWNLOAD_RECHECK"
  | "PREVIEW_DOWNLOAD_PREPARE"
  | "PREVIEW_DOWNLOAD_RECHECK";

export type AlbumRepositoryTestEvent = Readonly<{
  stage:
    | "FAMILY_LOCK_QUERY_DISPATCHED"
    | "MUTATION_APPLIED_BEFORE_COMMIT"
    | "ORIGINAL_DOWNLOAD_VALIDATED_BEFORE_COMMIT"
    | "PREVIEW_DOWNLOAD_VALIDATED_BEFORE_COMMIT";
  operation: AlbumRepositoryTestOperation;
  familyId: string;
  /** Test-only server connection identity for lock-wait correlation. */
  connectionId?: number;
}>;

export type AlbumRepositoryTestHook = (
  event: AlbumRepositoryTestEvent,
) => void | Promise<void>;
