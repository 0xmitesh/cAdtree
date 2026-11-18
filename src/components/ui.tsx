import { useEffect, useId, useRef, type ReactNode } from "react";
import { AlertCircle, Check, X } from "lucide-react";
import type {
  ProgressUpdate,
  RevisionNotes,
  VaultState,
} from "../engine/types";
import { formatBytes } from "../utils/format";

export function Modal({
  title,
  children,
  onClose,
  busy = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  busy?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const opener = useRef(document.activeElement as HTMLElement | null);
  const id = useId();
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    return () => {
      dialog.close();
      if (opener.current?.isConnected) opener.current.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      aria-labelledby={id}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
      className="modal"
    >
      <div className="modal-heading">
        <h2 id={id}>{title}</h2>
        <button
          className="icon-button"
          aria-label="Close dialog"
          disabled={busy}
          onClick={onClose}
        >
          <X size={18} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
/** Plain text that may contain line breaks (for example a measured path on its own line). */
export function MessageLines({ text }: { text: string }) {
  const lines = text.split("\n");
  if (lines.length === 1) return <>{text}</>;
  return (
    <>
      {lines.map((line, index) => (
        <span key={index} style={{ display: "block" }}>
          {line}
        </span>
      ))}
    </>
  );
}

export function Notice({
  type = "info",
  children,
  onDismiss,
}: {
  type?: "info" | "error" | "success";
  children: ReactNode;
  onDismiss?: () => void;
}) {
  return (
    <div
      className={`notice ${type}`}
      role={type === "error" ? "alert" : "status"}
    >
      {type === "success" ? <Check size={17} /> : <AlertCircle size={17} />}
      <div>{children}</div>
      {onDismiss ? (
        <button
          type="button"
          className="icon-button"
          aria-label="Dismiss message"
          onClick={onDismiss}
        >
          <X size={16} />
        </button>
      ) : null}
    </div>
  );
}
export function OperationProgress({
  progress,
  onCancel,
}: {
  progress: ProgressUpdate | null;
  onCancel: () => void;
}) {
  if (!progress) return null;
  return (
    <div className="operation" role="status">
      <div>
        <strong>{progress.message}</strong>
        <p>
          {progress.processedFiles} / {progress.totalFiles} files ·{" "}
          {formatBytes(progress.processedBytes)} /{" "}
          {formatBytes(progress.totalBytes)}
        </p>
        <progress
          max={Math.max(1, progress.totalFiles)}
          value={progress.processedFiles}
        />
      </div>
      <button className="button secondary" onClick={onCancel}>
        Cancel operation
      </button>
    </div>
  );
}
export function NotesFields({
  value,
  onChange,
  disabled,
  scope,
}: {
  value: RevisionNotes;
  onChange: (value: RevisionNotes) => void;
  disabled?: boolean;
  scope: string;
}) {
  const id = useId();
  return (
    <div className="notes-fields">
      {(["problem", "modification", "observations"] as const).map((field) => (
        <label key={field} htmlFor={`${id}-${field}`}>
          <span>
            {
              {
                problem: "Problem or intent",
                modification: "Engineering change",
                observations: "Observations",
              }[field]
            }
          </span>
          <textarea
            id={`${id}-${field}`}
            aria-label={`${scope}: ${field}`}
            value={value[field]}
            onChange={(e) => onChange({ ...value, [field]: e.target.value })}
            disabled={disabled}
            rows={2}
          />
        </label>
      ))}
    </div>
  );
}
export function NotesText({ notes }: { notes: RevisionNotes }) {
  return (
    <dl className="notes-text">
      {(["problem", "modification", "observations"] as const)
        .filter((k) => notes[k]?.trim())
        .map((k) => (
          <div key={k}>
            <dt>
              {
                {
                  problem: "Problem or intent",
                  modification: "Engineering change",
                  observations: "Observations",
                }[k]
              }
            </dt>
            <dd>{notes[k]}</dd>
          </div>
        ))}
    </dl>
  );
}
export function IntegrityNotice({ state }: { state: VaultState }) {
  const damaged =
    state.revisions.filter((r) => r.integrityStatus === "corrupted").length +
    state.corruptedRecords.length;
  const conflicts = Object.values(state.competingHeads).some(
    (h) => h.length > 0,
  );
  const blocked = Object.keys(state.damagedBranchHeads).length > 0;
  if (!damaged && !conflicts && !blocked) return null;
  return (
    <Notice type="error">
      <strong>History needs attention.</strong>{" "}
      {damaged > 0 ? `${damaged} damaged record(s). ` : ""}
      {conflicts ? "Competing branch heads. " : ""}
      {blocked ? "The branch baseline is damaged. " : ""}Check Settings →
      Troubleshooting. Unsafe saves and restores remain blocked.
    </Notice>
  );
}
export function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`status-badge ${status.toLowerCase().split(" ")[0]}`}>
      {status}
    </span>
  );
}
