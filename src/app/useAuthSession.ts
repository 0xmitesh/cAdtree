import { useEffect, useRef, useState, type RefObject } from "react";
import {
  type AccountUser,
  type AuthAdapter,
  type AuthSnapshot,
  isSignInCancelled,
  resolveAuthAdapter,
} from "../auth/firebase-auth";
import {
  type RememberedHome,
  type RememberedWorkspace,
  setConvenienceAccountScope,
} from "../engine/idb-store";
import type { BannerScope, PendingAuthAction, SignInPrompt, StatusBanner } from "./types";

export type UseAuthSessionArgs = {
  auth?: AuthAdapter;
  resetActiveSessionUi: () => void;
  setRememberedWorkspace: (value: RememberedWorkspace | null) => void;
  setRememberedHome: (value: RememberedHome | null) => void;
  // The values below come from code App declares after this hook; they are read only when called.
  getOperationRef: () => RefObject<AbortController | null>;
  setBannerScope: (scope: BannerScope) => void;
  setStatusBanner: (banner: StatusBanner | null) => void;
  completeAuthenticatedSignIn: (
    account: AccountUser,
    intendedAction: PendingAuthAction,
  ) => Promise<void>;
  connectHomeInternal: (create: boolean, saved?: RememberedHome) => Promise<void>;
};

/** Sign-in and sign-out: the account state, the sign-in dialog's handlers, and sign-out deferred while an operation runs. */
export function useAuthSession({
  auth,
  resetActiveSessionUi,
  setRememberedWorkspace,
  setRememberedHome,
  getOperationRef,
  setBannerScope,
  setStatusBanner,
  completeAuthenticatedSignIn,
  connectHomeInternal,
}: UseAuthSessionArgs) {
  const authAdapterRef = useRef<AuthAdapter | null>(null);
  if (!authAdapterRef.current || auth) {
    authAdapterRef.current = resolveAuthAdapter(auth);
  }
  const authAdapter = authAdapterRef.current;
  const [authState, setAuthState] = useState<AuthSnapshot>(() => {
    const initial = authAdapter.getCurrentState?.() ?? {
      ready: false,
      user: null,
    };
    setConvenienceAccountScope(
      initial.ready && initial.user ? initial.user.uid : null,
    );
    return initial;
  });
  const authStateRef = useRef<AuthSnapshot>(authState);
  authStateRef.current = authState;
  const [signInPrompt, setSignInPrompt] = useState<SignInPrompt | null>(null);
  const [signOutPending, setSignOutPending] = useState(false);
  const pendingSignOutRef = useRef(false);
  const pendingAccountSnapshotRef = useRef<AuthSnapshot | null>(null);

  const applyAuthSnapshot = (next: AuthSnapshot) => {
    const prevUid = authStateRef.current.user?.uid ?? null;
    const nextUid = next.ready && next.user ? next.user.uid : null;
    setConvenienceAccountScope(nextUid);
    authStateRef.current = next;
    setAuthState(next);
    if (prevUid !== null && prevUid !== nextUid) {
      resetActiveSessionUi();
    } else if (nextUid === null) {
      setRememberedWorkspace(null);
      setRememberedHome(null);
    }
  };

  useEffect(() => {
    return authAdapter.subscribe((next) => {
      const prevUid = authStateRef.current.user?.uid ?? null;
      const nextUid = next.ready && next.user ? next.user.uid : null;
      if (getOperationRef().current && prevUid !== null && prevUid !== nextUid) {
        pendingAccountSnapshotRef.current = next;
        setSignOutPending(true);
        return;
      }
      // A later auth event can return to the account whose write is still running.
      // Discard any superseded switch rather than applying it after completion.
      if (getOperationRef().current && pendingAccountSnapshotRef.current) {
        pendingAccountSnapshotRef.current = null;
        setSignOutPending(pendingSignOutRef.current);
      }
      applyAuthSnapshot(next);
    });
  }, [authAdapter]);

  const executeSignOut = async () => {
    setSignOutPending(true);
    try {
      await authAdapter.signOut();
    } catch (error) {
      pendingSignOutRef.current = false;
      setBannerScope("workspace");
      setStatusBanner({
        type: "error",
        message:
          error instanceof Error ? error.message : "Could not sign out.",
      });
      setSignOutPending(false);
      return;
    }
    pendingSignOutRef.current = false;
    pendingAccountSnapshotRef.current = null;
    setSignOutPending(false);
    setSignInPrompt(null);
    applyAuthSnapshot({ ready: true, user: null });
    resetActiveSessionUi();
  };

  const handleRequestSignOut = () => {
    if (signOutPending || pendingSignOutRef.current) return;
    pendingSignOutRef.current = true;
    if (getOperationRef().current) {
      setSignOutPending(true);
      return;
    }
    void executeSignOut();
  };

  const requestSignIn = (action: PendingAuthAction) => {
    setSignInPrompt({
      step: "sign-in",
      action,
      signingIn: false,
      error: null,
      info: null,
    });
  };
  const handleContinueWithGoogle = async () => {
    if (!signInPrompt || signInPrompt.signingIn) return;
    const intendedAction = signInPrompt.action;
    setSignInPrompt({
      ...signInPrompt,
      signingIn: true,
      error: null,
      info: null,
    });
    try {
      const account = await authAdapter.signInWithGoogle();
      await completeAuthenticatedSignIn(account, intendedAction);
    } catch (error) {
      if (isSignInCancelled(error)) {
        setSignInPrompt(null);
        return;
      }
      setSignInPrompt({
        step: "sign-in",
        action: intendedAction,
        signingIn: false,
        error:
          error instanceof Error
            ? error.message
            : "Google sign-in failed. Try again.",
        info: null,
      });
    }
  };
  const handleSubmitEmailAuth = async (
    mode: "sign-in" | "create-account",
    email: string,
    password: string,
  ) => {
    if (!signInPrompt || signInPrompt.signingIn) return;
    const trimmedEmail = email.trim();
    if (!trimmedEmail) {
      setSignInPrompt({
        ...signInPrompt,
        error: "Enter your email address.",
        info: null,
      });
      return;
    }
    if (!password || password.length < 6) {
      setSignInPrompt({
        ...signInPrompt,
        error: "Password must be at least 6 characters.",
        info: null,
      });
      return;
    }
    const intendedAction = signInPrompt.action;
    setSignInPrompt({
      ...signInPrompt,
      signingIn: true,
      error: null,
      info: null,
    });
    try {
      const emailAction = mode === "create-account"
        ? authAdapter.signUpWithEmail
        : authAdapter.signInWithEmail;
      if (!emailAction) throw new Error("Email authentication is unavailable. Use Continue with Google.");
      const account = await emailAction.call(authAdapter, trimmedEmail, password);
      await completeAuthenticatedSignIn(account, intendedAction);
    } catch (error) {
      setSignInPrompt({
        step: "sign-in",
        action: intendedAction,
        signingIn: false,
        error:
          error instanceof Error
            ? error.message
            : mode === "create-account"
              ? "Account creation failed. Try again."
              : "Sign-in failed. Try again.",
        info: null,
      });
    }
  };
  const handleForgotPassword = async (email: string) => {
    if (!signInPrompt || signInPrompt.signingIn) return;
    const trimmedEmail = email.trim();
    if (!trimmedEmail) {
      setSignInPrompt({
        ...signInPrompt,
        error: "Enter your email address first to receive a password reset link.",
        info: null,
      });
      return;
    }
    const intendedAction = signInPrompt.action;
    setSignInPrompt({
      ...signInPrompt,
      signingIn: true,
      error: null,
      info: null,
    });
    try {
      if (!authAdapter.sendPasswordReset) throw new Error("Password reset is unavailable. Try again later.");
      await authAdapter.sendPasswordReset(trimmedEmail);
      setSignInPrompt({
        step: "sign-in",
        action: intendedAction,
        signingIn: false,
        error: null,
        info: `Password reset email sent to ${trimmedEmail}. Check your inbox.`,
      });
    } catch (error) {
      setSignInPrompt({
        step: "sign-in",
        action: intendedAction,
        signingIn: false,
        error:
          error instanceof Error
            ? error.message
            : "Could not send password reset email. Try again.",
        info: null,
      });
    }
  };
  const handleContinuePickerAfterSignIn = () => {
    if (!signInPrompt || signInPrompt.action.kind !== "connect-home") {
      setSignInPrompt(null);
      return;
    }
    const { create, saved } = signInPrompt.action;
    setSignInPrompt(null);
    void connectHomeInternal(create, saved);
  };

  return {
    authState,
    authStateRef,
    signInPrompt,
    setSignInPrompt,
    signOutPending,
    setSignOutPending,
    pendingSignOutRef,
    pendingAccountSnapshotRef,
    applyAuthSnapshot,
    executeSignOut,
    handleRequestSignOut,
    requestSignIn,
    handleContinueWithGoogle,
    handleSubmitEmailAuth,
    handleForgotPassword,
    handleContinuePickerAfterSignIn,
  };
}
