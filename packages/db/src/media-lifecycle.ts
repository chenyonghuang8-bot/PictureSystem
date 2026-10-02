// SQL aliases are fixed at the call site; no request-controlled SQL fragments.
export function activeMediaSql(alias: "m" | "mi" | "media_items" = "m") {
  if (!["m", "mi", "media_items"].includes(alias))
    throw new Error("INVALID_MEDIA_ALIAS");
  return `${alias}.trashed_at IS NULL AND ${alias}.purge_intent_id IS NULL`;
}

export function isActiveMedia(row: {
  trashedAt: Date | null;
  purgeIntentId: string | null;
}) {
  return row.trashedAt === null && row.purgeIntentId === null;
}
