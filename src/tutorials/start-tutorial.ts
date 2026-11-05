export interface TutorialHierarchyNode {
  label: string;
  detail: string;
  depth: number;
  highlight?: boolean;
}

export type TutorialVisualKind = "cadtree" | "os" | "concept";

export interface TutorialVisualAsset {
  src: string;
  alt: string;
  caption: string;
  kind: TutorialVisualKind;
}

export interface TutorialStep {
  id: string;
  title: string;
  summary: string;
  points: string[];
  note?: string;
  nextHint?: string;
  hierarchy?: TutorialHierarchyNode[];
  visuals?: TutorialVisualAsset[];
}

export interface TutorialDefinition {
  id: string;
  title: string;
  steps: TutorialStep[];
}

export const START_TUTORIAL: TutorialDefinition = {
  id: "start-with-cadtree",
  title: "Start with cAdtree",
  steps: [
    {
      id: "cadtree-home",
      title: "Cadtree Home",
      summary:
        "Cadtree Home is one dedicated folder on your computer that holds all of your cAdtree workspaces and projects.",
      points: [
        "Inside Cadtree Home, work is organized into three levels: Cadtree Home, Workspace, and Project.",
        "cAdtree manages the folder structure inside Cadtree Home on your local drive.",
      ],
      hierarchy: [
        {
          label: "Cadtree Home",
          detail: "Dedicated root folder on your computer",
          depth: 0,
          highlight: true,
        },
        {
          label: "Workspace",
          detail: "Groups related projects by client, team, or CAD tool",
          depth: 1,
        },
        {
          label: "Project",
          detail: "Holds one engineering design and its working folder",
          depth: 2,
        },
      ],
    },
    {
      id: "create-connect-home",
      title: "Create Cadtree Home",
      summary:
        "Click Start my Cadtree home and select an empty dedicated folder, or click Open my Cadtree home for an existing one.",
      points: [],
      visuals: [
        {
          src: "/tutorials/start-with-cadtree/step-2-start-home.png",
          alt: "cAdtree Welcome screen card showing Start my Cadtree home button",
          caption: "1. Click Start my Cadtree home.",
          kind: "cadtree",
        },
        {
          src: "/tutorials/start-with-cadtree/step-2-windows-select-folder.svg",
          alt: "Synthetic Windows Select Folder dialog showing Documents and the empty Cadtree folder selected with a mouse cursor on Select Folder",
          caption: "2. Select a dedicated empty folder for Cadtree Home.",
          kind: "os",
        },
      ],
    },
    {
      id: "copy-home-address",
      title: "Copy the Cadtree Home address",
      summary:
        "Copy the absolute path of the Cadtree Home folder you selected, then paste it into cAdtree.",
      points: [
        "Windows may copy the path in quotation marks. Paste it directly; cAdtree removes matching surrounding quotes automatically.",
        "Use the address of your own selected folder. D:\\Cadtree is only an example.",
      ],
      visuals: [
        {
          src: "/tutorials/start-with-cadtree/step-3-windows-copy-as-path.png",
          alt: "Synthetic Windows 11 File Explorer in Documents with the generic Cadtree folder selected and the cursor pointing to Copy as path in its context menu",
          caption: "1. In File Explorer, right-click Cadtree Home and choose Copy as path.",
          kind: "os",
        },
        {
          src: "/tutorials/start-with-cadtree/step-2-complete-home-setup.png",
          alt: "Real cAdtree Complete home setup dialog with D:\\Cadtree in Cadtree home folder address and Complete setup highlighted",
          caption: "2. Paste the folder address into cAdtree and click Complete setup.",
          kind: "cadtree",
        },
      ],
      note:
        "The browser can access the selected folder but cannot provide or verify its full local filesystem address. cAdtree uses the address you enter for Copy path shortcuts.",
    },
    {
      id: "workspace",
      title: "Workspace",
      summary:
        "A workspace groups related projects inside your Cadtree Home—for example by client, product line, or CAD application.",
      points: [
        "cAdtree creates the workspace folder inside Cadtree Home automatically without opening another folder picker.",
      ],
      visuals: [
        {
          src: "/tutorials/start-with-cadtree/step-3-my-workspaces.png",
          alt: "My workspaces screen showing the Create workspace button",
          caption: "1. Click Create workspace.",
          kind: "cadtree",
        },
        {
          src: "/tutorials/start-with-cadtree/step-3-create-workspace-dialog.png",
          alt: "Create workspace dialog with My Workspace entered as the workspace name",
          caption: "2. Name the workspace and create it.",
          kind: "cadtree",
        },
      ],
    },
    {
      id: "project",
      title: "Project",
      summary:
        "A project holds the CAD files and version history for one engineering design or assembly.",
      points: [
        "cAdtree creates the project and its Main working folder (working/main) inside the workspace automatically.",
      ],
      visuals: [
        {
          src: "/tutorials/start-with-cadtree/step-4-workspace-projects.png",
          alt: "My Workspace screen showing the Create project button",
          caption: "1. Click Create project.",
          kind: "cadtree",
        },
        {
          src: "/tutorials/start-with-cadtree/step-4-create-project-dialog.png",
          alt: "Create project dialog with My Project entered as the project name",
          caption: "2. Name the project and create it.",
          kind: "cadtree",
        },
      ],
    },
    {
      id: "ready-to-work",
      title: "Ready to work",
      summary:
        "Your project is created and ready for CAD work and version tracking.",
      points: [
        "Place and edit your CAD files inside the project's Main working folder (working/main).",
        "Use Copy path to copy the working folder location, then paste it into your system file manager (such as File Explorer or Finder) when you need to reach your CAD files.",
      ],
      hierarchy: [
        {
          label: "Cadtree Home",
          detail: "D:\\Cadtree",
          depth: 0,
        },
        {
          label: "My Workspace",
          detail: "Workspace folder inside Cadtree Home",
          depth: 1,
        },
        {
          label: "My Project",
          detail: "Project folder inside My Workspace",
          depth: 2,
          highlight: true,
        },
        {
          label: "working/main",
          detail: "Main working folder — place your live CAD files here",
          depth: 3,
          highlight: true,
        },
      ],
      nextHint: "Next: save your first revision.",
    },
  ],
};

export function clampTutorialStep(index: number, totalSteps: number): number {
  if (totalSteps <= 0) return 0;
  return Math.max(0, Math.min(totalSteps - 1, index));
}
