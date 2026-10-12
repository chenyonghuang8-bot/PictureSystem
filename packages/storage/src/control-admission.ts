import {
  verifyRunAdmissionProof,
  type RunAdmissionProof,
} from "@family-album/contracts";
import {
  type OperationGate,
  currentOperationPermit,
  type OperationLock,
} from "./operation-gate.js";
export type ControlledAction =
  | "MEDIA_WRITE"
  | "MEMBER_INCREASE"
  | "MEMBER_REVOKE"
  | "INVITATION_CREATE"
  | "INVITATION_CONSUME"
  | "INVITATION_REVOKE";
export type ControlAdmissionSnapshot = Readonly<{
  runProof?: RunAdmissionProof;
  deploymentId: string;
  namespaceIdentity: string | null;
  requestedMode: "NORMAL" | "READ_ONLY" | "MAINTENANCE";
  enforcedMode: "NORMAL" | "READ_ONLY" | "MAINTENANCE";
  transitionState: "STABLE" | "DRAINING" | "RESUMING" | "RECOVERY_REQUIRED";
  revision: string;
  healthGeneration: string;
  faultLatched: boolean;
}>;
export interface ControlAdmission {
  run<T>(action: ControlledAction, operation: () => Promise<T>): Promise<T>;
}
export class ControlAdmissionError extends Error {
  constructor(
    readonly reason:
      "CONTROL_UNAVAILABLE" | "CONTROL_NAMESPACE_CHANGED" | "WRITE_PAUSED",
  ) {
    super(reason);
    this.name = "ControlAdmissionError";
  }
}
export const denyControlAdmission: ControlAdmission = Object.freeze({
  async run<T>(
    _action: ControlledAction,
    _operation: () => Promise<T>,
  ): Promise<T> {
    void _action;
    void _operation;
    throw new ControlAdmissionError("CONTROL_UNAVAILABLE");
  },
});

/** Each unit holds a native permit through SQL, filesystem work and settlement. */
export class DeploymentAdmission implements ControlAdmission {
  #localDeny = false;
  #revoked = false;
  #localGeneration = 0n;
  constructor(
    readonly gate: OperationGate,
    private readonly readCurrent: () => Promise<ControlAdmissionSnapshot>,
    private readonly safety: {
      beforeMediaWrite?: () => Promise<void>;
      onFault?: (reason: string) => Promise<void>;
      classifyFault?: (error: unknown) => string | undefined;
    } = {},
  ) {}
  revoke() {
    this.#revoked = true;
  }
  denyLocally() {
    this.#localGeneration++;
    this.#localDeny = true;
  }
  localGeneration() {
    return this.#localGeneration;
  }
  isLocallyDenied() {
    return this.#localDeny;
  }
  async run<T>(
    action: ControlledAction,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (currentOperationPermit()?.mode === "X")
      throw new ControlAdmissionError("CONTROL_UNAVAILABLE");
    let permit: OperationLock;
    try {
      permit = await this.gate.acquire("S");
    } catch {
      throw new ControlAdmissionError("CONTROL_UNAVAILABLE");
    }
    try {
      let current: ControlAdmissionSnapshot;
      try {
        current = await this.readCurrent();
      } catch {
        this.denyLocally();
        try {
          await this.safety.onFault?.("DB_UNAVAILABLE");
        } catch {
          /* deny remains */
        }
        throw new ControlAdmissionError("CONTROL_UNAVAILABLE");
      }
      if (
        current.deploymentId !== this.gate.namespace.deploymentId ||
        current.namespaceIdentity !== permit.identity()
      ) {
        this.denyLocally();
        try {
          await this.safety.onFault?.("CONTROL_NAMESPACE_CHANGED");
        } catch {
          /* deny remains */
        }
        throw new ControlAdmissionError("CONTROL_NAMESPACE_CHANGED");
      }
      // Read-current after S acquisition is the unit's admission linearization.
      const safe = action === "MEMBER_REVOKE" || action === "INVITATION_REVOKE";
      if (!safe) {
        const marker = permit.readDeny();
        const restricted =
          this.#revoked ||
          !verifyRunAdmissionProof(current.runProof) ||
          this.#localDeny ||
          marker !== null ||
          current.faultLatched ||
          current.transitionState !== "STABLE";
        if (action === "MEDIA_WRITE") {
          if (
            restricted ||
            current.enforcedMode !== "NORMAL" ||
            current.requestedMode !== "NORMAL"
          )
            throw new ControlAdmissionError("WRITE_PAUSED");
        } else if (
          this.#revoked ||
          !verifyRunAdmissionProof(current.runProof) ||
          current.enforcedMode === "MAINTENANCE" ||
          current.requestedMode === "MAINTENANCE"
        ) {
          throw new ControlAdmissionError("WRITE_PAUSED");
        }
      }
      if (action === "MEDIA_WRITE" && this.safety.beforeMediaWrite) {
        try {
          await this.safety.beforeMediaWrite();
        } catch {
          this.denyLocally();
          try {
            await this.safety.onFault?.("STORAGE_UNAVAILABLE");
          } catch {
            /* deny remains */
          }
          throw new ControlAdmissionError("CONTROL_UNAVAILABLE");
        }
      }
      try {
        return await permit.run(operation);
      } catch (error) {
        const reason = this.safety.classifyFault?.(error);
        if (reason) {
          this.denyLocally();
          try {
            await this.safety.onFault?.(reason);
          } catch {
            /* durable/local deny remains */
          }
        }
        throw error;
      }
    } finally {
      permit.close();
    }
  }
  /** Called only by a coordinator holding X after successful durable recovery. */
  clearLocalDeny(
    exclusive: OperationLock,
    expectedIdentity: string,
    expectedGeneration: bigint,
  ) {
    if (
      this.#localGeneration !== expectedGeneration ||
      exclusive.mode !== "X" ||
      !exclusive.drained ||
      exclusive.identity() !== expectedIdentity ||
      exclusive.readDeny() !== null
    )
      throw new ControlAdmissionError("CONTROL_UNAVAILABLE");
    this.#localDeny = false;
  }
}
