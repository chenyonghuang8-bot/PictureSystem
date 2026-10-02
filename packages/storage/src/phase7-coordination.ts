import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";
import type { StorageRoot } from "./index.js";

const require = createRequire(import.meta.url);
type NativeHandle = object;
type NativeCoordination = {
  openCoordination(
    root: string,
    marker: string,
    family: string,
    sha256: string,
    byteSize: string,
    kind: "L" | "R",
  ): NativeHandle;
  tryAcquireCoordination(handle: NativeHandle, mode: "S" | "X"): boolean;
  releaseCoordination(handle: NativeHandle): void;
  closeCoordination(handle: NativeHandle): void;
  createHandoff(readHandle: NativeHandle): NativeHandle;
  registerHandoffReceiver(handle: NativeHandle, pid: number): void;
  sendRegisteredOriginal(
    handle: NativeHandle,
    original: object,
    socketFd: number,
  ): void;
  settleHandoff(handle: NativeHandle): void;
  closeHandoff(handle: NativeHandle): void;
  createRegisteredLaunch(read: NativeHandle): {
    handle: object;
    childFd: number;
  };
};
function native(): NativeCoordination {
  // This internal adapter can be bundled into API/worker output. Resolve the
  // fixed storage package location rather than the calling bundle's directory.
  const entry = require.resolve("@family-album/storage");
  return require(
    join(dirname(entry), "../build/storage_native.node"),
  ) as NativeCoordination;
}

const hex64 = /^[0-9a-f]{64}$/u;
const uint64 = /^(?:[1-9][0-9]{0,19})$/u;
function validUint64(value: string) {
  return uint64.test(value) && BigInt(value) <= 18446744073709551615n;
}

// Internal-only. The root and content identity are trusted values from the
// validated storage catalog, never a caller-supplied filesystem path.
export class ContentCoordination {
  readonly #native = native();
  readonly #rootPath: string;
  readonly #markerId: string;
  readonly #familyId: string;
  readonly #sha256: string;
  readonly #byteSize: string;
  constructor(
    root: StorageRoot | { mediaRoot: string; expectedMarkerId: string },
    input: { familyId: string; sha256Hex: string; byteSize: string },
  ) {
    if (
      !validUint64(input.familyId) ||
      !validUint64(input.byteSize) ||
      !hex64.test(input.sha256Hex)
    )
      throw new Error("COORD_INVALID_KEY");
    if ("canonicalPath" in root) {
      root.assertIdentity();
      this.#rootPath = root.canonicalPath;
      this.#markerId = root.markerId;
    } else {
      if (
        !isAbsolute(root.mediaRoot) ||
        normalize(root.mediaRoot) !== root.mediaRoot ||
        resolve(root.mediaRoot) !== root.mediaRoot ||
        !/^[0-9a-f]{32}$/u.test(root.expectedMarkerId)
      ) {
        throw new Error("COORD_ROOT_INVALID");
      }
      // Native open and every acquisition revalidate root/marker/inode.
      this.#rootPath = root.mediaRoot;
      this.#markerId = root.expectedMarkerId;
    }
    this.#familyId = input.familyId;
    this.#sha256 = input.sha256Hex;
    this.#byteSize = input.byteSize;
  }

  async acquireLifecycle(
    mode: "S" | "X",
    timeoutMs: number,
  ): Promise<LifecycleGuard> {
    return new LifecycleGuard(
      this,
      mode,
      await this.#acquire("L", mode, timeoutMs),
    );
  }

  async acquireRead(
    lifecycle: LifecycleGuard,
    mode: "S" | "X",
    timeoutMs: number,
  ) {
    if (!lifecycle.heldBy(this)) throw new Error("COORD_LIFECYCLE_REQUIRED");
    if (mode === "X" && lifecycle.mode !== "X")
      throw new Error("COORD_LIFECYCLE_EXCLUSIVE_REQUIRED");
    return new ReadGuard(
      this,
      lifecycle,
      mode,
      await this.#acquire("R", mode, timeoutMs),
    );
  }

  // Pure reads hold only R-S. Trash needs only L-X and must never wait for a
  // long Original download or parser that does not mutate lifecycle state.
  async acquireReadOnly(timeoutMs: number) {
    return new ReadGuard(
      this,
      null,
      "S",
      await this.#acquire("R", "S", timeoutMs),
    );
  }

  async #acquire(kind: "L" | "R", mode: "S" | "X", timeoutMs: number) {
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 0 ||
      timeoutMs > 120_000
    )
      throw new Error("COORD_INVALID_TIMEOUT");
    const handle = this.#native.openCoordination(
      this.#rootPath,
      this.#markerId,
      this.#familyId,
      this.#sha256,
      this.#byteSize,
      kind,
    );
    const deadline = Date.now() + timeoutMs;
    try {
      let retry = true;
      while (retry) {
        if (this.#native.tryAcquireCoordination(handle, mode)) return handle;
        retry = Date.now() < deadline;
        if (retry)
          await delay(Math.min(10, Math.max(1, deadline - Date.now())));
      }
    } catch (error) {
      this.#native.closeCoordination(handle);
      throw error;
    }
    this.#native.closeCoordination(handle);
    throw new Error("COORD_ACQUIRE_TIMEOUT");
  }

  release(handle: NativeHandle) {
    this.#native.releaseCoordination(handle);
    this.#native.closeCoordination(handle);
  }
}

export class LifecycleGuard {
  #handle: NativeHandle | null;
  #reads = 0;
  constructor(
    readonly owner: ContentCoordination,
    readonly mode: "S" | "X",
    handle: NativeHandle,
  ) {
    this.#handle = handle;
  }
  heldBy(owner: ContentCoordination) {
    return this.owner === owner && this.#handle !== null;
  }
  withNativeExclusive<T>(operation: (handle: object) => T): T {
    if (!this.#handle || this.mode !== "X")
      throw new Error("PURGE_L_X_REQUIRED");
    return operation(this.#handle);
  }
  attachRead() {
    if (!this.#handle) throw new Error("COORD_LIFECYCLE_CLOSED");
    this.#reads++;
  }
  detachRead() {
    this.#reads--;
  }
  close() {
    if (!this.#handle || this.#reads !== 0) throw new Error("COORD_GUARD_BUSY");
    this.owner.release(this.#handle);
    this.#handle = null;
  }
}

export class ReadGuard {
  #handle: NativeHandle | null;
  #handoffs = 0;
  constructor(
    readonly owner: ContentCoordination,
    readonly lifecycle: LifecycleGuard | null,
    readonly mode: "S" | "X",
    handle: NativeHandle,
  ) {
    this.#handle = handle;
    lifecycle?.attachRead();
  }
  createHandoff(): RegisteredHandoff {
    if (!this.#handle || this.mode !== "S")
      throw new Error("HANDOFF_SHARED_READ_REQUIRED");
    const handle = native().createHandoff(this.#handle);
    this.#handoffs++;
    return new RegisteredHandoff(this, handle);
  }
  /** Storage orchestrator only: no business caller receives the descriptors. */
  createRegisteredLaunch() {
    if (!this.#handle || this.mode !== "S")
      throw new Error("HANDOFF_SHARED_READ_REQUIRED");
    const launch = native().createRegisteredLaunch(this.#handle);
    this.#handoffs++;
    return launch;
  }
  detachHandoff() {
    this.#handoffs--;
  }
  /** Internal native verifier adapter; the capability remains guard-owned. */
  withNativeOccupancy<T>(operation: (handle: object) => T): T {
    if (!this.#handle || this.mode !== "S")
      throw new Error("HANDOFF_SHARED_READ_REQUIRED");
    return operation(this.#handle);
  }
  withNativeExclusive<T>(operation: (life: object, read: object) => T): T {
    if (!this.#handle || this.mode !== "X" || !this.lifecycle)
      throw new Error("PURGE_R_X_REQUIRED");
    return this.lifecycle.withNativeExclusive((life) =>
      operation(life, this.#handle!),
    );
  }
  close() {
    if (!this.#handle || this.#handoffs !== 0)
      throw new Error("COORD_GUARD_BUSY");
    this.owner.release(this.#handle);
    this.#handle = null;
    this.lifecycle?.detachRead();
  }
}

// The only new transfer entry point takes a receiver PID and a connected
// Unix-domain socket. Native code durably registers process identity first,
// verifies the socket peer, then sends SCM_RIGHTS and closes the parent FD.
export class RegisteredHandoff {
  #handle: NativeHandle | null;
  constructor(
    readonly read: ReadGuard,
    handle: NativeHandle,
  ) {
    this.#handle = handle;
  }
  registerReceiver(pid: number) {
    if (!this.#handle || !Number.isSafeInteger(pid) || pid <= 0)
      throw new Error("HANDOFF_RECEIVER_INVALID");
    native().registerHandoffReceiver(this.#handle, pid);
  }
  sendOriginal(originalNativeHandle: object, socketFd: number) {
    if (!this.#handle || !Number.isSafeInteger(socketFd) || socketFd < 0)
      throw new Error("HANDOFF_INVALID_SOCKET");
    // The opaque Original's verified K is compared with this handoff's K by
    // native code. No TypeScript identity strings can relabel either handle.
    native().sendRegisteredOriginal(
      this.#handle,
      originalNativeHandle,
      socketFd,
    );
  }
  settleExactChild() {
    if (!this.#handle) throw new Error("HANDOFF_CLOSED");
    native().settleHandoff(this.#handle);
    this.close();
  }
  // On an uncertain failure, close only the local descriptor. The durable
  // unresolved record remains and fails R-exclusive admission closed.
  abandon() {
    this.close();
  }
  private close() {
    if (!this.#handle) throw new Error("HANDOFF_CLOSED");
    native().closeHandoff(this.#handle);
    this.#handle = null;
    this.read.detachHandoff();
  }
}
