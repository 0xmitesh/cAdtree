import { useEffect, useRef, useState } from "react";
import {
  type AccountUser,
  type AuthAdapter,
  type AuthSnapshot,
  isSignInCancelled,
  resolveAuthAdapter,
} from "../auth/firebase-auth";
import type { BannerScope, SignInPrompt, StatusBanner } from "./types";

export type UseAuthSessionArgs = {
  auth?: AuthAdapter;
  setBannerScope: (scope: BannerScope) => void;
  setStatusBanner: (banner: StatusBanner | null) => void;
};

/**
 * The optional account: its state, the sign-in dialog's handlers and sign-out.
 * Signing in or out only changes the account shown in the app. It never closes the open project,
 * never changes what the browser remembers, and no local action waits for it.
 */
export function useAuthSession({
  auth,
  setBannerScope,
  setStatusBanner,
}: UseAuthSessionArgs) {
  const authAdapterRef = useRef<AuthAdapter | null>(null);
  if (!authAdapterRef.current || auth) {
    authAdapterRef.current = resolveAuthAdapter(auth);
  }
  const authAdapter = authAdapterRef.current;
  const [authState, setAuthState] = useState<AuthSnapshot>(
    () => authAdapter.getCurrentState?.() ?? { ready: false, user: null },
  );
  const authStateRef = useRef<AuthSnapshot>(authState);
  authStateRef.current = authState;
  const [signInPrompt, setSignInPrompt] = useState<SignInPrompt | null>(null);
  const [signOutPending, setSignOutPending] = useState(false);

  const applyAuthSnapshot = (next: AuthSnapshot) => {
    authStateRef.current = next;
    setAuthState(next);
  };

  useEffect(() => authAdapter.subscribe(applyAuthSnapshot), [authAdapter]);

  const handleRequestSignOut = async () => {
    if (signOutPending) return;
    setSignOutPending(true);
    try {
      await authAdapter.signOut();
      setSignInPrompt(null);
      applyAuthSnapshot({ ready: true, user: null });
    } catch (error) {
      setBannerScope("workspace");
      setStatusBanner({
        type: "error",
        message:
          error instanceof Error ? error.message : "Could not sign out.",
      });
    } finally {
      setSignOutPending(false);
    }
  };

  const requestSignIn = () => {
    setSignInPrompt({ signingIn: false, error: null, info: null });
  };
  // Signing in only changes the account shown in the app; it never touches the open session.
  const completeSignIn = (account: AccountUser) => {
    applyAuthSnapshot({ ready: true, user: account });
    setSignInPrompt(null);
  };
  const handleContinueWithGoogle = async () => {
    if (!signInPrompt || signInPrompt.signingIn) return;
    setSignInPrompt({
      ...signInPrompt,
      signingIn: true,
      error: null,
      info: null,
    });
    try {
      const account = await authAdapter.signInWithGoogle();
      completeSignIn(account);
    } catch (error) {
      if (isSignInCancelled(error)) {
        setSignInPrompt(null);
        return;
      }
      setSignInPrompt({
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
      completeSignIn(account);
    } catch (error) {
      setSignInPrompt({
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
        signingIn: false,
        error: null,
        info: `Password reset email sent to ${trimmedEmail}. Check your inbox.`,
      });
    } catch (error) {
      setSignInPrompt({
        signingIn: false,
        error:
          error instanceof Error
            ? error.message
            : "Could not send password reset email. Try again.",
        info: null,
      });
    }
  };
  return {
    authState,
    authStateRef,
    signInPrompt,
    setSignInPrompt,
    signOutPending,
    handleRequestSignOut,
    requestSignIn,
    handleContinueWithGoogle,
    handleSubmitEmailAuth,
    handleForgotPassword,
  };
}
