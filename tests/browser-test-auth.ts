import {
  createTestAuthController,
  DEFAULT_TEST_USER,
  SECOND_TEST_USER,
  type SignInOutcome,
} from "./test-auth";
import type { AccountUser, AuthSnapshot } from "../src/auth/firebase-auth";
import { autoRefreshTiming } from "../src/app/useAutoRefresh";

const STORAGE_KEY = "__cadtree_browser_test_auth__";
const OUTCOME_KEY = "__cadtree_browser_test_auth_outcome__";

function loadInitialSnapshot(): AuthSnapshot {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as AuthSnapshot;
      if (typeof parsed.ready === "boolean") {
        return parsed;
      }
    }
  } catch {
    /* Fall back to signed-in test user */
  }
  return { ready: true, user: DEFAULT_TEST_USER };
}

function saveSnapshot(snapshot: AuthSnapshot) {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    /* Ignore storage errors */
  }
}

const controller = createTestAuthController(loadInitialSnapshot());

try {
  const rawOutcome = window.sessionStorage.getItem(OUTCOME_KEY);
  if (rawOutcome) {
    controller.setSignInOutcome(JSON.parse(rawOutcome) as SignInOutcome);
  }
} catch {
  /* Ignore */
}

controller.adapter.subscribe((snapshot) => {
  saveSnapshot(snapshot);
});

(
  window as unknown as {
    __CADTREE_TEST_AUTH__?: typeof controller.adapter;
    __CADTREE_TEST_AUTH_CONTROL__?: {
      DEFAULT_TEST_USER: AccountUser;
      SECOND_TEST_USER: AccountUser;
      setUser(user: AccountUser | null): void;
      setPending(): void;
      setSignInOutcome(outcome: SignInOutcome): void;
      getSignInPayloads(): unknown[];
      getSignOutCount(): number;
      getState(): AuthSnapshot;
    };
  }
).__CADTREE_TEST_AUTH__ = controller.adapter;

(
  window as unknown as {
    __CADTREE_TEST_AUTH_CONTROL__?: unknown;
  }
).__CADTREE_TEST_AUTH_CONTROL__ = {
  DEFAULT_TEST_USER,
  SECOND_TEST_USER,
  setUser(user: AccountUser | null) {
    saveSnapshot({ ready: true, user });
    controller.setUser(user);
  },
  setPending() {
    saveSnapshot({ ready: false, user: null });
    controller.setPending();
  },
  setSignInOutcome(outcome: SignInOutcome) {
    try {
      window.sessionStorage.setItem(OUTCOME_KEY, JSON.stringify(outcome));
    } catch {
      /* Ignore */
    }
    controller.setSignInOutcome(outcome);
  },
  getSignInPayloads() {
    return controller.getSignInPayloads();
  },
  getSignOutCount() {
    return controller.getSignOutCount();
  },
  getState() {
    return controller.getState();
  },
};

// The quiet background refresh waits seconds in the app; browser tests shorten it (see useAutoRefresh).
Object.assign(autoRefreshTiming, { debounceMs: 50, minIntervalMs: 0, retryMs: 50 });
