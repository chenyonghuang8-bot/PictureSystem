import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ownedContainers = new Set<string>();
process.once("exit", () => {
  for (const container of ownedContainers)
    rmSync(container, { recursive: true, force: true });
});

// The container is exclusively owned by this fixture process. The final root
// remains nonexistent until native exclusive mkdir establishes authority.
// Exit cleanup also covers a setup assertion failing before a test's finally.
export function freshStorageRootPath(prefix: string) {
  if (!/^[a-z0-9-]+-$/u.test(prefix)) throw new Error("FIXTURE_PREFIX_INVALID");
  const container = mkdtempSync(join(realpathSync(tmpdir()), prefix));
  ownedContainers.add(container);
  return join(container, "r");
}
