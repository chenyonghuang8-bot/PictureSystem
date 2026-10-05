import { randomBytes, randomUUID } from "node:crypto";
import type {
  Pool,
  ResultSetHeader,
  RowDataPacket,
} from "../../packages/db/src/index.js";
import { assertMigrationReadiness } from "../../packages/db/src/index.js";

// Owned synthetic DB fixtures only. Media inserted here is query-test data, never E2E evidence.
export class MemoriesFixture {
  familyId = "";
  users: string[] = [];
  memberId = "";
  otherMemberId = "";
  sessionId = "";
  lowAlbum = "";
  highAlbum = "";
  hiddenAlbum = "";
  tokenHash = randomBytes(32);
  suffix = randomUUID().replaceAll("-", "");
  constructor(readonly pool: Pool) {}
  async insert(sql: string, values: unknown[]) {
    const [r] = await this.pool.query<ResultSetHeader>(sql, values);
    return String(r.insertId);
  }
  async setup() {
    const c = await this.pool.getConnection();
    try {
      await c.query("SET SESSION time_zone = '+00:00'");
      const [rows] = await c.query<RowDataPacket[]>(
        "SELECT DATABASE() db,CURRENT_USER() account",
      );
      if (
        rows[0]?.db !== "family_album_dev" ||
        String(rows[0]?.account).split("@")[0]?.toLowerCase() === "root"
      )
        throw new Error("MEMORIES_DEV_ONLY");
      await assertMigrationReadiness(c);
    } finally {
      c.release();
    }
    this.familyId = await this.insert("INSERT INTO families(name) VALUES(?)", [
      "p9-memories-" + this.suffix,
    ]);
    for (let n = 0; n < 2; n++)
      this.users.push(
        await this.insert(
          "INSERT INTO users(username,username_normalized,password_hash,password_changed_at) VALUES(?,?,?,CURRENT_TIMESTAMP(3))",
          [
            "p9mem_" + n + this.suffix,
            Buffer.from("p9mem_" + n + this.suffix),
            "synthetic-unused",
          ],
        ),
      );
    this.memberId = await this.insert(
      "INSERT INTO family_members(family_id,user_id,role) VALUES(?,?,'MEMBER')",
      [this.familyId, this.users[0]],
    );
    this.otherMemberId = await this.insert(
      "INSERT INTO family_members(family_id,user_id,role) VALUES(?,?,'MEMBER')",
      [this.familyId, this.users[1]],
    );
    this.sessionId = await this.insert(
      "INSERT INTO sessions(user_id,token_hash,client_type,authenticated_at,last_seen_at,expires_at) VALUES(?,?,'WEB',CURRENT_TIMESTAMP(3),CURRENT_TIMESTAMP(3),DATE_ADD(CURRENT_TIMESTAMP(3),INTERVAL 1 DAY))",
      [this.users[0], this.tokenHash],
    );
    this.lowAlbum = await this.album(this.memberId, "Low");
    this.highAlbum = await this.album(this.memberId, "High");
    this.hiddenAlbum = await this.album(this.otherMemberId, "Hidden");
  }
  actor() {
    return {
      userId: this.users[0]!,
      sessionId: this.sessionId,
      tokenHash: this.tokenHash,
    };
  }
  async album(owner: string, name: string) {
    return this.insert(
      "INSERT INTO albums(family_id,owner_member_id,name,visibility) VALUES(?,?,?,'CUSTOM')",
      [this.familyId, owner, name],
    );
  }
  async media(
    date = "2025-10-05 12:00:00.000",
    capture = true,
    album = this.lowAlbum,
  ) {
    const sha = randomBytes(32),
      object = await this.insert(
        "INSERT INTO storage_objects(family_id,sha256,byte_size,key_version,state,durable_at,verified_at) VALUES(?,?,8,1,'AVAILABLE',CURRENT_TIMESTAMP(3),CURRENT_TIMESTAMP(3))",
        [this.familyId, sha],
      );
    const receipt = await this.insert(
      "INSERT INTO upload_sessions(public_id,family_id,created_by_member_id,original_filename,declared_size,committed_offset,state,computed_sha256,storage_object_id,finalize_started_at,completed_at,expires_at) VALUES(?,?,?,'synthetic.jpg',8,8,'COMPLETE',?,?,CURRENT_TIMESTAMP(3),CURRENT_TIMESTAMP(3),DATE_ADD(CURRENT_TIMESTAMP(3),INTERVAL 1 DAY))",
      [randomBytes(16), this.familyId, this.memberId, sha, object],
    );
    const id = await this.insert(
      "INSERT INTO media_items(family_id,storage_object_id,source_upload_id,uploaded_at,timeline_key,media_type,processing_state,metadata_generation,display_width,display_height) VALUES(?,?,?,?,?,'IMAGE','READY',1,1,1)",
      [this.familyId, object, receipt, date, date],
    );
    if (capture)
      await this.pool.query(
        "UPDATE media_items SET captured_local_at=?,captured_source='EXIF_ORIGINAL',captured_time_status='OFFSET_UNKNOWN',timeline_basis='CAPTURE_LOCAL' WHERE family_id=? AND id=?",
        [date, this.familyId, id],
      );
    const job = await this.insert(
      "INSERT INTO background_jobs(family_id,media_id,generation,recipe_id,job_type,state,available_at,finished_at) VALUES(?,?,1,1,'IMAGE_DERIVATIVES','SUCCEEDED',CURRENT_TIMESTAMP(3),CURRENT_TIMESTAMP(3))",
      [this.familyId, id],
    );
    for (const kind of ["PREVIEW", "THUMBNAIL"])
      await this.pool.query(
        "INSERT INTO derived_assets(family_id,media_id,generation,recipe_id,kind,state,reserved_bytes,byte_size,sha256,width,height,output_mime,producer_job_id,producer_lease_epoch,published_at) VALUES(?,?,1,1,?,'READY',100,8,?,1,1,'image/webp',?,1,CURRENT_TIMESTAMP(3))",
        [this.familyId, id, kind, randomBytes(32), job],
      );
    await this.pool.query(
      "INSERT INTO album_media(family_id,album_id,media_id) VALUES(?,?,?)",
      [this.familyId, album, id],
    );
    return id;
  }
  async cleanup() {
    if (this.familyId) {
      await this.pool.query(
        "UPDATE media_items SET purge_intent_id=NULL WHERE family_id=?",
        [this.familyId],
      );
      await this.pool.query("DELETE FROM purge_intents WHERE family_id=?", [
        this.familyId,
      ]);
    }
    if (this.familyId)
      for (const table of [
        "audit_logs",
        "user_favorites",
        "family_featured",
        "media_location_projections",
        "album_media",
        "derived_assets",
        "background_jobs",
        "media_items",
        "upload_sessions",
        "storage_objects",
        "album_members",
        "albums",
        "family_members",
      ])
        await this.pool.query(`DELETE FROM ${table} WHERE family_id=?`, [
          this.familyId,
        ]);
    for (const user of this.users) {
      await this.pool.query("DELETE FROM sessions WHERE user_id=?", [user]);
      await this.pool.query("DELETE FROM users WHERE id=?", [user]);
    }
    if (this.familyId)
      await this.pool.query("DELETE FROM families WHERE id=?", [this.familyId]);
  }
}
