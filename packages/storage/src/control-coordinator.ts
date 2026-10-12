import { randomUUID } from "node:crypto";
import type { OperationGate, OperationLock } from "./operation-gate.js";
import type { DeploymentAdmission } from "./control-admission.js";

export type RecoveryAction =
  | "STARTUP_ASSESS"
  | "CANONICAL_RECONCILE"
  | "PURGE_RECONCILE"
  | "CAPACITY_RECONCILE";
const recoverySecret = Symbol("owner-fenced-recovery");
const recoveryActions = new Set<RecoveryAction>([
  "STARTUP_ASSESS",
  "CANONICAL_RECONCILE",
  "PURGE_RECONCILE",
  "CAPACITY_RECONCILE",
]);
/** Minted only by the owner coordinator after DRAINED_X; no general S bypass. */
export class ControlRecoveryPermit {
  #active = true;
  constructor(
    secret: symbol,
    readonly operationId: string,
    readonly revision: string,
    private readonly exclusive: OperationLock,
  ) {
    if (secret !== recoverySecret || !exclusive.drained)
      throw new Error("CONTROL_RECOVERY_REQUIRED");
  }
  async run<T>(action: RecoveryAction, operation: () => Promise<T>) {
    if (!this.#active || !recoveryActions.has(action))
      throw new Error("CONTROL_RECOVERY_REQUIRED");
    this.exclusive.identity();
    return this.exclusive.run(operation);
  }
  retire() {
    this.#active = false;
  }
}
export type PendingControlCommand = {
  control: {
    revision: string;
    healthGeneration: string;
    namespaceIdentity: string | null;
    transitionState: string;
    activeOperationId: string;
  };
  operation: { operationId: string };
};
export interface ControlCoordinatorRepository<P extends PendingControlCommand> {
  pending(): Promise<P | null>;
  complete(
    command: P,
    proof: { namespaceIdentity: string; healthGeneration: string } | null,
  ): Promise<unknown>;
  latch(reason: string, eventId: string): Promise<unknown>;
}
export interface ControlOwner {
  /** Fresh native owner/namespace/capacity + current participant readiness; no child launch. */
  recover(permit: ControlRecoveryPermit): Promise<void | "NOT_READY">;
}
export class ControlCoordinator<P extends PendingControlCommand> {
  #round: Promise<void> | undefined;
  #stopped = false;
  #blockedOperation: string | undefined;
  #protection: { eventId: string; reason: string } | undefined;
  constructor(
    readonly gate: OperationGate,
    private readonly admission: DeploymentAdmission,
    private readonly repository: ControlCoordinatorRepository<P>,
    private readonly owner: ControlOwner,
  ) {}
  stop() {
    this.#stopped = true;
  }
  async drain() {
    await this.#round;
  }
  async trip(reason: string) {
    // Happens before waiting on disk or DB. Never a transparent retry of a write.
    this.admission.denyLocally();
    const id = randomUUID();
    const protection = { eventId: id, reason };
    this.#protection = protection;
    let durable = false;
    try {
      const latch = await this.gate.acquireLatch();
      try {
        latch.latchDeny(reason);
        durable = true;
      } finally {
        latch.close();
      }
    } finally {
      // Preserve native denial when available. If both persistence paths fail,
      // the durable non-CLEAN run also prevents automatic restart admission.
      protection.reason = durable ? reason : "MARKER_UNAVAILABLE";
      await this.repository.latch(protection.reason, id);
      if (this.#protection?.eventId === id) this.#protection = undefined;
    }
  }
  tick(): Promise<void> {
    if (this.#stopped) return Promise.resolve();
    if (this.#round) return this.#round;
    const round = this.coordinate();
    this.#round = round;
    void round
      .finally(() => {
        if (this.#round === round) this.#round = undefined;
      })
      .catch(() => {});
    return round;
  }
  private async coordinate() {
    if (this.#protection) {
      await this.repository.latch(
        this.#protection.reason,
        this.#protection.eventId,
      );
      this.#protection = undefined;
    }
    let pending: P | null;
    try {
      pending = await this.repository.pending();
    } catch (error) {
      try {
        await this.trip("DB_UNAVAILABLE");
      } catch {
        /* local/native protection remains */
      }
      throw error;
    }
    if (
      !pending ||
      this.#stopped ||
      pending.operation.operationId === this.#blockedOperation
    )
      return;
    const localGeneration = this.admission.localGeneration();
    // pending() owns no transaction/actor/content/capacity locks here.
    let x: OperationLock | undefined,
      latch: OperationLock | undefined,
      permit: ControlRecoveryPermit | undefined;
    try {
      x = await this.gate.acquire("X", 30_000);
      x.recoverBridges();
      const identity = x.identity();
      if (identity !== pending.control.namespaceIdentity)
        throw new Error("CONTROL_NAMESPACE_CHANGED");
      const beforeMarker = x.readDeny();
      if (pending.control.transitionState === "RESUMING") {
        permit = new ControlRecoveryPermit(
          recoverySecret,
          pending.operation.operationId,
          pending.control.revision,
          x,
        );
        // A fresh participant may still be publishing its paused heartbeat.
        // Keep RESUMING protected and observe again; never turn waiting into NORMAL.
        if ((await this.owner.recover(permit)) === "NOT_READY") return;
        latch = await this.gate.acquireLatch();
        const marker = latch.readDeny();
        if (
          this.admission.localGeneration() !== localGeneration ||
          marker?.token !== beforeMarker?.token
        )
          throw new Error("HEALTH_CHANGED");
        await this.repository.complete(pending, {
          namespaceIdentity: identity,
          healthGeneration: pending.control.healthGeneration,
        });
        // Only a known commit can reach this clear. Native enforces X+latch and exact marker.
        if (this.admission.localGeneration() !== localGeneration)
          throw new Error("HEALTH_CHANGED");
        if (marker) x.clearDenyWith(latch, marker.token);
        this.admission.clearLocalDeny(x, identity, localGeneration);
      } else if (pending.control.transitionState === "DRAINING") {
        latch = await this.gate.acquireLatch();
        await this.repository.complete(pending, null);
      }
    } catch (error) {
      // Waiting for an admitted unit is not proof of an unsafe bridge. The
      // already committed restriction stays DRAINING and can be observed again.
      if (error instanceof Error && error.message === "OPERATION_GATE_BUSY")
        return;
      // Protection tightening is allowed after failure; actuator itself is stopped.
      this.#blockedOperation = pending.operation.operationId;
      this.#protection = { eventId: randomUUID(), reason: "RECOVERY_FAILED" };
      this.admission.denyLocally();
      try {
        latch ??= await this.gate.acquireLatch();
        latch.latchDeny("RECOVERY_FAILED");
      } catch {
        this.#protection.reason = "MARKER_UNAVAILABLE";
      }
      try {
        await this.repository.latch(
          this.#protection.reason,
          this.#protection.eventId,
        );
        this.#protection = undefined;
      } catch {
        /* Durable native protection remains; next tick only observes/latches. */
      }
      throw error;
    } finally {
      permit?.retire();
      latch?.close();
      x?.close();
    }
  }
}
