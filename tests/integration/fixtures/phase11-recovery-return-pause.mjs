// Pause only after the actual fresh resource replacement returns READY. The
// coordinator still holds its original permit and performs original completion.
import { VersionedOwner } from "../../../packages/storage/src/index.ts";
const replace = VersionedOwner.prototype.replace;
let paused = false;
let released = false;
let resume;
const receive = (message) => {
  if (message !== "release-recovery-return") return;
  released = true;
  resume?.();
  process.off("message", receive);
  if (process.connected) process.disconnect();
};
process.on("message", receive);
VersionedOwner.prototype.replace = async function (...args) {
  const result = await replace.apply(this, args);
  if (result === "READY" && !paused) {
    paused = true;
    if (process.connected) process.send?.("recovery-return-paused");
    if (!released) await new Promise((resolve) => (resume = resolve));
  }
  return result;
};
