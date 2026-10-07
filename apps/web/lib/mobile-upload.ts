import {
  ClientFault,
  ContentSha256,
  apiPath,
  checked,
  type ClientJob,
} from "@family-album/contracts";
const name = "family-album-upload-v1";
export async function queueDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const r = indexedDB.open(name, 1);
    r.onupgradeneeded = () => {
      r.result.createObjectStore("jobs", { keyPath: "operationId" });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(new ClientFault(0, "PERSISTENCE_UNAVAILABLE"));
    r.onblocked = () => reject(new ClientFault(0, "PERSISTENCE_BLOCKED"));
  });
}
export async function savedJobs(scope: string) {
  const db = await queueDatabase();
  try {
    return await new Promise<ClientJob[]>((resolve, reject) => {
      const tx = db.transaction("jobs", "readonly");
      const r = tx.objectStore("jobs").getAll();
      r.onsuccess = () =>
        resolve((r.result as ClientJob[]).filter((j) => j.scope === scope));
      r.onerror = () => reject(new ClientFault(0, "PERSISTENCE_UNAVAILABLE"));
    });
  } finally {
    db.close();
  }
}
export async function persistJob(job: ClientJob | null, id?: string) {
  const db = await queueDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("jobs", "readwrite");
      if (job) tx.objectStore("jobs").put(job);
      else tx.objectStore("jobs").delete(id!);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(new ClientFault(0, "PERSISTENCE_UNAVAILABLE"));
      tx.onabort = () => reject(new ClientFault(0, "PERSISTENCE_UNAVAILABLE"));
    });
  } finally {
    db.close();
  }
  if (job?.stage === "DONE") {
    const done = (await savedJobs(job.scope))
      .filter((j) => j.stage === "DONE")
      .sort((a, b) => b.nextAttempt - a.nextAttempt);
    for (const old of done.slice(100)) await persistJob(null, old.operationId);
  }
}
export async function digestFile(file: Blob, active = () => true) {
  const hash = new ContentSha256();
  for (let start = 0; start < file.size; start += 1024 * 1024) {
    if (!active()) throw new ClientFault(0, "STALE");
    hash.update(
      new Uint8Array(
        await file.slice(start, start + 1024 * 1024).arrayBuffer(),
      ),
    );
    await new Promise<void>((r) => setTimeout(r, 0));
  }
  return hash.hex();
}
export async function webUploadRequest(
  path: string,
  init: RequestInit = {},
  signal?: AbortSignal,
) {
  apiPath(path);
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    redirect: "error",
    cache: "no-store",
    ...(signal ? { signal } : {}),
    headers: {
      ...Object.fromEntries(new Headers(init.headers)),
      "cache-control": "no-store",
    },
  });
  if (response.status === 401) {
    window.dispatchEvent(new Event("family-auth-lost"));
    throw new ClientFault(401, "AUTH");
  }
  if ([404, 409].includes(response.status)) return response;
  return checked(response);
}
