import { InMemoryFileSystemAdapter } from "../src/engine/fs-adapter";
import { createHome, createHomeWorkspace } from "../src/engine/home-service";
import { createProject, createManagedBranch, resolveManagedProject } from "../src/engine/workspace-service";
import { captureRevision } from "../src/engine/revision-service";
import type { CaptureRevisionInput } from "../src/engine/types";

/** Disposable bytes for workflow teaching, not valid CAD geometry or user files. */
export async function compareApplyRecoverSample() {
  const home = new InMemoryFileSystemAdapter("Cadtree");
  await createHome(home);
  const { workspace } = await createHomeWorkspace(home, "Tutorial Workspace");
  const project = await createProject(workspace.root, "Bracket Assembly");
  const main = project.workingFolders["branch-main"]!;
  const bytes = (version: number, size = 16384) => {
    const data = new Uint8Array(size);
    data.set(new TextEncoder().encode("OPAQUE TUTORIAL FIXTURE - NOT A VALID CAD DOCUMENT"));
    data[data.length - 1] = version;
    return data;
  };
  for (const name of ["Bracket.SLDPRT", "Mount.SLDPRT", "BracketAssembly.SLDASM", "Spacer.SLDPRT"]) {
    await main.writeFileBytes([name], bytes(1));
  }
  await main.getDirectory(["Exports"], { create: true });
  async function save(branchId: string, summary: string, input: Partial<CaptureRevisionInput> = {}) {
    const current = await resolveManagedProject(workspace.root, project.record.containerPath);
    return captureRevision(current.workingFolders[branchId]!, current.vaultDir, {
      branchId, summary, notes: { problem: "", modification: "", observations: "" },
      workingFolders: current.workingFolders, ...input,
    });
  }
  await save("branch-main", "Initial layout");
  await main.writeFileBytes(["Mount.SLDPRT"], bytes(2));
  await save("branch-main", "Mount geometry updated");
  await main.writeFileBytes(["Bracket.SLDPRT"], bytes(3));
  const baseline = (await save("branch-main", "Reviewed baseline", {
    notes: { problem: "Record a reference for the lightweight study.", modification: "Reviewed the mounting layout.", observations: "Use this saved state as the study baseline." },
  })).revision;
  const branched = await createManagedBranch(workspace.root, project.record.containerPath, {
    sourceRevisionId: baseline.manifest.revisionId, name: "Lightweight bracket",
    reason: "Explore a lighter mounting solution without changing Main.",
  });
  const caseId = branched.createdBranchId;
  const caseFolder = branched.workingFolders[caseId]!;
  await caseFolder.writeFileBytes(["Bracket.SLDPRT"], bytes(4));
  await save(caseId, "Reduced bracket thickness");
  await caseFolder.writeFileBytes(["Bracket.SLDPRT"], bytes(5));
  await caseFolder.writeFileBytes(["Rib.SLDPRT"], bytes(5));
  await caseFolder.removeEntry(["Spacer.SLDPRT"]);
  const source = (await save(caseId, "Reinforced mounting rib", {
    notes: { problem: "Reduce bracket mass while retaining stiffness.", modification: "Added a rib and removed the trial spacer.", observations: "Check the design and assembly references in CAD." },
    fileNotes: [{ path: "Bracket.SLDPRT", problem: "Reduce bracket mass.", modification: "Reduced thickness with rib reinforcement.", observations: "Validate stiffness and rebuild the assembly in CAD." }],
  })).revision;
  await main.writeFileBytes(["Mount.SLDPRT"], bytes(6));
  const destination = (await save("branch-main", "Mounting detail refined", {
    notes: { problem: "Refine the Main mounting layout.", modification: "Updated Mount.SLDPRT independently.", observations: "Retain this Main update when reviewing the case." },
  })).revision;
  return { home, workspace, project, main, caseFolder, caseId, baseline, source, destination };
}
