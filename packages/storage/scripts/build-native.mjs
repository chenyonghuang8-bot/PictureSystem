import { mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
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

// D3a-0 synthetic startup harness only; no image framework or encoder linked.
const bootstrapPath = join(outputDirectory, "image_renderer_bootstrap");
const modulePath = join(
  outputDirectory,
  "image_renderer_synthetic_module.dylib",
);
const supervisorPath = join(outputDirectory, "image_renderer_supervisor");
const buildStartupPart = (name, args) => {
  const built = spawnSync("clang", args, { encoding: "utf8" });
  if (built.status !== 0) {
    throw new Error(
      `Native ${name} build failed (${built.status ?? "signal"}): ${built.stderr.trim()}`,
    );
  }
};
const sha256File = (path) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");
const osBuild = spawnSync("/usr/bin/sw_vers", ["-buildVersion"], {
  encoding: "utf8",
});
if (osBuild.status !== 0 || !/^[A-Za-z0-9]+$/u.test(osBuild.stdout.trim())) {
  throw new Error("Renderer startup OS build fingerprint is unavailable.");
}
const expectedOsBuild = osBuild.stdout.trim();

buildStartupPart("image renderer synthetic module", [
  "-std=c11",
  "-Wall",
  "-Wextra",
  "-Werror",
  "-O2",
  "-fPIC",
  "-dynamiclib",
  `-DPS_RENDERER_BOOTSTRAP_PATH="${bootstrapPath}"`,
  `-DPS_DENIED_TEST_PATH="${join(packageRoot, "native/image_renderer_denied_secret.fixture")}"`,
  join(packageRoot, "native/image_renderer_synthetic_module.c"),
  "-o",
  modulePath,
]);
buildStartupPart("image renderer bootstrap", [
  "-std=c11",
  "-Wall",
  "-Wextra",
  "-Werror",
  "-O2",
  `-DPS_RENDERER_MODULE_PATH="${modulePath}"`,
  join(packageRoot, "native/image_renderer_bootstrap.c"),
  "-o",
  bootstrapPath,
]);
buildStartupPart("image renderer supervisor", [
  "-std=c11",
  "-Wall",
  "-Wextra",
  "-Werror",
  "-O2",
  `-DPS_RENDERER_BOOTSTRAP_PATH="${bootstrapPath}"`,
  `-DPS_RENDERER_MODULE_PATH="${modulePath}"`,
  `-DPS_RENDERER_BOOTSTRAP_SHA256="${sha256File(bootstrapPath)}"`,
  `-DPS_RENDERER_MODULE_SHA256="${sha256File(modulePath)}"`,
  `-DPS_EXPECTED_OS_BUILD="${expectedOsBuild}"`,
  join(packageRoot, "native/image_renderer_supervisor.c"),
  "-o",
  supervisorPath,
]);
buildStartupPart("image renderer mismatched fingerprint supervisor", [
  "-std=c11",
  "-Wall",
  "-Wextra",
  "-Werror",
  "-O2",
  `-DPS_RENDERER_BOOTSTRAP_PATH="${bootstrapPath}"`,
  `-DPS_RENDERER_MODULE_PATH="${modulePath}"`,
  `-DPS_RENDERER_BOOTSTRAP_SHA256="${sha256File(bootstrapPath)}"`,
  `-DPS_RENDERER_MODULE_SHA256="${"0".repeat(64)}"`,
  `-DPS_EXPECTED_OS_BUILD="${expectedOsBuild}"`,
  join(packageRoot, "native/image_renderer_supervisor.c"),
  "-o",
  join(outputDirectory, "image_renderer_supervisor_bad_fingerprint"),
]);

// Fixed, separately built fault binaries exist only for synthetic qualification.
for (const [name, macro] of [
  ["activation_failure", "PS_FORCE_ACTIVATION_FAILURE"],
  ["no_ready", "PS_FORCE_NO_READY"],
  ["bad_ready", "PS_FORCE_BAD_READY"],
  ["duplicate_ready", "PS_FORCE_DUP_READY"],
  ["crash_before_ready", "PS_FORCE_CRASH_BEFORE_READY"],
  ["timeout_before_ready", "PS_FORCE_TIMEOUT_BEFORE_READY"],
  ["early_read", "PS_FORCE_EARLY_READ"],
]) {
  const testBootstrap = join(
    outputDirectory,
    `image_renderer_bootstrap_${name}`,
  );
  const testSupervisor = join(
    outputDirectory,
    `image_renderer_supervisor_${name}`,
  );
  buildStartupPart(`image renderer ${name} bootstrap`, [
    "-std=c11",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-O2",
    `-D${macro}`,
    `-DPS_RENDERER_MODULE_PATH="${modulePath}"`,
    join(packageRoot, "native/image_renderer_bootstrap.c"),
    "-o",
    testBootstrap,
  ]);
  buildStartupPart(`image renderer ${name} supervisor`, [
    "-std=c11",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-O2",
    `-DPS_RENDERER_BOOTSTRAP_PATH="${testBootstrap}"`,
    `-DPS_RENDERER_MODULE_PATH="${modulePath}"`,
    `-DPS_RENDERER_BOOTSTRAP_SHA256="${sha256File(testBootstrap)}"`,
    `-DPS_RENDERER_MODULE_SHA256="${sha256File(modulePath)}"`,
    `-DPS_EXPECTED_OS_BUILD="${expectedOsBuild}"`,
    join(packageRoot, "native/image_renderer_supervisor.c"),
    "-o",
    testSupervisor,
  ]);
}
