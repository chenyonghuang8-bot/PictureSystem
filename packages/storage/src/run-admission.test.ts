import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import { issueRunAdmissionProof } from "@family-album/contracts/internal/run-admission";
import { OperationGate } from "./operation-gate.js";
import { DeploymentAdmission } from "./control-admission.js";
describe("R1 run admission capability", () => {
  it("defaults to deny old NORMAL, rejects JSON proof and irreversibly revokes even an issued boot", async () => {
    const path = mkdtempSync(
      join(realpathSync(tmpdir()), "phase11-r1-admission-"),
    );
    const gate = OperationGate.provisionDev({
      path,
      deploymentId: randomUUID(),
    });
    const s = await gate.acquire("S", 0);
    const identity = s.identity();
    s.close();
    const current = {
      deploymentId: gate.namespace.deploymentId,
      namespaceIdentity: identity,
      requestedMode: "NORMAL" as const,
      enforcedMode: "NORMAL" as const,
      transitionState: "STABLE" as const,
      revision: "1",
      healthGeneration: "1",
      faultLatched: false,
    };
    try {
      let calls = 0;
      const work = async () => ++calls;
      const absent = new DeploymentAdmission(gate, async () => current);
      await expect(absent.run("MEDIA_WRITE", work)).rejects.toThrow(
        "WRITE_PAUSED",
      );
      const proof = issueRunAdmissionProof({
        runId: randomUUID(),
        epoch: "1",
        processId: randomUUID(),
      });
      const forged = new DeploymentAdmission(gate, async () => ({
        ...current,
        runProof: JSON.parse(JSON.stringify(proof)),
      }));
      await expect(forged.run("MEDIA_WRITE", work)).rejects.toThrow(
        "WRITE_PAUSED",
      );
      expect(calls).toBe(0);
      const live = new DeploymentAdmission(gate, async () => ({
        ...current,
        runProof: proof,
      }));
      expect(await live.run("MEDIA_WRITE", work)).toBe(1);
      live.revoke();
      await expect(live.run("MEDIA_WRITE", work)).rejects.toThrow(
        "WRITE_PAUSED",
      );
      await expect(live.run("INVITATION_CREATE", work)).rejects.toThrow(
        "WRITE_PAUSED",
      );
      expect(calls).toBe(1);
      expect(await absent.run("MEMBER_REVOKE", async () => "revoked")).toBe(
        "revoked",
      );
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  });
});
