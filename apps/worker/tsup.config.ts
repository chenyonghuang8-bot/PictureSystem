import { defineConfig } from "tsup";
import { preserveWorkspaceInternals } from "../../scripts/tsup-workspace-internals.js";
export default defineConfig({
  esbuildPlugins: [preserveWorkspaceInternals(import.meta.dirname)],
});
