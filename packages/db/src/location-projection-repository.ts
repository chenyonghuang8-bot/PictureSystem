import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";
import type {
  LocationProjection,
  LocationProjector,
} from "@family-album/media";
import { locationCellCenter } from "@family-album/media";
import { runCheckedTransaction } from "./connection.js";
export type LocationToken = {
  familyId: string;
  mediaId: string;
  storageObjectId: string;
  generation: string;
  metadataGeneration: string;
  recipeId: number;
  lifecycleRevision: string;
  gpsLatitude: string;
  gpsLongitude: string;
};
const tokenColumns = `CAST(m.family_id AS CHAR) familyId,CAST(m.id AS CHAR) mediaId,CAST(m.storage_object_id AS CHAR) storageObjectId,CAST(m.generation AS CHAR) generation,CAST(m.metadata_generation AS CHAR) metadataGeneration,m.recipe_id recipeId,CAST(m.lifecycle_revision AS CHAR) lifecycleRevision,m.gps_latitude gpsLatitude,m.gps_longitude gpsLongitude`;
export function validateProjection(p: LocationProjection) {
  locationCellCenter(p.h3Cell);
  if (
    !Number.isInteger(p.policyVersion) ||
    p.policyVersion < 1 ||
    !/^[a-f0-9]{64}$/.test(p.datasetVersion) ||
    (p.countryCode !== null && !/^[A-Z]{2}$/.test(p.countryCode)) ||
    (p.cityGeonameId !== null &&
      (!p.countryCode || !/^[1-9][0-9]*$/.test(p.cityGeonameId)))
  )
    throw new Error("LOCATION_PROJECTION_INVALID");
}
export async function insertLocationProjection(
  c: PoolConnection,
  familyId: string,
  mediaId: string,
  generation: string,
  p: LocationProjection,
) {
  validateProjection(p);
  await c.execute(
    `INSERT INTO media_location_projections(family_id,media_id,generation,policy_version,dataset_version,h3_cell,country_code,city_geoname_id) VALUES(?,?,?,?,?,?,?,?)`,
    [
      familyId,
      mediaId,
      generation,
      p.policyVersion,
      p.datasetVersion,
      p.h3Cell,
      p.countryCode,
      p.cityGeonameId,
    ],
  );
}
export class MySqlLocationProjectionRepository {
  constructor(
    private readonly pool: Pool,
    private readonly projector: LocationProjector,
  ) {}
  async scan(
    familyId: string,
    limit: number,
    afterId = "0",
  ): Promise<LocationToken[]> {
    if (
      !/^[1-9][0-9]*$/.test(familyId) ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      !/^(0|[1-9][0-9]{0,19})$/.test(afterId) ||
      BigInt(afterId) > 18446744073709551615n
    )
      throw new Error("LOCATION_SCAN_INVALID");
    const [rows] = await this.pool.query<(RowDataPacket & LocationToken)[]>(
      `SELECT ${tokenColumns} FROM media_items m WHERE m.family_id=? AND m.id>? AND m.trashed_at IS NULL AND m.purge_intent_id IS NULL AND m.metadata_generation=m.generation AND m.gps_latitude IS NOT NULL AND m.gps_longitude IS NOT NULL AND NOT EXISTS(SELECT 1 FROM media_location_projections p WHERE p.family_id=m.family_id AND p.media_id=m.id AND p.generation=m.generation AND p.policy_version=? AND p.dataset_version=?) ORDER BY m.id LIMIT ?`,
      [
        familyId,
        afterId,
        this.projector.policyVersion,
        this.projector.datasetVersion,
        limit,
      ],
    );
    return rows;
  }
  async apply(
    token: LocationToken,
  ): Promise<"INSERTED" | "UPDATED" | "NOOP" | "STALE"> {
    const p = this.projector.project(token.gpsLatitude, token.gpsLongitude);
    validateProjection(p);
    return runCheckedTransaction(this.pool, async (c) => {
      const [family] = await c.query<RowDataPacket[]>(
        "SELECT id FROM families WHERE id=? FOR SHARE",
        [token.familyId],
      );
      if (!family[0]) return "STALE";
      const [storage] = await c.query<RowDataPacket[]>(
        "SELECT state FROM storage_objects WHERE family_id=? AND id=? FOR SHARE",
        [token.familyId, token.storageObjectId],
      );
      if (storage[0]?.state !== "AVAILABLE") return "STALE";
      const [media] = await c.query<
        (RowDataPacket &
          LocationToken & {
            trashedAt: Date | null;
            purgeIntentId: string | null;
          })[]
      >(
        `SELECT ${tokenColumns},m.trashed_at trashedAt,CAST(m.purge_intent_id AS CHAR) purgeIntentId FROM media_items m WHERE m.family_id=? AND m.id=? FOR UPDATE`,
        [token.familyId, token.mediaId],
      );
      const current = media[0];
      if (
        !current ||
        current.trashedAt !== null ||
        current.purgeIntentId !== null ||
        current.metadataGeneration !== current.generation ||
        Object.keys(token).some(
          (key) =>
            String(current[key as keyof LocationToken]) !==
            String(token[key as keyof LocationToken]),
        )
      )
        return "STALE";
      const [existing] = await c.query<RowDataPacket[]>(
        "SELECT CAST(generation AS CHAR) generation,h3_cell h3Cell,country_code countryCode,CAST(city_geoname_id AS CHAR) cityGeonameId FROM media_location_projections WHERE family_id=? AND media_id=? AND policy_version=? AND dataset_version=? FOR UPDATE",
        [token.familyId, token.mediaId, p.policyVersion, p.datasetVersion],
      );
      const row = existing[0];
      if (row?.generation === token.generation) {
        if (
          row.h3Cell !== p.h3Cell ||
          row.countryCode !== p.countryCode ||
          row.cityGeonameId !== p.cityGeonameId
        )
          throw new Error("LOCATION_INVARIANT_CONFLICT");
        return "NOOP";
      }
      if (row) {
        await c.execute(
          "UPDATE media_location_projections SET generation=?,h3_cell=?,country_code=?,city_geoname_id=?,updated_at=CURRENT_TIMESTAMP(3) WHERE family_id=? AND media_id=? AND policy_version=? AND dataset_version=?",
          [
            token.generation,
            p.h3Cell,
            p.countryCode,
            p.cityGeonameId,
            token.familyId,
            token.mediaId,
            p.policyVersion,
            p.datasetVersion,
          ],
        );
        return "UPDATED";
      }
      await insertLocationProjection(
        c,
        token.familyId,
        token.mediaId,
        token.generation,
        p,
      );
      return "INSERTED";
    });
  }
}
