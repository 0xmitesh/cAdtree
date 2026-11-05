import "../../tests/dom";
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { HomeWelcome } from "./HomeWelcome";
import { InMemoryFileSystemAdapter } from "../engine/fs-adapter";
import { nativeDirectory } from "../../tests/native-fs";

afterEach(cleanup);

test("homepage Learn cards replace the footer link and only the available tutorial opens", () => {
  let start = 0, open = 0, returns = 0;
  const ui = render(<HomeWelcome remembered={null} busy={false}
    onStart={() => start++} onOpen={() => open++} onReturn={() => returns++} />);
  const learn = ui.getByRole("region", { name: "Learn cAdtree" });
  const cards = within(learn).getAllByRole("article");
  assert.deepEqual(cards.map((card) => within(card).getByRole("heading").textContent), [
    "Start with cAdtree", "Save your first revision", "Bring existing work into cAdtree",
    "Explore design alternatives", "Compare & recover",
  ]);
  assert.equal(within(learn).getAllByText("Coming soon").length, 2);
  assert.equal(within(learn).getAllByRole("button").length, 3);
  assert.ok(within(cards[0]).getByText("6 steps"));
  assert.equal(ui.queryByText("Tutorial: Start with cAdtree"), null);
  const benefits = ui.getByRole("region", { name: "Make space for better work" });
  assert.ok(learn.compareDocumentPosition(benefits) & window.Node.DOCUMENT_POSITION_FOLLOWING);
  const footer = ui.container.querySelector(".welcome-footer")!;
  assert.ok(footer.contains(benefits));
  assert.equal(ui.queryByText("Your files. Your storage."), null, "the homepage does not repeat the sidebar footer");
  for (const card of cards.slice(3)) {
    assert.equal(card.querySelector("button, a, [tabindex]"), null);
    fireEvent.click(card);
    assert.equal(ui.queryByRole("dialog"), null);
  }
  fireEvent.click(within(cards[0]).getByRole("button", { name: "Start tutorial" }));
  const dialog = within(ui.getByRole("dialog", { name: "Start with cAdtree" }));
  assert.ok(dialog.getByText("Step 1 of 6"));
  assert.ok(dialog.getByRole("heading", { name: "Cadtree Home" }));
  fireEvent.click(dialog.getByRole("button", { name: "Close" }));
  assert.equal(ui.queryByRole("dialog"), null);
  assert.deepEqual([start, open, returns], [0, 0, 0], "tutorial does not invoke folder workflows");
  fireEvent.click(ui.getByRole("button", { name: "Start my Cadtree home" }));
  fireEvent.click(ui.getByRole("button", { name: "Open my Cadtree home" }));
  assert.deepEqual([start, open, returns], [1, 1, 0]);
});

test("Learn respects the homepage busy state while remembered-home actions still work", () => {
  let returns = 0;
  const remembered = { name: "Cadtree", homeId: "home-test", rootHandle: nativeDirectory(new InMemoryFileSystemAdapter("Cadtree")) };
  const props = { remembered, busy: true, onStart: () => {}, onOpen: () => {}, onReturn: () => returns++ };
  const ui = render(<HomeWelcome {...props} />);
  for (const button of ui.getAllByRole("button", { name: "Start tutorial" })) {
    assert.equal((button as HTMLButtonElement).disabled, true);
    fireEvent.click(button);
  }
  assert.equal(ui.queryByRole("dialog"), null);
  ui.rerender(<HomeWelcome {...props} busy={false} />);
  fireEvent.click(ui.getByRole("button", { name: "Return to Cadtree" }));
  assert.equal(returns, 1);
});
