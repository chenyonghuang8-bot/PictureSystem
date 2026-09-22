import { cpSync, lstatSync, mkdirSync, readFileSync, rmSync } from "node:fs";
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

// The codec is built from the authenticated, unmodified release tree. Build
// artifacts live only under the ignored package build directory.
const vendorRoot = join(packageRoot, "vendor/libwebp");
const sourceRoot = join(vendorRoot, "1.6.0");
const sourceLock = JSON.parse(
  readFileSync(join(vendorRoot, "SOURCE.lock.json"), "utf8"),
);
const sourceManifest = readFileSync(join(vendorRoot, "SOURCE.sha256"));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
if (
  process.arch !== "arm64" ||
  sourceLock.version !== "1.6.0" ||
  sourceLock.commit !== "4fa21912338357f89e4fd51cf2368325b59e9bd9" ||
  digest(sourceManifest) !== sourceLock.sourceTreeManifestSha256
) {
  throw new Error("Pinned libwebp source identity mismatch.");
}
const sourceLines = sourceManifest.toString("utf8").trimEnd().split("\n");
if (sourceLines.length !== sourceLock.sourceFiles) {
  throw new Error("Pinned libwebp source file count mismatch.");
}
for (const line of sourceLines) {
  const match = /^([0-9a-f]{64}) {2}(\.\/[^\r\n]+)$/u.exec(line);
  if (!match || match[2].split("/").includes("..")) {
    throw new Error("Pinned libwebp source manifest is malformed.");
  }
  const file = resolve(sourceRoot, match[2]);
  if (
    !file.startsWith(`${sourceRoot}/`) ||
    !lstatSync(file).isFile() ||
    digest(readFileSync(file)) !== match[1]
  ) {
    throw new Error("Pinned libwebp source file mismatch.");
  }
}
const codecBuild = join(outputDirectory, "libwebp-build");
rmSync(codecBuild, { recursive: true, force: true });
cpSync(sourceRoot, codecBuild, { recursive: true });
const codecResult = spawnSync(
  "/usr/bin/make",
  [
    "-s",
    "-f",
    "makefile.unix",
    "-j4",
    "CC=/usr/bin/clang",
    "AR=/usr/bin/ar",
    "EXTRA_FLAGS=-fPIC -fno-common -fvisibility=hidden",
    "src/libwebp.a",
    "sharpyuv/libsharpyuv.a",
  ],
  { cwd: codecBuild, encoding: "utf8" },
);
if (codecResult.status !== 0) {
  throw new Error(
    `Pinned libwebp static build failed: ${codecResult.stderr.trim()}`,
  );
}

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
const lifecycleHarness = spawnSync(
  "clang",
  [
    "-std=c11",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-O2",
    "-DPS_LIFECYCLE_TRACE",
    join(packageRoot, "native/process_lifecycle_harness.c"),
    "-o",
    join(outputDirectory, "process_lifecycle_harness"),
  ],
  { encoding: "utf8" },
);
if (lifecycleHarness.status !== 0) {
  throw new Error(
    `Native process lifecycle harness build failed: ${lifecycleHarness.stderr.trim()}`,
  );
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
const buildSupervisor = (name, bootstrap, extraFlags = []) =>
  buildStartupPart(name, [
    "-std=c11",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-O2",
    ...extraFlags,
    `-DPS_RENDERER_BOOTSTRAP_PATH="${bootstrap}"`,
    `-DPS_RENDERER_MODULE_PATH="${modulePath}"`,
    `-DPS_RENDERER_BOOTSTRAP_SHA256="${sha256File(bootstrap)}"`,
    `-DPS_RENDERER_MODULE_SHA256="${sha256File(modulePath)}"`,
    `-DPS_EXPECTED_OS_BUILD="${expectedOsBuild}"`,
    join(packageRoot, "native/image_renderer_supervisor.c"),
    "-o",
    join(outputDirectory, name),
  ]);

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

for (const [kind, number] of [
  ["thumbnail", 1],
  ["preview", 2],
]) {
  const realModule = join(
    outputDirectory,
    `image_renderer_${kind}_module.dylib`,
  );
  const realBootstrap = join(
    outputDirectory,
    `image_renderer_${kind}_bootstrap`,
  );
  buildStartupPart(`image renderer ${kind} module`, [
    "-Wall",
    "-Wextra",
    "-Werror",
    "-O2",
    "-fobjc-arc",
    "-fPIC",
    "-dynamiclib",
    `-DPS_RENDER_KIND=${number}`,
    `-I${join(codecBuild, "src")}`,
    join(packageRoot, "native/image_renderer_module.m"),
    join(codecBuild, "src/libwebp.a"),
    join(codecBuild, "sharpyuv/libsharpyuv.a"),
    "-framework",
    "Foundation",
    "-framework",
    "CoreGraphics",
    "-framework",
    "ImageIO",
    "-o",
    realModule,
  ]);
  buildStartupPart(`image renderer ${kind} bootstrap`, [
    "-std=c11",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-O2",
    "-DPS_RENDER_REAL",
    `-DPS_RENDERER_MODULE_PATH="${realModule}"`,
    join(packageRoot, "native/image_renderer_bootstrap.c"),
    "-o",
    realBootstrap,
  ]);
  buildStartupPart(`image renderer ${kind} supervisor`, [
    "-std=c11",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-O2",
    `-DPS_RENDER_BINARY=${number}`,
    `-DPS_RENDERER_BOOTSTRAP_PATH="${realBootstrap}"`,
    `-DPS_RENDERER_MODULE_PATH="${realModule}"`,
    `-DPS_RENDERER_BOOTSTRAP_SHA256="${sha256File(realBootstrap)}"`,
    `-DPS_RENDERER_MODULE_SHA256="${sha256File(realModule)}"`,
    `-DPS_EXPECTED_OS_BUILD="${expectedOsBuild}"`,
    join(packageRoot, "native/image_renderer_supervisor.c"),
    "-o",
    join(outputDirectory, `image_renderer_${kind}_supervisor`),
  ]);
}

// Fixed, package-owned synthetic failure harness; never used by the public API.
const faultModule = join(outputDirectory, "image_renderer_fault_module.dylib");
const faultBootstrap = join(outputDirectory, "image_renderer_fault_bootstrap");
buildStartupPart("image renderer synthetic fault module", [
  "-std=c11",
  "-Wall",
  "-Wextra",
  "-Werror",
  "-O2",
  "-fPIC",
  "-dynamiclib",
  join(packageRoot, "native/image_renderer_fault_module.c"),
  "-o",
  faultModule,
]);
buildStartupPart("image renderer synthetic fault bootstrap", [
  "-std=c11",
  "-Wall",
  "-Wextra",
  "-Werror",
  "-O2",
  "-DPS_RENDER_REAL",
  `-DPS_RENDERER_MODULE_PATH="${faultModule}"`,
  join(packageRoot, "native/image_renderer_bootstrap.c"),
  "-o",
  faultBootstrap,
]);
buildStartupPart("image renderer synthetic fault supervisor", [
  "-std=c11",
  "-Wall",
  "-Wextra",
  "-Werror",
  "-O2",
  "-DPS_RENDER_BINARY=2",
  `-DPS_RENDERER_BOOTSTRAP_PATH="${faultBootstrap}"`,
  `-DPS_RENDERER_MODULE_PATH="${faultModule}"`,
  `-DPS_RENDERER_BOOTSTRAP_SHA256="${sha256File(faultBootstrap)}"`,
  `-DPS_RENDERER_MODULE_SHA256="${sha256File(faultModule)}"`,
  `-DPS_EXPECTED_OS_BUILD="${expectedOsBuild}"`,
  join(packageRoot, "native/image_renderer_supervisor.c"),
  "-o",
  join(outputDirectory, "image_renderer_fault_supervisor"),
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
  ["ignore_term", "PS_FORCE_IGNORE_TERM"],
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

// Test-only supervisors preserve the production path and allow deterministic
// lifecycle/FD assertions without weakening the shipped binary.
buildSupervisor("image_renderer_supervisor_trace", bootstrapPath, [
  "-DPS_LIFECYCLE_TRACE",
]);
buildSupervisor("image_renderer_supervisor_high_fd", bootstrapPath, [
  "-DPS_REQUIRE_HIGH_FDS",
]);
const nativeHighFdSupervisor = "image_renderer_supervisor_native_high_fd";
buildSupervisor(nativeHighFdSupervisor, bootstrapPath, [
  "-DPS_REQUIRE_HIGH_FDS",
  "-DPS_REQUIRE_SOCKET_FD",
]);
buildStartupPart("image renderer native high FD parent", [
  "-std=c11",
  "-Wall",
  "-Wextra",
  "-Werror",
  "-O2",
  `-DPS_TEST_SUPERVISOR_PATH="${join(outputDirectory, nativeHighFdSupervisor)}"`,
  join(packageRoot, "native/image_renderer_high_fd_parent.c"),
  "-o",
  join(outputDirectory, "image_renderer_high_fd_parent"),
]);
buildSupervisor(
  "image_renderer_supervisor_group_loss",
  join(outputDirectory, "image_renderer_bootstrap_timeout_before_ready"),
  ["-DPS_LIFECYCLE_TRACE", "-DPS_TEST_GROUP_SIGNAL_LOST"],
);
for (const scenario of [
  "timeout_before_ready",
  "ignore_term",
  "crash_before_ready",
]) {
  const bootstrap = join(
    outputDirectory,
    `image_renderer_bootstrap_${scenario}`,
  );
  buildSupervisor(`image_renderer_supervisor_${scenario}_trace`, bootstrap, [
    "-DPS_LIFECYCLE_TRACE",
  ]);
}
