// Development-only real-engine fixture for the read-only three-way preview.
import { RealFileSystemAdapter } from "../src/engine/fs-adapter";
import { createHome, createHomeWorkspace } from "../src/engine/home-service";
import {
  importProject,
  createManagedBranch,
  resolveManagedProject,
} from "../src/engine/workspace-service";
import { captureRevision } from "../src/engine/revision-service";
import { rememberHome } from "../src/engine/idb-store";
import { comparisonFixtureFingerprint } from "./comparison-seed";
export async function seedApplyPreviewReview() {
  if (!import.meta.env.DEV)
    throw new Error("Synthetic development fixture only");
  const storage = await navigator.storage.getDirectory();
  const root = new RealFileSystemAdapter(
    await storage.getDirectoryHandle(
      `Synthetic application preview ${crypto.randomUUID()}`,
      { create: true },
    ),
  );
  const home = await createHome(root);
  const workspace = (
    await createHomeWorkspace(root, "Application preview review")
  ).workspace;
  const original = new RealFileSystemAdapter(
    await storage.getDirectoryHandle(`preview-source-${crypto.randomUUID()}`, {
      create: true,
    }),
  );
  for (const path of [
    "Parts/Part-X.SLDPRT",
    "Other/Part-X.SLDPRT",
    "DeleteMe.SLDPRT",
    "ModifiedVsDeleted.SLDPRT",
    "Assembly.SLDASM",
  ])
    await original.writeFileText(path.split("/"), `SYNTHETIC BASE ${path}`);
  await original.getDirectory(["Base empty"], { create: true });
  let project = await importProject(
    workspace.root,
    original,
    "Actuator preview",
  );
  const ids: string[] = [];
  const capture = async (branchId: string, summary: string) => {
    const result = await captureRevision(
      project.workingFolders[branchId]!,
      project.vaultDir,
      {
        branchId,
        workingFolders: project.workingFolders,
        summary,
        notes: {
          problem: `Overall: ${summary}`,
          modification: summary,
          observations: "Synthetic saved-state notes",
        },
        fileNotes: [
          {
            path: "Parts/Part-X.SLDPRT",
            problem: `Part-X note: ${summary}`,
            modification: summary,
            observations: "Synthetic file-specific notes",
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
  await capture("branch-main", "Base with 5 files");
  const main = project.workingFolders["branch-main"]!;
  await main.writeFileText(
    ["Other", "Part-X.SLDPRT"],
    "SYNTHETIC newer Main-only development for other Part-X",
  );
  for (let i = 1; i <= 15; i++)
    await main.writeFileText(
      ["MainOnly", `New${i}.SLDPRT`],
      `SYNTHETIC Main addition ${i}`,
    );
  await main.getDirectory(["Main empty"], { create: true });
  await capture("branch-main", "Main with 20 files");
  let branch = await createManagedBranch(
    workspace.root,
    project.record.containerPath,
    {
      sourceRevisionId: ids[0],
      name: "Part-X redesign",
      reason: "Change only Part-X from the older baseline",
    },
  );
  project = branch;
  const safeCaseId = branch.createdBranchId;
  await project.workingFolders[safeCaseId]!.writeFileText(
    ["Parts", "Part-X.SLDPRT"],
    "SYNTHETIC SOURCE redesign Part-X only",
  );
  await capture(safeCaseId, "Redesign only Part-X");
  branch = await createManagedBranch(
    workspace.root,
    project.record.containerPath,
    {
      sourceRevisionId: ids[1],
      name: "Conflict destination",
      reason: "Independent destination development",
    },
  );
  project = branch;
  const conflictDestinationId = branch.createdBranchId;
  const working = project.workingFolders[conflictDestinationId]!;
  await working.writeFileText(
    ["Parts", "Part-X.SLDPRT"],
    "SYNTHETIC independent destination Part-X",
  );
  await working.writeFileText(
    ["DeleteMe.SLDPRT"],
    "SYNTHETIC independently modified destination file",
  );
  await working.removeEntry(["ModifiedVsDeleted.SLDPRT"]);
  await working.writeFileText(
    ["SharedNew.SLDPRT"],
    "SYNTHETIC destination independent addition",
  );
  await working.getDirectory(["Collision"], { create: true });
  await capture(conflictDestinationId, "Destination with independent changes");
  branch = await createManagedBranch(
    workspace.root,
    project.record.containerPath,
    {
      sourceRevisionId: ids[0],
      name: "Conflicting source",
      reason: "Exercise explicit choices",
    },
  );
  project = branch;
  const conflictingSourceId = branch.createdBranchId;
  const conflicting = project.workingFolders[conflictingSourceId]!;
  await conflicting.writeFileText(
    ["Parts", "Part-X.SLDPRT"],
    "SYNTHETIC conflicting source Part-X",
  );
  await conflicting.removeEntry(["DeleteMe.SLDPRT"]);
  await conflicting.writeFileText(
    ["ModifiedVsDeleted.SLDPRT"],
    "SYNTHETIC source changes destination-deleted file",
  );
  await conflicting.writeFileText(
    ["SharedNew.SLDPRT"],
    "SYNTHETIC source independent addition",
  );
  await conflicting.writeFileText(
    ["NewOnly.SLDPRT"],
    "SYNTHETIC source-only addition",
  );
  await conflicting.writeFileText(
    ["Collision"],
    "SYNTHETIC file colliding with destination directory",
  );
  await capture(
    conflictingSourceId,
    "Source additions, deletion and conflicts",
  );
  await main.writeFileText(
    ["Parts", "Part-X.SLDPRT"],
    "UNCAPTURED WORKING EDIT — preview must neither read nor replace this as saved state",
  );
  await rememberHome({
    homeId: home.identity.homeId,
    name: root.name,
    rootHandle: root.handle,
  });
  return {
    vaultPath: await root.resolveRelativePath(project.vaultDir),
    workingPaths: Object.fromEntries(
      await Promise.all(
        Object.entries(project.workingFolders).map(async ([id, dir]) => [
          id,
          await root.resolveRelativePath(dir!),
        ]),
      ),
    ),
    ids,
    safeCaseId,
    conflictDestinationId,
    conflictingSourceId,
    rootName: root.name,
    savedFiles: Object.fromEntries(
      project.vaultState.revisions.map((revision) => [
        revision.manifest.revisionId,
        revision.manifest.files,
      ]),
    ),
    fingerprint: await comparisonFixtureFingerprint(root.name),
  };
}
