import type { VaultState } from "../engine/types";
import { caseLabel } from "../engine/case-lifecycle";

/** Project name and the current case. Switching cases happens in the Explorer. */
export function ProjectContextHeader({
  state,
  activeBranchId,
  showWorkingCase = true,
}: {
  state: VaultState;
  activeBranchId: string;
  showWorkingCase?: boolean;
}) {
  return (
    <section
      className="page project-context-header"
      aria-label="Project context"
      data-branch-id={activeBranchId}
    >
      <strong className="project-context-name">{state.project.name}</strong>
      {showWorkingCase ? (
        <span className="project-context-case">
          Case: <strong>{caseLabel(state, activeBranchId)}</strong>
        </span>
      ) : null}
    </section>
  );
}
