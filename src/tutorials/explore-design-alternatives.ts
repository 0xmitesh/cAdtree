import type { TutorialDefinition } from "./start-tutorial";

export const EXPLORE_DESIGN_ALTERNATIVES_TUTORIAL: TutorialDefinition = {
  id: "explore-design-alternatives",
  title: "Explore design alternatives",
  steps: [
    {
      id: "main-and-alternatives",
      title: "Main and design alternatives",
      summary: "Main is your primary design direction. A Design Case lets you explore an alternative without changing Main.",
      points: [
        "Create a case to test a lighter bracket or a different mounting arrangement.",
        "This example starts Lightweight bracket from the reviewed Main baseline, Rev 003. The current case, shown above each project page, identifies the direction you are editing.",
      ],
      visuals: [{
        src: "/tutorials/explore-design-alternatives/step-1-design-directions.svg",
        alt: "Main saves Rev 001, Rev 002 and Rev 003. Lightweight bracket is a Design Case starting from Rev 003 in its own working location; Main remains a separate direction.",
        caption: "Start an alternative from a saved baseline while keeping Main separate.",
        kind: "concept",
      }],
    },
    {
      id: "saved-revision",
      title: "Start from a saved revision",
      summary: "In History, select the saved revision where the alternative should begin, then choose Create design case from this revision.",
      points: [
        "Choose Rev 003 — Reviewed design baseline in Bracket Assembly.",
        "A saved revision gives the case a recorded starting point and a complete project copy. Newer unsaved working edits are not included. Inspecting a revision does not switch your working case.",
      ],
      visuals: [
        {
          src: "/tutorials/explore-design-alternatives/step-2-choose-revision.png",
          alt: "Close view of the real Bracket Assembly History graph with Main's Rev 001 through Rev 003 and Reviewed design baseline selected.",
          caption: "1. Choose the revision where the alternative should begin.",
          kind: "cadtree",
        },
        {
          src: "/tutorials/explore-design-alternatives/step-2-create-action.png",
          alt: "Close view of the real History actions for the selected revision, with Create design case from this revision focused.",
          caption: "2. Click Create design case from this revision for the selected saved revision.",
          kind: "cadtree",
        },
      ],
    },
    {
      id: "name-case",
      title: "Name the Design Case",
      summary: "In Create design case, enter a Case name and Engineering reason, then click Create design case.",
      points: [
        "Case name: Lightweight bracket. Engineering reason: Explore a lighter mounting solution without changing Main.",
        "For this managed project, cAdtree creates and verifies a fresh working folder automatically. No folder picker is needed. The new case becomes active; creation adds no revision.",
      ],
      visuals: [{
        src: "/tutorials/explore-design-alternatives/step-3-create-dialog.png",
        alt: "Close view of the real Create design case form: Lightweight bracket in Case name, the engineering reason filled, automatic destination guidance and Create design case focused.",
        caption: "Name the alternative, explain why, then click Create design case.",
        kind: "cadtree",
      }],
    },
    {
      id: "working-locations",
      title: "A separate working location",
      summary: "Main and the Design Case have separate working locations inside the same managed project.",
      points: [
        "Main uses working/main. Lightweight bracket uses its own folder named after the case, working/Lightweight bracket. Editing that case's files does not directly modify Main.",
        "Settings → Working folder shows the active direction's exact location. In Changes, reveal unchanged files if needed and use a file's Copy folder path; paste it into your file manager to reach that folder.",
        "Open the CAD files from that location. Keep managed folders where cAdtree creates them.",
      ],
      visuals: [
        {
          src: "/tutorials/explore-design-alternatives/step-4-working-locations.svg",
          alt: "Bracket Assembly has two separate children under working: main for Main, and a folder named after the case for Lightweight bracket. Saved history is shared in the project's separate vault. Settings shows exact locations.",
          caption: "Two working folders, one project: edit the folder for your chosen direction.",
          kind: "concept",
        },
        {
          src: "/tutorials/explore-design-alternatives/step-4-case-location.png",
          alt: "Real shared project header shows Working case Lightweight bracket; Settings shows Working folder ending in working slash Lightweight bracket.",
          caption: "1. In Settings, check Working folder for the active case's exact location.",
          kind: "cadtree",
        },
        {
          src: "/tutorials/explore-design-alternatives/step-4-copy-folder-path.png",
          alt: "Real Changes view on Lightweight bracket with unchanged files revealed and Copy folder path for Bracket.SLDPRT focused.",
          caption: "2. In Changes, reveal unchanged files if needed and use Copy folder path.",
          kind: "cadtree",
        },
      ],
    },
    {
      id: "switch-directions",
      title: "Switch between design directions",
      summary: "Choose Main or Lightweight bracket in the Explorer. The current case is named above History, Changes and Settings; check it before working.",
      points: [
        "cAdtree scans and saves from the selected case's working folder. The current case stays named above the project views; inspecting an old revision does not change the working case.",
        "Switch back to Main in the Explorer. Each direction keeps its own files; switching does not replace the other folder's contents.",
      ],
      note: "Save and close CAD documents before moving to the other working location, then open its files manually. cAdtree does not launch CAD or change which documents CAD has open.",
      visuals: [
        {
          src: "/tutorials/explore-design-alternatives/step-5-main-active.png",
          alt: "Real Bracket Assembly shared project header shows Main selected in Working case; Settings shows its Working folder ending in working/main.",
          caption: "1. Main is active; Working folder identifies Main's files.",
          kind: "cadtree",
        },
        {
          src: "/tutorials/explore-design-alternatives/step-5-case-active.png",
          alt: "Real shared Working case selector has Lightweight bracket selected; Settings shows its separate Working folder.",
          caption: "2. Choose Lightweight bracket in the Explorer to work on the alternative.",
          kind: "cadtree",
        },
        {
          src: "/tutorials/explore-design-alternatives/step-5-case-origin.png",
          alt: "Real shared header shows Working case Lightweight bracket above History, Started from Rev 003 on Main and the case's engineering reason.",
          caption: "3. History confirms the current case and the saved revision it started from.",
          kind: "cadtree",
        },
      ],
    },
    {
      id: "keep-histories",
      title: "Keep both histories",
      summary: "Continue saving meaningful revisions in whichever design direction you are working on: save CAD files, scan and review Changes, then Save revision.",
      points: [
        "The case's first changed save follows Rev 003. In this example, Lightweight bracket gets Rev 004 and Rev 005; Main later gets Rev 006 with Rev 003 as its parent. Numbers run across the whole project, not from one on each case.",
        "Both histories keep their connection to the starting revision. Do not delete a useful alternative just because it did not become Main.",
        "Finished alternatives can be archived in History → Design cases while preserving their working folder and saved history. Main cannot be archived.",
      ],
      visuals: [
        {
          src: "/tutorials/explore-design-alternatives/step-6-independent-history.svg",
          alt: "Project-wide numbering: Main Rev 001 to Rev 002 to Rev 003, then Main Rev 006. Lightweight bracket branches from Rev 003 to Rev 004, Reduced bracket thickness, then Rev 005, Reinforced mounting rib. Main Rev 006 has Rev 003 as its parent, not the case's Rev 005.",
          caption: "Separate histories share an origin; revision numbers belong to the whole project.",
          kind: "concept",
        },
        {
          src: "/tutorials/explore-design-alternatives/step-6-saved-histories.png",
          alt: "Close view of the real Bracket Assembly History graph: Main's Rev 003 baseline connects to Lightweight bracket Rev 004 and Rev 005 and Main Rev 006.",
          caption: "Both design directions remain in the project's saved history.",
          kind: "cadtree",
        },
      ],
      nextHint: "Next: compare, apply and recover designs.",
    },
  ],
};
