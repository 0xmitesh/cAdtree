import "../../tests/dom";
import { completeHomeAddress } from "../../tests/app-controls";
import type { AccountUser } from "../auth/firebase-auth";
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
  getWorkspacePath,
  saveWorkspacePath,
} from "../engine/idb-store";

Object.assign(globalThis, { indexedDB });

/** Opens the Account dialog from the navigation rail. */
const openAccount = async (ui: ReturnType<typeof render>) => {
  fireEvent.click(ui.getByRole("button", { name: "Account" }));
  return await waitFor(() => ui.getByRole("dialog", { name: "Account" }));
};
/** The Account control says nobody is signed in. */
const showsSignedOut = (ui: ReturnType<typeof render>) =>
  within(ui.getByRole("button", { name: "Account" })).getByText("Optional");
/** Signs out through the Account dialog. */
const signOut = async (ui: ReturnType<typeof render>) => {
  const dialog = await openAccount(ui);
  fireEvent.click(within(dialog).getByRole("button", { name: "Sign out" }));
  await waitFor(() => assert.equal(ui.queryAllByRole("dialog").length, 0));
};

beforeEach(async () => {
  await clearAllConvenienceMetadata();
  resetGlobalTestAuth({ ready: true, user: DEFAULT_TEST_USER });
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(navigator, "onLine");
  resetGlobalTestAuth({ ready: true, user: DEFAULT_TEST_USER });
});

test("signing in as another account while the workspace import picker is open changes nothing that is remembered", async () => {
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
  assert.equal((await getRememberedHome())?.homeId, created.identity.homeId, "the remembered home does not depend on the account");
  assert.ok(ui.getByText(SECOND_TEST_USER.displayName!));
  assert.equal(inventorySignature(await readVerifiedInventory(source)), sourceBefore);
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

test("signed-out visitor can browse the homepage and complete a tutorial without signing in", async () => {
  const auth = createTestAuthController({ ready: true, user: null });
  const ui = render(<App auth={auth.adapter} />);

  assert.ok(showsSignedOut(ui));
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

test("the remembered home is offered while the session is still being checked and stays when an account signs in", async () => {
  const disk = new InMemoryFileSystemAdapter("Secret Engineering Home");
  const created = await createHome(disk);
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

  await waitFor(() =>
    assert.ok(
      ui.getByRole("button", { name: "Return to Secret Engineering Home" }),
    ),
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
  assert.ok(ui.getByText(DEFAULT_TEST_USER.displayName!));
  assert.ok(
    ui.getByRole("button", { name: "Return to Secret Engineering Home" }),
  );
});

test("a signed-out visitor creates a home, a workspace and a project with no sign-in dialog; the home and its address are remembered after a reload and across sign-in and sign-out", async () => {
  const diskRoot = new InMemoryFileSystemAdapter("Cadtree");
  Object.assign(window, { showDirectoryPicker: async () => nativeDirectory(diskRoot) });
  const auth = createTestAuthController({ ready: true, user: null });
  const ui = render(<App auth={auth.adapter} />);
  const noSignInDialog = () => assert.equal(ui.queryByRole("dialog", { name: "Account" }), null);

  fireEvent.click(ui.getByRole("button", { name: "Start my Cadtree home" }));
  await completeHomeAddress(ui, "D:\\Cadtree");
  await waitFor(() => assert.ok(ui.getByRole("heading", { name: "My workspaces." })));
  noSignInDialog();

  await waitFor(() => assert.equal((ui.getByRole("button", { name: "Create workspace" }) as HTMLButtonElement).disabled, false));
  fireEvent.click(ui.getByRole("button", { name: "Create workspace" }));
  const workspaceDialog = within(ui.getByRole("dialog", { name: "Create workspace" }));
  fireEvent.change(workspaceDialog.getByLabelText("Workspace name"), { target: { value: "Studio" } });
  fireEvent.click(workspaceDialog.getByRole("button", { name: "Create workspace" }));
  await waitFor(() => assert.ok(ui.getByRole("button", { name: "Create project" })));
  noSignInDialog();

  await waitFor(() => assert.equal((ui.getByRole("button", { name: "Create project" }) as HTMLButtonElement).disabled, false));
  fireEvent.click(ui.getByRole("button", { name: "Create project" }));
  const projectDialog = within(ui.getByRole("dialog", { name: "Create project" }));
  fireEvent.change(projectDialog.getByLabelText("Project name"), { target: { value: "Bracket" } });
  fireEvent.click(projectDialog.getByRole("button", { name: "Create project" }));
  await waitFor(() => assert.ok(ui.getByText(/Created project "Bracket"/)));
  await waitFor(() => assert.equal(ui.container.querySelector("main")?.getAttribute("aria-busy"), "false"));
  noSignInDialog();
  assert.equal(auth.getSignInPayloads().length, 0);

  // A reload while signed out: the home and its address are still there.
  cleanup();
  const reloaded = render(<App auth={createTestAuthController({ ready: true, user: null }).adapter} />);
  await waitFor(() => assert.ok(reloaded.getByRole("button", { name: "Return to Cadtree" })));
  const remembered = (await getRememberedHome())!;
  assert.equal(await getWorkspacePath(remembered.homeId, nativeDirectory(diskRoot)), "D:\\Cadtree");

  // Signing in and out never hides or clears it.
  cleanup();
  const controller = createTestAuthController({ ready: true, user: null });
  const again = render(<App auth={controller.adapter} />);
  await waitFor(() => assert.ok(again.getByRole("button", { name: "Return to Cadtree" })));
  act(() => { controller.setUser(DEFAULT_TEST_USER); });
  assert.ok(again.getByRole("button", { name: "Return to Cadtree" }));
  await signOut(again);
  assert.ok(showsSignedOut(again));
  assert.ok(again.getByRole("button", { name: "Return to Cadtree" }));
  assert.equal((await getRememberedHome())!.homeId, remembered.homeId);
});

test("the app is usable while the sign-in service never answers", async () => {
  const diskRoot = new InMemoryFileSystemAdapter("Cadtree");
  Object.assign(window, { showDirectoryPicker: async () => nativeDirectory(diskRoot) });
  const silent = {
    subscribe: () => () => {},
    signInWithGoogle: () => new Promise<never>(() => {}),
    signOut: async () => {},
  };
  const ui = render(<App auth={silent} />);
  fireEvent.click(ui.getByRole("button", { name: "Start my Cadtree home" }));
  await completeHomeAddress(ui, "D:\\Cadtree");
  await waitFor(() => assert.ok(ui.getByRole("heading", { name: "My workspaces." })));
  await waitFor(() => assert.equal((ui.getByRole("button", { name: "Create workspace" }) as HTMLButtonElement).disabled, false));
  fireEvent.click(ui.getByRole("button", { name: "Create workspace" }));
  const dialog = within(ui.getByRole("dialog", { name: "Create workspace" }));
  fireEvent.change(dialog.getByLabelText("Workspace name"), { target: { value: "Studio" } });
  fireEvent.click(dialog.getByRole("button", { name: "Create workspace" }));
  await waitFor(() => assert.ok(ui.getByRole("button", { name: "Create project" })));
});

test("a signed-out visitor creates a home with no sign-in dialog; the Account sign-in handles cancel, failure and success without touching the open home", async () => {
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

  fireEvent.click(ui.getByRole("button", { name: "Start my Cadtree home" }));
  await waitFor(() =>
    assert.ok(ui.getByRole("dialog", { name: "Complete home setup" })),
  );
  assert.equal(pickerCalls, 1);
  assert.equal(ui.queryByRole("dialog", { name: "Account" }), null);
  await completeHomeAddress(ui, "D:\\Cadtree");
  await waitFor(() =>
    assert.ok(ui.getByRole("heading", { name: "My workspaces." })),
  );
  assert.equal(auth.getSignInPayloads().length, 0);

  // 1. Cancelled sign-in closes the dialog and changes nothing.
  auth.setSignInOutcome({ type: "cancel" });
  const first = await openAccount(ui);
  fireEvent.click(
    within(first).getByRole("button", { name: /Continue with Google/i }),
  );
  await waitFor(() => assert.ok(!ui.queryByRole("dialog")));
  assert.equal(ui.queryByRole("alert"), null);

  // 2. A failed sign-in shows a retryable error.
  auth.setSignInOutcome({
    type: "error",
    message: "Network connection failed during Google sign-in.",
  });
  const retry = await openAccount(ui);
  fireEvent.click(
    within(retry).getByRole("button", { name: /Continue with Google/i }),
  );
  await waitFor(() =>
    assert.match(
      within(retry).getByRole("alert").textContent!,
      /Network connection failed/,
    ),
  );

  // 3. Success closes the dialog; the open home stays open.
  auth.setSignInOutcome({ type: "success", user: DEFAULT_TEST_USER });
  fireEvent.click(
    within(retry).getByRole("button", { name: /Continue with Google/i }),
  );
  await waitFor(() => assert.ok(!ui.queryByRole("dialog")));
  assert.ok(ui.getByText(DEFAULT_TEST_USER.displayName!));
  assert.ok(ui.getByRole("heading", { name: "My workspaces." }));
  assert.equal(pickerCalls, 1);
  assert.deepEqual(auth.getSignInPayloads(), [[], [], []]);
});

test("Sign In / Create Account tabs, Email & Password authentication, and Forgot password flow", async () => {
  const auth = createTestAuthController({ ready: true, user: null });
  const ui = render(<App auth={auth.adapter} />);

  const modal = await openAccount(ui);

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

  await waitFor(() => assert.ok(!ui.queryByRole("dialog")));
  assert.ok(ui.getByText(DEFAULT_TEST_USER.displayName!));
  assert.deepEqual(auth.getSignInPayloads(), [
    [{ method: "create-account", email: "engineer@company.com" }],
  ]);
});

async function saveRevisionOffline(user: AccountUser | null) {
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

  const auth = createTestAuthController({ ready: true, user });
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
    changesPage.getByRole("textbox", { name: /Version summary/ }),
    { target: { value: "Initial offline capture" } },
  );

  // Trigger capture; when signed in, request Sign out while it is running.
  const saveBtn = changesPage.getByRole("button", {
    name: "Save version",
  });
  fireEvent.click(saveBtn);
  if (user) {
    await signOut(ui);
    // Signing out leaves the save and the open project alone.
    assert.ok(showsSignedOut(ui));
    assert.equal(auth.getSignOutCount(), 1);
  }
  await waitFor(() =>
    assert.equal(
      ui.container.querySelector("main")?.getAttribute("aria-busy"),
      "false",
    ),
  );
  assert.equal(
    (ui.getByRole("button", { name: "History" }) as HTMLButtonElement).disabled,
    false,
  );
  assert.equal(ui.queryByRole("button", { name: "Start my Cadtree home" }), null);
  assert.equal(ui.queryByRole("dialog", { name: "Account" }), null);

  // Reopen the actual managed vault and verify the completed save.
  const reopened = await resolveManagedProject(ws.workspace.root, imported.record.containerPath);
  assert.equal(reopened.vaultState.revisions.length, 1);
  assert.equal(reopened.vaultState.revisions[0].manifest.summary, "Initial offline capture");
  const working = reopened.workingFolders["branch-main"];
  assert.ok(working);
  assert.equal(await working.readFileText(["Bracket.SLDPRT"]), "initial CAD geometry");
}

test("signed-in user can capture versions offline and sign out while the save runs", () => saveRevisionOffline(DEFAULT_TEST_USER));
test("a signed-out user can open a project and save a version offline with no sign-in dialog", () => saveRevisionOffline(null));

test("signing out and signing in as another account keeps the open home, its workspaces and the remembered home", async () => {
  const homeA = new InMemoryFileSystemAdapter("Alice Engineering Home");
  const createdA = await createHome(homeA);
  await createHomeWorkspace(homeA, "Alice R&D", {
    expectedHomeId: createdA.identity.homeId,
  });

  Object.assign(window, {
    showDirectoryPicker: async () => nativeDirectory(homeA),
  });

  const auth = createTestAuthController({
    ready: true,
    user: DEFAULT_TEST_USER,
  });
  const ui = render(<App auth={auth.adapter} />);

  fireEvent.click(ui.getByRole("button", { name: "Open my Cadtree home" }));
  await completeHomeAddress(ui, "D:\\AliceSecretPath\\Cadtree");
  await waitFor(() =>
    assert.ok(ui.getByRole("heading", { name: "My workspaces." })),
  );
  assert.ok(ui.getByRole("heading", { name: "Alice R&D" }));

  await signOut(ui);
  assert.ok(showsSignedOut(ui));
  assert.ok(ui.getByRole("heading", { name: "My workspaces." }));
  assert.ok(ui.getByRole("heading", { name: "Alice R&D" }));

  act(() => {
    auth.setUser(SECOND_TEST_USER);
  });
  await waitFor(() =>
    assert.ok(ui.getByText(SECOND_TEST_USER.displayName!)),
  );
  assert.ok(ui.getByRole("heading", { name: "Alice R&D" }));

  // The disk is untouched, and a fresh page still offers the home to whoever opens the browser.
  assert.ok((await homeA.listEntries()).some((entry) => entry.name === ".cadtree-home.json"));
  assert.equal((await getRememberedHome())?.homeId, createdA.identity.homeId);
  cleanup();
  const reopened = render(<App auth={createTestAuthController({ ready: true, user: null }).adapter} />);
  await waitFor(() =>
    assert.ok(reopened.getByRole("button", { name: "Return to Alice Engineering Home" })),
  );
});
