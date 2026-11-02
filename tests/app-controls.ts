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
    .querySelector(".current-branch-indicator")
    ?.getAttribute("data-branch-id");

/** External projects can still switch from Settings when History has no picker. */
export async function selectBranch(ui: RenderResult, branchId: string) {
  const history = Boolean(ui.queryByRole("heading", { name: "History." }));
  const nav = within(ui.getByRole("navigation"));
  if (history) fireEvent.click(nav.getByRole("button", { name: "Settings" }));
  fireEvent.change(ui.getByRole("combobox", { name: "Active branch" }), {
    target: { value: branchId },
  });
  await waitFor(() => assert.equal(appBusy(ui), false));
  if (history) fireEvent.click(nav.getByRole("button", { name: "History" }));
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

/** Legacy regression fixtures enter their tools from a connected home now.
 * Keep their own queued workspace/vault pickers and call counts independent. */
export async function openExternalWorkspaces(ui: RenderResult) {
  if (!ui.queryByText("Home options")) {
    const previous = Object.getOwnPropertyDescriptor(
      window,
      "showDirectoryPicker",
    );
    Object.defineProperty(window, "showDirectoryPicker", {
      configurable: true,
      value: async () =>
        nativeDirectory(new InMemoryFileSystemAdapter("Regression home")),
    });
    try {
      fireEvent.click(
        ui.getByRole("button", { name: "Start my Cadtree home" }),
      );
      await completeHomeAddress(ui, "D:\\Regression home");
      await waitFor(() => assert.equal(appBusy(ui), false));
    } finally {
      if (previous)
        Object.defineProperty(window, "showDirectoryPicker", previous);
      else Reflect.deleteProperty(window, "showDirectoryPicker");
    }
  }
  fireEvent.click(ui.getByText("Home options"));
  fireEvent.click(
    ui.getByRole("button", { name: "Inspect external workspaces" }),
  );
}
