import { Buffer } from "node:buffer";
import process from "node:process";

import {
  createDatabase,
  MySqlUploadRepository,
} from "../../../packages/db/dist/index.js";
import { StorageRoot } from "../../../packages/storage/src/index.ts";
import { UploadService } from "../../../apps/api/src/uploads/service.ts";

const [mediaRoot, markerId, uploadHex, userId, sessionId] =
  process.argv.slice(2);
if (
  !process.env.DATABASE_URL ||
  !mediaRoot ||
  !markerId ||
  !uploadHex ||
  !userId ||
  !sessionId ||
  !process.send
) {
  process.exit(2);
}

const database = createDatabase(process.env.DATABASE_URL);
let stage = "PREFLIGHT";
try {
  const [preflight] = await database.pool.query(
    "SELECT DATABASE() AS db, CURRENT_USER() AS account",
  );
  if (
    preflight[0]?.db !== "family_album_dev" ||
    String(preflight[0]?.account).startsWith("root@")
  ) {
    process.exit(3);
  }
  const [rows] = await database.pool.query(
    "SELECT token_hash AS tokenHash FROM sessions WHERE id=? AND user_id=?",
    [sessionId, userId],
  );
  if (!Buffer.isBuffer(rows[0]?.tokenHash) || rows[0].tokenHash.length !== 32) {
    process.exit(4);
  }
  const root = StorageRoot.open(mediaRoot, {
    initialize: false,
    expectedMarkerId: markerId,
  });
  stage = "FINALIZE";
  const real = new MySqlUploadRepository(database.pool);
  const halted = Object.create(real);
  halted.completeFinalize = async () => {
    process.send({ phase: "PUBLISHED_BEFORE_DB_COMPLETION" });
    await new Promise(() => undefined);
  };
  const service = new UploadService(halted, { state: "READ_WRITE", root });
  await service.finalize(
    {
      identity: { userId, sessionId },
      tokenHash: rows[0].tokenHash,
    },
    Buffer.from(uploadHex, "hex"),
  );
  process.send({ phase: "UNEXPECTED_COMPLETE" });
  process.exit(5);
} catch (error) {
  const code =
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[A-Z0-9_]+$/u.test(error.code)
      ? error.code
      : "CONTROLLED_CHILD_FAILURE";
  const detail =
    error &&
    typeof error === "object" &&
    "internalCategory" in error &&
    typeof error.internalCategory === "string" &&
    /^[A-Z0-9_]+$/u.test(error.internalCategory)
      ? error.internalCategory
      : null;
  process.send({ phase: "CHILD_FAILED", category: code, stage, detail });
  process.exit(6);
}
