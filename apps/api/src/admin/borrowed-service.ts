import type { VersionedOwner } from "@family-album/storage";

/** Fixed public async methods only. The original receiver is selected inside a
 * lease and never escapes it; private fields always belong to that generation. */
export function borrowedService<R, S extends object>(
  owner: VersionedOwner<R>,
  select: (resource: R) => S,
  methods: readonly (keyof NoInfer<S>)[],
  constants: NoInfer<Partial<S>> = {},
): S {
  const allowed = new Set<PropertyKey>(methods);
  return new Proxy(constants as S, {
    get(target, key) {
      if (!allowed.has(key)) return Reflect.get(target, key);
      return (...args: unknown[]) =>
        owner.withValue(async (resource) => {
          const service = select(resource);
          const method: unknown = Reflect.get(service, key);
          if (typeof method !== "function")
            throw Error("OWNER_SERVICE_UNAVAILABLE");
          return await Reflect.apply(method, service, args);
        });
    },
  });
}
