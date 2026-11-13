import type { TutorialDefinition } from "./start-tutorial";

export const SAVE_FIRST_REVISION_TUTORIAL: TutorialDefinition = {
  id: "save-first-revision",
  title: "Save your first revision",
  steps: [
    {
      id: "cad-saves-and-revisions",
      title: "CAD saves and cAdtree revisions",
      summary: "Keep saving normally in your CAD application.",
      points: [
        "Create a cAdtree revision when the design reaches a meaningful engineering state worth keeping.",
        "Example: mounting geometry finalized after a clearance review.",
      ],
      visuals: [{
        src: "/tutorials/save-first-revision/step-1-saves-and-revisions.svg",
        alt: "Normal CAD work has repeated saves; cAdtree records fewer meaningful milestones as Rev 001 and Rev 002.",
        caption: "CAD Save ≠ cAdtree Revision: keep normal saves; record milestones as revisions.",
        kind: "concept",
      }],
    },
    {
      id: "reach-cad-files",
      title: "Reach your CAD files",
      summary: "Your live CAD files belong in Main's working/main folder.",
      points: [
        "For an empty project, open Settings. Working folder shows the location relative to your workspace; place your CAD files there.",
        "Copy folder path copies a listed file's containing folder. Paste it into File Explorer's address bar.",
      ],
      visuals: [
        {
          src: "/tutorials/save-first-revision/step-2-working-folder.png",
          alt: "Real cAdtree Settings, Folder connections: Working folder ends in projects/Bracket Assembly, then working/main.",
          caption: "1. Open Settings and find Working folder; place your CAD files in this working/main folder.",
          kind: "cadtree",
        },
        {
          src: "/tutorials/save-first-revision/step-2-copy-folder-path.png",
          alt: "Real Changes list containing Bracket.SLDPRT, BracketAssembly.SLDASM and Mount.SLDPRT, with Bracket's Copy folder path icon highlighted.",
          caption: "2. Open Changes, click Scan for changes, then use Copy folder path beside a listed file.",
          kind: "cadtree",
        },
        {
          src: "/tutorials/save-first-revision/step-2-windows-address.png",
          alt: "Synthetic Windows 11 File Explorer with a cursor in the address bar, an illustrative Bracket Assembly working/main path and the three sample CAD files.",
          caption: "3. In File Explorer, press Ctrl+L, paste the copied folder path and press Enter.",
          kind: "os",
        },
      ],
    },
    {
      id: "make-a-change",
      title: "Make a change",
      summary: "Edit Bracket.SLDPRT and save it normally in your CAD application.",
      points: [
        "Save and close the CAD documents before returning to cAdtree to scan.",
        "cAdtree detects saved file changes when you scan; it does not interpret geometry or monitor CAD edits in real time.",
      ],
      visuals: [{
        src: "/tutorials/save-first-revision/step-3-normal-cad-work.svg",
        alt: "Edit and save Bracket.SLDPRT in CAD, close the CAD documents, then use Scan for changes in cAdtree.",
        caption: "Edit in CAD → Save normally → Close documents → Scan in cAdtree.",
        kind: "concept",
      }],
    },
    {
      id: "review-changes",
      title: "Review detected changes",
      summary: "In Changes, click Scan for changes after saving and closing your CAD documents.",
      points: [
        "Review each listed file before saving a revision.",
        "On the first revision, files appear as Added. After a baseline exists, an edited file can appear as Modified.",
      ],
      note: "A revision saves the complete project state. File selections apply only to notes.",
      visuals: [
        {
          src: "/tutorials/save-first-revision/step-4-scan.png",
          alt: "Real Bracket Assembly project header with Working case Main above Changes and the Scan for changes button highlighted.",
          caption: "1. Click Scan for changes to refresh the list from your saved files.",
          kind: "cadtree",
        },
        {
          src: "/tutorials/save-first-revision/step-4-added-files.png",
          alt: "Real Changes list shows three Added files, zero Modified and zero Deleted; Bracket.SLDPRT now contains the saved edit.",
          caption: "2. Review what cAdtree detected. This first capture contains three Added files.",
          kind: "cadtree",
        },
      ],
    },
    {
      id: "revision-notes",
      title: "Add useful revision notes",
      summary: "Revision notes should explain why the design changed, not just that a file changed.",
      points: [
        "Enter a required Revision summary, such as “Finalize bracket mounting flange after stress review.”",
        "Add note supports Problem or intent, Engineering change and Observations. Overall engineering notes are optional too.",
      ],
      visuals: [
        {
          src: "/tutorials/save-first-revision/step-5-summary.png",
          alt: "Real Save revision form with Revision summary set to Finalize bracket mounting flange after stress review.",
          caption: "1. Enter a short Revision summary for the saved design state.",
          kind: "cadtree",
        },
        {
          src: "/tutorials/save-first-revision/step-5-file-note.png",
          alt: "Real Bracket.SLDPRT note editor with Problem or intent, Engineering change and Observations, explaining a flange change from 4 mm to 5 mm after stress review.",
          caption: "2. Add note for Bracket.SLDPRT: “Increased mounting flange thickness from 4 mm to 5 mm after stress review.”",
          kind: "cadtree",
        },
      ],
    },
    {
      id: "save-first-revision",
      title: "Save your first revision",
      summary: "When the design state is worth keeping, click Save revision.",
      points: [
        "cAdtree scans again before saving; if the files changed, review the updated list and retry.",
        "Your normal CAD files remain the working files. The saved revision can later be compared, recovered or used as a starting point for another design direction.",
      ],
      visuals: [
        {
          src: "/tutorials/save-first-revision/step-6-save.png",
          alt: "Real Save revision form with the example summary and Bracket.SLDPRT file note, and the Save revision button highlighted.",
          caption: "1. Click Save revision after reviewing the files and notes.",
          kind: "cadtree",
        },
        {
          src: "/tutorials/save-first-revision/step-6-history.png",
          alt: "Real Bracket Assembly History showing the first Main revision, Rev 001 in its detail header and R001 on the graph, with the saved summary.",
          caption: "2. Open History to find Rev 001 and its saved summary.",
          kind: "cadtree",
        },
      ],
      nextHint: "Your first meaningful design state is saved.",
    },
  ],
};
