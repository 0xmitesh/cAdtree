import type { TutorialDefinition } from "./start-tutorial";

export const BRING_EXISTING_WORK_TUTORIAL: TutorialDefinition = {
  id: "bring-existing-work",
  title: "Bring existing work into cAdtree",
  steps: [
    {
      id: "create-or-import",
      title: "Create or import?",
      summary: "Create starts new work. Import brings existing work into a managed copy.",
      points: [
        "Start with a connected Cadtree Home. Import existing workspace is for a workspace already created by cAdtree.",
        "For an ordinary CAD folder, create or open a workspace, then choose Import existing project.",
      ],
      visuals: [{
        src: "/tutorials/bring-existing-work/step-1-create-or-import.svg",
        alt: "Create workspace and Create project start new managed work. Import existing workspace copies a cAdtree workspace; Import existing project can copy an ordinary CAD folder.",
        caption: "Choose Create for new work; choose Import for existing work.",
        kind: "concept",
      }],
    },
    {
      id: "import-workspace",
      title: "Import an existing workspace",
      summary: "In My workspaces, open Home options and choose Import existing workspace.",
      points: [
        "Select the complete Client A cAdtree workspace folder, not its parent or Cadtree Home.",
        "The folder picker follows the import dialog. After a successful import, Client A opens automatically.",
      ],
      visuals: [
        {
          src: "/tutorials/bring-existing-work/step-2-workspace-menu.png",
          alt: "Real My workspaces page with Home options expanded and Import existing workspace highlighted.",
          caption: "1. Open Home options and choose Import existing workspace.",
          kind: "cadtree",
        },
        {
          src: "/tutorials/bring-existing-work/step-2-workspace-dialog.png",
          alt: "Real Import existing workspace dialog explains the managed copy and shows Choose workspace folder highlighted.",
          caption: "2. Read the managed-copy notice and click Choose workspace folder.",
          kind: "cadtree",
        },
        {
          src: "/tutorials/bring-existing-work/step-2-windows-workspace.png",
          alt: "Synthetic Windows folder picker at Documents, Engineering, with Client A selected and a cursor over Select Folder.",
          caption: "3. Select Client A, the existing cAdtree workspace, and click Select Folder.",
          kind: "os",
        },
      ],
    },
    {
      id: "workspace-copy",
      title: "What happens to the workspace?",
      summary: "cAdtree creates a verified managed copy inside Cadtree Home. The original workspace stays unchanged.",
      points: [
        "The copy includes existing projects, saved history and working edits not yet captured. cAdtree records the workspace in this home.",
        "After a successful import, the source location is no longer required for the managed copy. The two copies are not synchronized.",
      ],
      visuals: [{
        src: "/tutorials/bring-existing-work/step-3-workspace-copy.svg",
        alt: "Existing Client A cAdtree workspace stays at Documents/Engineering/Client A. A verified independent copy is registered inside Cadtree Home, including projects, history and working edits.",
        caption: "Import copies and verifies the workspace; it does not move or synchronize the source.",
        kind: "concept",
      }],
    },
    {
      id: "import-project",
      title: "Import an existing project",
      summary: "Inside Client A, choose Import existing project for the separate Bracket Assembly CAD folder.",
      points: [
        "Save and close CAD documents first. Select Bracket Assembly itself, containing Bracket.SLDPRT, Mount.SLDPRT and BracketAssembly.SLDASM.",
        "An ordinary CAD folder supplies the new project name. Choose a source outside the destination workspace.",
      ],
      visuals: [
        {
          src: "/tutorials/bring-existing-work/step-4-project-action.png",
          alt: "Real Client A workspace heading with Import existing project highlighted beside Create project.",
          caption: "1. In Client A, click Import existing project.",
          kind: "cadtree",
        },
        {
          src: "/tutorials/bring-existing-work/step-4-project-dialog.png",
          alt: "Real Import existing project dialog describes the copy, advises saving and closing CAD documents, and highlights Choose project folder.",
          caption: "2. Read the import notice and click Choose project folder.",
          kind: "cadtree",
        },
        {
          src: "/tutorials/bring-existing-work/step-4-windows-project.png",
          alt: "Synthetic Windows folder picker at Documents, Engineering, with Bracket Assembly selected and a cursor over Select Folder.",
          caption: "3. Select the Bracket Assembly CAD project folder and click Select Folder.",
          kind: "os",
        },
      ],
    },
    {
      id: "managed-working-copy",
      title: "Your existing files and cAdtree",
      summary: "For an ordinary CAD folder, cAdtree copies the files into a new managed project's Main working/main folder.",
      points: [
        "Edit the managed Main copy from now on. The original Bracket Assembly folder stays unchanged; edits are not synchronized between copies.",
        "cAdtree creates project records and a revision vault. Ordinary CAD-folder import does not create a saved revision.",
      ],
      note: "Check CAD references in the managed copy after import. cAdtree does not rewrite native CAD references.",
      visuals: [{
        src: "/tutorials/bring-existing-work/step-5-managed-files.svg",
        alt: "Original Bracket Assembly CAD folder remains unchanged. The new managed project inside Cadtree Home and Client A contains working/main for editing and a separate vault for saved history. Display names simplify generated folder suffixes.",
        caption: "Work in the managed working/main copy. The original is a separate copy, not a live connection.",
        kind: "concept",
      }],
    },
    {
      id: "imported-and-ready",
      title: "Imported and ready",
      summary: "Your existing work is now available in cAdtree.",
      points: [
        "Open Client A from My workspaces, then open Bracket Assembly. In Settings, Working folder shows the Main location relative to the workspace.",
        "Use that managed copy for CAD work. Follow Save your first revision to record its first meaningful design state.",
      ],
      visuals: [
        {
          src: "/tutorials/bring-existing-work/step-6-workspaces.png",
          alt: "Real My workspaces page shows Client A connected with one project and an Open workspace button.",
          caption: "1. Find Client A in My workspaces and click Open workspace.",
          kind: "cadtree",
        },
        {
          src: "/tutorials/bring-existing-work/step-6-projects.png",
          alt: "Real Client A workspace lists the managed Bracket Assembly project with Open project.",
          caption: "2. Find Bracket Assembly in Client A and click Open project.",
          kind: "cadtree",
        },
        {
          src: "/tutorials/bring-existing-work/step-6-managed-main.png",
          alt: "Real Bracket Assembly Settings shows Working folder ending in working/main under the generated managed project folder, with a separate revision vault.",
          caption: "3. Open Settings and find Working folder: this managed working/main is where you work.",
          kind: "cadtree",
        },
      ],
      nextHint: "Next: explore another design direction.",
    },
  ],
};
