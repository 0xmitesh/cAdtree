import { getApp, getApps, initializeApp } from "firebase/app";
import {
  GoogleAuthProvider,
  createUserWithEmailAndPassword,
  getAuth,
  onAuthStateChanged,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut as firebaseSignOut,
  type Auth,
  type User,
} from "firebase/auth";
import firebaseConfig from "../../firebase-applet-config.json";

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

export function isUserActivationError(error: unknown): boolean {
  if (!error) return false;
  if (error instanceof Error && error.cause && error.cause !== error) {
    return isUserActivationError(error.cause);
  }
  if (error instanceof DOMException && error.name === "SecurityError") {
    return true;
  }
  const name = (error as { name?: unknown }).name;
  const message =
    error instanceof Error ? error.message : String(error ?? "");
  return (
    name === "SecurityError" ||
    /user gesture|user activation|must be handling a user gesture/i.test(
      message,
    )
  );
}

function toAccountUser(user: User): AccountUser {
  return {
    uid: user.uid,
    email: user.email,
    displayName: user.displayName,
  };
}

function formatEmailAuthError(error: unknown, mode: "sign-in" | "sign-up" | "reset"): string {
  const code = (error as { code?: unknown })?.code;
  if (
    code === "auth/invalid-credential" ||
    code === "auth/wrong-password" ||
    code === "auth/user-not-found"
  ) {
    return "Incorrect email or password. Try again or create an account.";
  }
  if (code === "auth/email-already-in-use") {
    return "An account with this email already exists. Switch to Sign In or reset your password.";
  }
  if (code === "auth/weak-password") {
    return "Password must be at least 6 characters.";
  }
  if (code === "auth/invalid-email") {
    return "Enter a valid email address.";
  }
  if (code === "auth/operation-not-allowed") {
    return "Email sign-in is unavailable right now. Try Continue with Google.";
  }
  if (code === "auth/too-many-requests") {
    return "Too many attempts. Wait a moment and try again.";
  }
  if (code === "auth/network-request-failed") {
    return "Network connection failed. Check your connection and try again.";
  }
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (mode === "reset") {
    return "Could not send password reset email. Try again.";
  }
  return mode === "sign-up"
    ? "Account creation could not be completed. Try again."
    : "Sign-in could not be completed. Try again.";
}

let cachedAuthInstance: Auth | null = null;
let cachedFirebaseAdapter: AuthAdapter | null = null;

function getFirebaseAuthInstance(): Auth {
  if (cachedAuthInstance) return cachedAuthInstance;
  const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
  const auth = getAuth(app);
  cachedAuthInstance = auth;
  return auth;
}

export function getFirebaseAuthAdapter(): AuthAdapter {
  if (cachedFirebaseAdapter) return cachedFirebaseAdapter;
  let latestState: AuthSnapshot = { ready: false, user: null };
  cachedFirebaseAdapter = {
    getCurrentState: () => latestState,
    subscribe(listener) {
      let active = true;
      const emit = (user: User | null) => {
        if (!active) return;
        latestState = {
          ready: true,
          user: user ? toAccountUser(user) : null,
        };
        listener(latestState);
      };
      try {
        const auth = getFirebaseAuthInstance();
        const fallbackTimer = setTimeout(() => {
          if (!latestState.ready) {
            emit(auth.currentUser);
          }
        }, 1200);
        void auth
          .authStateReady()
          .then(() => {
            clearTimeout(fallbackTimer);
            if (!latestState.ready) {
              emit(auth.currentUser);
            }
          })
          .catch(() => {
            clearTimeout(fallbackTimer);
            if (!latestState.ready) {
              emit(auth.currentUser);
            }
          });
        const unsubscribe = onAuthStateChanged(
          auth,
          (user) => {
            clearTimeout(fallbackTimer);
            emit(user);
          },
          () => {
            clearTimeout(fallbackTimer);
            emit(null);
          },
        );
        return () => {
          active = false;
          clearTimeout(fallbackTimer);
          unsubscribe();
        };
      } catch {
        latestState = { ready: true, user: null };
        listener(latestState);
        return () => {
          active = false;
        };
      }
    },
    async signInWithGoogle() {
      const auth = getFirebaseAuthInstance();
      const provider = new GoogleAuthProvider();
      provider.setCustomParameters({ prompt: "select_account" });
      try {
        const credential = await signInWithPopup(auth, provider);
        const account = toAccountUser(credential.user);
        latestState = { ready: true, user: account };
        return account;
      } catch (error) {
        if (isSignInCancelled(error)) {
          throw new SignInCancelledError();
        }
        const code = (error as { code?: unknown })?.code;
        if (code === "auth/unauthorized-domain") {
          throw new Error(
            "Google sign-in is not authorized for this domain in Firebase Authentication settings.",
          );
        }
        if (code === "auth/popup-blocked") {
          throw new Error(
            "Sign-in popup was blocked by the browser. Allow popups for this site and try again.",
          );
        }
        if (code === "auth/network-request-failed") {
          throw new Error(
            "Network connection failed during Google sign-in. Check your connection and try again.",
          );
        }
        throw new Error(
          error instanceof Error && error.message
            ? error.message
            : "Google sign-in could not be completed. Try again.",
        );
      }
    },
    async signInWithEmail(email: string, password: string) {
      const auth = getFirebaseAuthInstance();
      try {
        const credential = await signInWithEmailAndPassword(
          auth,
          email.trim(),
          password,
        );
        const account = toAccountUser(credential.user);
        latestState = { ready: true, user: account };
        return account;
      } catch (error) {
        throw new Error(formatEmailAuthError(error, "sign-in"));
      }
    },
    async signUpWithEmail(email: string, password: string) {
      const auth = getFirebaseAuthInstance();
      try {
        const credential = await createUserWithEmailAndPassword(
          auth,
          email.trim(),
          password,
        );
        const account = toAccountUser(credential.user);
        latestState = { ready: true, user: account };
        return account;
      } catch (error) {
        throw new Error(formatEmailAuthError(error, "sign-up"));
      }
    },
    async sendPasswordReset(email: string) {
      const auth = getFirebaseAuthInstance();
      try {
        await sendPasswordResetEmail(auth, email.trim());
      } catch (error) {
        throw new Error(formatEmailAuthError(error, "reset"));
      }
    },
    async signOut() {
      const auth = getFirebaseAuthInstance();
      await firebaseSignOut(auth);
      latestState = { ready: true, user: null };
    },
  };
  return cachedFirebaseAdapter;
}

export function resolveAuthAdapter(explicit?: AuthAdapter): AuthAdapter {
  if (explicit) return explicit;
  if (!import.meta.env?.PROD) {
    const testAdapter = (
      globalThis as { __CADTREE_TEST_AUTH__?: AuthAdapter }
    ).__CADTREE_TEST_AUTH__;
    if (testAdapter) return testAdapter;
  }
  return getFirebaseAuthAdapter();
}
