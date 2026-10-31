import { useEffect, useState, type CSSProperties } from "react";

const preferenceKey = "cadtree.sidebar-width";
const minimum = 240;
const defaultWidth = 260;
const maximumFor = (viewport: number) =>
  Math.max(minimum, Math.min(400, viewport - 720));

/** Presentation preference only; never accesses project files or bindings. */
export function useSidebarWidth() {
  const [preferred, setPreferred] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(preferenceKey));
      return Number.isFinite(saved) && saved >= minimum
        ? Math.min(saved, 400)
        : defaultWidth;
    } catch {
      return defaultWidth;
    }
  });
  const [viewport, setViewport] = useState(() => window.innerWidth);
  useEffect(() => {
    const resize = () => setViewport(window.innerWidth);
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  const max = maximumFor(viewport);
  const width = Math.min(preferred, max);
  const change = (value: number) => {
    const next = Math.round(Math.max(minimum, Math.min(max, value)));
    setPreferred(next);
    try {
      localStorage.setItem(preferenceKey, String(next));
    } catch {
      /* Resizing still works without persistence. */
    }
  };
  return {
    width,
    max,
    change,
    style: { "--sidebar-width": `${width}px` } as CSSProperties,
  };
}

export function SidebarResizeHandle({
  width,
  max,
  onChange,
}: {
  width: number;
  max: number;
  onChange: (width: number) => void;
}) {
  return (
    <div
      className="sidebar-resizer"
      role="separator"
      tabIndex={0}
      aria-label="Resize sidebar"
      aria-orientation="vertical"
      aria-valuemin={minimum}
      aria-valuemax={max}
      aria-valuenow={width}
      aria-valuetext={`${width} pixels`}
      title="Drag to resize sidebar. Arrow keys adjust width; Home and End set limits."
      onKeyDown={(event) => {
        const next =
          event.key === "ArrowLeft"
            ? width - 16
            : event.key === "ArrowRight"
              ? width + 16
              : event.key === "Home"
                ? minimum
                : event.key === "End"
                  ? max
                  : undefined;
        if (next !== undefined) {
          event.preventDefault();
          onChange(next);
        }
      }}
      onPointerDown={(event) => {
        if (event.button === 0) {
          event.currentTarget.setPointerCapture(event.pointerId);
          event.currentTarget.focus();
          event.preventDefault();
        }
      }}
      onPointerMove={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId))
          onChange(event.clientX);
      }}
      onPointerUp={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId))
          event.currentTarget.releasePointerCapture(event.pointerId);
      }}
    />
  );
}
