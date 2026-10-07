import { fetch as nativeFetch } from "expo/fetch";
import * as SecureStore from "expo-secure-store";
import { File, Paths } from "expo-file-system";
import {
  androidSessionResponseSchema,
  meResponseSchema,
  ClientFault,
  apiPath,
  checked,
  type MeResponse,
} from "@family-album/contracts";

const configured =
  process.env.EXPO_PUBLIC_API_ORIGIN ?? "https://10.0.2.2:3443";
const url = new URL(configured);
if (
  url.protocol !== "https:" ||
  url.origin !== configured ||
  url.username ||
  url.password
)
  throw new Error("API_ORIGIN_INVALID");
export const API_ORIGIN = url.origin;
const key = "family.album.session.v1";
// Non-secret durable deny marker: tokens remain exclusively in SecureStore.
// A crash or failed delete cannot make a revoked/pending credential restorable.
const denied = new File(Paths.document, "session-invalidated.v1");
let storageTail: Promise<unknown> = Promise.resolve();
function orderedStorage<T>(work: () => Promise<T>): Promise<T> {
  const next = storageTail.then(work, work);
  storageTail = next.catch(() => {});
  return next;
}
function denyRestore() {
  if (!denied.exists) denied.create();
  denied.write("denied");
}
function clearCredential() {
  denyRestore();
  return orderedStorage(() => SecureStore.deleteItemAsync(key));
}
async function persistCredential(record: unknown, epoch: number) {
  return orderedStorage(async () => {
    if (epoch !== state.epoch) throw new ClientFault(0, "STALE");
    denyRestore();
    await SecureStore.setItemAsync(key, JSON.stringify(record));
    if (epoch !== state.epoch) {
      await SecureStore.deleteItemAsync(key).catch(() => {});
      throw new ClientFault(0, "STALE");
    }
    denied.delete();
  });
}
export type SessionState = {
  me: MeResponse | null;
  familyId: string | null;
  ready: boolean;
  epoch: number;
};
let token: string | null = null;
let state: SessionState = { me: null, familyId: null, ready: false, epoch: 0 };
const listeners = new Set<() => void>();
const requests = new Set<AbortController>();
let rotation = false;
let foreground = true;
function emit() {
  for (const f of listeners) f();
}
function invalidate() {
  for (const c of requests) c.abort();
  requests.clear();
  state = { ...state, me: null, epoch: state.epoch + 1 };
  emit();
}
export const session = {
  get: () => state,
  subscribe: (f: () => void) => {
    listeners.add(f);
    return () => {
      listeners.delete(f);
    };
  },
  scope: () =>
    state.me && state.familyId
      ? `${API_ORIGIN}|${state.me.user.id}|${state.familyId}`
      : null,
  active: () => foreground && !!state.me && !rotation,
  selectFamily(id: string) {
    if (!state.me?.memberships.some((m) => m.familyId === id)) return;
    for (const c of requests) c.abort();
    state = { ...state, familyId: id, epoch: state.epoch + 1 };
    emit();
  },
  async restore() {
    invalidate();
    const restoreEpoch = state.epoch;
    token = null;
    state = { ...state, ready: false };
    emit();
    try {
      const saved = await orderedStorage(async () => {
        if (denied.exists) {
          await SecureStore.deleteItemAsync(key).catch(() => {});
          return null;
        }
        return SecureStore.getItemAsync(key);
      });
      if (restoreEpoch !== state.epoch) return;
      if (saved) {
        const record = androidSessionResponseSchema.parse(JSON.parse(saved));
        token = record.token;
        await session.validate();
      }
    } catch {
      if (restoreEpoch === state.epoch) {
        token = null;
        await clearCredential().catch(() => {});
      }
    } finally {
      if (restoreEpoch === state.epoch) {
        state = { ...state, ready: true };
        emit();
      }
    }
  },
  async validate() {
    const epoch = state.epoch;
    const me = meResponseSchema.parse(
      await (await request("/api/v1/auth/me")).json(),
    );
    if (epoch !== state.epoch) throw new ClientFault(0, "STALE");
    state = {
      ...state,
      me,
      familyId: me.memberships.some((m) => m.familyId === state.familyId)
        ? state.familyId
        : (me.memberships[0]?.familyId ?? null),
      ready: true,
    };
    emit();
  },
  async login(username: string, password: string) {
    if (rotation) throw new ClientFault(0, "BUSY");
    rotation = true;
    invalidate();
    const loginEpoch = state.epoch;
    state = { ...state, ready: false };
    emit();
    token = null;
    try {
      const record = androidSessionResponseSchema.parse(
        await (
          await request(
            "/api/v1/auth/android/login",
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                username,
                password,
                deviceLabel: "Android",
              }),
            },
            true,
          )
        ).json(),
      );
      if (loginEpoch !== state.epoch) throw new ClientFault(0, "STALE");
      await persistCredential(record, loginEpoch);
      if (loginEpoch !== state.epoch) throw new ClientFault(0, "STALE");
      token = record.token;
      rotation = false;
      await session.validate();
    } catch {
      if (loginEpoch === state.epoch) await session.logout(false);
      throw new ClientFault(0, "LOGIN_FAILED");
    } finally {
      rotation = false;
    }
  },
  async rotate(
    password: string,
    currentPassword?: string,
    newPassword?: string,
  ) {
    if (rotation) throw new ClientFault(0, "BUSY");
    rotation = true;
    invalidate();
    const rotateEpoch = state.epoch;
    state = { ...state, ready: false };
    emit();
    try {
      const response = await request(
        `/api/v1/auth/android/${currentPassword === undefined ? "reauth" : "password"}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(
            currentPassword === undefined
              ? { password }
              : { currentPassword, newPassword },
          ),
        },
      );
      const record = androidSessionResponseSchema.parse(await response.json());
      if (rotateEpoch !== state.epoch) throw new ClientFault(0, "STALE");
      await persistCredential(record, rotateEpoch);
      if (rotateEpoch !== state.epoch) throw new ClientFault(0, "STALE");
      token = record.token;
      rotation = false;
      await session.validate();
    } catch {
      if (rotateEpoch === state.epoch) await session.logout(false);
      throw new ClientFault(0, "LOGIN_REQUIRED");
    } finally {
      rotation = false;
    }
  },
  async logout(remote = true) {
    const old = token;
    token = null;
    invalidate();
    state = { ...state, familyId: null, ready: true };
    emit();
    try {
      await clearCredential();
    } finally {
      if (remote && old)
        await request(
          "/api/v1/auth/android/logout",
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${old}`,
            },
            body: "{}",
          },
          true,
        ).catch(() => {});
    }
  },
  async foreground(active: boolean) {
    if (active === foreground) return;
    foreground = active;
    invalidate();
    const foregroundEpoch = state.epoch;
    state = { ...state, ready: !token };
    emit();
    if (active && !token) {
      await session.restore();
      return;
    }
    if (active && token) {
      try {
        await session.validate();
      } catch {
        if (foregroundEpoch !== state.epoch) return;
        token = null;
        await clearCredential().catch(() => {});
        state = { ...state, ready: true };
        emit();
      }
    }
  },
};
export async function request(
  path: string,
  init: RequestInit = {},
  anonymous = false,
) {
  apiPath(path);
  if (!anonymous && !token) throw new ClientFault(401, "AUTH");
  const epoch = state.epoch;
  const controller = new AbortController();
  requests.add(controller);
  const timeout = setTimeout(() => controller.abort(), 30000);
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  headers.set("cache-control", "no-store");
  if (!anonymous) {
    if (!token) throw new ClientFault(401, "AUTH");
    headers.set("authorization", `Bearer ${token}`);
  }
  const cleanup = () => {
    clearTimeout(timeout);
    requests.delete(controller);
  };
  try {
    const response = await nativeFetch(API_ORIGIN + path, {
      ...init,
      headers,
      credentials: "omit",
      redirect: "error",
      signal: controller.signal,
    });
    if (epoch !== state.epoch) throw new ClientFault(0, "STALE");
    if (response.status === 401 && !anonymous) {
      token = null;
      invalidate();
      state = { ...state, ready: true };
      emit();
      await clearCredential().catch(() => {});
    }
    if (
      response.status === 409 &&
      path.startsWith("/api/v1/families/") &&
      path.includes("/memories")
    )
      throw new ClientFault(409, "MEMORIES_ANCHOR_EXPIRED");
    await checked(response);
    if (!response.body || response.status === 204 || init.method === "HEAD") {
      cleanup();
      return response;
    }
    const reader = response.body.getReader();
    const stream = new ReadableStream<Uint8Array>(
      {
        async pull(c) {
          try {
            const part = await reader.read();
            if (epoch !== state.epoch) throw new ClientFault(0, "STALE");
            if (part.done) {
              cleanup();
              c.close();
            } else c.enqueue(part.value);
          } catch (e) {
            cleanup();
            c.error(e);
          }
        },
        cancel() {
          cleanup();
          controller.abort();
          return reader.cancel();
        },
      },
      { highWaterMark: 0 },
    );
    const readJson = async () => {
      const r = stream.getReader();
      let bytes = 0;
      const parts: Uint8Array[] = [];
      try {
        while (true) {
          const p = await r.read();
          if (p.done) break;
          bytes += p.value.length;
          if (bytes > 4 * 1024 ** 2) {
            await r.cancel();
            throw new ClientFault(400, "RESPONSE_LIMIT");
          }
          parts.push(p.value);
        }
        const buffer = new Uint8Array(bytes);
        let at = 0;
        for (const p of parts) {
          buffer.set(p, at);
          at += p.length;
        }
        if (epoch !== state.epoch) throw new ClientFault(0, "STALE");
        return JSON.parse(new TextDecoder().decode(buffer));
      } finally {
        cleanup();
        r.releaseLock();
      }
    };
    return new Proxy(response, {
      get(target, key) {
        if (key === "body") return stream;
        if (key === "json") return readJson;
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  } catch (error) {
    cleanup();
    controller.abort();
    throw error;
  }
}
// Queue observation needs uniform owner 404 without exposing arbitrary errors.
export async function queueRequest(path: string, init?: RequestInit) {
  try {
    return await request(path, init);
  } catch (e) {
    if (e instanceof ClientFault && [404, 409].includes(e.status))
      return new Response(null, { status: e.status });
    throw e;
  }
}
