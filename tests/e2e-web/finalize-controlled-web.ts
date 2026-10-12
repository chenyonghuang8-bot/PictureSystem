import { finalizeControlledWebFixture } from "../helpers/finalize-controlled-web.js";

try {
  await finalizeControlledWebFixture(process.argv[2]!);
  console.log("OWNED_WEB_FINALIZATION_PASS");
} catch (error) {
  console.error(
    error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)
      ? error.message
      : "WEB_FINALIZATION_FAILED_SANITIZED",
  );
  process.exitCode = 1;
}
