import { isAbsolute, normalize } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import {
  MySqlSystemControlRepository,
  MySqlSystemRunRepository,
  SystemControlError,
  type RunLease,
  type RunConfiguration,
  type Pool,
  type RuntimeRole,
} from "@family-album/db";
import {
  DeploymentAdmission,
  OperationGate,
  denyControlAdmission,
  type ControlAdmission,
  type OperationLock,
  ControlCoordinator,
  type ControlOwner,
} from "@family-album/storage";

function reportControlFailure(
  event:
    | "storage_health_unavailable"
    | "control_owner_unavailable"
    | "control_observation_unavailable",
  error: unknown,
) {
  const candidate =
    error instanceof Error
      ? "reason" in error
        ? error.reason
        : error.message
      : undefined;
  const allowed = [
    "PURGE_WRITER_REQUIRED",
    "OWNER_NOT_READY",
    "WRITER_NOT_READY",
    "STORAGE_CAPACITY_LOW",
    "ROOT_IDENTITY_CHANGED",
    "COORD_NAMESPACE_UNAVAILABLE",
    "STORAGE_MOUNT_UNAVAILABLE",
    "ORIGINAL_READER_UNAVAILABLE",
    "READINESS_UNAVAILABLE",
    "STORAGE_STARTUP_RECOVERY_INCOMPLETE",
    "OWNER_CLOSE_UNCERTAIN",
    "CONTROL_NAMESPACE_CHANGED",
    "DERIVATIVE_OUTCOME_UNKNOWN",
    "CONTROL_UNAVAILABLE",
    "CONTROL_RUN_UNCONFIRMED",
  ];
  const category =
    typeof candidate === "string" && allowed.includes(candidate)
      ? candidate
      : "UNCLASSIFIED";
  console.error(JSON.stringify({ event, category }));
}

/** One deployment-wide list may include an enabled process that has never
 * started. It cannot disappear from recovery proof merely by lacking a row. */
export function configuredControlRoles(
  local: readonly RuntimeRole[],
  raw = process.env.DEV_CONTROL_REQUIRED_ROLES,
): readonly RuntimeRole[] {
  if (raw === undefined || raw === "") return [...local];
  const roles = raw.split(",").map((r) => r.trim());
  if (
    roles.some(
      (r) => !["API", "DERIVATIVE", "METADATA", "PURGE"].includes(r),
    ) ||
    new Set(roles).size !== roles.length
  )
    throw Error("CONTROL_PARTICIPANT_CONFIG_INVALID");
  return [...new Set([...local, ...(roles as RuntimeRole[])])];
}

export type DeploymentControl = {
  repository: MySqlSystemControlRepository;
  admission: ControlAdmission;
  gate?: OperationGate;
  locallyDenied(): boolean;
  startupWritable: boolean;
  bindOwner?: (
    owner: ControlOwner & {
      ready(): boolean;
      changing(): boolean;
      health(): Promise<void>;
    },
  ) => void;
  bindHealth?: (probe: () => Promise<void>) => void;
  start?: (
    participants: readonly { role: RuntimeRole; ready(): boolean }[],
  ) => Promise<void>;
  stop?: () => void;
  drain?: () => Promise<void>;
  beginShutdown?: () => Promise<void>;
  resourcesClosed?: (successful: boolean) => Promise<void>;
  onStopping?: (callback: () => void) => void;
  trip?: (reason: string) => Promise<void>;
  track?: <T>(
    role: RuntimeRole,
    operation: () => Promise<T>,
    completed?: (result: T) => boolean,
  ) => Promise<T>;
};

/** Normal startup only opens the explicitly provisioned namespace. Missing
 * control config/readiness denies media writes while leaving auth/control alive. */
export async function loadDeploymentControl(
  pool: Pool,
  env: {
    APP_ENV: string;
    DATABASE_URL: string;
  },
  config: {
    path?: string | undefined;
    deploymentId?: string | undefined;
    roles?: readonly RuntimeRole[];
    mediaRoot?: string;
    markerId?: string;
  } = {
    path: process.env.DEV_CONTROL_PATH,
    deploymentId: process.env.DEV_CONTROL_DEPLOYMENT_ID,
  },
): Promise<DeploymentControl> {
  const repository = new MySqlSystemControlRepository(pool);
  const unavailable: DeploymentControl = {
    repository,
    admission: denyControlAdmission,
    locallyDenied: () => true,
    startupWritable: false,
  };
  const database = new URL(env.DATABASE_URL);
  if (
    env.APP_ENV !== "dev" ||
    database.protocol !== "mysql:" ||
    database.pathname !== "/family_album_dev" ||
    decodeURIComponent(database.username).toLowerCase() === "root" ||
    !config.path ||
    !config.deploymentId ||
    !isAbsolute(config.path) ||
    normalize(config.path) !== config.path
  )
    return unavailable;
  let gate: OperationGate;
  try {
    gate = new OperationGate({
      path: config.path,
      deploymentId: config.deploymentId,
    });
  } catch {
    return unavailable;
  }
  const runtime = new ManagedControl(gate, repository),
    admission = runtime.admission;
  try {
    if (config.roles?.length)
      await runtime.prepare(config.roles, config.mediaRoot, config.markerId);
    // Coordinator already owns run.lock before any S or media owner.
    const s = await gate.acquire("S");
    try {
      const current = await repository.readCurrent(),
        identity = s.identity(),
        marker = s.readDeny();
      if (
        current.deploymentId !== config.deploymentId ||
        current.namespaceIdentity !== identity
      ) {
        admission.denyLocally();
        return runtime.public(false);
      }
      // A prior process may have durably denied while its DB connection was
      // unavailable. Carry that protection into the current DB before opening
      // media resources; a restart is never a fresh health/resume proof.
      if (marker !== null && !current.faultLatched) {
        await runtime.syncStartupMarker(marker.reasonCode);
        return runtime.public(false);
      }
      return runtime.public(runtime.automaticPreparation());
    } finally {
      s.close();
    }
  } catch {
    admission.denyLocally();
    // Bootstrap/readiness errors cannot grant a write or initialize a new gate.
    runtime.disposeUnstarted();
    return unavailable;
  }
}

export class ManagedControl {
  readonly admission: DeploymentAdmission;
  readonly coordinator: ControlCoordinator<
    NonNullable<Awaited<ReturnType<MySqlSystemControlRepository["pending"]>>>
  >;
  private owner:
    | (ControlOwner & {
        ready(): boolean;
        changing(): boolean;
        health(): Promise<void>;
      })
    | undefined;
  private probe: (() => Promise<void>) | undefined;
  private participants: {
    role: RuntimeRole;
    ready(): boolean;
    boot: string;
    superseded: boolean;
    running: number;
    completed: bigint;
    reported: bigint;
  }[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private controlTimer: ReturnType<typeof setInterval> | undefined;
  private pulseWork: Promise<void> | undefined;
  private controlWork: Promise<void> | undefined;
  private shutdownWork: Promise<void> | undefined;
  private stopped = false;
  private lastFault: string | undefined;
  private lastGc = 0;
  private activeConfirmed = false;
  private readonly runs: MySqlSystemRunRepository;
  private runLease: RunLease | undefined;
  private runLock: OperationLock | undefined;
  private shutdownOperationId: string | undefined;
  private stoppingCallback: (() => void) | undefined;
  private processId = randomUUID();
  private declaredRoles: readonly RuntimeRole[] = [];
  private runConfig: RunConfiguration | undefined;
  /** No media owner/participant exists at this early load boundary. */
  disposeUnstarted() {
    if (this.owner || this.participants.length)
      throw Error("CONTROL_DRAIN_REQUIRED");
    this.admission.revoke();
    this.runLock?.close();
    this.runLock = undefined;
  }
  automaticPreparation() {
    return !!this.runLease?.automatic;
  }
  async prepare(
    localRoles: readonly RuntimeRole[],
    mediaRoot = process.env.DEV_MEDIA_ROOT ?? "",
    markerId = process.env.DEV_STORAGE_MARKER_ID ?? "",
  ) {
    if (this.runLease || this.runConfig)
      throw Error("CONTROL_RUNTIME_ALREADY_STARTED");
    this.declaredRoles = [...localRoles];
    const expectedRoles = [...configuredControlRoles(localRoles)].sort();
    const ownerRole = localRoles.includes("API")
      ? "API"
      : localRoles.includes("PURGE")
        ? "PURGE"
        : undefined;
    if (ownerRole && !this.runLock) this.runLock = await this.gate.acquireRun();
    const x = ownerRole ? await this.gate.acquire("X", 0) : undefined;
    try {
      const current = await this.repository.readCurrent();
      let namespaceIdentity = x?.identity();
      if (!namespaceIdentity) {
        const s = await this.gate.acquire("S");
        try {
          namespaceIdentity = s.identity();
        } finally {
          s.close();
        }
      }
      const runNamespaceIdentity = this.gate.runIdentity();
      const coordinatorRole =
        ownerRole ?? (expectedRoles.includes("API") ? "API" : "PURGE");
      this.runConfig = {
        deploymentId: this.gate.namespace.deploymentId,
        namespaceIdentity,
        runNamespaceIdentity,
        expectedRoles,
        ownerRole: coordinatorRole,
        configDigest: createHash("sha256")
          .update(
            JSON.stringify({
              protocol: 1,
              mediaRoot,
              markerId,
              expectedRoles,
              ownerRole: coordinatorRole,
            }),
          )
          .digest("hex"),
      };
      if (
        current.deploymentId !== this.gate.namespace.deploymentId ||
        current.namespaceIdentity !== namespaceIdentity
      ) {
        // Fresh DEV bootstrap binds the namespace first; no boot/run is fabricated.
        return;
      }
      const newMembers = localRoles.map((role) => ({
        role,
        bootId: randomUUID(),
      }));
      if (ownerRole) {
        if (!x?.drained || !this.runLock)
          throw Error("CONTROL_RUN_UNCONFIRMED");
        const process = this.runLock.registerRunOwner(this.processId);
        this.runLease = await this.runs.begin(
          this.runConfig,
          process,
          newMembers,
          x.readDeny() === null,
        );
      } else {
        const prior = await this.runs.observeCurrent();
        if (!prior) throw Error("CONTROL_RUN_UNCONFIRMED");
        const coordinator = {
          processId: String(prior.coordinator_process_id),
          osBootId: String(prior.coordinator_os_boot_id),
          pid: Number(prior.coordinator_pid),
          startSec: String(prior.coordinator_start_sec),
          startUsec: Number(prior.coordinator_start_usec),
        };
        if (!this.gate.verifyRunOwner(coordinator))
          throw Error("CONTROL_RUN_UNCONFIRMED");
        // The joining process identity is recorded independently of coordinator ownership.
        const process = { ...coordinator, processId: this.processId };
        this.runLease = await this.runs.join(
          this.runConfig,
          process,
          newMembers,
          String(prior.id),
        );
        if (!this.gate.verifyRunOwner(coordinator))
          throw Error("CONTROL_RUN_UNCONFIRMED");
      }
    } finally {
      x?.close();
    }
    if (ownerRole && this.runLease && !this.runLease.automatic) {
      const current = await this.repository.readCurrent();
      if (
        current.reasonCode !== "NOT_INITIALIZED" ||
        current.transitionState !== "RESUMING"
      )
        await this.trip("STARTUP_RECHECK_REQUIRED");
    }
  }

  constructor(
    readonly gate: OperationGate,
    readonly repository: MySqlSystemControlRepository,
    runs?: MySqlSystemRunRepository,
  ) {
    this.runs = runs ?? new MySqlSystemRunRepository(repository.pool);
    this.admission = new DeploymentAdmission(
      gate,
      async () => {
        const verify = async () => {
          if (!this.runLease) return;
          if (this.runLock) {
            if (
              this.runLock.identity() !==
              this.runLease.configuration.runNamespaceIdentity
            )
              throw Error("CONTROL_RUN_UNCONFIRMED");
          } else {
            const r = await this.runs.observeCurrent();
            if (
              !r ||
              r.id !== this.runLease.id ||
              !this.gate.verifyRunOwner({
                processId: String(r.coordinator_process_id),
                osBootId: String(r.coordinator_os_boot_id),
                pid: Number(r.coordinator_pid),
                startSec: String(r.coordinator_start_sec),
                startUsec: Number(r.coordinator_start_usec),
              })
            )
              throw Error("CONTROL_RUN_UNCONFIRMED");
          }
        };
        await verify();
        const snapshot = await this.runs.readAdmission(this.runLease);
        await verify();
        return snapshot;
      },
      {
        beforeMediaWrite: async () => {
          if (!this.probe) throw Error("WRITER_NOT_READY");
          await this.probe();
        },
        onFault: (reason) => this.trip(reason),
        classifyFault: (error) => {
          if (!(error instanceof Error)) return undefined;
          if (
            error.name === "CommitOutcomeUnknownError" ||
            ["DERIVATIVE_OUTCOME_UNKNOWN", "PURGE_COMMIT_UNKNOWN"].includes(
              error.message,
            ) ||
            ("code" in error && error.code === "OUTCOME_UNKNOWN")
          )
            return "COMMIT_UNKNOWN";
          return undefined;
        },
      },
    );
    this.coordinator = new ControlCoordinator<
      NonNullable<Awaited<ReturnType<MySqlSystemControlRepository["pending"]>>>
    >(
      gate,
      this.admission,
      {
        pending: () => repository.pending(),
        latch: (reason, eventId) => repository.latch(reason, eventId),
        complete: (command, proof) =>
          repository.complete(
            command,
            proof
              ? {
                  ...proof,
                  ...(this.runLease ? { runLease: this.runLease } : {}),
                }
              : null,
          ),
      },
      {
        recover: (permit) =>
          this.owner?.recover(permit) ?? Promise.resolve("NOT_READY" as const),
      },
    );
  }
  public(startupWritable: boolean): DeploymentControl {
    return {
      repository: this.repository,
      gate: this.gate,
      admission: this.admission,
      startupWritable,
      locallyDenied: () =>
        this.admission.isLocallyDenied() ||
        !this.activeConfirmed ||
        this.stopped,
      bindOwner: (owner) => {
        this.owner = owner;
        this.probe = () => owner.health();
      },
      bindHealth: (probe) => {
        this.probe = probe;
      },
      start: (participants) => this.start(participants),
      stop: () => this.stop(),
      drain: () => this.drain(),
      beginShutdown: () => this.beginShutdown(),
      resourcesClosed: (successful) => this.resourcesClosed(successful),
      onStopping: (callback) => {
        this.stoppingCallback = callback;
      },
      trip: (reason) => this.trip(reason),
      track: (role, operation, completed) =>
        this.track(role, operation, completed),
    };
  }
  async trip(reason: string) {
    if (this.lastFault === reason && this.admission.isLocallyDenied()) return;
    this.admission.denyLocally();
    this.lastFault = reason;
    try {
      await this.coordinator.trip(reason);
      if (this.runLease) await this.runs.requireRecovery(this.runLease);
    } catch (error) {
      this.lastFault = undefined;
      throw error;
    }
  }
  /** A fresh process observes shared protection, not its own failed unit.
   * Keep the marker/run fence and synchronize monotone DB protection; actual
   * local health/transaction faults still go through trip and stay denied. */
  async syncStartupMarker(reason: string) {
    await this.repository.latch(reason, randomUUID());
    if (this.runLease) await this.runs.requireRecovery(this.runLease);
  }
  private async track<T>(
    role: RuntimeRole,
    operation: () => Promise<T>,
    completed: (result: T) => boolean = (result) =>
      result !== false && result !== undefined,
  ): Promise<T> {
    const p = this.participants.find((p) => p.role === role && !p.superseded);
    if (p) p.running++;
    try {
      const result = await operation();
      if (p && completed(result)) p.completed++;
      return result;
    } finally {
      if (p) p.running--;
    }
  }
  private async start(
    participants: readonly { role: RuntimeRole; ready(): boolean }[],
  ) {
    if (this.timer || this.controlTimer || this.stopped)
      throw Error("CONTROL_RUNTIME_ALREADY_STARTED");
    if (
      !participants.length ||
      new Set(participants.map((p) => p.role)).size !== participants.length
    )
      throw Error("CONTROL_PARTICIPANT_CONFIG_INVALID");
    if (!this.runConfig) await this.prepare(participants.map((p) => p.role));
    if (!this.runLease) {
      // The trusted bootstrap may have bound the namespace after prepare.
      const roles = this.declaredRoles;
      this.runConfig = undefined;
      await this.prepare(roles);
    }
    if (!this.runLease) throw Error("CONTROL_RUN_UNCONFIRMED");
    if (
      participants
        .map((p) => p.role)
        .sort()
        .join(",") !== [...this.declaredRoles].sort().join(",")
    )
      throw Error("CONTROL_PARTICIPANT_CONFIG_INVALID");
    for (const p of participants) {
      const row = {
        ...p,
        boot: this.runLease.members.find((m) => m.role === p.role)!.bootId,
        superseded: false,
        running: 0,
        completed: 0n,
        reported: 0n,
      };
      this.participants.push(row);
    }
    if (participants.every((p) => p.ready()))
      await this.runs.ready(this.runLease);
    await this.pulse();
    this.controlTimer = setInterval(() => {
      if (this.controlWork || this.stopped || !this.owner?.ready()) return;
      const work = this.coordinate();
      this.controlWork = work;
      void work
        .finally(() => {
          if (this.controlWork === work) this.controlWork = undefined;
        })
        .catch(() => {});
    }, 1000);
    (this.controlTimer as unknown as NodeJS.Timeout).unref();
  }
  private async pulse() {
    const work = (async () => {
      const current = await this.repository.readCurrent();
      if (this.runLease)
        this.activeConfirmed =
          (await this.runs.phase(this.runLease)) === "ACTIVE";
      if (
        this.runLease &&
        (await this.runs.phase(this.runLease)) === "STOPPING"
      ) {
        this.admission.revoke();
        this.stoppingCallback?.();
      }
      if (
        this.runLease &&
        this.participants.every((p) => p.ready()) &&
        ["PREPARING", "RECOVERY_REQUIRED"].includes(
          await this.runs.phase(this.runLease),
        )
      ) {
        try {
          await this.runs.ready(this.runLease);
        } catch (error) {
          // A queued heartbeat can observe recovery before STOPPING commits.
          // READY still refuses that phase; only an authoritative observation
          // of this exact run turns the rejected duplicate into normal drain.
          if (
            !(error instanceof SystemControlError) ||
            error.reason !== "CONTROL_UNAVAILABLE" ||
            (await this.runs.phase(this.runLease)) !== "STOPPING"
          )
            throw error;
          this.admission.revoke();
          this.stoppingCallback?.();
          return;
        }
      }
      // Reopening/draining is intentional unavailability, not a new fault.
      if (this.probe && !this.owner?.changing()) {
        try {
          await this.probe();
        } catch (error) {
          // Failed replacement has already closed the old resource set. An
          // existing protected run must be able to perform a new authorized
          // fresh RECHECK without its empty slot cancelling that recovery.
          // This grants no admission and never clears local/native/DB deny.
          const protectedEmptyOwner =
            error instanceof Error &&
            error.message === "OWNER_NOT_READY" &&
            current.faultLatched &&
            current.enforcedMode !== "NORMAL" &&
            ["RECOVERY_REQUIRED", "RESUMING"].includes(
              current.transitionState,
            ) &&
            this.runLease !== undefined &&
            (await this.runs.phase(this.runLease)) === "RECOVERY_REQUIRED";
          if (!protectedEmptyOwner) {
            reportControlFailure("storage_health_unavailable", error);
            await this.trip("STORAGE_UNAVAILABLE");
          }
        }
      }
      const writable =
        current.enforcedMode === "NORMAL" &&
        current.transitionState === "STABLE" &&
        !current.faultLatched &&
        !this.admission.isLocallyDenied() &&
        this.activeConfirmed;
      for (const p of this.participants) {
        if (p.superseded) continue;
        const participantReady =
          p.ready() &&
          (this.owner !== undefined || !this.admission.isLocallyDenied());
        const state = participantReady
          ? p.running > 0
            ? "RUNNING"
            : writable
              ? "IDLE"
              : "PAUSED"
          : "STARTING";
        const completed = p.completed;
        p.superseded = !(await this.repository.runtimeBeat(p.role, p.boot, {
          revision: current.revision,
          state,
          reasonCode: state === "RUNNING" ? "NONE" : state,
          success: completed > p.reported,
          completedUnits: completed.toString(),
        }));
        if (!p.superseded) p.reported = completed;
        if (p.superseded) await this.trip("WRITER_NOT_READY");
      }
    })();
    this.pulseWork = work;
    try {
      await work;
    } catch (error) {
      reportControlFailure("control_observation_unavailable", error);
      try {
        await this.trip("DB_UNAVAILABLE");
      } catch {
        /* deny persists */
      }
    } finally {
      if (this.pulseWork === work) this.pulseWork = undefined;
      if (!this.stopped) {
        this.timer = setTimeout(() => {
          void this.pulse();
        }, 5000);
        (this.timer as unknown as NodeJS.Timeout).unref();
      }
    }
  }
  private async coordinate() {
    try {
      if (
        this.runLease?.automatic &&
        !this.admission.isLocallyDenied() &&
        (await this.repository.readCurrent()).transitionState === "STABLE" &&
        (await this.runs.phase(this.runLease)) === "PREPARING"
      ) {
        const x = await this.gate.acquire("X", 0);
        try {
          if (
            !x.drained ||
            x.readDeny() !== null ||
            this.admission.isLocallyDenied() ||
            !this.owner ||
            !("confirmFresh" in this.owner)
          )
            throw Error("CONTROL_RUN_UNCONFIRMED");
          await (
            this.owner as unknown as { confirmFresh(): Promise<void> }
          ).confirmFresh();
          await this.runs.activateAutomatic(this.runLease);
        } finally {
          x.close();
        }
      } else await this.coordinator.tick();
      if (Date.now() - this.lastGc < 5000 || this.owner?.changing()) return;
      this.lastGc = Date.now();
      // Namespace maintenance only; no media recovery under a raw kernel X.
      const x = await this.gate.acquire("X", 0);
      try {
        x.recoverBridges();
      } finally {
        x.close();
      }
    } catch (error) {
      if (error instanceof Error && error.message === "OPERATION_GATE_BUSY")
        return;
      reportControlFailure("control_owner_unavailable", error);
      try {
        await this.trip("RECOVERY_FAILED");
      } catch {
        /* local/native deny persists */
      }
    }
  }
  private beginShutdown(): Promise<void> {
    this.admission.revoke();
    if (this.shutdownWork) return this.shutdownWork;
    this.shutdownWork = (async () => {
      if (!this.runLease) return;
      const existing = await this.runs.observeCurrent();
      this.shutdownOperationId ??=
        existing?.id === this.runLease.id && existing.phase === "STOPPING"
          ? String(existing.shutdown_operation_id)
          : randomUUID();
      await this.runs.stopping(this.runLease, this.shutdownOperationId);
    })();
    return this.shutdownWork;
  }
  private async resourcesClosed(successful: boolean) {
    this.admission.revoke();
    try {
      if (
        !successful ||
        !this.stopped ||
        !this.runLease ||
        this.admission.isLocallyDenied()
      )
        return;
      await this.runs.acknowledge(this.runLease, randomUUID());
      if (this.runLock) {
        // A missing member never becomes terminal merely because time elapsed.
        for (let attempt = 0; attempt < 40; attempt++) {
          try {
            const x = await this.gate.acquire("X", 0);
            try {
              if (
                x.drained &&
                x.readDeny() === null &&
                (await this.runs.clean(this.runLease))
              )
                return;
            } finally {
              x.close();
            }
          } catch (error) {
            // An existing S unit is still settling. Keep the original R owner
            // through the bounded drain wait; no CLEAN is inferred from BUSY.
            if (
              !(error instanceof Error) ||
              error.message !== "OPERATION_GATE_BUSY"
            )
              throw error;
          }
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      }
    } finally {
      this.runLock?.close();
      this.runLock = undefined;
    }
  }
  private stop() {
    this.stopped = true;
    this.coordinator.stop();
    if (this.timer) clearTimeout(this.timer);
    if (this.controlTimer) clearInterval(this.controlTimer);
  }
  private async drain() {
    this.stop();
    const drained = await Promise.allSettled([
      this.pulseWork,
      this.controlWork,
      this.coordinator.drain(),
    ]);
    // A stopping callback can launch this record while pulse is settling.
    // Observe it only after joining pulse/control, before terminal observation.
    const shutdown = await Promise.allSettled([this.shutdownWork]);
    if ([...drained, ...shutdown].some((r) => r.status === "rejected"))
      throw Error("CONTROL_DRAIN_UNCERTAIN");
    const current = await this.repository.readCurrent();
    for (const p of this.participants)
      if (!p.superseded)
        await this.repository.runtimeBeat(p.role, p.boot, {
          revision: current.revision,
          state: "STOPPED",
          reasonCode: "STOPPED",
          success: p.completed > p.reported,
          completedUnits: p.completed.toString(),
        });
  }
}
