import { createRequire } from "node:module";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, URL } from "node:url";
const require = createRequire(import.meta.url),
  pkg = require.resolve("maplibre-gl/package.json");
if (JSON.parse(readFileSync(pkg, "utf8")).version !== "6.11.2")
  throw new Error("MAPLIBRE_WORKER_VERSION_MISMATCH");
const target = fileURLToPath(
  new URL("../public/vendor/maplibre-6.11.2/", import.meta.url),
);
mkdirSync(target, { recursive: true });
for (const name of ["maplibre-gl-worker.mjs", "maplibre-gl-shared.mjs"])
  copyFileSync(join(dirname(pkg), "dist", name), join(target, name));
copyFileSync(join(dirname(pkg), "LICENSE.txt"), join(target, "LICENSE.txt"));
