/** Internal test seam. Deliberately not re-exported by the package entrypoint. */
export type AlbumRepositoryTestOperation =
  | "TAG_CREATE_APPLY"
  | "TAG_APPLY_EXISTING"
  | "TAG_REMOVE"
  | "NOTE_UPDATE"
  | "COMMENT_CREATE"
  | "COMMENT_DELETE";

export type AlbumRepositoryTestEvent = Readonly<{
  stage: "FAMILY_LOCK_QUERY_DISPATCHED" | "MUTATION_APPLIED_BEFORE_COMMIT";
  operation: AlbumRepositoryTestOperation;
  familyId: string;
}>;

export type AlbumRepositoryTestHook = (
  event: AlbumRepositoryTestEvent,
) => void | Promise<void>;
