import { useEffect, useState } from "react";
import type { ProgressUpdate } from "../engine/types";
import type { GetVersionCheck, GetVersionController } from "../app/useGetVersionActions";
import { Modal, Notice, OperationProgress } from "./ui";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Confirmation for Get this version: checks the working folder first (a fresh
 * scan), then puts the file from the chosen revision into it on Confirm.
 */
export function GetVersionDialog({
  controller,
  revisionId,
  path,
  progress,
  onCancel,
  onClose,
}: {
  controller: GetVersionController;
  revisionId: string;
  path: string;
  progress: ProgressUpdate | null;
  onCancel: () => void;
  onClose: () => void;
}) {
  const [check, setCheck] = useState<GetVersionCheck | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);
  useEffect(() => {
    let live = true;
    controller
      .check(revisionId, path)
      .then((result) => live && setCheck(result))
      .catch((e) => live && setError(message(e)))
      .finally(() => live && setBusy(false));
    return () => {
      live = false;
    };
    // Checked once, when the dialog opens.
  }, []);
  const confirm = async () => {
    if (!check) return;
    setBusy(true);
    setError("");
    try {
      await controller.confirm(check);
      onClose();
    } catch (e) {
      setError(message(e));
      setBusy(false);
    }
  };
  const blocked = controller.blockedReason ?? check?.blockers.join(" ");
  return (
    <Modal title="Get this version" busy={busy} onClose={onClose}>
      {error ? <Notice type="error">{error}</Notice> : null}
      {!check && !error ? <p className="muted">Checking your working folder…</p> : null}
      {check ? (
        <>
          <p>
            Put <strong className="file-path">{path}</strong> from {check.fromLabel} into
            your working folder? It will show as an unsaved change.
          </p>
          {blocked ? <Notice type="error">{blocked}</Notice> : null}
          {!blocked && check.hasUnsavedEdits ? (
            <Notice type="info">
              Your current edits will be kept in {check.keptFolder}.
            </Notice>
          ) : null}
        </>
      ) : null}
      {busy ? <OperationProgress progress={progress} onCancel={onCancel} /> : null}
      <div className="modal-actions">
        <button className="button secondary" disabled={busy} onClick={onClose}>
          Cancel
        </button>
        <button
          className="button primary"
          disabled={busy || !check || Boolean(blocked)}
          onClick={() => void confirm()}
        >
          Get this version
        </button>
      </div>
    </Modal>
  );
}
