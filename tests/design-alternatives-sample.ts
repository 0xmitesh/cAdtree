import { InMemoryFileSystemAdapter } from "../src/engine/fs-adapter";
import { createHome, createHomeWorkspace } from "../src/engine/home-service";
import { createProject, resolveManagedProject } from "../src/engine/workspace-service";
import { captureRevision } from "../src/engine/revision-service";

/** Disposable opaque CAD-extension bytes, never real SolidWorks models or user files. */
export async function designAlternativesSample() {
  const home = new InMemoryFileSystemAdapter("Cadtree");
  await createHome(home);
  const { workspace } = await createHomeWorkspace(home, "Tutorial Workspace");
  const project = await createProject(workspace.root, "Bracket Assembly");
  const main = project.workingFolders["branch-main"]!;
  for (const [name, size] of [["Bracket.SLDPRT", 512000], ["Mount.SLDPRT", 256000], ["BracketAssembly.SLDASM", 128000]] as const) {
    const bytes = new Uint8Array(size);
    bytes.set(new TextEncoder().encode("OPAQUE TUTORIAL FIXTURE - NOT A VALID CAD DOCUMENT"));
    await main.writeFileBytes([name], bytes);
  }
  async function save(branchId: string, summary: string, version: number) {
    const current = await resolveManagedProject(workspace.root, project.record.containerPath);
    const folder = current.workingFolders[branchId]!;
    const bytes = await folder.readFileBytes(["Bracket.SLDPRT"]);
    bytes[bytes.length - 1] = version;
    await folder.writeFileBytes(["Bracket.SLDPRT"], bytes);
    return captureRevision(folder, current.vaultDir, {
      branchId, summary, notes: { problem: "", modification: "", observations: "" },
      workingFolders: current.workingFolders,
    });
  }
  await save("branch-main", "Initial layout", 1);
  await save("branch-main", "Mounting geometry updated", 2);
  const baseline = await save("branch-main", "Reviewed design baseline", 3);
  return { home, workspace, project, main, baseline: baseline.revision, save };
}
