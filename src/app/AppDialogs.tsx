import type { Dispatch, SetStateAction } from "react";
import { AccountModal } from "../components/AccountControls";
import { FolderAddressDialog } from "../components/FolderAddressDialog";
import { ProjectLearningModal } from "../components/ProjectLearningModal";
import { Modal } from "../components/ui";
import {
  WorkspaceTree,
  type WorkspaceTreeProps,
} from "../components/WorkspaceTree";
import type { AccountUser } from "../auth/firebase-auth";
import type { HomeState } from "../engine/home-service";
import type { VaultState } from "../engine/types";
import type { BannerScope, PendingHome, SignInPrompt, StatusBanner } from "./types";

export interface AppDialogsProps {
  busy: boolean;
  home: HomeState | null;
  homeView: boolean;
  vaultState: VaultState | null;
  treeProps: WorkspaceTreeProps;
  pendingHome: PendingHome | null;
  setPendingHome: Dispatch<SetStateAction<PendingHome | null>>;
  connectHome: (create: boolean) => Promise<void>;
  setBannerScope: Dispatch<SetStateAction<BannerScope>>;
  setStatusBanner: Dispatch<SetStateAction<StatusBanner | null>>;
  onCompleteHomeSetup: (path: string) => Promise<void>;
  addressPrompt: { resolve: (saved: boolean) => void } | null;
  settleAddressPrompt: (saved: boolean) => void;
  onSaveHomeAddressFromPrompt: (path: string) => Promise<void>;
  learningOpen: boolean;
  setLearningOpen: Dispatch<SetStateAction<boolean>>;
  explorerOpen: boolean;
  setExplorerOpen: Dispatch<SetStateAction<boolean>>;
  signInPrompt: SignInPrompt | null;
  setSignInPrompt: Dispatch<SetStateAction<SignInPrompt | null>>;
  accountUser: AccountUser | null;
  signOutPending: boolean;
  onSignOut: () => void;
  handleContinueWithGoogle: () => Promise<void>;
  handleSubmitEmailAuth: (
    mode: "sign-in" | "create-account",
    email: string,
    password: string,
  ) => Promise<void>;
  handleForgotPassword: (email: string) => Promise<void>;
}

/** Dialogs hosted by the shell: home address, learning, folder browser and sign-in. */
export function AppDialogs({
  busy,
  home,
  homeView,
  vaultState,
  treeProps,
  pendingHome,
  setPendingHome,
  connectHome,
  setBannerScope,
  setStatusBanner,
  onCompleteHomeSetup,
  addressPrompt,
  settleAddressPrompt,
  onSaveHomeAddressFromPrompt,
  learningOpen,
  setLearningOpen,
  explorerOpen,
  setExplorerOpen,
  signInPrompt,
  setSignInPrompt,
  accountUser,
  signOutPending,
  onSignOut,
  handleContinueWithGoogle,
  handleSubmitEmailAuth,
  handleForgotPassword,
}: AppDialogsProps) {
  return (
    <>
      {pendingHome ? (
        <FolderAddressDialog
          key={pendingHome.requestId}
          home
          folderName={pendingHome.root.name}
          onSave={onCompleteHomeSetup}
          onCancel={() => setPendingHome(null)}
          onBack={() => {
            const create = pendingHome.create;
            setPendingHome(null);
            void connectHome(create).catch((error) => {
              setBannerScope("workspace");
              setStatusBanner({ type: "error", message: String(error) });
            });
          }}
        />
      ) : null}
      {addressPrompt && home ? (
        <FolderAddressDialog
          home
          folderName={home.root.name}
          title="Add your Cadtree home address"
          intro="cAdtree needs the full address to keep paths within Windows' limit; the browser can't read it."
          onSave={onSaveHomeAddressFromPrompt}
          onCancel={() => {
            settleAddressPrompt(false);
          }}
        />
      ) : null}
      {learningOpen && !homeView && vaultState ? (
        <ProjectLearningModal busy={busy} onClose={() => setLearningOpen(false)} />
      ) : null}
      {explorerOpen ? (
        <Modal
          title="Browse folders"
          busy={busy}
          onClose={() => setExplorerOpen(false)}
        >
          <div className="mobile-workspace-tree">
            <WorkspaceTree {...treeProps} />
          </div>
        </Modal>
      ) : null}
      {signInPrompt ? (
        <AccountModal
          user={accountUser}
          signOutPending={signOutPending}
          onSignOut={onSignOut}
          signingIn={signInPrompt.signingIn}
          error={signInPrompt.error}
          info={signInPrompt.info}
          onContinueWithGoogle={() => {
            void handleContinueWithGoogle();
          }}
          onSubmitEmail={(mode, email, password) => {
            void handleSubmitEmailAuth(mode, email, password);
          }}
          onForgotPassword={(email) => {
            void handleForgotPassword(email);
          }}
          onClearFeedback={() => {
            setSignInPrompt((prev) =>
              prev ? { ...prev, error: null, info: null } : null,
            );
          }}
          onCancel={() => {
            if (!signInPrompt.signingIn) setSignInPrompt(null);
          }}
        />
      ) : null}
    </>
  );
}
