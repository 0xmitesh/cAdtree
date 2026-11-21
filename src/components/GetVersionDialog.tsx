import { useEffect, useRef, useState } from "react";
import { ReplacePlanChangedError } from "../engine/apply-preview";
import type { ProgressUpdate } from "../engine/types";
import type { GetVersionCheck, GetVersionController } from "../app/useGetVersionActions";
import { Modal, Notice, OperationProgress } from "./ui";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Confirmation for Get this version: checks the working folder first (a fresh
 * scan), then puts the file from the chosen revision into it on Confirm. If the
 * files changed after the check, the engine refuses and the dialog checks again.
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
  const [stale, setStale] = useState(false);
  const live = useRef(true);
  const load = async () => {
    setBusy(true);
    try {
      const result = await controller.check(revisionId, path);
      if (live.current) setCheck(result);
    } catch (e) {
      if (live.current) setError(message(e));
    } finally {
      if (live.current) setBusy(false);
    }
  };
  useEffect(() => {
    live.current = true;
    void load();
    return () => {
      live.current = false;
    };
    // Checked once, when the dialog opens; a stale plan asks for another check.
  }, []);
  const confirm = async () => {
    if (!check) return;
    setBusy(true);
    setError("");
    setStale(false);
    try {
      await controller.confirm(check);
      onClose();
    } catch (e) {
      if (!live.current) return;
      if (e instanceof ReplacePlanChangedError) {
        setStale(true);
        setCheck(null);
        await load();
      } else {
        setError(message(e));
        setBusy(false);
      }
    }
  };
  const blocked = controller.blockedReason ?? check?.blockers.join(" ");
  return (
    <Modal title="Get this version" busy={busy} onClose={onClose}>
      {stale ? (
        <Notice type="error">Changes differ from what you saw; review again.</Notice>
      ) : null}
      {error ? <Notice type="error">{error}</Notice> : null}
      {!check && !error ? <p className="muted">Checking your working folder…</p> : null}
      {check ? (
        <>
          {check.fromCase ? (
            <p data-testid="get-version-other-case">
              Get {check.revisionLabel} of <strong className="file-path">{path}</strong> from{" "}
              <strong>{check.fromCase}</strong>. It goes into {check.intoCase}'s working
              folder as an unsaved change.
            </p>
          ) : (
            <p>
              Put <strong className="file-path">{path}</strong> from {check.fromLabel} into
              your working folder? It will show as an unsaved change.
            </p>
          )}
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
