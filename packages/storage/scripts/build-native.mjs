import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

if (process.platform !== "darwin") {
  throw new Error("Phase 3A native storage requires macOS.");
}

const packageRoot = resolve(import.meta.dirname, "..");
const outputDirectory = join(packageRoot, "build");
const nodeInclude = resolve(dirname(process.execPath), "../include/node");
mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });

const result = spawnSync(
  "clang",
  [
    "-std=c11",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-O2",
    "-fPIC",
    "-bundle",
    "-undefined",
    "dynamic_lookup",
    `-I${nodeInclude}`,
    join(packageRoot, "native/storage_native.c"),
    "-o",
    join(outputDirectory, "storage_native.node"),
  ],
  { encoding: "utf8" },
);

if (result.status !== 0) {
  throw new Error(
    `Native storage build failed (${result.status ?? "signal"}): ${result.stderr.trim()}`,
  );
}

for (const source of ["original_probe_supervisor", "original_probe_child"]) {
  const executable = spawnSync(
    "clang",
    [
      "-std=c11",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-O2",
      join(packageRoot, `native/${source}.c`),
      "-o",
      join(outputDirectory, source),
    ],
    { encoding: "utf8" },
  );
  if (executable.status !== 0) {
    throw new Error(
      `Native ${source} build failed (${executable.status ?? "signal"}): ${executable.stderr.trim()}`,
    );
  }
}

const metadataParser = spawnSync(
  "clang",
  [
    "-Wall",
    "-Wextra",
    "-Werror",
    "-O2",
    "-fobjc-arc",
    join(packageRoot, "native/metadata_parser_child.m"),
    "-framework",
    "Foundation",
    "-framework",
    "CoreGraphics",
    "-framework",
    "ImageIO",
    "-o",
    join(outputDirectory, "metadata_parser_child"),
  ],
  { encoding: "utf8" },
);

if (metadataParser.status !== 0) {
  throw new Error(
    `Native metadata parser build failed (${metadataParser.status ?? "signal"}): ${metadataParser.stderr.trim()}`,
  );
}
