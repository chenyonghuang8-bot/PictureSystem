// Test scheduling barrier only. Every READY invokes its original real SQL
// transaction; no admission, role registration or terminal state is fabricated.
import { MySqlSystemRunRepository } from "../../../packages/db/dist/index.js";
const ready = MySqlSystemRunRepository.prototype.ready;
const stopping = MySqlSystemRunRepository.prototype.stopping;
let calls = 0;
const released = new Set();
const waiting = new Map();
const receive = (message) => {
  if (!["release-ready-heartbeat", "release-stopping-record"].includes(message))
    return;
  released.add(message);
  waiting.get(message)?.();
  waiting.delete(message);
  if (released.size === 2) {
    process.off("message", receive);
    if (process.connected) process.disconnect();
  }
};
process.on("message", receive);
const wait = (message) =>
  released.has(message)
    ? Promise.resolve()
    : new Promise((resolve) => waiting.set(message, resolve));
MySqlSystemRunRepository.prototype.ready = async function (...args) {
  if (++calls === 4) {
    if (process.connected) process.send?.("ready-heartbeat-paused");
    await wait("release-ready-heartbeat");
  }
  return ready.apply(this, args);
};
MySqlSystemRunRepository.prototype.stopping = async function (...args) {
  const result = await stopping.apply(this, args);
  if (process.connected) process.send?.("stopping-record-paused");
  await wait("release-stopping-record");
  return result;
};
