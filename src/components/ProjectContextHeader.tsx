import type { VaultState } from "../engine/types";
import { ActiveBranchPicker } from "./ActiveBranchPicker";

export function ProjectContextHeader({
  state,
  activeBranchId,
  busy,
  onSelect,
  showWorkingCase = true,
}: {
  state: VaultState;
  activeBranchId: string;
  busy: boolean;
  onSelect: (branchId: string) => Promise<void>;
  showWorkingCase?: boolean;
}) {
  return (
    <section
      className="page project-context-header"
      aria-label="Project context"
      data-branch-id={activeBranchId}
    >
      <strong className="project-context-name">{state.project.name}</strong>
      {showWorkingCase ? <ActiveBranchPicker
        state={state}
        activeBranchId={activeBranchId}
        busy={busy}
        onSelect={onSelect}
      /> : null}
    </section>
  );
}
