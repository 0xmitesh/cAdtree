import type { Page } from "@playwright/test";

/** The History page's File picker: a filterable combobox. */
export const fileInput = (page: Page) =>
  page.getByRole("combobox", { name: "File", exact: true });

/** Types the file name to filter the list, then clicks the matching entry. */
export async function pickFile(page: Page, label: string) {
  const input = fileInput(page);
  await input.click();
  await input.fill(label);
  await page
    .getByRole("listbox", { name: "Files" })
    .getByRole("option", { name: label, exact: true })
    .click();
}

/** Picks a tracked file by component id: its entry carries a short id suffix only when another entry shares its name. */
export async function pickComponent(page: Page, componentId: string, latestPath: string) {
  const input = fileInput(page);
  await input.click();
  await input.fill(latestPath);
  const short = componentId.slice(10, 18);
  const escaped = latestPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  await page
    .getByRole("listbox", { name: "Files" })
    .getByRole("option", { name: new RegExp(`^${escaped}( · ${short})?$`) })
    .click();
}

export async function showAllFiles(page: Page) {
  await page.getByRole("button", { name: "Show all files", exact: true }).click();
}
