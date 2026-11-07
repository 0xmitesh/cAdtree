import type { TutorialDefinition } from "./start-tutorial";

export const COMPARE_APPLY_RECOVER_TUTORIAL: TutorialDefinition = {
  id: "compare-apply-recover",
  title: "Compare, apply & recover",
  steps: [
    {
      id: "compare-before-deciding",
      title: "Compare before deciding",
      summary: "Before bringing another design direction into Main, compare the saved states first.",
      points: [
        "In Bracket Assembly, Lightweight bracket starts from Main's Rev 003. The case reaches Rev 005 while Main continues to Rev 006.",
        "Compare Main Rev 006 with case Rev 005 to see which project files differ. These are saved states, not unsaved work in CAD.",
      ],
      visuals: [{
        src: "/tutorials/compare-apply-recover/step-1-compare-directions.svg",
        alt: "Main and Lightweight bracket share Rev 003. The case continues through Rev 004 to Rev 005; Main continues to Rev 006. Compare the saved Main Rev 006 and case Rev 005 before deciding.",
        caption: "Compare the saved Main and Design Case states before deciding what to reuse.",
        kind: "concept",
      }],
    },
    {
      id: "compare-saved-revisions",
      title: "Compare saved revisions",
      summary: "In History, select Rev 005 — Reinforced mounting rib, then click Compare.",
      points: [
        "Choose From revision: Rev 006 on Main, and To revision: Rev 005 on Lightweight bracket. You can compare any two available saved revisions, including across design cases.",
        "Added and deleted are relative to From → To. Swap reverses that direction. Review the file counts and recorded overall and per-file engineering notes.",
      ],
      visuals: [
        {
          src: "/tutorials/compare-apply-recover/step-2-open-compare.png",
          alt: "Real History details for Rev 005, Reinforced mounting rib on Lightweight bracket, with Compare focused.",
          caption: "1. Select the saved revision in History and click Compare.",
          kind: "cadtree",
        },
        {
          src: "/tutorials/compare-apply-recover/step-2-choose-states.png",
          alt: "Real Compare saved revisions selectors show From Rev 006 on Main and To Rev 005 on Lightweight bracket, with Swap between them.",
          caption: "2. Choose From and To; Swap reverses the comparison.",
          kind: "cadtree",
        },
        {
          src: "/tutorials/compare-apply-recover/step-2-file-differences.png",
          alt: "Real comparison shows one added, one deleted, two modified and one unchanged file, plus Bracket.SLDPRT's saved presence, content-hash controls and per-file notes.",
          caption: "3. Review the file differences and the saved notes for Bracket.SLDPRT.",
          kind: "cadtree",
        },
        {
          src: "/tutorials/compare-apply-recover/step-2-engineering-notes.png",
          alt: "Real Overall engineering notes compare Main Rev 006's mounting update with case Rev 005's lighter bracket and reinforcement study.",
          caption: "4. Read the engineering notes recorded at each selected revision.",
          kind: "cadtree",
        },
      ],
    },
    {
      id: "file-level-evidence",
      title: "Understand what Compare means",
      summary: "Modified means the saved content hashes differ for the same file path. It does not tell you which CAD features or geometry changed.",
      points: [
        "Added means present only in To; deleted means present only in From. Unchanged means matching saved content hashes. File metadata edits can change a hash too.",
        "Compare also lists directory additions and deletions, including empty folders. It does not assess stress, assembly references or CAD compatibility.",
        "Compare reads saved records; it does not rescan working files or recheck stored binary contents. Missing or damaged revision evidence makes the comparison unavailable.",
      ],
      visuals: [{
        src: "/tutorials/compare-apply-recover/step-3-file-evidence.svg",
        alt: "At the same Bracket.SLDPRT path, Main Rev 006 has saved content A and case Rev 005 has saved content B. Different saved content hashes mean Modified; geometry and CAD compatibility still need engineering review.",
        caption: "A file-level difference is evidence to review, not a geometry or compatibility result.",
        kind: "concept",
      }],
    },
    {
      id: "review-before-applying",
      title: "Review before applying",
      summary: "Keep Main active. In History, select the case's Rev 005, then choose Review changes to apply.",
      points: [
        "Source is the saved design you are bringing work from: Rev 005. Destination is the active direction you are updating: Main, with saved baseline Rev 006. Base is their shared starting state, Rev 003.",
        "Nothing starts selected. Choose the exact file actions and add an engineering reason. Here, replace Bracket.SLDPRT, add Rib.SLDPRT and delete Spacer.SLDPRT; Main's independent Mount.SLDPRT update stays.",
        "Resolve any Conflict explicitly. If saved evidence changes, use Refresh saved states and review again. An unavailable preview is not permission to apply.",
      ],
      note: "This is a file-action review. Existing destination folders stay; empty-folder-only changes are not applied. No working files change during this review.",
      visuals: [
        {
          src: "/tutorials/compare-apply-recover/step-4-open-review.png",
          alt: "Real History details for source Rev 005 on Lightweight bracket with Review changes to apply focused; Main remains the active destination.",
          caption: "1. With Main active, review the saved case revision before changing Main.",
          kind: "cadtree",
        },
        {
          src: "/tutorials/compare-apply-recover/step-4-source-destination.png",
          alt: "Real review planner shows Base Rev 003 on Main, Source Rev 005 on Lightweight bracket and Destination Rev 006 on the Main working case.",
          caption: "2. Check Base, Source and Destination — including Main's saved baseline.",
          kind: "cadtree",
        },
        {
          src: "/tutorials/compare-apply-recover/step-4-selected-actions.png",
          alt: "Real source-change checkboxes select a Bracket.SLDPRT modification, Rib.SLDPRT addition and Spacer.SLDPRT deletion; the deletion notice says the destination file will be deleted.",
          caption: "3. Select only the file actions you intend, including any explicit deletion.",
          kind: "cadtree",
        },
      ],
    },
    {
      id: "apply-and-save",
      title: "Apply reviewed changes",
      summary: "Choose Prepare application to check the destination, then review Confirm working-file application.",
      points: [
        "Preparation needs read/write access and a destination matching its saved baseline. Save uncaptured Main work as a normal revision, then refresh and review again.",
        "Check Destination: Main, its connected folder, baseline Rev 006, Source Rev 005 and the exact additions, replacements and deletions. Save and close relevant CAD documents, check the confirmation and choose Apply confirmed changes.",
        "Apply changes working files; no revision is saved yet. Open Main manually in CAD, check references and rebuild, then save and close after adjustments. In Changes, scan, review and Save revision: Main Rev 007 in this example.",
      ],
      note: "Keep other apps and sync from writing during Apply; cAdtree cannot lock them or make multiple file writes atomic. Apply does not delete or archive the Design Case.",
      visuals: [
        {
          src: "/tutorials/compare-apply-recover/step-5-confirm-actions.png",
          alt: "Real confirmation identifies Bracket Assembly, Destination Main, its connected working location, baseline Rev 006, Source Rev 005 and the three confirmed file actions.",
          caption: "1. Confirm Main, its working location and the exact file actions.",
          kind: "cadtree",
        },
        {
          src: "/tutorials/compare-apply-recover/step-5-confirm-apply.png",
          alt: "Real saved-and-closed CAD confirmation checkbox is checked and Apply confirmed changes is focused.",
          caption: "2. Save and close CAD documents, confirm the destination, then apply.",
          kind: "cadtree",
        },
        {
          src: "/tutorials/compare-apply-recover/step-5-applied-working-files.png",
          alt: "Real Application completed dialog says Applied to working files — revision not yet saved, and instructs checking the destination in CAD before saving a normal revision.",
          caption: "3. Applied working files still need your CAD check and a saved revision.",
          kind: "cadtree",
        },
        {
          src: "/tutorials/compare-apply-recover/step-5-saved-main.png",
          alt: "Real History shows Main Rev 007, Adopt lightweight bracket after review, and Applied from Rev 005 on Lightweight bracket.",
          caption: "4. After the CAD check, save the reviewed Main state; its application origin is retained.",
          kind: "cadtree",
        },
      ],
    },
    {
      id: "return-to-earlier-work",
      title: "Return to earlier work",
      summary: "A saved revision gives you a known design state to return to. Restore project copy recovers it into another folder.",
      points: [
        "Select Rev 003 in History and choose Restore project copy. Check the revision and file count, keep the managed destination and click Restore copy.",
        "cAdtree creates a verified fresh copy under this project's recoveries folder. Recovery report shows its location; Restored files — copy paths provides Copy folder path so you can reach and open it manually.",
        "Main and the case stay unchanged. This does not switch the working case or create a revision. Viewing an old revision alone restores nothing; this recovery is a separate copy, not a destructive rollback.",
      ],
      visuals: [
        {
          src: "/tutorials/compare-apply-recover/step-6-recovery-copy.svg",
          alt: "Saved Rev 003 is copied into a new recovery folder. Current Main Rev 007 and Lightweight bracket working files remain in place and unchanged; recovery adds no revision.",
          caption: "Recover an earlier saved state as a separate copy while keeping current work.",
          kind: "concept",
        },
        {
          src: "/tutorials/compare-apply-recover/step-6-restore-action.png",
          alt: "Real History action group for the selected Rev 003 with Restore project copy focused.",
          caption: "1. Select the earlier revision in History, then choose Restore project copy.",
          kind: "cadtree",
        },
        {
          src: "/tutorials/compare-apply-recover/step-6-restore-confirmation.png",
          alt: "Real Restore a complete project copy dialog identifies Rev 003, four files and the automatic project recoveries destination, with Restore copy focused.",
          caption: "2. Check the saved revision and separate destination, then click Restore copy.",
          kind: "cadtree",
        },
        {
          src: "/tutorials/compare-apply-recover/step-6-restored-copy.png",
          alt: "Real Complete project copy verified result confirms four files restored from Rev 003; expanded Recovery report shows the generated recoveries/copy folder location.",
          caption: "3. Find the verified copy in Recovery report; use its path to reach the recovered files.",
          kind: "cadtree",
        },
      ],
    },
    {
      id: "preserve-the-case",
      title: "Preserve the Design Case",
      summary: "Finished Design Cases do not need to be deleted. Archive the experiment while preserving its working folder and saved history.",
      points: [
        "Keep Main active. In History, expand Design cases, find Lightweight bracket and choose Archive case. Review Archive design case, then confirm Archive case. Uncaptured case edits or pending applications must be resolved first.",
        "Archive is independent of Apply; it preserves useful alternatives whether or not you adopted them. Main cannot be archived. Archived cases can be reopened later with Reopen case; reopening does not switch your working case.",
      ],
      visuals: [
        {
          src: "/tutorials/compare-apply-recover/step-7-archive-action.png",
          alt: "Real History Design cases lists Lightweight bracket as Active with Archive case focused while Main is the active working direction.",
          caption: "1. With Main active, expand Design cases in History and find the finished case.",
          kind: "cadtree",
        },
        {
          src: "/tutorials/compare-apply-recover/step-7-archive-confirmation.png",
          alt: "Real Archive design case dialog identifies Lightweight bracket, explains the clean-baseline check and retained files/history, and focuses Archive case.",
          caption: "2. Review the preservation notice and confirm Archive case.",
          kind: "cadtree",
        },
        {
          src: "/tutorials/compare-apply-recover/step-7-archived-case.png",
          alt: "Real Archived cases section shows Lightweight bracket as Archived with Reopen case available; saved history and the working folder remain retained.",
          caption: "3. The archived case remains available to inspect or reopen later.",
          kind: "cadtree",
        },
      ],
      nextHint: "You now know the core cAdtree workflow. Save meaningful revisions, explore alternatives separately, compare before applying changes, and preserve useful design history.",
    },
  ],
};
