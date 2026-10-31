import type { VaultState } from "../engine/types";

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
        {state.branches.map((branch) => (
          <option key={branch.branchId} value={branch.branchId}>
            {branch.name}
          </option>
        ))}
      </select>
    </label>
  );
}
