"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

export type ConfirmOptions = {
  title?: string;
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  // Red confirm button for a destructive action (delete, revoke, reverse) —
  // the default (emerald, matching the app's accent) is for a confirm that
  // isn't itself destructive (e.g. "apply this decay to N characters").
  danger?: boolean;
};

type ConfirmState = ConfirmOptions & { resolve: (value: boolean) => void };

const ConfirmContext = createContext<((opts: ConfirmOptions) => Promise<boolean>) | null>(null);

// Drop-in async replacement for `window.confirm()` — every destructive
// action in this app used the browser's native confirm() (LedgerTable,
// BankBrowseTable, DeleteCharacterButton, ReverseDecayButton,
// RevokeAppKeyButton, and the three decay forms), which is blocking and
// unspoofable but ugly and inconsistent with the rest of the UI. This
// component is deliberately shaped so call sites migrate mechanically:
// `if (!confirm(msg)) return;` becomes `if (!(await confirm({ message: msg
// }))) return;` inside the same already-async handler — no other
// restructuring needed. Mounted once, in the root layout, so any client
// component anywhere can call useConfirm().
export function useConfirm() {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error("useConfirm() must be used within ConfirmDialogProvider");
  return ctx;
}

export function ConfirmDialogProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ConfirmState | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);

  const confirm = useCallback((opts: ConfirmOptions) => {
    return new Promise<boolean>((resolve) => {
      setState({ ...opts, resolve });
    });
  }, []);

  // showModal()/close() are imperative DOM APIs — this is what gives the
  // dialog a real focus trap and an inert background for free (native
  // <dialog> behavior per spec), rather than something hand-rolled.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (state && !dialog.open) dialog.showModal();
    else if (!state && dialog.open) dialog.close();
  }, [state]);

  function settle(result: boolean) {
    setState((current) => {
      current?.resolve(result);
      return null;
    });
  }

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <dialog
        ref={dialogRef}
        onCancel={(e) => {
          // Escape fires the native "cancel" event — resolve false rather
          // than letting the dialog just close with no answer.
          e.preventDefault();
          settle(false);
        }}
        onClick={(e) => {
          // Native <dialog> doesn't close on backdrop click by default; a
          // click landing on the <dialog> element itself (not its content,
          // which stopPropagation()s below) means the backdrop was hit.
          if (e.target === dialogRef.current) settle(false);
        }}
        className="m-auto rounded-lg border border-border bg-neutral-900 p-0 text-neutral-100 backdrop:bg-black/60"
      >
        {state && (
          <div className="w-[min(90vw,26rem)] p-5" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-base font-semibold">{state.title ?? "Are you sure?"}</h2>
            <div className="mt-2 text-sm text-neutral-400">{state.message}</div>
            <div className="mt-5 flex justify-end gap-3">
              <button
                type="button"
                autoFocus
                onClick={() => settle(false)}
                className="rounded-full border border-field px-4 py-1.5 text-sm font-medium text-neutral-300 transition-colors hover:border-neutral-500"
              >
                {state.cancelLabel ?? "Cancel"}
              </button>
              <button
                type="button"
                onClick={() => settle(true)}
                className={`rounded-full px-4 py-1.5 text-sm font-semibold text-black transition-colors ${
                  state.danger ? "bg-danger hover:bg-red-400" : "bg-accent hover:bg-accent-hover"
                }`}
              >
                {state.confirmLabel ?? (state.danger ? "Delete" : "Confirm")}
              </button>
            </div>
          </div>
        )}
      </dialog>
    </ConfirmContext.Provider>
  );
}
