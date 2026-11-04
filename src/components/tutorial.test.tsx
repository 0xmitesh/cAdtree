import "../../tests/dom";
import { indexedDB } from "fake-indexeddb";
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { render, cleanup, fireEvent, within } from "@testing-library/react";
import App from "../App";

Object.assign(globalThis, { indexedDB });
afterEach(cleanup);

test("Tutorial 1 opens from Welcome screen, renders real screenshot assets without placeholders, steps forward/back, and causes no filesystem side effects", () => {
  let pickerCalls = 0;
  Object.assign(window, {
    showDirectoryPicker: async () => {
      pickerCalls++;
      throw new Error("Tutorial must not invoke directory picker");
    },
  });

  const ui = render(<App />);
  const trigger = ui.getByRole("button", {
    name: "Tutorial: Start with cAdtree",
  });
  fireEvent.click(trigger);

  const dialog = within(
    ui.getByRole("dialog", { name: "Start with cAdtree" }),
  );
  assert.ok(dialog.getByText("Step 1 of 5"));
  assert.ok(dialog.getByRole("heading", { name: "Cadtree Home" }));
  assert.equal(
    (dialog.getByRole("button", { name: "Back" }) as HTMLButtonElement).disabled,
    true,
  );

  // Step 1 -> Step 2 (3-action sequence: cAdtree -> Windows -> cAdtree)
  fireEvent.click(dialog.getByRole("button", { name: "Next" }));
  assert.ok(dialog.getByText("Step 2 of 5"));
  assert.ok(
    dialog.getByRole("heading", { name: "Create or connect Cadtree Home" }),
  );
  assert.ok(
    dialog.getByText(
      /cannot provide or verify its full local filesystem address/,
    ),
  );
  assert.ok(dialog.getByText("1. Click Start my Cadtree home."));
  assert.ok(
    dialog.getByText("2. Select a dedicated empty folder for Cadtree Home."),
  );
  assert.ok(
    dialog.getByText("3. Paste the folder's full address and complete setup."),
  );
  const step2Images = dialog.getAllByRole("img") as HTMLImageElement[];
  assert.equal(step2Images.length, 3);
  assert.match(step2Images[1].getAttribute("src") ?? "", /step-2-windows-select-folder\.svg$/);
  assert.equal(dialog.queryByText(/Screenshot slot/i), null);
  assert.equal(dialog.queryByText(/Interface preview/i), null);
  assert.equal(
    (dialog.getByRole("button", { name: "Back" }) as HTMLButtonElement).disabled,
    false,
  );

  // Step 2 -> Step 3 (real screenshots of My workspaces & Create workspace)
  fireEvent.click(dialog.getByRole("button", { name: "Next" }));
  assert.ok(dialog.getByText("Step 3 of 5"));
  assert.ok(dialog.getByRole("heading", { name: "Workspace" }));
  assert.equal(dialog.getAllByRole("img").length, 2);

  // Step 3 -> Step 4 (real screenshots of My Workspace & Create project)
  fireEvent.click(dialog.getByRole("button", { name: "Next" }));
  assert.ok(dialog.getByText("Step 4 of 5"));
  assert.ok(dialog.getByRole("heading", { name: "Project" }));
  assert.equal(dialog.getAllByRole("img").length, 2);
  assert.ok(
    dialog.getByText(
      /cAdtree creates the project and its Main working folder \(working\/main\) inside the workspace automatically/,
    ),
  );

  // Back from Step 4 -> Step 3
  fireEvent.click(dialog.getByRole("button", { name: "Back" }));
  assert.ok(dialog.getByText("Step 3 of 5"));

  // Forward to Step 5 (final step)
  fireEvent.click(dialog.getByRole("button", { name: "Next" }));
  fireEvent.click(dialog.getByRole("button", { name: "Next" }));
  assert.ok(dialog.getByText("Step 5 of 5"));
  assert.ok(dialog.getByRole("heading", { name: "Ready to work" }));
  assert.ok(
    dialog.getByText(/paste it into your system file manager/),
  );
  assert.ok(dialog.getByText("Next: save your first revision."));
  assert.equal(dialog.queryByRole("button", { name: "Next" }), null);

  // Finish closes the modal
  fireEvent.click(dialog.getByRole("button", { name: "Finish" }));
  assert.equal(ui.queryByRole("dialog", { name: "Start with cAdtree" }), null);

  // Reopen and test Close button on an earlier step
  fireEvent.click(trigger);
  const reopened = within(
    ui.getByRole("dialog", { name: "Start with cAdtree" }),
  );
  assert.ok(reopened.getByText("Step 1 of 5"));
  fireEvent.click(reopened.getByRole("button", { name: "Close" }));
  assert.equal(ui.queryByRole("dialog", { name: "Start with cAdtree" }), null);

  // Verify no filesystem picker was invoked
  assert.equal(pickerCalls, 0);
});
