import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { ContentCoordination, type ReadGuard } from "./phase7-coordination.js";

const require = createRequire(import.meta.url);
type Source = {
  mediaRoot: string;
  expectedMarkerId: string;
  familyId: string;
  sha256Hex: string;
  byteSize: string;
};
type Binding = {
  registeredOriginalIdentity(source: object): Source;
  registerLaunchSupervisor(launch: object, pid: number): void;
  pollRegisteredLaunch(launch: object): boolean;
  transferRegisteredOriginal(launch: object, source: object): void;
  verifyRegisteredSettlement(launch: object): void;
  closeRegisteredLaunch(launch: object): void;
};

/** Internal storage orchestration. Callers cannot choose a PID or descriptor. */
export class RegisteredOriginalRun {
  readonly #native: Binding;
  readonly #read: ReadGuard;
  readonly #launch: object;
  readonly #source: object;
  readonly childFd: number;
  #closed = false;

  private constructor(
    native: Binding,
    read: ReadGuard,
    launch: { handle: object; childFd: number },
    source: object,
  ) {
    this.#native = native;
    this.#read = read;
    this.#launch = launch.handle;
    this.childFd = launch.childFd;
    this.#source = source;
  }

  static async prepare(source: object) {
    const native = require("../build/storage_native.node") as Binding;
    const identity = native.registeredOriginalIdentity(source);
    const coordination = new ContentCoordination(identity, identity);
    const read = await coordination.acquireReadOnly(30_000);
    try {
      return new RegisteredOriginalRun(
        native,
        read,
        read.createRegisteredLaunch(),
        source,
      );
    } catch (error) {
      read.close();
      throw error;
    }
  }

  async start(supervisorPid: number, isTerminal: () => boolean) {
    this.#native.registerLaunchSupervisor(this.#launch, supervisorPid);
    const deadline = Date.now() + 30_000;
    while (!this.#native.pollRegisteredLaunch(this.#launch)) {
      if (isTerminal() || Date.now() >= deadline)
        throw new Error("HANDOFF_CONSUMER_START_FAILED");
      await delay(2);
    }
    this.#native.transferRegisteredOriginal(this.#launch, this.#source);
  }

  verifySettlement() {
    this.#native.verifyRegisteredSettlement(this.#launch);
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.#native.closeRegisteredLaunch(this.#launch);
    } finally {
      this.#read.detachHandoff();
      this.#read.close();
    }
  }
}
