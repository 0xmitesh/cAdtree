import { useState, type FormEvent } from "react";
import { ArrowRight, Lock, Mail } from "lucide-react";
import type { AccountUser } from "../auth/firebase-auth";
import { Modal, Notice } from "./ui";

export interface AccountStatusControlProps {
  ready: boolean;
  user: AccountUser | null;
  busy: boolean;
  signOutPending: boolean;
  onSignIn: () => void;
  onSignOut: () => void;
}

export function AccountStatusControl({
  ready,
  user,
  busy,
  signOutPending,
  onSignIn,
  onSignOut,
}: AccountStatusControlProps) {
  if (!ready) {
    return (
      <div className="account-control" aria-live="polite">
        <span className="account-status-label">Checking session…</span>
      </div>
    );
  }
  if (!user) {
    return (
      <div className="account-control">
        <button
          type="button"
          className="text-button account-action-button"
          disabled={busy}
          onClick={onSignIn}
        >
          Sign in
        </button>
      </div>
    );
  }
  const label = user.displayName || user.email || "Signed-in account";
  return (
    <div className="account-control" aria-label="Account status">
      <span className="account-user-label" title={user.email ?? label}>
        {label}
      </span>
      <button
        type="button"
        className="text-button account-action-button"
        disabled={signOutPending}
        onClick={onSignOut}
      >
        {signOutPending ? "Finishing write…" : "Sign out"}
      </button>
    </div>
  );
}

export interface AccountSignInModalProps {
  signingIn: boolean;
  error: string | null;
  info?: string | null;
  onContinueWithGoogle: () => void;
  onSubmitEmail?: (
    mode: "sign-in" | "create-account",
    email: string,
    password: string,
  ) => void;
  onForgotPassword?: (email: string) => void;
  onClearFeedback?: () => void;
  onCancel: () => void;
}

export function AccountSignInModal({
  signingIn,
  error,
  info,
  onContinueWithGoogle,
  onSubmitEmail,
  onForgotPassword,
  onClearFeedback,
  onCancel,
}: AccountSignInModalProps) {
  const [mode, setMode] = useState<"sign-in" | "create-account">("sign-in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const handleFormSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (signingIn || !onSubmitEmail) return;
    onSubmitEmail(mode, email, password);
  };

  return (
    <Modal title="Sign in to cAdtree" busy={signingIn} onClose={onCancel}>
      <div className="auth-modal-body">
        <p className="muted auth-modal-subtitle">
          Sign in or create a free account. You do not need one to use cAdtree
          on your own computer, and your CAD files always stay on your device.
        </p>

        <div className="auth-mode-tabs" role="tablist" aria-label="Account mode">
          <button
            type="button"
            role="tab"
            aria-selected={mode === "sign-in"}
            className={`auth-mode-tab${mode === "sign-in" ? " active" : ""}`}
            disabled={signingIn}
            onClick={() => {
              setMode("sign-in");
              onClearFeedback?.();
            }}
          >
            Sign In
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "create-account"}
            className={`auth-mode-tab${mode === "create-account" ? " active" : ""}`}
            disabled={signingIn}
            onClick={() => {
              setMode("create-account");
              onClearFeedback?.();
            }}
          >
            Create Account
          </button>
        </div>

        <button
          type="button"
          className="button secondary auth-google-button"
          disabled={signingIn}
          onClick={onContinueWithGoogle}
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            aria-hidden="true"
            className="auth-google-icon"
          >
            <path
              fill="#4285F4"
              d="M23.49 12.27c0-.79-.07-1.54-.19-2.27H12v4.51h6.47c-.29 1.48-1.14 2.73-2.4 3.58v3h3.86c2.26-2.09 3.56-5.17 3.56-8.82Z"
            />
            <path
              fill="#34A853"
              d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.86-3c-1.08.72-2.45 1.16-4.07 1.16-3.13 0-5.78-2.11-6.73-4.96H1.29v3.09C3.26 21.3 7.31 24 12 24Z"
            />
            <path
              fill="#FBBC05"
              d="M5.27 14.29c-.25-.72-.38-1.49-.38-2.29s.14-1.57.38-2.29V6.62H1.29C.47 8.24 0 10.06 0 12s.47 3.76 1.29 5.38l3.98-3.09Z"
            />
            <path
              fill="#EA4335"
              d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.7 1.29 6.62l3.98 3.09c.95-2.85 3.6-4.96 6.73-4.96Z"
            />
          </svg>
          <span>Continue with Google / Gmail</span>
        </button>

        <div className="auth-divider" role="separator">
          <span>OR CONTINUE WITH EMAIL</span>
        </div>

        <form className="auth-email-form" onSubmit={handleFormSubmit}>
          <label className="field auth-field">
            <span>Email Address</span>
            <div className="auth-input-wrap">
              <Mail size={16} aria-hidden="true" className="auth-input-icon" />
              <input
                type="email"
                required
                autoComplete="email"
                placeholder="name@company.com"
                disabled={signingIn}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
          </label>

          <div className="field auth-field">
            <div className="auth-password-header">
              <label htmlFor="cadtree-auth-password">Password</label>
              {mode === "sign-in" && onForgotPassword ? (
                <button
                  type="button"
                  className="text-button auth-forgot-button"
                  disabled={signingIn}
                  onClick={() => onForgotPassword(email)}
                >
                  Forgot password?
                </button>
              ) : null}
            </div>
            <div className="auth-input-wrap">
              <Lock size={16} aria-hidden="true" className="auth-input-icon" />
              <input
                id="cadtree-auth-password"
                type="password"
                required
                minLength={6}
                autoComplete={
                  mode === "sign-in" ? "current-password" : "new-password"
                }
                placeholder="••••••••"
                disabled={signingIn}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
          </div>

          {error ? <Notice type="error">{error}</Notice> : null}
          {info ? <Notice type="success">{info}</Notice> : null}

          <button
            type="submit"
            className="button primary auth-submit-button"
            disabled={signingIn}
          >
            <span>
              {signingIn
                ? mode === "create-account"
                  ? "Creating account…"
                  : "Signing in…"
                : mode === "create-account"
                  ? "Create Account"
                  : "Sign In"}
            </span>
            <ArrowRight size={15} aria-hidden="true" />
          </button>
        </form>
      </div>
    </Modal>
  );
}
