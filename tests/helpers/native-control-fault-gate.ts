import { createRequire } from "node:module";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  OperationGate,
  OperationLock,
} from "../../packages/storage/src/operation-gate.js";

type Boundary =
  "NONE" | "TEMP_CREATE" | "FILE_FSYNC" | "LATCH_DIR_FSYNC" | "CLEAR_DIR_FSYNC";
const require = createRequire(import.meta.url);
const binding = require(
  resolve(
    import.meta.dirname,
    "../../packages/storage/build/storage_native_test.node",
  ),
) as ConstructorParameters<typeof OperationLock>[0] & {
  phase11TestDenyFault(boundary: Boundary): void;
};

/** Same native implementation and real locks; only the separate test addon
 * exports a one-shot EIO at a named durability syscall boundary. */
export class NativeControlFaultGate extends OperationGate {
  static fault(boundary: Boundary) {
    binding.phase11TestDenyFault(boundary);
  }
  override acquire(mode: "S" | "X", timeoutMs = 30_000, signal?: AbortSignal) {
    return this.hold("G", mode, timeoutMs, signal);
  }
  override acquireLatch(timeoutMs = 2_000, signal?: AbortSignal) {
    return this.hold("L", "X", timeoutMs, signal);
  }
  private async hold(
    kind: "G" | "L",
    mode: "S" | "X",
    timeoutMs: number,
    signal?: AbortSignal,
  ) {
    const handle = binding.openOperationGate(
      this.namespace.path,
      this.namespace.deploymentId,
      kind,
      false,
    );
    const deadline = performance.now() + timeoutMs;
    try {
      while (true) {
        signal?.throwIfAborted();
        if (binding.tryOperationGate(handle, mode))
          return new OperationLock(binding, handle, mode, kind);
        if (performance.now() >= deadline) throw Error("OPERATION_GATE_BUSY");
        await delay(5);
      }
    } catch (error) {
      try {
        binding.closeOperationGate(handle);
      } catch {
        /* rejected RAW_X already closed */
      }
      throw error;
    }
  }
}
