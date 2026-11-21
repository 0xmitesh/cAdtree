import { useEffect, useId, useState } from "react";
import type { RevisionNotes } from "../engine/types";

/**
 * One main field bound to `modification`, with a "More detail" disclosure for
 * `problem` ("Why") and `observations` ("What you noticed"). The disclosure
 * starts open when either of those already has text, and opens by itself when
 * text arrives later (Save now fills Why). With `label={null}` there is no main
 * field: only the More detail disclosure is shown (the version's overall notes,
 * whose one required line is the version summary).
 */
export function NoteEditor({
  value,
  onChange,
  disabled,
  scope,
  label,
}: {
  value: RevisionNotes;
  onChange: (value: RevisionNotes) => void;
  disabled?: boolean;
  scope: string;
  label: "Note" | null;
}) {
  const id = useId();
  const hasDetail = Boolean(value.problem.trim() || value.observations.trim());
  const [detailOpen, setDetailOpen] = useState(hasDetail);
  useEffect(() => {
    if (hasDetail) setDetailOpen(true);
  }, [hasDetail]);
  const extra = [
    ["problem", "Why"],
    ["observations", "What you noticed"],
  ] as const;
  return (
    <div className="notes-fields" data-testid={`note-${scope}`}>
      {label ? (
        <label htmlFor={`${id}-modification`}>
          <span>{label}</span>
          <textarea
            id={`${id}-modification`}
            aria-label={`${scope}: ${label}`}
            value={value.modification}
            onChange={(e) => onChange({ ...value, modification: e.target.value })}
            disabled={disabled}
            rows={3}
          />
        </label>
      ) : null}
      <details
        className="note-more-detail"
        open={detailOpen}
        onToggle={(e) => setDetailOpen(e.currentTarget.open)}
      >
        <summary>More detail</summary>
        {extra.map(([field, text]) => (
          <label key={field} htmlFor={`${id}-${field}`}>
            <span>{text}</span>
            <textarea
              id={`${id}-${field}`}
              aria-label={`${scope}: ${text}`}
              value={value[field]}
              onChange={(e) => onChange({ ...value, [field]: e.target.value })}
              disabled={disabled}
              rows={2}
            />
          </label>
        ))}
      </details>
    </div>
  );
}
