import "../../tests/dom";
import { completeHomeAddress } from "../../tests/app-controls";
import {
  createTestAuthController,
  DEFAULT_TEST_USER,
  resetGlobalTestAuth,
  SECOND_TEST_USER,
} from "../../tests/test-auth";
import { indexedDB } from "fake-indexeddb";
import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  render,
  cleanup,
  fireEvent,
  waitFor,
  within,
  act,
} from "@testing-library/react";
import App from "../App";
import { nativeDirectory } from "../../tests/native-fs";
import { InMemoryFileSystemAdapter } from "../engine/fs-adapter";
import {
  createHome,
  createHomeWorkspace,
  openHome,
} from "../engine/home-service";
import { createWorkspace, importProject, resolveManagedProject } from "../engine/workspace-service";
import { inventorySignature, readVerifiedInventory } from "../engine/copy-service";
import {
  clearAllConvenienceMetadata,
  rememberHome,
  getRememberedHome,
  saveWorkspacePath,
  setConvenienceAccountScope,
} from "../engine/idb-store";

Object.assign(globalThis, { indexedDB });

beforeEach(async () => {
  setConvenienceAccountScope("default");
  await clearAllConvenienceMetadata();
  resetGlobalTestAuth({ ready: true, user: DEFAULT_TEST_USER });
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(navigator, "onLine");
  resetGlobalTestAuth({ ready: true, user: DEFAULT_TEST_USER });
});

test("account changes during the workspace import picker cannot transfer remembered homes between accounts", async () => {
  const home = new InMemoryFileSystemAdapter("Account A home");
  const created = await createHome(home);
  const source = new InMemoryFileSystemAdapter("Imported workspace");
  await createWorkspace(source);
  const sourceBefore = inventorySignature(await readVerifiedInventory(source));
  Object.assign(window, { showDirectoryPicker: async () => nativeDirectory(home) });
  const auth = createTestAuthController({ ready: true, user: DEFAULT_TEST_USER });
  const ui = render(<App auth={auth.adapter} />);
  fireEvent.click(ui.getByRole("button", { name: "Open my Cadtree home" }));
  await completeHomeAddress(ui, "D:\\Account A home");
  await waitFor(() => assert.equal(ui.container.querySelector("main")?.getAttribute("aria-busy"), "false"));

  let release!: (handle: FileSystemDirectoryHandle) => void;
  Object.assign(window, { showDirectoryPicker: () => new Promise<FileSystemDirectoryHandle>((resolve) => { release = resolve; }) });
  fireEvent.click(ui.getByText("Home options"));
  fireEvent.click(ui.getByRole("button", { name: "Import existing workspace" }));
  fireEvent.click(ui.getByRole("button", { name: "Choose workspace folder" }));
  assert.ok(release, "the import picker is pending");
  act(() => { auth.setUser(SECOND_TEST_USER); });
  await act(async () => { release(nativeDirectory(source)); });
  await waitFor(async () => assert.equal((await openHome(home)).workspaces.length, 1));
  await waitFor(() => assert.equal(ui.container.querySelector("main")?.getAttribute("aria-busy"), "false"));
  assert.equal((await getRememberedHome())?.homeId ?? null, null, "Account B must not inherit Account A's home");
  assert.equal(ui.queryAllByRole("heading", { name: "Imported workspace" }).length, 0);
  assert.ok(ui.getByText(SECOND_TEST_USER.displayName!));
  assert.equal(inventorySignature(await readVerifiedInventory(source)), sourceBefore);
  setConvenienceAccountScope(DEFAULT_TEST_USER.uid);
  assert.equal((await getRememberedHome())?.homeId, created.identity.homeId);
});

test("all five current tutorials stay available to signed-out visitors without opening local folders", async () => {
  const auth = createTestAuthController({ ready: true, user: null });
  let picks = 0;
  Object.assign(window, { showDirectoryPicker: async () => { picks++; throw Error("Unexpected picker"); } });
  const ui = render(<App auth={auth.adapter} />);
  const titles = ["Start with cAdtree", "Save your first revision", "Bring existing work into cAdtree", "Explore design alternatives", "Compare, apply & recover"];
  assert.equal(ui.queryAllByText("Coming soon").length, 0);
  for (const title of titles) {
    const trigger = within(ui.getByRole("article", { name: title })).getByRole("button", { name: "Start tutorial" });
    fireEvent.click(trigger);
    const dialog = within(ui.getByRole("dialog", { name: title }));
    assert.ok(dialog.getByText(title === titles[4] ? "Step 1 of 7" : "Step 1 of 6"));
    fireEvent.click(dialog.getByRole("button", { name: /^Close$/ }));
  }
  assert.equal(picks, 0);
  assert.equal(auth.getSignInPayloads().length, 0);
});

test("a superseded account switch is not replayed after an in-progress folder connection", async () => {
  const disk = new InMemoryFileSystemAdapter("Cadtree");
  await createHome(disk);
  let release!: (handle: FileSystemDirectoryHandle) => void;
  Object.assign(window, { showDirectoryPicker: () => new Promise<FileSystemDirectoryHandle>((resolve) => { release = resolve; }) });
  const auth = createTestAuthController({ ready: true, user: DEFAULT_TEST_USER });
  const ui = render(<App auth={auth.adapter} />);
  fireEvent.click(ui.getByRole("button", { name: "Open my Cadtree home" }));
  act(() => {
    auth.setUser(SECOND_TEST_USER);
    auth.setUser(DEFAULT_TEST_USER);
  });
  await act(async () => { release(nativeDirectory(disk)); });
  await completeHomeAddress(ui, "D:\\Cadtree");
  assert.ok(ui.getByText(DEFAULT_TEST_USER.displayName!));
  assert.equal(ui.queryAllByText(SECOND_TEST_USER.displayName!).length, 0);
});

test("signed-out visitor can browse the homepage and complete a tutorial without signing in", async () => {
  const auth = createTestAuthController({ ready: true, user: null });
  const ui = render(<App auth={auth.adapter} />);

  assert.ok(ui.getByRole("button", { name: "Sign in" }));
  assert.ok(ui.getByRole("heading", { name: "Learn cAdtree" }));

  fireEvent.click(within(ui.getByRole("article", { name: "Start with cAdtree" })).getByRole("button", { name: "Start tutorial" }));
  const dialog = within(
    await waitFor(() =>
      ui.getByRole("dialog", { name: "Start with cAdtree" }),
    ),
  );
  assert.ok(dialog.getByText("Step 1 of 6"));

  fireEvent.click(dialog.getByRole("button", { name: "Next" }));
  for (let step = 2; step <= 5; step++) {
    assert.ok(dialog.getByText(`Step ${step} of 6`));
    fireEvent.click(dialog.getByRole("button", { name: "Next visual" }));
    fireEvent.click(dialog.getByRole("button", { name: "Next" }));
  }
  assert.ok(dialog.getByText("Step 6 of 6"));
  fireEvent.click(dialog.getByRole("button", { name: "Finish" }));
  await waitFor(() => assert.ok(!ui.queryByRole("dialog")));
  assert.equal(auth.getSignInPayloads().length, 0);
});

test("initial session gate waits for Firebase auth resolution before restoring remembered home", async () => {
  const disk = new InMemoryFileSystemAdapter("Secret Engineering Home");
  const created = await createHome(disk);
  setConvenienceAccountScope(DEFAULT_TEST_USER.uid);
  await rememberHome({
    homeId: created.identity.homeId,
    name: created.identity.name,
    rootHandle: nativeDirectory(disk),
  });
  await saveWorkspacePath(
    created.identity.homeId,
    "D:\\SecretHome",
    nativeDirectory(disk),
  );

  const auth = createTestAuthController({ ready: false, user: null });
  const ui = render(<App auth={auth.adapter} />);

  assert.ok(ui.getByText("Checking session…"));
  assert.equal(
    ui.queryByRole("button", { name: /Return to Secret Engineering Home/i }),
    null,
  );
  assert.equal(
    (
      ui.getByRole("button", {
        name: "Start my Cadtree home",
      }) as HTMLButtonElement
    ).disabled,
    false,
  );
  assert.equal(
    (within(ui.getByRole("article", { name: "Start with cAdtree" })).getByRole("button", { name: "Start tutorial" }) as HTMLButtonElement)
      .disabled,
    false,
  );

  act(() => {
    auth.setUser(DEFAULT_TEST_USER);
  });

  await waitFor(() =>
    assert.ok(
      ui.getByRole("button", { name: "Return to Secret Engineering Home" }),
    ),
  );
});

test("signed-out workspace actions prompt for Google sign-in, handle cancellation and failure, and resume after sign-in", async () => {
  const emptyHome = new InMemoryFileSystemAdapter("Cadtree");
  let pickerCalls = 0;
  Object.assign(window, {
    showDirectoryPicker: async () => {
      pickerCalls++;
      return nativeDirectory(emptyHome);
    },
  });

  const auth = createTestAuthController({ ready: true, user: null });
  const ui = render(<App auth={auth.adapter} />);

  // 1. Cancelled sign-in leaves visitor on public page without invoking picker
  auth.setSignInOutcome({ type: "cancel" });
  fireEvent.click(ui.getByRole("button", { name: "Start my Cadtree home" }));
  const signInDialog = await waitFor(() =>
    ui.getByRole("dialog", { name: "Sign in to cAdtree" }),
  );
  fireEvent.click(
    within(signInDialog).getByRole("button", {
      name: /Continue with Google/i,
    }),
  );
  await waitFor(() => assert.ok(!ui.queryByRole("dialog")));
  assert.equal(pickerCalls, 0);
  assert.equal(ui.queryByRole("alert"), null);

  // 2. Failed sign-in shows retryable error without opening folder
  auth.setSignInOutcome({
    type: "error",
    message: "Network connection failed during Google sign-in.",
  });
  fireEvent.click(ui.getByRole("button", { name: "Start my Cadtree home" }));
  const retryDialog = await waitFor(() =>
    ui.getByRole("dialog", { name: "Sign in to cAdtree" }),
  );
  fireEvent.click(
    within(retryDialog).getByRole("button", {
      name: /Continue with Google/i,
    }),
  );
  await waitFor(() =>
    assert.match(
      within(retryDialog).getByRole("alert").textContent!,
      /Network connection failed/,
    ),
  );
  assert.equal(pickerCalls, 0);

  // 3. Retry succeeds and resumes intended Start my Cadtree home action
  auth.setSignInOutcome({ type: "success", user: DEFAULT_TEST_USER });
  fireEvent.click(
    within(retryDialog).getByRole("button", {
      name: /Continue with Google/i,
    }),
  );
  await waitFor(() =>
    assert.ok(ui.getByRole("dialog", { name: "Complete home setup" })),
  );
  assert.equal(pickerCalls, 1);
  await completeHomeAddress(ui, "D:\\Cadtree");
  await waitFor(() =>
    assert.ok(ui.getByRole("heading", { name: "My workspaces." })),
  );
  assert.deepEqual(auth.getSignInPayloads(), [[], [], []]);
});

test("Sign In / Create Account tabs, Email & Password authentication, and Forgot password flow", async () => {
  const emptyHome = new InMemoryFileSystemAdapter("Cadtree");
  Object.assign(window, {
    showDirectoryPicker: async () => nativeDirectory(emptyHome),
  });

  const auth = createTestAuthController({ ready: true, user: null });
  const ui = render(<App auth={auth.adapter} />);

  fireEvent.click(ui.getByRole("button", { name: "Start my Cadtree home" }));
  const modal = await waitFor(() =>
    ui.getByRole("dialog", { name: "Sign in to cAdtree" }),
  );

  // Forgot password requires email address first
  fireEvent.click(
    within(modal).getByRole("button", { name: "Forgot password?" }),
  );
  await waitFor(() =>
    assert.match(
      within(modal).getByRole("alert").textContent!,
      /Enter your email address first/,
    ),
  );

  // Entering email and clicking Forgot password sends reset email
  fireEvent.change(within(modal).getByLabelText("Email Address"), {
    target: { value: "engineer@company.com" },
  });
  fireEvent.click(
    within(modal).getByRole("button", { name: "Forgot password?" }),
  );
  await waitFor(() =>
    assert.match(
      within(modal).getByRole("status").textContent!,
      /Password reset email sent to engineer@company\.com/,
    ),
  );
  assert.deepEqual(auth.getResetEmails(), ["engineer@company.com"]);

  // Switch to Create Account tab and register with Email + Password
  fireEvent.click(
    within(modal).getByRole("tab", { name: "Create Account" }),
  );
  assert.equal(
    within(modal).queryByRole("button", { name: "Forgot password?" }),
    null,
  );
  fireEvent.change(within(modal).getByLabelText("Password"), {
    target: { value: "securePass123" },
  });
  fireEvent.click(
    within(modal).getByRole("button", { name: "Create Account" }),
  );

  await waitFor(() =>
    assert.ok(ui.getByRole("dialog", { name: "Complete home setup" })),
  );
  assert.deepEqual(auth.getSignInPayloads(), [
    [{ method: "create-account", email: "engineer@company.com" }],
  ]);
});

test("when native directory picker requires a fresh click after async sign-in, Continue button completes the flow", async () => {
  const emptyHome = new InMemoryFileSystemAdapter("Cadtree");
  let pickerAttempt = 0;
  Object.assign(window, {
    showDirectoryPicker: async () => {
      pickerAttempt++;
      if (pickerAttempt === 1) {
        throw new DOMException(
          "Must be handling a user gesture to show a directory picker.",
          "SecurityError",
        );
      }
      return nativeDirectory(emptyHome);
    },
  });

  const auth = createTestAuthController({ ready: true, user: null });
  auth.setSignInOutcome({ type: "success", user: DEFAULT_TEST_USER });
  const ui = render(<App auth={auth.adapter} />);

  fireEvent.click(ui.getByRole("button", { name: "Start my Cadtree home" }));
  const modal = await waitFor(() =>
    ui.getByRole("dialog", { name: "Sign in to cAdtree" }),
  );
  fireEvent.click(
    within(modal).getByRole("button", { name: /Continue with Google/i }),
  );

  const continueDialog = await waitFor(() =>
    ui.getByRole("dialog", { name: "Start Cadtree home" }),
  );
  assert.match(
    continueDialog.textContent!,
    /Signed in\. Click Continue to choose your local folder\./,
  );
  assert.equal(ui.queryByRole("alert"), null);

  fireEvent.click(
    within(continueDialog).getByRole("button", { name: "Continue" }),
  );
  await waitFor(() =>
    assert.ok(ui.getByRole("dialog", { name: "Complete home setup" })),
  );
  assert.equal(pickerAttempt, 2);
});

test("signed-in user can capture revisions offline and sign-out waits for an in-progress write before clearing UI", async () => {
  Object.defineProperty(navigator, "onLine", { value: false, configurable: true });
  const homeRoot = new InMemoryFileSystemAdapter("Cadtree");
  const home = await createHome(homeRoot);
  const ws = await createHomeWorkspace(homeRoot, "Product Line", {
    expectedHomeId: home.identity.homeId,
  });
  const cadSource = new InMemoryFileSystemAdapter("Bracket source");
  await cadSource.writeFileText(["Bracket.SLDPRT"], "initial CAD geometry");
  const imported = await importProject(ws.workspace.root, cadSource, "Bracket");

  Object.assign(window, {
    showDirectoryPicker: async () => nativeDirectory(homeRoot),
  });

  const auth = createTestAuthController({
    ready: true,
    user: DEFAULT_TEST_USER,
  });
  const ui = render(<App auth={auth.adapter} />);

  fireEvent.click(ui.getByRole("button", { name: "Open my Cadtree home" }));
  await completeHomeAddress(ui, "D:\\Cadtree");
  await waitFor(() =>
    assert.equal(
      (ui.getByRole("button", { name: "Open workspace" }) as HTMLButtonElement)
        .disabled,
      false,
    ),
  );
  fireEvent.click(ui.getByRole("button", { name: "Open workspace" }));
  await waitFor(() =>
    assert.equal(
      (ui.getByRole("button", { name: "Open project" }) as HTMLButtonElement)
        .disabled,
      false,
    ),
  );
  fireEvent.click(ui.getByRole("button", { name: "Open project" }));

  await waitFor(() =>
    assert.equal(
      ui.container.querySelector("main")?.getAttribute("aria-busy"),
      "false",
    ),
  );

  const changesPage = within(
    [...ui.container.querySelectorAll<HTMLElement>(".changes-page")].find(
      (p) => !p.parentElement!.hidden,
    )!,
  );

  await waitFor(() =>
    assert.ok(changesPage.getByText(/Bracket\.SLDPRT/)),
  );
  fireEvent.change(
    changesPage.getByRole("textbox", { name: /Revision summary/ }),
    { target: { value: "Initial offline capture" } },
  );

  // Trigger capture and immediately request Sign out while capture is running
  const saveBtn = changesPage.getByRole("button", {
    name: "Save revision",
  });
  fireEvent.click(saveBtn);
  const signOutBtn = ui.getByRole("button", {
    name: /Sign out|Finishing write…/i,
  });
  fireEvent.click(signOutBtn);

  // Wait for capture to finish and sign-out to complete back to public homepage
  await waitFor(() =>
    assert.ok(ui.getByRole("button", { name: "Sign in" })),
  );
  assert.ok(ui.getByRole("button", { name: "Start my Cadtree home" }));
  assert.equal(auth.getSignOutCount(), 1);

  // Reopen the actual managed vault after sign-out and verify the completed save.
  const reopened = await resolveManagedProject(ws.workspace.root, imported.record.containerPath);
  assert.equal(reopened.vaultState.revisions.length, 1);
  assert.equal(reopened.vaultState.revisions[0].manifest.summary, "Initial offline capture");
  const working = reopened.workingFolders["branch-main"];
  assert.ok(working);
  assert.equal(await working.readFileText(["Bracket.SLDPRT"]), "initial CAD geometry");

});

test("shared browser isolation: Account B does not see Account A's remembered home or paths, and A's files stay intact", async () => {
  const homeA = new InMemoryFileSystemAdapter("Alice Engineering Home");
  const createdA = await createHome(homeA);
  await createHomeWorkspace(homeA, "Alice R&D", {
    expectedHomeId: createdA.identity.homeId,
  });

  const homeB = new InMemoryFileSystemAdapter("Bob Manufacturing Home");
  await createHome(homeB);

  let nextDirectory = homeA;
  Object.assign(window, {
    showDirectoryPicker: async () => nativeDirectory(nextDirectory),
  });

  const auth = createTestAuthController({
    ready: true,
    user: DEFAULT_TEST_USER,
  });
  const ui = render(<App auth={auth.adapter} />);

  // Account A opens Alice Engineering Home
  fireEvent.click(ui.getByRole("button", { name: "Open my Cadtree home" }));
  await completeHomeAddress(ui, "D:\\AliceSecretPath\\Cadtree");
  await waitFor(() =>
    assert.ok(ui.getByRole("heading", { name: "My workspaces." })),
  );
  assert.ok(ui.getByRole("heading", { name: "Alice R&D" }));

  // Account A signs out
  fireEvent.click(ui.getByRole("button", { name: "Sign out" }));
  await waitFor(() =>
    assert.ok(ui.getByRole("button", { name: "Sign in" })),
  );
  assert.equal(ui.queryByRole("heading", { name: "Alice R&D" }), null);
  assert.equal(
    ui.queryByRole("button", { name: /Return to Alice Engineering Home/i }),
    null,
  );
  assert.equal(ui.queryByText(/AliceSecretPath/), null);

  // Account B signs in on the same browser
  act(() => {
    auth.setUser(SECOND_TEST_USER);
  });
  await waitFor(() =>
    assert.ok(ui.getByText(SECOND_TEST_USER.displayName!)),
  );
  assert.equal(
    ui.queryByRole("button", { name: /Return to Alice Engineering Home/i }),
    null,
  );
  assert.equal(ui.queryByText(/AliceSecretPath/), null);

  // Account B explicitly selects Bob's local folder
  nextDirectory = homeB;
  fireEvent.click(ui.getByRole("button", { name: "Open my Cadtree home" }));
  await completeHomeAddress(ui, "D:\\BobPath\\Cadtree");
  await waitFor(() =>
    assert.ok(ui.getByRole("heading", { name: "My workspaces." })),
  );

  // Account A's disk files remain completely intact
  const entriesA = await homeA.listEntries();
  assert.ok(entriesA.some((entry) => entry.name === ".cadtree-home.json"));
});
