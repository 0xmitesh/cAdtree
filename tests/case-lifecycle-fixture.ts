// Development-only inspection of the disposable actual-App lifecycle fixture.
import { RealFileSystemAdapter } from "../src/engine/fs-adapter";
import {
  inventorySignature,
  readVerifiedInventory,
} from "../src/engine/copy-service";
import { isHomeGuideFile, isProjectGuideFile } from "./offline-guide-files";
import { openExistingVault } from "../src/engine/vault-service";
import { getBranchBaseline } from "../src/engine/branch-state";
import {
  getObjectPathSegments,
  verifyStoredObject,
} from "../src/engine/object-store";
export async function readLifecycleFixture(fixture: {
  rootName: string;
  vaultPath: string[];
}) {
  if (
    !import.meta.env.DEV ||
    !fixture.rootName.startsWith("Synthetic application preview ")
  )
    throw new Error("Disposable development fixture required");
  const storage = await navigator.storage.getDirectory();
  const root = new RealFileSystemAdapter(
    await storage.getDirectoryHandle(fixture.rootName),
  );
  const inventory = await readVerifiedInventory(root);
  const lifecycle = `${fixture.vaultPath.join("/")}/case-lifecycle`;
  return {
    state: await openExistingVault(await root.getDirectory(fixture.vaultPath)),
    unchangedFingerprint: inventorySignature({
      ...inventory,
      // Archiving or reopening also refreshes the derived offline guide (Map, revision listings, home files).
      files: inventory.files.filter(
        (file) =>
          !file.path.startsWith(`${lifecycle}/`) && !isHomeGuideFile(file.path) && !isProjectGuideFile(file.path),
      ),
      directories: inventory.directories.filter(
        (path) => path !== lifecycle && !path.startsWith(`${lifecycle}/`),
      ),
    }),
  };
}
export async function lifecycleDraftEdit(
  fixture: {
    rootName: string;
    vaultPath: string[];
    workingPaths: Record<string, string[]>;
    safeCaseId: string;
  },
  restore = false,
) {
  if (
    !import.meta.env.DEV ||
    !fixture.rootName.startsWith("Synthetic application preview ")
  )
    throw new Error("Disposable development fixture required");
  const storage = await navigator.storage.getDirectory();
  const root = new RealFileSystemAdapter(
    await storage.getDirectoryHandle(fixture.rootName),
  );
  const working = await root.getDirectory(
    fixture.workingPaths[fixture.safeCaseId],
  );
  const path = ["Parts", "Part-X.SLDPRT"];
  if (!restore) {
    await working.writeFileText(
      path,
      "Synthetic temporary edit for session draft validation",
    );
    return;
  }
  const vault = await root.getDirectory(fixture.vaultPath);
  const baseline = getBranchBaseline(
    await openExistingVault(vault),
    fixture.safeCaseId,
  )!;
  const file = baseline.files.find((file) => file.path === path.join("/"))!;
  if (!(await verifyStoredObject(vault, file.sha256, file.size)).valid)
    throw new Error("Invalid fixture object");
  await working.writeFileStream(
    path,
    await vault.readFileStream(getObjectPathSegments(file.sha256)),
  );
}
