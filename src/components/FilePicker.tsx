import { useEffect, useId, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import type { FileHistoryEntry } from "../history/file-history";

/** Type-to-filter picker for the History page. An empty value means "All files". */
export function FilePicker({
  entries,
  value,
  onChange,
}: {
  entries: FileHistoryEntry[];
  value: string;
  onChange: (value: string) => void;
}) {
  const baseId = useId();
  const inputId = `${baseId}-input`;
  const listId = `${baseId}-list`;
  const inputRef = useRef<HTMLInputElement>(null);
  // Set while the clear button hands focus back to the input, so that does not reopen the list.
  const refocusing = useRef(false);
  const [open, setOpen] = useState(false);
  // null: not editing, so the input shows the selected file.
  const [query, setQuery] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const selected = entries.find((entry) => entry.value === value);
  const selectedLabel = value ? (selected?.label ?? value) : "";
  const text = query ?? selectedLabel;
  const needle = (query ?? "").trim().toLowerCase();
  const options = useMemo(() => {
    const filtered = needle
      ? entries.filter(
          (entry) =>
            entry.label.toLowerCase().includes(needle) ||
            entry.paths.some((path) => path.toLowerCase().includes(needle)),
        )
      : entries;
    return [
      ...(needle ? [] : [{ value: "", label: "All files" }]),
      ...filtered.map(({ value: v, label }) => ({ value: v, label })),
    ];
  }, [entries, needle]);
  const safeActive = Math.min(active, Math.max(options.length - 1, 0));
  const optionId = (index: number) => `${baseId}-option-${index}`;

  useEffect(() => {
    if (!open) return;
    (document.getElementById(optionId(safeActive)) as HTMLElement | null)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [open, safeActive]);

  const show = () => {
    if (open) return;
    setOpen(true);
    setActive(Math.max(0, options.findIndex((option) => option.value === value)));
  };
  const close = () => {
    setOpen(false);
    setQuery(null);
  };
  const choose = (next: string) => {
    close();
    if (next !== value) onChange(next);
  };

  return (
    <div className="history-file-picker">
      <label htmlFor={inputId}>File</label>
      <div className="file-picker-box">
        <input
          ref={inputRef}
          id={inputId}
          className="file-picker-input"
          type="text"
          role="combobox"
          autoComplete="off"
          spellCheck={false}
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-activedescendant={open && options.length ? optionId(safeActive) : undefined}
          placeholder="All files"
          title={value ? (selected?.path ?? value) : "All files"}
          value={text}
          onFocus={(event) => {
            if (refocusing.current) {
              refocusing.current = false;
              return;
            }
            event.currentTarget.select();
            show();
          }}
          onClick={show}
          onBlur={close}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
            setOpen(true);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              if (!open) {
                show();
                return;
              }
              const step = event.key === "ArrowDown" ? 1 : -1;
              setActive(Math.min(Math.max(safeActive + step, 0), options.length - 1));
            } else if (event.key === "Enter" && open && options.length) {
              event.preventDefault();
              choose(options[safeActive].value);
            } else if (event.key === "Escape" && open) {
              event.preventDefault();
              event.stopPropagation();
              close();
            }
          }}
        />
        {value ? (
          <button
            type="button"
            className="file-picker-clear"
            aria-label="Show all files"
            title="Show all files"
            onClick={() => {
              close();
              onChange("");
              refocusing.current = true;
              inputRef.current?.focus();
              refocusing.current = false;
            }}
          >
            <X size={14} />
          </button>
        ) : null}
        {open ? (
          <div
            className="file-picker-popup"
            // The scroll bar and padding must not take focus from the input, or blur would close the list.
            onMouseDown={(event) => event.preventDefault()}
          >
            {options.length ? (
              <ul id={listId} role="listbox" aria-label="Files">
                {options.map((option, index) => (
                  <li
                    key={option.value || "all"}
                    id={optionId(index)}
                    role="option"
                    aria-selected={option.value === value}
                    className={index === safeActive ? "active" : undefined}
                    title={option.label}
                    // Keep focus in the input so blur does not close the list before the click lands.
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseMove={() => setActive(index)}
                    onClick={() => choose(option.value)}
                  >
                    {option.label}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="file-picker-empty" role="status">No files match.</p>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
