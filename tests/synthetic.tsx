import "../src/index.css";
if (!import.meta.env.DEV)
  throw new Error("Synthetic preview is development-only");
import { createRoot } from "react-dom/client";
import App from "../src/App";
import { RealFileSystemAdapter } from "../src/engine/fs-adapter";
import {
  createHome,
  createHomeWorkspace,
  openHome,
} from "../src/engine/home-service";
import {
  importProject,
  createManagedBranch,
  resolveManagedProject,
} from "../src/engine/workspace-service";
import { captureRevision } from "../src/engine/revision-service";
import { rememberHome } from "../src/engine/idb-store";

const message = document.getElementById("preparing")!;
const nativeDate = Date;
let fixtureTime = nativeDate.parse("2026-10-17T00:00:00Z");
const notes = (
  problem: string,
  modification: string,
  observations: string,
) => ({ problem, modification, observations });
const catalogue = [
  {
    name: "Personal SolidWorks",
    projects: ["Linear Actuator", "Compact Gearbox", "Camera Mount"],
  },
  { name: "Client ABC", projects: ["Packaging Gripper", "Conveyor Drive"] },
  { name: "AutoCAD", projects: ["Workshop Layout", "Fixture Plate"] },
  { name: "Concept Lab", projects: ["Pump Housing", "Cable Guide"] },
];
const firstSummaries = [
  "Initial assembly and component set",
  "Resolve housing clearance",
  "Add bearing retainer and drawing",
  "Reduce wall thickness for weight",
  "Add ribs around mounting bosses",
  "Validate lightweight configuration",
  "Simplify machining setup",
  "Standardize fasteners and tolerances",
  "Prototype alternate actuator stroke",
  "Refine prototype mounting interface",
  "Update Main after design review",
  "Release Main for prototype manufacture",
];
const otherSummaries = [
  "Initial design baseline",
  "Refine interfaces and clearances",
  "Add manufacturing drawing",
  "Explore lighter construction",
  "Strengthen critical mounting features",
  "Simplify production setup",
];
function update(text: string) {
  message.textContent = text;
}

async function seed() {
  const storage = await navigator.storage.getDirectory();
  let root: RealFileSystemAdapter;
  let attempt = 0;
  while (true) {
    const name = `cAdtree Synthetic Preview v2${attempt ? ` (retry ${attempt})` : ""}`;
    root = new RealFileSystemAdapter(
      await storage.getDirectoryHandle(name, { create: true }),
    );
    if (await root.hasFile([".synthetic-seed-complete.json"]))
      return openHome(root);
    if (!(await root.hasFile([".cadtree-home.json"]))) break;
    // Retain interrupted sample files; the next isolated attempt gets a new folder.
    update(
      "Retained an interrupted synthetic setup. Preparing a fresh sample folder…",
    );
    attempt++;
  }
  // Only this synthetic fixture-generation phase uses a controlled clock.
  globalThis.Date = new Proxy(nativeDate, {
    construct(target, args) {
      return args.length
        ? Reflect.construct(target, args)
        : new target(fixtureTime);
    },
    get(target, prop) {
      return prop === "now" ? () => fixtureTime : Reflect.get(target, prop);
    },
  });
  try {
    await createHome(root);
    let projectIndex = 0;
    for (const group of catalogue) {
      update(`Creating ${group.name}…`);
      const workspace = (await createHomeWorkspace(root, group.name)).workspace;
      for (const name of group.projects) {
        const rich = projectIndex === 0;
        update(
          `Populating ${group.name} / ${name} (${projectIndex + 1} of 9)…`,
        );
        const sourceHandle = await storage.getDirectoryHandle(
          `sample-source-v2-${attempt}-${projectIndex}`,
          { create: true },
        );
        const source = new RealFileSystemAdapter(sourceHandle);
        const drawing = group.name === "AutoCAD";
        const file = drawing ? "Drawings/Layout.dwg" : "Parts/Housing.SLDPRT";
        const drawingFile = drawing
          ? "Drawings/Detail.dxf"
          : "Drawings/Assembly.SLDDRW";
        const files = drawing
          ? [
              "Drawings/Layout.dwg",
              "Drawings/Detail.dxf",
              "Reference/Dimensions.csv",
              "README.txt",
            ]
          : [
              "Actuator.SLDASM",
              "Parts/Housing.SLDPRT",
              "Parts/Shaft.SLDPRT",
              "Parts/Bearing.SLDPRT",
              "Drawings/Assembly.SLDDRW",
              "README.txt",
            ];
        for (const [i, path] of files.entries())
          await source.writeFileText(
            path.split("/"),
            `SYNTHETIC UI PREVIEW ONLY — NOT A VALID CAD DOCUMENT\nProject: ${name}\nFile: ${path}\nBaseline fixture ${i}\n`,
          );
        await source.getDirectory(["Reference", "Supplier documents"], {
          create: true,
        });
        let project = await importProject(workspace.root, source, name);
        const saved: string[] = [];
        async function capture(
          branchId: string,
          summary: string,
          stage: number,
        ) {
          fixtureTime += 6 * 3600000;
          const working = project.workingFolders[branchId]!;
          const changedFile = /drawing/i.test(summary) ? drawingFile : file;
          await working.writeFileText(
            changedFile.split("/"),
            `SYNTHETIC UI PREVIEW — NOT A VALID CAD FILE\n${name}\n${summary}\nDesign step ${stage}; branch ${branchId}\n`,
          );
          if (stage === 2)
            await working.writeFileText(
              ["Reference", "Tolerance review.csv"],
              "feature,target,measured\nShaft clearance,0.25,0.28\nMounting bore,8.0,8.01\n",
            );
          const result = await captureRevision(working, project.vaultDir, {
            branchId,
            summary,
            workingFolders: project.workingFolders,
            notes: notes(
              stage % 2
                ? "Review fit, service access, and assembly clearance."
                : "Prepare a more repeatable prototype manufacturing process.",
              summary,
              stage % 3
                ? "Synthetic design-review notes. Check the mating interfaces before release."
                : "Ready for the next design review; prototype validation remains pending.",
            ),
            fileNotes: [
              {
                path: changedFile,
                ...notes(
                  "Review the changed design document.",
                  summary,
                  "Synthetic review: validate before release.",
                ),
              },
            ],
          });
          saved.push(result.revision.manifest.revisionId);
          project = await resolveManagedProject(
            workspace.root,
            project.record.containerPath,
          );
          return result.revision.manifest.revisionId;
        }
        const summaries = rich ? firstSummaries : otherSummaries;
        for (let i = 0; i < 3; i++)
          await capture("branch-main", summaries[i], i + 1);
        const light = await createManagedBranch(
          workspace.root,
          project.record.containerPath,
          {
            sourceRevisionId: saved[1],
            name: "Lightweight concept",
            reason:
              "Explore reduced material while maintaining stiffness around mounting points.",
          },
        );
        project = light;
        for (let i = 0; i < (rich ? 3 : 2); i++)
          await capture(light.createdBranchId, summaries[3 + i], i + 4);
        const manufacturing = await createManagedBranch(
          workspace.root,
          project.record.containerPath,
          {
            sourceRevisionId: saved[2],
            name: "Manufacturing alternative",
            reason:
              "Reduce machining setups and standardize purchased hardware.",
          },
        );
        project = manufacturing;
        for (let i = 0; i < (rich ? 2 : 1); i++)
          await capture(
            manufacturing.createdBranchId,
            rich ? summaries[6 + i] : summaries[5],
            i + 7,
          );
        if (rich) {
          const prototype = await createManagedBranch(
            workspace.root,
            project.record.containerPath,
            {
              sourceRevisionId: saved[0],
              name: "Long-stroke prototype",
              reason:
                "Evaluate a longer travel option without disturbing the current release.",
            },
          );
          project = prototype;
          for (let i = 0; i < 2; i++)
            await capture(prototype.createdBranchId, summaries[8 + i], i + 9);
          for (let i = 0; i < 2; i++)
            await capture("branch-main", summaries[10 + i], i + 11);
        }
        const main = project.workingFolders["branch-main"]!;
        await main.writeFileText(
          file.split("/"),
          `SYNTHETIC CURRENT WORKING EDIT\n${name}: pending clearance adjustment; not yet captured.\n`,
        );
        await main.writeFileText(
          ["Reference", "Next review checklist.txt"],
          "SYNTHETIC NOTES\n- Check mounting clearance\n- Compare lightweight alternative\n- Confirm fastener access\n",
        );
        await project.workingFolders[light.createdBranchId]!.writeFileText(
          ["Reference", "Prototype observations.txt"],
          "Synthetic uncaptured observations: evaluate rib thickness in the next prototype.",
        );
        projectIndex++;
      }
    }
    const complete = await openHome(root);
    const projects = complete.workspaces.flatMap(
      (entry) => entry.workspace?.projects ?? [],
    );
    if (
      complete.workspaces.length !== 4 ||
      projects.length !== 9 ||
      projects.reduce(
        (sum, project) =>
          sum + (project.project?.vaultState.revisions.length ?? 0),
        0,
      ) !== 60
    )
      throw new Error(
        "Synthetic setup did not finish; the partial data was retained.",
      );
    await root.writeFileText(
      [".synthetic-seed-complete.json"],
      JSON.stringify({ version: 2 }),
    );
    return complete;
  } finally {
    globalThis.Date = nativeDate;
  }
}

async function start() {
  const home = await navigator.locks.request("cadtree-synthetic-seed-v2", seed);
  const projects = home.workspaces.flatMap((e) => e.workspace!.projects);
  const branchCount = projects.reduce(
    (total, p) => total + p.project!.vaultState.branches.length,
    0,
  );
  const revisionCount = projects.reduce(
    (total, p) => total + p.project!.vaultState.revisions.length,
    0,
  );
  await rememberHome({
    homeId: home.identity.homeId,
    name: home.root.name,
    rootHandle: (home.root as RealFileSystemAdapter).handle,
  });
  document.getElementById("demo-counts")!.textContent =
    `${home.workspaces.length} workspaces · ${projects.length} projects · ${branchCount} branches · ${revisionCount} revisions`;
  document.getElementById("loading")!.remove();
  createRoot(document.getElementById("root")!).render(<App />);
}
start().catch((error) => {
  update(
    `Sample setup stopped: ${error.message}. No real CAD folders were accessed.`,
  );
  console.error(error);
});
