"use client";
import { useEffect, useRef, type ReactNode } from "react";
export function LifecycleDialog({
  title,
  busy,
  onCancel,
  children,
}: {
  title: string;
  busy: boolean;
  onCancel: () => void;
  children: ReactNode;
}) {
  const box = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = box.current;
    if (!dialog) return;
    const previous = document.activeElement;
    dialog.showModal(); // Native top-layer modal: background is actually inert.
    const retainFocus = (event: FocusEvent) => {
      if (!dialog.contains(event.target as Node)) dialog.focus();
    };
    document.addEventListener("focusin", retainFocus, true);
    return () => {
      document.removeEventListener("focusin", retainFocus, true);
      dialog.close();
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus();
    };
  }, []);
  useEffect(() => {
    const dialog = box.current;
    if (!dialog) return;
    if (busy) dialog.focus();
    else if (
      !dialog.contains(document.activeElement) ||
      document.activeElement === dialog
    )
      (
        dialog.querySelector<HTMLElement>(
          "button:not(:disabled),input:not(:disabled),a[href]",
        ) ?? dialog
      ).focus();
  }, [busy, children]);
  return (
    <dialog
      role="dialog"
      className="trash-dialog"
      ref={box}
      tabIndex={-1}
      aria-modal="true"
      aria-label={title}
      aria-busy={busy}
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!busy) onCancel();
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key !== "Tab") return;
        const nodes = Array.from(
          box.current?.querySelectorAll<HTMLElement>(
            "button:not(:disabled),input:not(:disabled),a[href]",
          ) ?? [],
        );
        const first = nodes[0],
          last = nodes.at(-1),
          active = document.activeElement;
        if (!first) {
          event.preventDefault();
          box.current?.focus();
        } else if (
          event.shiftKey &&
          (active === first || active === box.current)
        ) {
          event.preventDefault();
          last?.focus();
        } else if (
          !event.shiftKey &&
          (active === last || active === box.current)
        ) {
          event.preventDefault();
          first.focus();
        }
      }}
    >
      <h2>{title}</h2>
      <button type="button" disabled={busy} onClick={onCancel}>
        取消
      </button>
      {children}
    </dialog>
  );
}
