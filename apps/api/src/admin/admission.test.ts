import { issueRunAdmissionProof } from "@family-album/contracts/internal/run-admission";
import Fastify from "fastify";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  DeploymentAdmission,
  OperationGate,
  denyControlAdmission,
} from "@family-album/storage";
import { installControlAdmission } from "./admission.js";

describe("Phase11 complete HTTP mutation units", () => {
  it("denies new and unknown write routes when no deployment admission is supplied", async () => {
    const app = Fastify(),
      handler = vi.fn(async () => ({ changed: true }));
    installControlAdmission(app, denyControlAdmission);
    app.post("/api/v1/future-mutation", handler);
    try {
      const r = await app.inject({
        method: "POST",
        url: "/api/v1/future-mutation",
      });
      expect(r.statusCode).toBe(503);
      expect(handler).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it("holds real native S until the whole handler settles, independently of response publication", async () => {
    const path = mkdtempSync(
      join(realpathSync(tmpdir()), "phase11-http-admission-"),
    );
    const namespace = { path, deploymentId: randomUUID() },
      gate = OperationGate.provisionDev(namespace);
    const proof = await gate.acquire("S", 0),
      namespaceIdentity = proof.identity();
    proof.close();
    const admission = new DeploymentAdmission(gate, async () => ({
      runProof: issueRunAdmissionProof({
        runId: randomUUID(),
        epoch: "1",
        processId: randomUUID(),
      }),
      deploymentId: namespace.deploymentId,
      namespaceIdentity,
      requestedMode: "NORMAL",
      enforcedMode: "NORMAL",
      transitionState: "STABLE",
      revision: "1",
      healthGeneration: "1",
      faultLatched: false,
    }));
    const app = Fastify();
    installControlAdmission(app, admission);
    let started!: () => void, finish!: () => void;
    const entered = new Promise<void>((r) => {
        started = r;
      }),
      settled = new Promise<void>((r) => {
        finish = r;
      });
    app.post("/api/v1/future-mutation", async (_request, reply) => {
      started();
      reply.send({ accepted: true });
      await settled;
    });
    try {
      const response = app.inject({
        method: "POST",
        url: "/api/v1/future-mutation",
      });
      await entered;
      await expect(gate.acquire("X", 0)).rejects.toThrow("OPERATION_GATE_BUSY");
      finish();
      await response;
      const x = await gate.acquire("X", 1000);
      x.close();
    } finally {
      finish?.();
      await app.close();
      rmSync(path, { recursive: true, force: true });
    }
  });
  it("classifies only a validated disable request as the maintenance revoke exception", async () => {
    const calls: string[] = [],
      app = Fastify();
    installControlAdmission(app, {
      run: async (action, run) => {
        calls.push(action);
        return run();
      },
    });
    app.patch("/api/v1/families/:familyId/members/:memberId", async () => ({
      ok: true,
    }));
    try {
      for (const payload of [
        { disabled: true },
        { disabled: false },
        { role: "ADMIN" },
        { disabled: true, force: true },
      ])
        await app.inject({
          method: "PATCH",
          url: "/api/v1/families/1/members/2",
          payload,
        });
      expect(calls).toEqual([
        "MEMBER_REVOKE",
        "MEMBER_INCREASE",
        "MEMBER_INCREASE",
        "MEMBER_INCREASE",
      ]);
    } finally {
      await app.close();
    }
  });
});
