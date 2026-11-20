// Actual-App tests only: disposable browser storage, never native user folders.
import { RealFileSystemAdapter } from "../src/engine/fs-adapter";
import { openExistingVault } from "../src/engine/vault-service";
import {
  readVerifiedInventory,
  inventorySignature,
} from "../src/engine/copy-service";
export interface ApplicationFixtureLocation {
  rootName: string;
  vaultPath: string[];
  workingPaths: Record<string, string[]>;
  safeCaseId: string;
}
async function folders(fixture: ApplicationFixtureLocation) {
  if (!import.meta.env.DEV) throw new Error("Development fixture only");
  if (!fixture.rootName.startsWith("Synthetic application preview "))
    throw new Error("Disposable fixture required");
  const storage = await navigator.storage.getDirectory();
  const root = new RealFileSystemAdapter(
    await storage.getDirectoryHandle(fixture.rootName),
  );
  return {
    root,
    vault: await root.getDirectory(fixture.vaultPath),
    main: await root.getDirectory(fixture.workingPaths["branch-main"]),
    source: await root.getDirectory(fixture.workingPaths[fixture.safeCaseId]),
  };
}
export async function cleanFixtureMain(fixture: ApplicationFixtureLocation) {
  const { main } = await folders(fixture);
  await main.writeFileText(
    ["Parts", "Part-X.SLDPRT"],
    "SYNTHETIC BASE Parts/Part-X.SLDPRT",
  );
}
export async function adjustFixtureMain(fixture: ApplicationFixtureLocation) {
  const { main } = await folders(fixture);
  await main.writeFileText(
    ["Parts", "Part-X.SLDPRT"],
    "SYNTHETIC CAD-like post-application adjustment",
  );
}
export async function readApplicationFixture(
  fixture: ApplicationFixtureLocation,
) {
  const { vault, main, source } = await folders(fixture);
  return {
    state: await openExistingVault(vault),
    main: await readVerifiedInventory(main),
    source: inventorySignature(await readVerifiedInventory(source)),
  };
}
export async function failNextFixtureWorkingAcknowledgement(
  fixture: ApplicationFixtureLocation,
) {
  const { main } = await folders(fixture);
  const original = RealFileSystemAdapter.prototype.writeFileStream;
  RealFileSystemAdapter.prototype.writeFileStream = async function (
    ...args: Parameters<typeof original>
  ) {
    const result = await original.apply(this, args);
    if (
      args[0].join("/") === "Parts/Part-X.SLDPRT" &&
      (await this.isSameEntry(main))
    ) {
      RealFileSystemAdapter.prototype.writeFileStream = original;
      throw new Error(
        "Synthetic working-write acknowledgement lost. Reopen to inspect the interrupted application.",
      );
    }
    return result;
  };
}
/** The readable copies Discard kept in the project's Discarded folder: name → path → text. */
export async function readDiscardedCopies(fixture: ApplicationFixtureLocation) {
  const { root } = await folders(fixture);
  const project = await root.getDirectory(fixture.vaultPath.slice(0, -1));
  if (!(await project.hasDirectory(["Discarded"]))) return {};
  const discarded = await project.getDirectory(["Discarded"]);
  const copies: Record<string, Record<string, string>> = {};
  for (const entry of await discarded.listEntries()) {
    if (entry.kind !== "directory") continue;
    const folder = await discarded.getDirectory([entry.name]);
    const files: Record<string, string> = {};
    for (const file of (await readVerifiedInventory(folder)).files)
      files[file.path] = await folder.readFileText(file.path.split("/"));
    copies[entry.name] = files;
  }
  return copies;
}
