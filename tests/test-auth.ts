import {
  SignInCancelledError,
  type AccountUser,
  type AuthAdapter,
  type AuthSnapshot,
} from "../src/auth/firebase-auth";

export const DEFAULT_TEST_USER: AccountUser = {
  uid: "test-engineer-1",
  email: "engineer@example.com",
  displayName: "Test Engineer",
};

export const SECOND_TEST_USER: AccountUser = {
  uid: "test-engineer-2",
  email: "second@example.com",
  displayName: "Second Engineer",
};

export type SignInOutcome =
  | { type: "success"; user?: AccountUser }
  | { type: "cancel" }
  | { type: "error"; message: string };

export interface TestAuthController {
  adapter: AuthAdapter;
  getState(): AuthSnapshot;
  setUser(user: AccountUser | null): void;
  setPending(): void;
  setSignInOutcome(outcome: SignInOutcome): void;
  getSignInPayloads(): unknown[];
  getResetEmails(): string[];
  getSignOutCount(): number;
  reset(snapshot?: AuthSnapshot): void;
}

export function createTestAuthController(
  initial: AuthSnapshot = { ready: true, user: DEFAULT_TEST_USER },
): TestAuthController {
  let state: AuthSnapshot = { ...initial };
  let nextOutcome: SignInOutcome = {
    type: "success",
    user: DEFAULT_TEST_USER,
  };
  const listeners = new Set<(snapshot: AuthSnapshot) => void>();
  const signInPayloads: unknown[] = [];
  const resetEmails: string[] = [];
  let signOutCount = 0;

  const notify = () => {
    const snapshot = { ...state };
    for (const listener of [...listeners]) {
      listener(snapshot);
    }
  };

  const resolveOutcome = (fallbackEmail?: string): AccountUser => {
    if (nextOutcome.type === "cancel") {
      throw new SignInCancelledError();
    }
    if (nextOutcome.type === "error") {
      throw new Error(nextOutcome.message);
    }
    const user =
      nextOutcome.user ??
      (fallbackEmail
        ? {
            uid: `email-${fallbackEmail}`,
            email: fallbackEmail,
            displayName: fallbackEmail.split("@")[0] || fallbackEmail,
          }
        : DEFAULT_TEST_USER);
    state = { ready: true, user };
    notify();
    return user;
  };

  const adapter: AuthAdapter = {
    getCurrentState() {
      return { ...state };
    },
    subscribe(listener) {
      listeners.add(listener);
      listener({ ...state });
      return () => {
        listeners.delete(listener);
      };
    },
    async signInWithGoogle(...args: unknown[]) {
      signInPayloads.push(args);
      return resolveOutcome();
    },
    async signInWithEmail(email: string, _password: string) {
      signInPayloads.push([{ method: "sign-in", email }]);
      return resolveOutcome(email);
    },
    async signUpWithEmail(email: string, _password: string) {
      signInPayloads.push([{ method: "create-account", email }]);
      return resolveOutcome(email);
    },
    async sendPasswordReset(email: string) {
      if (nextOutcome.type === "error") {
        throw new Error(nextOutcome.message);
      }
      resetEmails.push(email);
    },
    async signOut() {
      signOutCount++;
      state = { ready: true, user: null };
      notify();
    },
  };

  return {
    adapter,
    getState: () => ({ ...state }),
    setUser(user) {
      state = { ready: true, user };
      notify();
    },
    setPending() {
      state = { ready: false, user: null };
      notify();
    },
    setSignInOutcome(outcome) {
      nextOutcome = outcome;
    },
    getSignInPayloads: () => [...signInPayloads],
    getResetEmails: () => [...resetEmails],
    getSignOutCount: () => signOutCount,
    reset(snapshot = { ready: true, user: DEFAULT_TEST_USER }) {
      state = { ...snapshot };
      nextOutcome = {
        type: "success",
        user: snapshot.user ?? DEFAULT_TEST_USER,
      };
      signInPayloads.length = 0;
      resetEmails.length = 0;
      signOutCount = 0;
      notify();
    },
  };
}

const globalController = createTestAuthController();

export function installGlobalTestAuth(): TestAuthController {
  (
    globalThis as {
      __CADTREE_TEST_AUTH__?: AuthAdapter;
      __CADTREE_TEST_AUTH_CONTROLLER__?: TestAuthController;
    }
  ).__CADTREE_TEST_AUTH__ = globalController.adapter;
  (
    globalThis as {
      __CADTREE_TEST_AUTH_CONTROLLER__?: TestAuthController;
    }
  ).__CADTREE_TEST_AUTH_CONTROLLER__ = globalController;
  return globalController;
}

export function resetGlobalTestAuth(
  snapshot: AuthSnapshot = { ready: true, user: DEFAULT_TEST_USER },
): TestAuthController {
  installGlobalTestAuth();
  globalController.reset(snapshot);
  return globalController;
}
