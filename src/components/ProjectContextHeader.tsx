import type { VaultState } from "../engine/types";
import { ActiveBranchPicker } from "./ActiveBranchPicker";

export function ProjectContextHeader({
  state,
  activeBranchId,
  busy,
  onSelect,
}: {
  state: VaultState;
  activeBranchId: string;
  busy: boolean;
  onSelect: (branchId: string) => Promise<void>;
}) {
  return (
    <section
      className="page project-context-header"
      aria-label="Project context"
      data-branch-id={activeBranchId}
    >
      <strong className="project-context-name">{state.project.name}</strong>
      <ActiveBranchPicker
        state={state}
        activeBranchId={activeBranchId}
        busy={busy}
        onSelect={onSelect}
      />
    </section>
  );
}
