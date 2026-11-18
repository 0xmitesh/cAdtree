import "../../tests/dom";
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { useState } from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { RevisionNotes } from "../engine/types";
import { NoteEditor } from "./NoteEditor";
afterEach(cleanup);

function Harness({ initial, onChange }: { initial: RevisionNotes; onChange: (n: RevisionNotes) => void }) {
  const [value, setValue] = useState(initial);
  return <NoteEditor scope="Part.SLDPRT" label="Note" value={value} onChange={(next) => { setValue(next); onChange(next); }} />;
}
const empty: RevisionNotes = { problem: "", modification: "", observations: "" };

test("one main field is bound to modification; More detail is closed and holds Why and What you noticed", () => {
  let latest = empty;
  const ui = render(<Harness initial={empty} onChange={(n) => (latest = n)} />);
  const more = ui.getByText("More detail").closest("details") as HTMLDetailsElement;
  assert.equal(more.open, false);
  fireEvent.change(ui.getByRole("textbox", { name: "Part.SLDPRT: Note" }), { target: { value: "Thicker flange" } });
  fireEvent.change(ui.getByRole("textbox", { name: "Part.SLDPRT: Why" }), { target: { value: "Cracked in test" } });
  fireEvent.change(ui.getByRole("textbox", { name: "Part.SLDPRT: What you noticed" }), { target: { value: "Fits" } });
  assert.deepEqual(latest, { problem: "Cracked in test", modification: "Thicker flange", observations: "Fits" });
  assert.equal(ui.queryByText(/Problem or intent|Engineering change|Observations/), null);
});

test("More detail opens by itself when Why or What you noticed already has text", () => {
  for (const initial of [{ ...empty, problem: "Why text" }, { ...empty, observations: "Seen" }]) {
    const ui = render(<Harness initial={initial} onChange={() => {}} />);
    assert.equal((ui.getByText("More detail").closest("details") as HTMLDetailsElement).open, true);
    cleanup();
  }
  const onlyNote = render(<Harness initial={{ ...empty, modification: "Just a note" }} onChange={() => {}} />);
  assert.equal((onlyNote.getByText("More detail").closest("details") as HTMLDetailsElement).open, false);
});
