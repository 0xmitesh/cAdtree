import assert from "node:assert/strict";
import {
  fireEvent,
  waitFor,
  within,
  type RenderResult,
} from "@testing-library/react";
import { InMemoryFileSystemAdapter } from "../src/engine/fs-adapter";
import { nativeDirectory } from "./native-fs";

export const appBusy = (ui: RenderResult) =>
  ui.container.querySelector("main")?.getAttribute("aria-busy") === "true";
export const currentBranchId = (ui: RenderResult) =>
  ui.container
    .querySelector(".project-context-header")
    ?.getAttribute("data-branch-id");

/** Cases are switched in the Explorer tree (the only case switcher), from any project view. */
export async function selectBranch(ui: RenderResult, branchId: string) {
  const find = () =>
    ui.container.querySelector<HTMLElement>(
      `.desktop-workspace-tree [role="treeitem"][data-branch-id="${branchId}"]`,
    );
  // The tree expands the open project when the page switches to it, a moment after the project opens.
  await waitFor(() => assert.ok(find(), `Explorer has no row for case ${branchId}`));
  fireEvent.click(find()!);
  await waitFor(() => assert.equal(appBusy(ui), false));
}

/** Completes the required second step after a native test picker selection. */
export async function completeHomeAddress(
  ui: RenderResult,
  address = "D:\\Cadtree",
) {
  await waitFor(() =>
    assert.ok(ui.getByRole("dialog", { name: "Complete home setup" })),
  );
  const dialog = within(
    ui.getByRole("dialog", { name: "Complete home setup" }),
  );
  fireEvent.change(
    dialog.getByRole("textbox", { name: "Cadtree home folder address" }),
    { target: { value: address } },
  );
  fireEvent.click(dialog.getByRole("button", { name: "Complete setup" }));
  await waitFor(() =>
    assert.ok(!ui.queryByRole("dialog", { name: "Complete home setup" })),
  );
}

/** Connect a disposable test home without consuming the action-specific picker queue. */
export async function openTestHome(ui: RenderResult, home: InMemoryFileSystemAdapter) {
  const previous = Object.getOwnPropertyDescriptor(window, "showDirectoryPicker");
  Object.defineProperty(window, "showDirectoryPicker", { configurable: true, value: async () => nativeDirectory(home) });
  try {
    fireEvent.click(ui.getByRole("button", { name: "Open my Cadtree home" }));
    await completeHomeAddress(ui);
    await waitFor(() => assert.equal(appBusy(ui), false));
  } finally {
    if (previous) Object.defineProperty(window, "showDirectoryPicker", previous);
    else Reflect.deleteProperty(window, "showDirectoryPicker");
  }
}
export async function openHomeWorkspace(ui: RenderResult, home: InMemoryFileSystemAdapter) {
  await openTestHome(ui, home);
  fireEvent.click(ui.getByRole("button", { name: "Open workspace" }));
  await waitFor(() => assert.equal(appBusy(ui), false));
}
