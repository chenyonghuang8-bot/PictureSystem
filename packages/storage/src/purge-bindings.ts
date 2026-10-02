// Internal orchestration only. These bindings are not exported by the package.
const roots = new WeakMap<object, object>();
const stores = new WeakMap<object, object>();
export function bindPurgeRoot(owner: object, handle: object) {
  roots.set(owner, handle);
}
export function bindPurgeStore(owner: object, handle: object) {
  stores.set(owner, handle);
}
export function purgeBindings(root: object, store: object) {
  const original = roots.get(root),
    derived = stores.get(store);
  if (!original || !derived) throw new Error("PURGE_WRITER_REQUIRED");
  return { original, derived };
}
