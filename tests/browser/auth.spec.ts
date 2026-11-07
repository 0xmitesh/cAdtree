import { expect, test } from "@playwright/test";

test("signed-out visitor can complete a tutorial, sign in to open a home, and isolate remembered homes across accounts", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1366, height: 844 });
  await page.goto("/");

  // Switch to signed-out visitor state
  await page.evaluate(() => {
    const ctrl = (window as unknown as { __CADTREE_TEST_AUTH_CONTROL__?: any })
      .__CADTREE_TEST_AUTH_CONTROL__;
    ctrl.setUser(null);
  });

  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();

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

  // Clicking Start my Cadtree home while signed out opens Sign in modal
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
  const signInModal = page.getByRole("dialog", { name: "Sign in to cAdtree" });
  await expect(signInModal).toBeVisible();
  await expect(
    signInModal.getByRole("tab", { name: "Sign In" }),
  ).toBeVisible();
  await expect(
    signInModal.getByRole("tab", { name: "Create Account" }),
  ).toBeVisible();
  await expect(signInModal.getByLabel("Email Address")).toBeVisible();
  await expect(signInModal.getByLabel("Password")).toBeVisible();
  await expect(
    signInModal.getByRole("button", { name: "Forgot password?" }),
  ).toBeVisible();

  // Failed sign-in shows error and stays on public page
  await page.evaluate(() => {
    const ctrl = (window as unknown as { __CADTREE_TEST_AUTH_CONTROL__?: any })
      .__CADTREE_TEST_AUTH_CONTROL__;
    ctrl.setSignInOutcome({
      type: "error",
      message: "Sign-in failed in test.",
    });
  });
  await signInModal
    .getByRole("button", { name: /Continue with Google/i })
    .click();
  await expect(signInModal.getByRole("alert")).toContainText(
    "Sign-in failed in test.",
  );

  // Retry succeeds as Account A and proceeds to Complete home setup
  await page.evaluate(() => {
    const ctrl = (window as unknown as { __CADTREE_TEST_AUTH_CONTROL__?: any })
      .__CADTREE_TEST_AUTH_CONTROL__;
    ctrl.setSignInOutcome({
      type: "success",
      user: ctrl.DEFAULT_TEST_USER,
    });
  });
  await signInModal
    .getByRole("button", { name: /Continue with Google/i })
    .click();

  const addressDialog = page.getByRole("dialog", {
    name: "Complete home setup",
  });
  await expect(addressDialog).toBeVisible();
  await addressDialog
    .getByLabel("Cadtree home folder address")
    .fill("D:\\EngineerA\\Cadtree");
  await addressDialog
    .getByRole("button", { name: "Complete setup" })
    .click();

  await expect(
    page.getByRole("heading", { name: "My workspaces." }),
  ).toBeVisible();
  await expect(page.getByText("Test Engineer")).toBeVisible();

  // Sign out returns to public homepage
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Start my Cadtree home" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Return to/i }),
  ).toHaveCount(0);

  // Sign in as Account B on the same browser: Account A's remembered home stays hidden
  await page.evaluate(() => {
    const ctrl = (window as unknown as { __CADTREE_TEST_AUTH_CONTROL__?: any })
      .__CADTREE_TEST_AUTH_CONTROL__;
    ctrl.setUser(ctrl.SECOND_TEST_USER);
  });
  await expect(page.getByText("Second Engineer")).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Return to/i }),
  ).toHaveCount(0);
});
