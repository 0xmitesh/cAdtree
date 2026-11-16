// Saved-snapshot comparison fixture. Never imported by the production App.
import { RealFileSystemAdapter } from "../src/engine/fs-adapter";
import { createHome, createHomeWorkspace } from "../src/engine/home-service";
import {
  importProject,
  createManagedBranch,
  resolveManagedProject,
} from "../src/engine/workspace-service";
import { captureRevision } from "../src/engine/revision-service";
import { rememberHome } from "../src/engine/idb-store";
import {
  inventorySignature,
  readVerifiedInventory,
} from "../src/engine/copy-service";
import { isHomeGuideFile } from "./offline-guide-files";

export async function seedComparisonReview() {
  if (!import.meta.env.DEV)
    throw new Error("Development-only synthetic fixture");
  const storage = await navigator.storage.getDirectory();
  const handle = await storage.getDirectoryHandle(
    `Synthetic comparison ${crypto.randomUUID()}`,
    { create: true },
  );
  const root = new RealFileSystemAdapter(handle);
  const home = await createHome(root);
  const workspace = (await createHomeWorkspace(root, "Comparison review"))
    .workspace;
  const source = new RealFileSystemAdapter(
    await storage.getDirectoryHandle(
      `comparison-source-${crypto.randomUUID()}`,
      { create: true },
    ),
  );
  for (const path of [
    "Assembly.SLDASM",
    "Parts/Pin.SLDPRT",
    "Other/Pin.SLDPRT",
    "Drawings/Assembly.SLDDRW",
    "Retired/Legacy.SLDPRT",
  ])
    await source.writeFileText(
      path.split("/"),
      `SYNTHETIC INITIAL BYTES: ${path}`,
    );
  await source.getDirectory(["Empty original"], { create: true });
  let project = await importProject(
    workspace.root,
    source,
    "Snapshot comparison",
  );
  const ids: string[] = [];
  const capture = async (
    branchId: string,
    summary: string,
    pinNote: string,
  ) => {
    const result = await captureRevision(
      project.workingFolders[branchId]!,
      project.vaultDir,
      {
        branchId,
        summary,
        workingFolders: project.workingFolders,
        notes: {
          problem: "Synthetic comparison review",
          modification: summary,
          observations: "No real CAD data",
        },
        fileNotes: [
          {
            path: "Parts/Pin.SLDPRT",
            problem: pinNote,
            modification: summary,
            observations: "Notes at this endpoint only",
          },
        ],
      },
    );
    ids.push(result.revision.manifest.revisionId);
    project = await resolveManagedProject(
      workspace.root,
      project.record.containerPath,
    );
  };
  await capture("branch-main", "Initial 5-file design", "Initial-pin note");
  await project.workingFolders["branch-main"]!.writeFileText(
    ["Parts", "Pin.SLDPRT"],
    "SYNTHETIC Main pin step two",
  );
  await project.workingFolders["branch-main"]!.writeFileText(
    ["MainNotes.txt"],
    "SYNTHETIC Main notes",
  );
  await capture(
    "branch-main",
    "Main intermediate design",
    "Intermediate-pin note",
  );
  const alternative = await createManagedBranch(
    workspace.root,
    project.record.containerPath,
    {
      sourceRevisionId: ids[0],
      name: "Old design case",
      reason: "Compare an older 5-file alternative with current Main",
    },
  );
  project = alternative;
  await project.workingFolders[alternative.createdBranchId]!.writeFileText(
    ["Parts", "Pin.SLDPRT"],
    "SYNTHETIC case pin",
  );
  await capture(
    alternative.createdBranchId,
    "Old case with 5 files",
    "Case-pin note",
  );
  const main = project.workingFolders["branch-main"]!;
  await main.writeFileText(
    ["Parts", "Pin.SLDPRT"],
    "SYNTHETIC Main pin release with different bytes",
  );
  await main.removeEntry(["Drawings", "Assembly.SLDDRW"]);
  await main.removeEntry(["Retired", "Legacy.SLDPRT"]);
  await main.removeEntry(["Retired"]);
  await main.removeEntry(["Empty original"]);
  await main.getDirectory(["Empty new", "Empty nested"], { create: true });
  await main.writeFileText(
    ["Drawings", "Manufacturing.SLDDRW"],
    "SYNTHETIC manufacturing drawing",
  );
  for (let i = 1; i <= 15; i++)
    await main.writeFileText(
      ["MainOnly", `Part${String(i).padStart(2, "0")}.SLDPRT`],
      `SYNTHETIC main addition ${i}`,
    );
  await capture(
    "branch-main",
    "Main release with 20 files",
    "Main-release pin note",
  );
  await importProject(workspace.root, source, "Second comparison project");
  await rememberHome({
    homeId: home.identity.homeId,
    name: root.name,
    rootHandle: handle,
  });
  return {
    ids,
    alternativeId: alternative.createdBranchId,
    rootName: root.name,
    fingerprint: await comparisonFixtureFingerprint(root.name),
  };
}

export async function comparisonFixtureFingerprint(rootName: string) {
  const storage = await navigator.storage.getDirectory();
  const root = new RealFileSystemAdapter(
    await storage.getDirectoryHandle(rootName),
  );
  // Opening a writable home writes its Readme and Index; nothing else may change.
  const inventory = await readVerifiedInventory(root);
  return inventorySignature({
    ...inventory,
    files: inventory.files.filter((file) => !isHomeGuideFile(file.path)),
  });
}
