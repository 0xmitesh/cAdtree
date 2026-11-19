import "../../tests/dom";
import { indexedDB } from "fake-indexeddb";
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import App from "../App";
import {
  OFFLINE_SIGN_IN_MESSAGE,
  SIGN_IN_UNAVAILABLE_MESSAGE,
  SignInUnavailableError,
  createLazyAuthAdapter,
  type AccountUser,
  type AuthAdapter,
  type AuthSnapshot,
} from "../auth/firebase-auth";

Object.assign(globalThis, { indexedDB });
afterEach(() => {
  cleanup();
  Reflect.deleteProperty(navigator, "onLine");
});

const USER: AccountUser = { uid: "saved-user", email: "saved@example.com", displayName: "Saved User" };

/** A stand-in for the real Firebase adapter that reports `saved` once it has loaded. */
function fakeFirebase(saved: AccountUser | null) {
  const listeners = new Set<(state: AuthSnapshot) => void>();
  const adapter: AuthAdapter = {
    subscribe(listener) {
      listeners.add(listener);
      queueMicrotask(() => listener({ ready: true, user: saved }));
      return () => listeners.delete(listener);
    },
    signInWithGoogle: async () => USER,
    signOut: async () => {
      for (const listener of listeners) listener({ ready: true, user: null });
    },
  };
  return adapter;
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

test("the lazy adapter starts signed out and ready, and loads nothing when no session is saved", async () => {
  let loads = 0;
  const adapter = createLazyAuthAdapter(async () => { loads++; return fakeFirebase(USER); }, async () => false);
  assert.deepEqual(adapter.getCurrentState!(), { ready: true, user: null });
  const seen: AuthSnapshot[] = [];
  adapter.subscribe((state) => seen.push(state));
  await tick();
  assert.equal(loads, 0, "Firebase is not loaded for a visitor with no saved session");
  assert.deepEqual(seen, [{ ready: true, user: null }]);
  await adapter.signOut();
  assert.equal(loads, 0, "signing out with nothing loaded does not load Firebase");
});

test("the lazy adapter loads after the first paint when a session may be saved and upgrades the state", async () => {
  let loads = 0;
  const adapter = createLazyAuthAdapter(async () => { loads++; return fakeFirebase(USER); }, async () => true);
  const seen: AuthSnapshot[] = [];
  adapter.subscribe((state) => seen.push(state));
  assert.equal(loads, 0, "nothing is loaded while subscribing");
  assert.deepEqual(seen, [{ ready: true, user: null }], "the first snapshot is signed out and never waits");
  await tick();
  assert.equal(loads, 1);
  assert.deepEqual(seen.at(-1), { ready: true, user: USER });
  assert.deepEqual(adapter.getCurrentState!(), { ready: true, user: USER });
});

test("signing in loads Firebase on demand; offline or a failed load gives a clear message and can be retried", async () => {
  let loads = 0;
  let fail = true;
  const adapter = createLazyAuthAdapter(async () => {
    loads++;
    if (fail) throw new Error("chunk failed");
    return fakeFirebase(null);
  }, async () => false);

  Object.defineProperty(navigator, "onLine", { value: false, configurable: true });
  await assert.rejects(adapter.signInWithGoogle(), { message: OFFLINE_SIGN_IN_MESSAGE });
  assert.equal(loads, 0, "offline is reported without loading anything");
  Reflect.deleteProperty(navigator, "onLine");

  await assert.rejects(adapter.signInWithGoogle(), { message: OFFLINE_SIGN_IN_MESSAGE });
  assert.equal(loads, 1);
  fail = false;
  assert.equal((await adapter.signInWithGoogle()).uid, USER.uid);
  assert.equal(loads, 2, "a failed load is retried");
  await adapter.signInWithGoogle();
  assert.equal(loads, 2, "a loaded Firebase is reused");
});

test("opening the Account dialog starts loading the sign-in code; the app alone does not", async () => {
  let preloads = 0;
  const adapter: AuthAdapter = {
    getCurrentState: () => ({ ready: true, user: null }),
    subscribe: (listener) => { listener({ ready: true, user: null }); return () => {}; },
    signInWithGoogle: async () => USER,
    signOut: async () => {},
    preload: () => { preloads++; },
  };
  const ui = render(<App auth={adapter} />);
  await tick();
  assert.equal(preloads, 0);
  fireEvent.click(ui.getByRole("button", { name: "Account" }));
  await waitFor(() => assert.ok(ui.getByRole("dialog", { name: "Account" })));
  assert.equal(preloads, 1);
  assert.match(ui.getByRole("dialog").textContent!, /You do not need an account/);
});

test("a failure that is not about the connection says sign-in is unavailable; sign-out after a failed load is friendly too", async () => {
  const quiet = console.error;
  console.error = () => {};
  try {
    const adapter = createLazyAuthAdapter(async () => { throw new SignInUnavailableError(new Error("bad config")); }, async () => false);
    await assert.rejects(adapter.signInWithGoogle(), { message: SIGN_IN_UNAVAILABLE_MESSAGE });
    const failing = createLazyAuthAdapter(async () => { throw new Error("Failed to fetch dynamically imported module"); }, async () => false);
    await assert.rejects(failing.signInWithGoogle(), { message: OFFLINE_SIGN_IN_MESSAGE });
    // A failed load that is still in flight when signing out gives the friendly message, not the raw error.
    let rejectLoad!: (error: Error) => void;
    const pending = createLazyAuthAdapter(() => new Promise<AuthAdapter>((_, reject) => { rejectLoad = reject; }), async () => false);
    pending.preload!();
    const out = pending.signOut();
    rejectLoad(new Error("Failed to fetch dynamically imported module"));
    await assert.rejects(out, { message: OFFLINE_SIGN_IN_MESSAGE });
  } finally {
    console.error = quiet;
  }
});
