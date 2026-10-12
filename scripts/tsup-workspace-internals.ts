import { existsSync } from "node:fs";
import { resolve, relative, sep } from "node:path";
import type { Options } from "tsup";

/** Native capability WeakMaps must have the same module identity as the
 * external workspace package entry. Keep private modules private and loaded
 * once; do not inline a second owner registry or export its opaque handles. */
export function preserveWorkspaceInternals(
  project: string,
): NonNullable<Options["esbuildPlugins"]>[number] {
  const packageRoot = resolve(project, "../../packages") + sep;
  const output = resolve(project, "dist");
  return {
    name: "preserve-workspace-internal-singletons",
    setup(build) {
      build.onResolve({ filter: /^\.\.?\// }, (args) => {
        const candidate = resolve(args.resolveDir, args.path);
        if (!candidate.startsWith(packageRoot)) return undefined;
        const source = candidate.endsWith(".js")
          ? candidate.slice(0, -3) + ".ts"
          : candidate;
        if (!existsSync(source))
          throw Error("WORKSPACE_INTERNAL_SOURCE_REQUIRED");
        const path = relative(output, source).split(sep).join("/");
        return {
          path: path.startsWith(".") ? path : "./" + path,
          external: true,
        };
      });
    },
  };
}
