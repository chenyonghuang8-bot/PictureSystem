import { describe, it, expect } from "vitest";
import { ContentSha256 } from "./content-sha256.js";
import {
  invitationToken,
  offsetFrom,
  queueFailure,
  uploadStep,
  ClientFault,
  type ClientJob,
} from "./client-upload.js";
const job = (): ClientJob => ({
  operationId: "00000000-0000-4000-8000-000000000001",
  scope: "https://api.test|7|8",
  name: "原图.jpg",
  mime: "image/jpeg",
  size: 4,
  digest: "a".repeat(64),
  source: "private.source",
  originalTargets: ["1"],
  targets: ["1"],
  offset: 0,
  stage: "WAITING",
  failures: 0,
  nextAttempt: 0,
});
const status = {
  uploadId: "a".repeat(32),
  state: "UPLOADING",
  declaredSize: "4",
  committedOffset: "2",
  expiresAt: "2027-01-01T00:00:00.000Z",
  completedAt: null,
  failureCode: null,
};
const result = {
  uploadId: "a".repeat(32),
  state: "UPLOADING",
  declaredSize: "4",
  committedOffset: "2",
  processing: "PENDING",
  placement: "PENDING",
  retryable: true,
};
const json = (x: unknown) => Response.json(x);
describe("Phase10 client durability and authority", () => {
  for (const size of [0, 3, 55, 56, 63, 64, 65, 4097, 1000000])
    it(`matches independent SHA256 reference with split input ${size}`, () => {
      const b = new Uint8Array(size).fill(0x61),
        h = new ContentSha256();
      for (let i = 0; i < size; i += 37) h.update(b.subarray(i, i + 37));
      expect(h.hex()).toBe(
        (
          {
            "0": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            "3": "9834876dcfb05cb167a5c24953eba58c4ac89b1adf57f28f2f9d09af107ee8f0",
            "55": "9f4390f8d30c2dd92ec9f095b65e2b9ae9b0a925a5258e241c9f1e910f734318",
            "56": "b35439a4ac6f0948b6d6f9e3c6af0f5f590ce20f1bde7090ef7970686ec6738a",
            "63": "7d3e74a05d7db15bce4ad9ec0658ea98e3f06eeecf16b4c6fff2da457ddc2f34",
            "64": "ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb",
            "65": "635361c48bb9eab14198e76ea8ab7f1a41685d6ad62aa9146d301d4f17eb0ae0",
            "4097":
              "4e369b5618643c3abddd027b650bfa54810be3b418028a7c9d82299a59d008e8",
            "1000000":
              "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0",
          } as Record<string, string>
        )[String(size)],
      );
    });
  it("strictly accepts one canonical invitation without percent/token navigation", () => {
    const t = "A".repeat(43);
    expect(invitationToken(`familyalbum://invite?token=${t}`)).toBe(t);
    for (const u of [
      `familyalbum://invite?token=${"A".repeat(42)}B`,
      `familyalbum://invite/?token=${t}`,
      `familyalbum://invite?token=${t}&x=1`,
      `familyalbum://invite?token=${t}#a`,
      `familyalbum://invite?token=${t}&token=${t}`,
      `familyalbum://user@invite?token=${t}`,
      `familyalbum://invite?token=%41${t.slice(1)}`,
      `https://invite?token=${t}`,
    ])
      expect(invitationToken(u)).toBeNull();
  });
  it("lost create is observed by same durable UUID before any recreate", async () => {
    const j = job();
    const calls: string[] = [];
    let attempt = 0;
    const io = {
      active: () => true,
      save: async () => {},
      read: async () => new Uint8Array([1, 2]),
      request: async (p: string, init?: RequestInit) => {
        calls.push((init?.method ?? "GET") + p);
        if (p.includes("operations"))
          return attempt ? json(status) : new Response(null, { status: 404 });
        if (p.endsWith("/tus")) {
          attempt++;
          throw new Error("TCP_RESPONSE_LOST");
        }
        if (p.endsWith("result")) return json(result);
        if (init?.method === "HEAD")
          return new Response(null, { headers: { "upload-offset": "2" } });
        return new Response(null, {
          status: 204,
          headers: { "upload-offset": "4" },
        });
      },
    };
    await expect(uploadStep(j, io)).rejects.toThrow("TCP_RESPONSE_LOST");
    await uploadStep(j, io);
    expect(calls.filter((x) => x.startsWith("POST"))).toHaveLength(1);
    expect(j.uploadId).toBe(status.uploadId);
    expect(j.offset).toBe(4);
  });
  it("lost PATCH is re-HEADed and never repeats committed bytes", async () => {
    const j = job();
    j.uploadId = status.uploadId;
    let offset = 2,
      patches = 0;
    const io = {
      active: () => true,
      save: async () => {},
      read: async (start: number) => {
        expect(start).toBe(2);
        return new Uint8Array([3, 4]);
      },
      request: async (p: string, i?: RequestInit) => {
        if (p.endsWith("result"))
          return json({ ...result, committedOffset: String(offset) });
        if (i?.method === "HEAD")
          return new Response(null, {
            headers: { "upload-offset": String(offset) },
          });
        if (i?.method === "PATCH") {
          patches++;
          offset = 4;
          throw new Error("LOST");
        }
        return json({});
      },
    };
    await expect(uploadStep(j, io)).rejects.toThrow("LOST");
    await uploadStep(j, io);
    expect(patches).toBe(1);
    expect(j.stage).toBe("PROCESSING");
  });
  it("APPLIED without current identity requires action and never places again", async () => {
    const j = job();
    j.uploadId = status.uploadId;
    let posts = 0;
    await uploadStep(j, {
      active: () => true,
      save: async () => {},
      read: async () => {
        throw new Error();
      },
      request: async (_, i) => {
        if (i?.method === "POST") posts++;
        return json({
          ...result,
          state: "COMPLETE",
          processing: "READY",
          placement: "APPLIED",
        });
      },
    });
    expect(j.stage).toBe("NEEDS_ACTION");
    expect(posts).toBe(0);
  });
  it("401 pauses account, retries bounded and offsets cannot exceed size", () => {
    const j = job();
    queueFailure(j, new ClientFault(401));
    expect(j.stage).toBe("PAUSED_AUTH");
    for (let i = 0; i < 8; i++) queueFailure(j, new ClientFault(503));
    expect(j.stage).toBe("NEEDS_ACTION");
    expect(() =>
      offsetFrom(
        new Response(null, {
          headers: { "upload-offset": "9007199254740993" },
        }),
        4,
      ),
    ).toThrow("OFFSET_INVALID");
  });
  it("suspended epoch cannot dispatch after durable save", async () => {
    const j = job();
    let active = true,
      calls = 0;
    await expect(
      uploadStep(j, {
        active: () => active,
        save: async () => {
          active = false;
        },
        read: async () => new Uint8Array(),
        request: async () => {
          calls++;
          return json({});
        },
      }),
    ).rejects.toThrow("SUSPENDED");
    expect(calls).toBe(0);
  });
  it("account switch during result body cannot dispatch a subsequent HEAD", async () => {
    const j = job();
    j.uploadId = status.uploadId;
    let active = true,
      calls = 0;
    await expect(
      uploadStep(j, {
        active: () => active,
        save: async () => {},
        read: async () => new Uint8Array(),
        request: async () => {
          calls++;
          const r = json(result);
          r.json = async () => {
            active = false;
            return result;
          };
          return r;
        },
      }),
    ).rejects.toThrow("SUSPENDED");
    expect(calls).toBe(1);
  });
  it.each([true, false])(
    "canonical creation UNAVAILABLE retryable=%s respects server contract without placing",
    async (retryable) => {
      const j = job();
      j.uploadId = status.uploadId;
      let mutations = 0;
      await uploadStep(j, {
        active: () => true,
        save: async () => {},
        read: async () => new Uint8Array(),
        request: async (_p, i) => {
          if (i?.method) mutations++;
          return json({
            ...result,
            state: "COMPLETE",
            processing: "UNAVAILABLE",
            placement: "PENDING",
            retryable,
          });
        },
      });
      expect(j.stage).toBe(retryable ? "PROCESSING" : "NEEDS_ACTION");
      expect(mutations).toBe(0);
    },
  );
  it("unavailable historical APPLIED identity never polls into re-placement", async () => {
    const j = job();
    j.uploadId = status.uploadId;
    await uploadStep(j, {
      active: () => true,
      save: async () => {},
      read: async () => new Uint8Array(),
      request: async () =>
        json({
          ...result,
          state: "COMPLETE",
          processing: "UNAVAILABLE",
          placement: "APPLIED",
          retryable: true,
        }),
    });
    expect(j.stage).toBe("NEEDS_ACTION");
  });
});
