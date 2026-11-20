import { useEffect, useRef, useState } from "react";
import { ReplacePlanChangedError, replaceKeepsCopy } from "../engine/apply-preview";
import type { ReplaceWorkingFilesResult } from "../engine/application-service";
import { discardedFolderBase } from "../engine/discarded-paths";
import type { ProgressUpdate } from "../engine/types";
import type { DiscardReview, DiscardSelection } from "../app/useDiscardActions";
import { Modal, Notice, OperationProgress } from "./ui";

/** What the Changes view and the Bring back dialog need to discard unsaved changes. */
export interface DiscardController {
  /** Read-only: a fresh full-hash scan and the plan for the selection. */
  review: (branchId: string, selection: DiscardSelection) => Promise<DiscardReview | undefined>;
  /** Writes the confirmed plan (engine `replaceWorkingFiles`, mode `discard`). */
  discard: (review: DiscardReview) => Promise<ReplaceWorkingFilesResult | undefined>;
  progress: ProgressUpdate | null;
  cancel: () => void;
  /** Why discarding isn't possible right now (read-only case, unfinished operation…). */
  blockedReason?: string;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * The Discard confirmation: what will happen to each file and folder, built from
 * a fresh scan (never the list on screen), and where the copy of the edits goes.
 * If the files changed before Confirm, the engine refuses and the dialog shows
 * the new plan to review again.
 */
export function DiscardDialog({
  branchId,
  selection,
  folder = false,
  caseName,
  controller,
  onClose,
}: {
  branchId: string;
  selection: DiscardSelection;
  /** The single selected path is a folder: everything inside it is discarded too. */
  folder?: boolean;
  caseName: string;
  controller: DiscardController;
  onClose: () => void;
}) {
  const [review, setReview] = useState<DiscardReview | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const runningRef = useRef(false);
  const [error, setError] = useState("");
  const [stale, setStale] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const load = async () => {
    setLoading(true);
    try {
      const next = await controller.review(branchId, selection);
      if (mounted.current) setReview(next ?? null);
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mounted.current) setLoading(false);
    }
  };
  useEffect(() => {
    void load();
    // One fresh review when the dialog opens; "review again" asks for another.
  }, []);
  const confirm = async () => {
    if (!review || runningRef.current || !review.plan.ready) return;
    runningRef.current = true;
    setRunning(true);
    setError("");
    setStale(false);
    try {
      await controller.discard(review);
      onClose();
    } catch (e) {
      if (!mounted.current) return;
      if (e instanceof ReplacePlanChangedError) {
        setStale(true);
        setReview(null);
        await load();
      } else setError(e instanceof Error ? e.message : String(e));
    } finally {
      runningRef.current = false;
      if (mounted.current) setRunning(false);
    }
  };
  const plan = review?.plan;
  const actions = plan?.actions ?? [];
  const folders = plan?.folderActions ?? [];
  const groups: [string, string[]][] = [
    ["Put back to the saved version", actions.filter((a) => a.before && a.after).map((a) => a.path)],
    ["Removed (not in the saved version)", actions.filter((a) => a.before && !a.after).map((a) => a.path)],
    ["Brought back (deleted since the last save)", actions.filter((a) => !a.before && a.after).map((a) => a.path)],
    ["Folders removed", folders.filter((f) => f.operation === "remove").map((f) => `${f.path}/`)],
    ["Folders brought back", folders.filter((f) => f.operation === "create").map((f) => `${f.path}/`)],
  ];
  const count = actions.length + folders.length;
  const nothing = Boolean(plan && !count);
  const ready = Boolean(plan?.ready) && !running && !loading && !controller.blockedReason;
  const title =
    selection === "all"
      ? `Discard all changes in ${caseName}`
      : folder
        ? "Discard this folder and everything inside it"
        : "Discard this change";
  return (
    <Modal title={title} onClose={onClose} busy={running}>
      <div className="apply-preview discard-dialog">
        {stale ? (
          <Notice type="error">Changes differ from what you saw; review again.</Notice>
        ) : null}
        {error ? <Notice type="error">{error}</Notice> : null}
        {controller.blockedReason ? <Notice type="error">{controller.blockedReason}</Notice> : null}
        {folder && selection !== "all" ? (
          <p className="muted small">
            Discards <span className="file-path">{selection[0]}/</span> and everything inside it.
          </p>
        ) : null}
        {loading ? <p role="status">Checking your files…</p> : null}
        {plan && !loading ? (
          <>
            <p role="status" aria-label="What will change">
              <strong>
                {nothing
                  ? "There are no unsaved changes to discard."
                  : `${plural(count, "change", "changes")} will be discarded`}
              </strong>
            </p>
            {nothing ? null : (
              <p className="muted small">
                These files go back to how they were in the last saved revision. Other
                unsaved files are not touched. Close these files in your CAD program first.
              </p>
            )}
            {replaceKeepsCopy(plan) ? (
              <p data-testid="discard-copy-line">
                A copy of your edits will be kept in a folder like Discarded/
                {discardedFolderBase(new Date())} in the project folder.
              </p>
            ) : null}
            {groups.map(([heading, paths]) =>
              paths.length ? (
                <section key={heading} aria-label={heading}>
                  <h3>
                    {heading} ({paths.length})
                  </h3>
                  <ul className="application-actions">
                    {paths.map((path) => (
                      <li key={path} className="file-path">
                        {path}
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null,
            )}
            {!nothing && plan.blockers.length ? (
              <Notice type="error">
                <ul>
                  {plan.blockers.map((b) => (
                    <li key={b}>{b}</li>
                  ))}
                </ul>
              </Notice>
            ) : null}
          </>
        ) : null}
        <OperationProgress
          progress={running || loading ? controller.progress : null}
          onCancel={controller.cancel}
        />
        <div className="modal-actions">
          <button className="button secondary" onClick={onClose} disabled={running}>
            Cancel
          </button>
          <button
            className="button primary"
            disabled={!ready || nothing}
            onClick={() => void confirm()}
          >
            {running ? "Discarding…" : "Discard"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
