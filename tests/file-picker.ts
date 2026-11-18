import { fireEvent, within, type RenderResult } from "@testing-library/react";

/** The History page's File picker (a filterable combobox). */
export const filePicker = (ui: Pick<RenderResult, "getByRole">) =>
  ui.getByRole("combobox", { name: "File" }) as HTMLInputElement;

/** Picks a file the way a user would: type its label to filter, then click the option. */
export function pickFile(ui: Pick<RenderResult, "getByRole">, label: string) {
  const input = filePicker(ui);
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: label } });
  fireEvent.click(within(ui.getByRole("listbox", { name: "Files" })).getByRole("option", { name: label }));
}

/** Labels of the options currently offered by the open picker. */
export function pickerOptions(ui: Pick<RenderResult, "getByRole">): string[] {
  return within(ui.getByRole("listbox", { name: "Files" }))
    .getAllByRole("option")
    .map((option) => option.textContent ?? "");
}

export function showAllFiles(ui: Pick<RenderResult, "getByRole">) {
  fireEvent.click(ui.getByRole("button", { name: "Show all files" }));
}
