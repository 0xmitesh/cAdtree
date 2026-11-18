// Development-only fixture: real engine, complete manifests and browser OPFS.
import { RealFileSystemAdapter } from "../src/engine/fs-adapter";
import { createHome, createHomeWorkspace } from "../src/engine/home-service";
import {
  importProject,
  createManagedBranch,
  resolveManagedProject,
} from "../src/engine/workspace-service";
import { captureRevision } from "../src/engine/revision-service";
import { rememberHome } from "../src/engine/idb-store";
export async function seedFileHistoryReview() {
  if (!import.meta.env.DEV) throw new Error("Test fixture is development-only");
  const storage = await navigator.storage.getDirectory();
  const handle = await storage.getDirectoryHandle(
    `Synthetic file history ${crypto.randomUUID()}`,
    { create: true },
  );
  const root = new RealFileSystemAdapter(handle);
  const home = await createHome(root);
  const workspace = (await createHomeWorkspace(root, "File history review"))
    .workspace;
  const source = new RealFileSystemAdapter(
    await storage.getDirectoryHandle(`source-${crypto.randomUUID()}`, {
      create: true,
    }),
  );
  const path = ["Parts", "Pin.SLDPRT"];
  await source.writeFileText(path, "SYNTHETIC CAD BYTES a");
  await source.writeFileText(["Other", "Pin.SLDPRT"], "SYNTHETIC other pin");
  await source.writeFileText(
    ["Obsolete", "Retired.SLDPRT"],
    "SYNTHETIC retired",
  );
  let project = await importProject(
    workspace.root,
    source,
    "Synthetic actuator",
  );
  // This review covers path history, as in a project saved before component tracking:
  // deleting and re-adding a file would otherwise create two tracked files.
  await project.vaultDir.removeEntry(["components"], { recursive: true });
  const ids: string[] = [];
  async function capture(branchId: string, summary: string) {
    const result = await captureRevision(
      project.workingFolders[branchId]!,
      project.vaultDir,
      {
        branchId,
        summary,
        workingFolders: project.workingFolders,
        notes: {
          problem: "Synthetic review",
          modification: summary,
          observations: "No real CAD files",
        },
        fileNotes: [
          {
            path: path.join("/"),
            problem: "Synthetic pin review",
            modification: summary,
            observations: "Recorded byte change only",
          },
        ],
      },
    );
    ids.push(result.revision.manifest.revisionId);
    project = await resolveManagedProject(
      workspace.root,
      project.record.containerPath,
    );
  }
  for (const [index, hash] of [
    "a",
    "a",
    "b",
    "b",
    "b",
    "c",
    "c",
    "a",
    "a",
    "a",
  ].entries()) {
    const working = project.workingFolders["branch-main"]!;
    await working.writeFileText(path, `SYNTHETIC CAD BYTES ${hash}`);
    await working.writeFileText(
      ["Other", "Pin.SLDPRT"],
      `SYNTHETIC other pin ${index}`,
    );
    if (index === 1) await working.removeEntry(["Obsolete", "Retired.SLDPRT"]);
    await capture("branch-main", `Project step ${index + 1}`);
  }
  const alt = await createManagedBranch(
    workspace.root,
    project.record.containerPath,
    {
      sourceRevisionId: ids[1],
      name: "Alternative",
      reason: "Inherited from older Main",
    },
  );
  project = alt;
  await project.workingFolders[alt.createdBranchId]!.writeFileText(
    ["Other", "Pin.SLDPRT"],
    "Alternative other file edit",
  );
  await capture(alt.createdBranchId, "Alternative: other file only");
  await project.workingFolders[alt.createdBranchId]!.writeFileText(
    path,
    "SYNTHETIC CAD BYTES alternative",
  );
  await project.workingFolders[alt.createdBranchId]!.writeFileText(
    ["AlternativeOnly.txt"],
    "Alternative-only synthetic reference",
  );
  await capture(alt.createdBranchId, "Alternative: pin change");
  await project.workingFolders["branch-main"]!.removeEntry(path);
  await capture("branch-main", "Delete Main pin");
  await project.workingFolders["branch-main"]!.writeFileText(
    path,
    "SYNTHETIC CAD BYTES a",
  );
  await capture("branch-main", "Reintroduce Main pin");
  await importProject(workspace.root, source, "Second synthetic project");
  await rememberHome({
    homeId: home.identity.homeId,
    name: root.name,
    rootHandle: handle,
  });
  return { ids, alternativeId: alt.createdBranchId };
}
