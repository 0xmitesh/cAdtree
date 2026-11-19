/**
 * Account types and the lazy sign-in adapter.
 *
 * Signing in is optional: nothing in the app waits for it. This module does not import Firebase.
 * The Firebase code lives in firebase-adapter.ts and is loaded with import() only when the Account
 * control is opened, or after the first paint when a saved session may exist in this browser.
 */

export interface AccountUser {
  uid: string;
  email: string | null;
  displayName: string | null;
}

export interface AuthSnapshot {
  ready: boolean;
  user: AccountUser | null;
}

export interface AuthAdapter {
  subscribe(listener: (state: AuthSnapshot) => void): () => void;
  signInWithGoogle(): Promise<AccountUser>;
  signInWithEmail?(email: string, password: string): Promise<AccountUser>;
  signUpWithEmail?(email: string, password: string): Promise<AccountUser>;
  sendPasswordReset?(email: string): Promise<void>;
  signOut(): Promise<void>;
  getCurrentState?(): AuthSnapshot;
  /** Starts loading the sign-in code ahead of a click (the real adapter loads Firebase lazily). */
  preload?(): void;
}

export class SignInCancelledError extends Error {
  readonly cancelled = true;
  constructor(message = "Sign-in was cancelled.") {
    super(message);
    this.name = "SignInCancelledError";
  }
}

export function isSignInCancelled(error: unknown): boolean {
  if (!error) return false;
  if (error instanceof SignInCancelledError) return true;
  if (error instanceof DOMException && error.name === "AbortError") return true;
  const code = (error as { code?: unknown }).code;
  return (
    code === "auth/popup-closed-by-user" ||
    code === "auth/cancelled-popup-request" ||
    code === "auth/user-cancelled"
  );
}

export const OFFLINE_SIGN_IN_MESSAGE =
  "Sign-in needs an internet connection. Check your connection and try again.";

export const SIGN_IN_UNAVAILABLE_MESSAGE = "Sign-in isn't available right now. Try again later.";

/** Firebase loaded but cannot be used (for example a missing or bad configuration). */
export class SignInUnavailableError extends Error {
  constructor(cause?: unknown) {
    super(SIGN_IN_UNAVAILABLE_MESSAGE, cause === undefined ? undefined : { cause });
    this.name = "SignInUnavailableError";
  }
}

const SIGNED_OUT: AuthSnapshot = { ready: true, user: null };

/** True when Firebase has stored a signed-in user in this browser (read without loading Firebase). */
async function hasSavedSession(): Promise<boolean> {
  try {
    for (let i = 0; i < localStorage.length; i++) {
      if (localStorage.key(i)?.startsWith("firebase:authUser:")) return true;
    }
  } catch {
    /* Storage may be unavailable. */
  }
  try {
    if (typeof indexedDB === "undefined" || !indexedDB) return false;
    const names = await indexedDB.databases?.();
    if (!names?.some((entry) => entry.name === "firebaseLocalStorageDb")) return false;
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("firebaseLocalStorageDb");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      if (!db.objectStoreNames.contains("firebaseLocalStorage")) return false;
      const keys = await new Promise<IDBValidKey[]>((resolve, reject) => {
        const request = db
          .transaction("firebaseLocalStorage", "readonly")
          .objectStore("firebaseLocalStorage")
          .getAllKeys();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      return keys.some((key) => typeof key === "string" && key.startsWith("firebase:authUser:"));
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}

/**
 * The adapter the app uses by default. It starts as signed out and ready, and never makes the app wait.
 * Firebase is loaded on demand; when it reports a saved user the state is upgraded.
 */
export function createLazyAuthAdapter(
  loadFirebase: () => Promise<AuthAdapter> = async () =>
    (await import("./firebase-adapter")).loadFirebaseAuthAdapter(),
  savedSessionCheck: () => Promise<boolean> = hasSavedSession,
): AuthAdapter {
  let latest: AuthSnapshot = SIGNED_OUT;
  const listeners = new Set<(state: AuthSnapshot) => void>();
  let loading: Promise<AuthAdapter> | null = null;
  let checkedForSavedSession = false;

  const publish = (next: AuthSnapshot) => {
    latest = next;
    for (const listener of [...listeners]) listener(next);
  };
  const load = (): Promise<AuthAdapter> => {
    if (!loading) {
      loading = loadFirebase().then((inner) => {
        // Reports the saved user once Firebase has read it, and every later change.
        inner.subscribe((state) => {
          if (state.ready) publish(state);
        });
        return inner;
      });
      // A failed load (for example offline with an uncached chunk) can be retried by the next call.
      loading.catch(() => {
        loading = null;
      });
    }
    return loading;
  };
  // A load that fails because the code could not be fetched is a connection problem; anything else
  // (such as a bad Firebase configuration) is "not available", with the detail kept in the console.
  const loadFriendly = async (): Promise<AuthAdapter> => {
    try {
      return await load();
    } catch (error) {
      if (error instanceof SignInUnavailableError) {
        console.error("Sign-in is unavailable:", error.cause ?? error);
        throw error;
      }
      throw new Error(OFFLINE_SIGN_IN_MESSAGE);
    }
  };
  const ready = async (): Promise<AuthAdapter> => {
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      throw new Error(OFFLINE_SIGN_IN_MESSAGE);
    }
    return loadFriendly();
  };
  const scheduleSavedSessionCheck = () => {
    if (checkedForSavedSession) return;
    checkedForSavedSession = true;
    // After the first paint, so the app is never held up by it.
    setTimeout(() => {
      void savedSessionCheck().then((saved) => {
        if (saved) void load().catch(() => {});
      });
    }, 0);
  };

  return {
    getCurrentState: () => latest,
    subscribe(listener) {
      listeners.add(listener);
      listener(latest);
      scheduleSavedSessionCheck();
      return () => {
        listeners.delete(listener);
      };
    },
    preload() {
      void load().catch(() => {});
    },
    async signInWithGoogle() {
      return (await ready()).signInWithGoogle();
    },
    async signInWithEmail(email, password) {
      const inner = await ready();
      if (!inner.signInWithEmail) throw new Error("Email authentication is unavailable. Use Continue with Google.");
      return inner.signInWithEmail(email, password);
    },
    async signUpWithEmail(email, password) {
      const inner = await ready();
      if (!inner.signUpWithEmail) throw new Error("Email authentication is unavailable. Use Continue with Google.");
      return inner.signUpWithEmail(email, password);
    },
    async sendPasswordReset(email) {
      const inner = await ready();
      if (!inner.sendPasswordReset) throw new Error("Password reset is unavailable. Try again later.");
      return inner.sendPasswordReset(email);
    },
    async signOut() {
      // Only a loaded Firebase can hold a signed-in user; without it there is nothing to sign out of.
      if (!loading) {
        publish(SIGNED_OUT);
        return;
      }
      const inner = await loadFriendly();
      await inner.signOut();
      publish(SIGNED_OUT);
    },
  };
}

let defaultAdapter: AuthAdapter | null = null;

export function resolveAuthAdapter(explicit?: AuthAdapter): AuthAdapter {
  if (explicit) return explicit;
  if (!import.meta.env?.PROD) {
    const testAdapter = (
      globalThis as { __CADTREE_TEST_AUTH__?: AuthAdapter }
    ).__CADTREE_TEST_AUTH__;
    if (testAdapter) return testAdapter;
  }
  defaultAdapter ??= createLazyAuthAdapter();
  return defaultAdapter;
}
