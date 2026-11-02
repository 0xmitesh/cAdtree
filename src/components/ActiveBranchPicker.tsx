import type { VaultState } from "../engine/types";
import { caseLifecycle, caseLabel } from "../engine/case-lifecycle";

export function ActiveBranchPicker({
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
    <label className="branch-picker project-branch-picker">
      <span>Active branch</span>
      <select
        aria-label="Active branch"
        value={activeBranchId}
        disabled={busy}
        onChange={(event) => {
          void onSelect(event.target.value);
        }}
      >
        {state.branches
          .filter(
            (branch) =>
              caseLifecycle(state, branch.branchId).status === "active" ||
              branch.branchId === activeBranchId,
          )
          .map((branch) => (
            <option
              key={branch.branchId}
              value={branch.branchId}
              disabled={
                caseLifecycle(state, branch.branchId).status !== "active"
              }
            >
              {caseLabel(state, branch.branchId)}
            </option>
          ))}
      </select>
    </label>
  );
}
