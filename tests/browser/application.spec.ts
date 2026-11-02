import { test, expect } from "@playwright/test";

for (const width of [1366, 390])
  test(`actual App: apply/reload/CAD-like adjustment/capture retains provenance and unrelated files at ${width}px`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/");
    const fixture = await page.evaluate(async () => {
      const url = "/tests/apply-preview-seed.ts";
      return (await import(/* @vite-ignore */ url)).seedApplyPreviewReview();
    });
    await page.reload();
    await page
      .getByRole("button", { name: /Return to Synthetic application preview/ })
      .click();
    await page
      .getByRole("textbox", { name: "Cadtree home folder address" })
      .fill("D:\\Synthetic application");
    await page
      .getByRole("button", { name: "Complete setup", exact: true })
      .click();
    const openProject = async () => {
      if (width === 390)
        await page
          .getByRole("button", { name: "Browse folders", exact: true })
          .click();
      const tree = page.getByRole("tree", { name: "Workspace explorer" });
      await tree
        .getByRole("treeitem", {
          name: "Application preview review",
          exact: true,
        })
        .click();
      if (width === 390)
        await page
          .getByRole("button", { name: "Browse folders", exact: true })
          .click();
      await tree
        .getByRole("treeitem", {
          name: "Actuator preview, Application preview review",
          exact: true,
        })
        .click();
      await expect(page.locator("main")).toHaveAttribute("aria-busy", "false");
    };
    await openProject();
    const before = await page.evaluate(async (fixture) => {
      const url = "/tests/application-fixture.ts";
      return (await import(/* @vite-ignore */ url)).readApplicationFixture(
        fixture,
      );
    }, fixture);
    const openReview = async () => {
      await page
        .getByRole("button", { name: /Rev 003: Redesign only Part-X/ })
        .press("Enter");
      await page
        .getByRole("button", { name: "Review changes to apply", exact: true })
        .click();
      const dialog = page.getByRole("dialog", {
        name: "Review changes to apply — preview",
      });
      await dialog
        .getByRole("textbox", {
          name: "Engineering reason for proposed application",
        })
        .fill(
          "Reuse reviewed Part-X while retaining all newer Main development",
        );
      await dialog
        .getByRole("checkbox", {
          name: "Select source modification: Parts/Part-X.SLDPRT",
        })
        .check();
      return dialog;
    };
    let review = await openReview();
    await review
      .getByRole("button", { name: "Prepare application", exact: true })
      .click();
    await expect(review.getByRole("alert")).toContainText(
      "Destination has uncaptured file or directory changes",
    );
    await expect(
      page.getByRole("dialog", { name: "Confirm working-file application" }),
    ).toHaveCount(0);
    const unchanged = await page.evaluate(async (fixture) => {
      const url = "/tests/application-fixture.ts";
      return (await import(/* @vite-ignore */ url)).readApplicationFixture(
        fixture,
      );
    }, fixture);
    expect(unchanged.main).toEqual(before.main);
    expect(unchanged.state.applicationOperations).toEqual([]);
    await page.keyboard.press("Escape");
    await page.evaluate(async (fixture) => {
      const url = "/tests/application-fixture.ts";
      await (await import(/* @vite-ignore */ url)).cleanFixtureMain(fixture);
    }, fixture);
    review = await openReview();
    await review
      .getByRole("button", { name: "Prepare application", exact: true })
      .click();
    const confirmation = page.getByRole("dialog", {
      name: "Confirm working-file application",
    });
    await expect(confirmation).toBeVisible();
    await expect
      .poll(() =>
        confirmation.evaluate((el) => el.contains(document.activeElement)),
      )
      .toBe(true);
    await expect(confirmation).toContainText("Destination: Main");
    await expect(confirmation).toContainText("working/main");
    const apply = confirmation.getByRole("button", {
      name: "Apply confirmed changes",
      exact: true,
    });
    await expect(apply).toBeDisabled();
    expect(
      await confirmation.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
    ).toBe(true);
    const acknowledgement = confirmation.getByRole("checkbox", {
      name: "I have saved and closed relevant CAD documents and confirm this destination.",
    });
    await page.keyboard.press("Tab");
    await expect(acknowledgement).toBeFocused();
    await page.keyboard.press("Space");
    await expect(acknowledgement).toBeChecked();
    await page.screenshot({
      path: `artifacts/screenshots/application-confirm-${width}.png`,
    });
    await apply.click();
    const completed = page.getByRole("dialog", {
      name: "Application completed",
    });
    await expect(
      completed.getByRole("button", { name: "Return to History", exact: true }),
    ).toBeFocused();
    await expect(completed).toContainText(
      "Applied to working files — revision not yet saved.",
    );
    await completed
      .getByRole("button", { name: "Return to History", exact: true })
      .click();
    const applied = await page.evaluate(async (fixture) => {
      const url = "/tests/application-fixture.ts";
      return (await import(/* @vite-ignore */ url)).readApplicationFixture(
        fixture,
      );
    }, fixture);
    expect(applied.source).toBe(before.source);
    expect(applied.main.files).toHaveLength(20);
    const baseline = fixture.savedFiles[fixture.ids[1]];
    for (const file of applied.main.files)
      expect(file.sha256).toBe(
        file.path === "Parts/Part-X.SLDPRT"
          ? fixture.savedFiles[fixture.ids[2]].find(
              (f: { path: string }) => f.path === file.path,
            ).sha256
          : baseline.find((f: { path: string }) => f.path === file.path).sha256,
      );
    expect(applied.state.applicationOperations).toHaveLength(1);
    expect(applied.state.applicationOperations[0].status).toBe("applied");
    expect(applied.state.revisions).toHaveLength(5);
    await page.reload();
    await page
      .getByRole("button", { name: /Return to Synthetic application preview/ })
      .click();
    await expect(page.locator("main")).toHaveAttribute("aria-busy", "false");
    // Reconnection may restore project context; opening it explicitly is deterministic.
    if (
      !(await page
        .getByRole("region", { name: "Destination application status" })
        .isVisible())
    )
      await openProject();
    const status = page.getByRole("region", {
      name: "Destination application status",
    });
    await expect(status).toContainText(
      "Applied to working files — revision not yet saved.",
    );
    await page.evaluate(async (fixture) => {
      const url = "/tests/application-fixture.ts";
      await (await import(/* @vite-ignore */ url)).adjustFixtureMain(fixture);
    }, fixture);
    await status
      .getByRole("button", { name: "Review and save revision", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Scan for changes", exact: true })
      .click();
    await expect(page.locator("main")).toHaveAttribute("aria-busy", "false");
    await page
      .getByRole("textbox", { name: /Revision summary/ })
      .fill("Reuse case Part-X after CAD reference checks");
    await page
      .getByRole("button", { name: /Add.*overall engineering notes/ })
      .click();
    await page
      .getByRole("textbox", { name: "Overall: observations", exact: true })
      .fill("CAD-like references and rebuild checked in disposable fixture");
    await page
      .getByRole("button", {
        name: "Add note for Parts/Part-X.SLDPRT",
        exact: true,
      })
      .click();
    await page
      .getByRole("textbox", {
        name: "Parts/Part-X.SLDPRT: observations",
        exact: true,
      })
      .fill("Adjusted after application in this fixture");
    await page
      .getByRole("button", { name: "Save revision", exact: true })
      .click();
    await expect(
      page.getByText(/Published and verified Rev 006/),
    ).toBeVisible();
    await expect(status).toHaveCount(0);
    const saved = await page.evaluate(async (fixture) => {
      const url = "/tests/application-fixture.ts";
      return (await import(/* @vite-ignore */ url)).readApplicationFixture(
        fixture,
      );
    }, fixture);
    const revision = saved.state.revisions.find(
      (r: { manifest: { displayNumber: number } }) =>
        r.manifest.displayNumber === 6,
    )!;
    expect(revision.manifest.parentRevisionId).toBe(fixture.ids[1]);
    expect(revision.manifest.files).toHaveLength(20);
    expect(revision.manifest.notes.observations).toContain("rebuild checked");
    expect(revision.manifest.fileNotes[0].observations).toContain(
      "Adjusted after application",
    );
    expect(saved.state.applicationOperations[0].status).toBe("captured");
    expect(saved.state.applicationOperations[0].capturedRevisionId).toBe(
      revision.manifest.revisionId,
    );
    expect(saved.source).toBe(before.source);
    await page
      .getByRole("navigation")
      .getByRole("button", { name: "History", exact: true })
      .click();
    await page
      .getByRole("button", { name: /Rev 006: Reuse case Part-X/ })
      .press("Enter");
    await page
      .getByText("Applied from Rev 003 · Part-X redesign", { exact: true })
      .click();
    await expect(
      page.getByText("Adjusted after application before saving", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByText(
        "Reuse reviewed Part-X while retaining all newer Main development",
        { exact: false },
      ),
    ).toBeVisible();
    await expect(
      page.getByRole("status", { name: "Current branch" }),
    ).toHaveAttribute("data-branch-id", "branch-main");
    await page.locator(".applied-from").scrollIntoViewIfNeeded();
    await page.screenshot({
      path: `artifacts/screenshots/application-provenance-${width}.png`,
    });
    expect(errors).toEqual([]);
  });

test("actual App: interrupted apply survives reload and recovery preserves unexpected later edits", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  const fixture = await page.evaluate(async () => {
    const url = "/tests/apply-preview-seed.ts";
    return (await import(/* @vite-ignore */ url)).seedApplyPreviewReview();
  });
  await page.evaluate(async (fixture) => {
    const url = "/tests/application-fixture.ts";
    await (await import(/* @vite-ignore */ url)).cleanFixtureMain(fixture);
  }, fixture);
  await page.reload();
  await page
    .getByRole("button", { name: /Return to Synthetic application preview/ })
    .click();
  await page
    .getByRole("textbox", { name: "Cadtree home folder address" })
    .fill("D:\\Synthetic application");
  await page
    .getByRole("button", { name: "Complete setup", exact: true })
    .click();
  const openProject = async () => {
    await page
      .getByRole("button", { name: "Browse folders", exact: true })
      .click();
    const tree = page.getByRole("tree", { name: "Workspace explorer" });
    await tree
      .getByRole("treeitem", {
        name: "Application preview review",
        exact: true,
      })
      .click();
    await page
      .getByRole("button", { name: "Browse folders", exact: true })
      .click();
    await tree
      .getByRole("treeitem", {
        name: "Actuator preview, Application preview review",
        exact: true,
      })
      .click();
    await expect(page.locator("main")).toHaveAttribute("aria-busy", "false");
  };
  await openProject();
  await page
    .getByRole("button", { name: /Rev 003: Redesign only Part-X/ })
    .press("Enter");
  await page
    .getByRole("button", { name: "Review changes to apply", exact: true })
    .click();
  const review = page.getByRole("dialog", {
    name: "Review changes to apply — preview",
  });
  await review
    .getByRole("textbox", {
      name: "Engineering reason for proposed application",
    })
    .fill("Disposable recovery qualification");
  await review
    .getByRole("checkbox", {
      name: "Select source modification: Parts/Part-X.SLDPRT",
    })
    .check();
  await review
    .getByRole("button", { name: "Prepare application", exact: true })
    .click();
  await page.evaluate(async (fixture) => {
    const url = "/tests/application-fixture.ts";
    await (
      await import(/* @vite-ignore */ url)
    ).failNextFixtureWorkingAcknowledgement(fixture);
  }, fixture);
  const confirm = page.getByRole("dialog", {
    name: "Confirm working-file application",
  });
  await confirm
    .getByRole("checkbox", {
      name: "I have saved and closed relevant CAD documents and confirm this destination.",
    })
    .check();
  await confirm
    .getByRole("button", { name: "Apply confirmed changes", exact: true })
    .click();
  await expect(
    review.getByRole("alert").filter({ hasText: "acknowledgement lost" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  const status = page.getByRole("region", {
    name: "Destination application status",
  });
  await expect(status).toContainText("Interrupted application");
  await page.reload();
  await page
    .getByRole("button", { name: /Return to Synthetic application preview/ })
    .click();
  await expect(page.locator("main")).toHaveAttribute("aria-busy", "false");
  if (!(await status.isVisible())) await openProject();
  await expect(status).toContainText("saving and another apply are blocked");
  await page.evaluate(async (fixture) => {
    const url = "/tests/application-fixture.ts";
    await (await import(/* @vite-ignore */ url)).adjustFixtureMain(fixture);
  }, fixture);
  await status
    .getByRole("button", {
      name: "Recover interrupted application",
      exact: true,
    })
    .click();
  const recovery = page.getByRole("dialog", {
    name: "Recover interrupted application",
  });
  await recovery
    .getByRole("checkbox", {
      name: "I have saved and closed relevant CAD documents.",
    })
    .check();
  await recovery
    .getByRole("button", {
      name: "Recover recognized applied files",
      exact: true,
    })
    .click();
  await expect(recovery.getByRole("alert")).toContainText(
    "Manual recovery required: Parts/Part-X.SLDPRT",
  );
  expect(
    await recovery.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
  ).toBe(true);
  await page.screenshot({
    path: "artifacts/screenshots/application-recovery-mobile.png",
  });
  const retained = await page.evaluate(async (fixture) => {
    const url = "/tests/application-fixture.ts";
    return (await import(/* @vite-ignore */ url)).readApplicationFixture(
      fixture,
    );
  }, fixture);
  expect(retained.state.applicationOperations[0].status).toBe("unresolved");
  expect(
    retained.main.files.find(
      (f: { path: string }) => f.path === "Parts/Part-X.SLDPRT",
    ).sha256,
  ).not.toBe(
    fixture.savedFiles[fixture.ids[2]].find(
      (f: { path: string }) => f.path === "Parts/Part-X.SLDPRT",
    ).sha256,
  );
  // Simulate an engineer manually restoring the verified before-state, then verify recovery.
  await page.evaluate(async (fixture) => {
    const url = "/tests/application-fixture.ts";
    await (await import(/* @vite-ignore */ url)).cleanFixtureMain(fixture);
  }, fixture);
  await recovery
    .getByRole("button", {
      name: "Recover recognized applied files",
      exact: true,
    })
    .click();
  await expect(recovery).toHaveCount(0);
  await expect(status).toHaveCount(0);
  const recovered = await page.evaluate(async (fixture) => {
    const url = "/tests/application-fixture.ts";
    return (await import(/* @vite-ignore */ url)).readApplicationFixture(
      fixture,
    );
  }, fixture);
  expect(recovered.state.applicationOperations[0].status).toBe("recovered");
  expect(recovered.state.revisions).toHaveLength(5);
  expect(recovered.main.files).toHaveLength(20);
});
