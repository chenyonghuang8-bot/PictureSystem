import { tmpdir } from "node:os";
import { join } from "node:path";
import { StorageRoot } from "../../../packages/storage/src/index.js";
import { createServer, connect, type Socket } from "node:net";
import { writeFileSync, mkdtempSync, realpathSync } from "node:fs";
import assert from "node:assert/strict";
import {
  createDatabase,
  MySqlSystemRunRepository,
} from "../../../packages/db/src/index.js";
import { InProcessControlOwner } from "../../helpers/in-process-control-owner.js";
import { NativeControlFaultGate } from "../../helpers/native-control-fault-gate.js";
const boundary = process.argv[2],
  evidencePath = process.argv[3];
if (!["FILE_FSYNC", "TEMP_CREATE"].includes(boundary!) || !evidencePath)
  throw Error("EXACT_DOUBLE_FAULT_ARGUMENT_REQUIRED");
const upstream = new URL(process.env.DATABASE_URL!),
  sockets = new Set<Socket>();
let online = true;
const proxy = createServer((client) => {
  if (!online) {
    client.destroy();
    return;
  }
  const remote = connect({
    host: upstream.hostname,
    port: Number(upstream.port || 3306),
  });
  for (const socket of [client, remote]) {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {
      client.destroy();
      remote.destroy();
    });
  }
  client.pipe(remote);
  remote.pipe(client);
});
await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
const url = new URL(upstream);
url.hostname = "127.0.0.1";
url.port = String((proxy.address() as { port: number }).port);
const db = createDatabase(url.toString());
const mediaContainer = mkdtempSync(
  join(realpathSync(tmpdir()), "phase11-r1-cross-process-"),
);
const root = StorageRoot.open(join(mediaContainer, "r"), { initialize: true });
const owner = await InProcessControlOwner.start(
  db.pool,
  [],
  root,
  {},
  undefined,
  (gate) => new NativeControlFaultGate(gate.namespace),
);
const before = await new MySqlSystemRunRepository(db.pool).observeCurrent();
assert.equal(before?.phase, "ACTIVE");
const media = await owner.withResources(async (r) => {
  assert.notEqual(r.capability.state, "UNAVAILABLE");
  if (r.capability.state === "UNAVAILABLE") throw Error("OWNED_MEDIA_REQUIRED");
  return {
    path: r.capability.root.canonicalPath,
    marker: r.capability.root.markerId,
  };
});
owner.haltObservationsForFault();
online = false;
for (const socket of sockets) socket.destroy();
NativeControlFaultGate.fault(boundary as "FILE_FSYNC" | "TEMP_CREATE");
let rejected = false;
try {
  await owner.trip("DB_UNAVAILABLE");
} catch {
  rejected = true;
}
assert.equal(rejected, true);
const s = await owner.fixture.gate.acquire("S", 0);
try {
  assert.equal(s.readDeny(), null);
} finally {
  s.close();
}
writeFileSync(
  evidencePath,
  JSON.stringify({
    deploymentId: owner.fixture.gate.namespace.deploymentId,
    runId: before!.id,
    media,
    boundary,
    actualTcpDisconnected: true,
    nativeMarkerFailed: true,
    denyAbsent: true,
    cleanSigned: false,
  }),
  { mode: 0o600 },
);
// Actual abnormal owner exit: no resource-close acknowledgment/CLEAN is issued.
process.exit(0);
