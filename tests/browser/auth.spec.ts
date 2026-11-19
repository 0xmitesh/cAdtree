import { expect, test } from "@playwright/test";

type AuthControl = {
  DEFAULT_TEST_USER: unknown;
  SECOND_TEST_USER: unknown;
  setUser(user: unknown): void;
  setSignInOutcome(outcome: unknown): void;
};

test("signing in is optional: a signed-out visitor creates a home with no sign-in, and the Account control never changes what is open or remembered", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1366, height: 844 });
  await page.goto("/");

  // Switch to signed-out visitor state
  await page.evaluate(() => {
    const ctrl = (window as unknown as { __CADTREE_TEST_AUTH_CONTROL__: AuthControl })
      .__CADTREE_TEST_AUTH_CONTROL__;
    ctrl.setUser(null);
  });

  const account = page.getByRole("button", { name: "Account" });
  await expect(account).toContainText("Optional");

  // Signed-out visitor can open and complete a tutorial
  await page.getByRole("article", { name: "Start with cAdtree" }).getByRole("button", { name: "Start tutorial" }).click();
  const tutorialModal = page.getByRole("dialog", {
    name: "Start with cAdtree",
  });
  await expect(tutorialModal).toBeVisible();
  for (let step = 1; step <= 6; step++) {
    const visualNext = tutorialModal.getByRole("button", { name: "Next visual" });
    while (await visualNext.count() && await visualNext.isEnabled()) await visualNext.click();
    await tutorialModal.getByRole("button", { name: step === 6 ? "Finish" : "Next", exact: true }).click();
  }
  await expect(tutorialModal).toBeHidden();

  // Starting a home goes straight to the folder step: no sign-in dialog.
  await page.evaluate(async () => {
    const opfs = await navigator.storage.getDirectory();
    try {
      await opfs.removeEntry("auth-test-home-a", { recursive: true });
    } catch {
      /* ignore */
    }
    const dir = await opfs.getDirectoryHandle("auth-test-home-a", {
      create: true,
    });
    (window as unknown as { showDirectoryPicker: unknown }).showDirectoryPicker =
      async () => dir;
  });

  await page.getByRole("button", { name: "Start my Cadtree home" }).click();
  const addressDialog = page.getByRole("dialog", {
    name: "Complete home setup",
  });
  await expect(addressDialog).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Account" })).toHaveCount(0);
  await addressDialog
    .getByLabel("Cadtree home folder address")
    .fill("D:\\EngineerA\\Cadtree");
  await addressDialog
    .getByRole("button", { name: "Complete setup" })
    .click();
  await expect(
    page.getByRole("heading", { name: "My workspaces." }),
  ).toBeVisible();

  // The Account dialog explains that an account is optional and handles a failed sign-in.
  await account.click();
  const accountDialog = page.getByRole("dialog", { name: "Account" });
  await expect(accountDialog).toContainText("You do not need an account");
  await expect(accountDialog.getByRole("tab", { name: "Sign In" })).toBeVisible();
  await expect(accountDialog.getByRole("tab", { name: "Create Account" })).toBeVisible();
  await expect(accountDialog.getByLabel("Email Address")).toBeVisible();
  await expect(accountDialog.getByLabel("Password")).toBeVisible();
  await expect(accountDialog.getByRole("button", { name: "Forgot password?" })).toBeVisible();
  await page.evaluate(() => {
    const ctrl = (window as unknown as { __CADTREE_TEST_AUTH_CONTROL__: AuthControl })
      .__CADTREE_TEST_AUTH_CONTROL__;
    ctrl.setSignInOutcome({ type: "error", message: "Sign-in failed in test." });
  });
  await accountDialog.getByRole("button", { name: /Continue with Google/i }).click();
  await expect(accountDialog.getByRole("alert")).toContainText("Sign-in failed in test.");

  // A retry succeeds; the open home stays open.
  await page.evaluate(() => {
    const ctrl = (window as unknown as { __CADTREE_TEST_AUTH_CONTROL__: AuthControl })
      .__CADTREE_TEST_AUTH_CONTROL__;
    ctrl.setSignInOutcome({ type: "success", user: ctrl.DEFAULT_TEST_USER });
  });
  await accountDialog.getByRole("button", { name: /Continue with Google/i }).click();
  await expect(accountDialog).toBeHidden();
  await expect(account).toContainText("Test Engineer");
  await expect(page.getByRole("heading", { name: "My workspaces." })).toBeVisible();

  // Signing out leaves everything open too.
  await account.click();
  await page.getByRole("dialog", { name: "Account" }).getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("dialog", { name: "Account" })).toBeHidden();
  await expect(account).toContainText("Optional");
  await expect(page.getByRole("heading", { name: "My workspaces." })).toBeVisible();

  // Another account on the same browser sees the same home.
  await page.evaluate(() => {
    const ctrl = (window as unknown as { __CADTREE_TEST_AUTH_CONTROL__: AuthControl })
      .__CADTREE_TEST_AUTH_CONTROL__;
    ctrl.setUser(ctrl.SECOND_TEST_USER);
  });
  await expect(account).toContainText("Second Engineer");
  await expect(page.getByRole("heading", { name: "My workspaces." })).toBeVisible();

  // After a reload the home is still offered, whoever is signed in.
  await page.reload();
  await expect(page.getByRole("button", { name: /Return to/i })).toBeVisible();
});
