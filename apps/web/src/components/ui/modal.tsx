'use client';

// =============================================================================
// Gemeinsame Modal-Basis für alle Dialoge der Dokumenten-UI (und darüber
// hinaus). Bündelt das bislang verstreute Muster (Inline-Overlay,
// createPortal ohne A11y, window.confirm/prompt) zu EINEM Pattern:
//   - Portal an document.body
//   - role="dialog" + aria-modal
//   - Esc schließt, Tab bleibt im Dialog gefangen (Fokus-Falle),
//     Initial-Fokus, Fokus-Rückgabe an den Auslöser (useDialogA11y)
// =============================================================================

import { useEffect, useRef, useState, useTransition, type FormEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { X } from 'lucide-react';

/** Modal-A11y: Esc schließt, Tab bleibt im Dialog gefangen, Initial-Fokus aufs
 *  erste Element (bzw. [autofocus]), beim Schließen kehrt der Fokus zum
 *  Auslöser zurück. */
export function useDialogA11y(onClose: () => void, closeDisabled = false) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  const closeDisabledRef = useRef(closeDisabled);
  useEffect(() => {
    closeRef.current = onClose;
    closeDisabledRef.current = closeDisabled;
  }, [closeDisabled, onClose]);
  useEffect(() => {
    const node = ref.current;
    const prevFocus = document.activeElement as HTMLElement | null;
    const focusables = () =>
      node
        ? Array.from(
            node.querySelectorAll<HTMLElement>(
              'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])',
            ),
          ).filter((el) => el.offsetParent !== null)
        : [];
    const auto = node?.querySelector<HTMLElement>('[autofocus]');
    (auto ?? focusables()[0])?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (!closeDisabledRef.current) closeRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const f = focusables();
      if (f.length === 0) return;
      const first = f[0]!,
        last = f[f.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      prevFocus?.focus?.();
    };
  }, []);
  return ref;
}

/**
 * Modal-Basiskomponente: Overlay + Karte + Schließen-Button. Die Kinder
 * liefern Überschrift und Inhalt (bestehende Dialog-Markups bleiben so
 * weitgehend unverändert).
 */
export function Modal({
  title,
  onClose,
  children,
  maxWidth = 'max-w-md',
  panelClassName,
  backdropClassName = 'bg-black/50 p-4',
  showCloseButton = true,
  closeDisabled = false,
}: {
  /** Für aria-label — kurze deutsche Bezeichnung des Dialogs. */
  title: string;
  onClose: () => void;
  children: ReactNode;
  maxWidth?: string;
  /** Vollständige Panel-Klassen für Dialoge mit eigenem Layout. */
  panelClassName?: string;
  /** Ergänzt die gemeinsame Backdrop-Basis. */
  backdropClassName?: string;
  /** Ausblenden, wenn der Dialogkopf bereits einen eigenen Schließen-Button hat. */
  showCloseButton?: boolean;
  /** Verhindert Schließen per Escape, Backdrop und Schließen-Button. */
  closeDisabled?: boolean;
}) {
  const ref = useDialogA11y(onClose, closeDisabled);
  const modal = (
    <div
      className={`modal-backdrop fixed inset-0 z-[130] flex items-center justify-center ${backdropClassName}`}
      onClick={() => {
        if (!closeDisabled) onClose();
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={panelClassName ?? `w-full ${maxWidth} card p-6 relative`}
        onClick={(e) => e.stopPropagation()}
      >
        {showCloseButton && (
          <button
            type="button"
            onClick={onClose}
            disabled={closeDisabled}
            className="modal-close"
            aria-label="Schließen"
          >
            <X className="h-5 w-5" />
          </button>
        )}
        {children}
      </div>
    </div>
  );
  return typeof document !== 'undefined' ? createPortal(modal, document.body) : null;
}

/**
 * Bestätigungs-Modal — Ersatz für window.confirm(). `onConfirm` führt die
 * Aktion aus; bei Fehler bleibt der Dialog offen und zeigt die Meldung.
 */
export function ConfirmModal({
  title,
  message,
  confirmLabel = 'Bestätigen',
  busyLabel = 'Bitte warten…',
  danger = false,
  onConfirm,
  onClose,
}: {
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  busyLabel?: string;
  danger?: boolean;
  onConfirm: () => Promise<{ ok: boolean; error?: string }>;
  onClose: () => void;
}) {
  const [err, setErr] = useState<string | null>(null);
  const [busy, start] = useTransition();
  return (
    <Modal title={title} onClose={onClose} maxWidth="max-w-sm" closeDisabled={busy}>
      <h2 className="text-base font-semibold text-primary mb-2">{title}</h2>
      <div className="text-sm text-secondary mb-4 whitespace-pre-line">{message}</div>
      {err && (
        <div
          role="alert"
          className="rounded bg-red-50 p-2 text-xs text-red-700 mb-3 whitespace-pre-line"
        >
          {err}
        </div>
      )}
      <div className="flex gap-2">
        <button type="button" onClick={onClose} disabled={busy} className="btn-secondary flex-1">
          Abbrechen
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            start(async () => {
              setErr(null);
              const r = await onConfirm();
              if (r.ok) onClose();
              else setErr(r.error ?? 'Fehler.');
            })
          }
          className={`btn-primary flex-1 ${danger ? '!bg-red-600 hover:!bg-red-700' : ''}`}
        >
          {busy ? busyLabel : confirmLabel}
        </button>
      </div>
    </Modal>
  );
}

/**
 * Kleines Eingabe-Modal — Ersatz für window.prompt() (verallgemeinerte
 * RenameModal-Funktionalität). `onSubmit` führt die Aktion aus; bei Fehler
 * bleibt der Dialog offen und zeigt die Meldung.
 */
export function InputModal({
  title,
  message,
  initialValue = '',
  placeholder,
  maxLength = 120,
  confirmLabel = 'Speichern',
  busyLabel = 'Speichert…',
  onSubmit,
  onClose,
}: {
  title: string;
  message?: ReactNode;
  initialValue?: string;
  placeholder?: string;
  maxLength?: number;
  confirmLabel?: string;
  busyLabel?: string;
  onSubmit: (value: string) => Promise<{ ok: boolean; error?: string }>;
  onClose: () => void;
}) {
  const [value, setValue] = useState(initialValue);
  const [err, setErr] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const submit = () => {
    const v = value.trim();
    if (!v || busy) return;
    start(async () => {
      setErr(null);
      const r = await onSubmit(v);
      if (r.ok) onClose();
      else setErr(r.error ?? 'Fehler.');
    });
  };
  return (
    <Modal title={title} onClose={onClose} maxWidth="max-w-sm" closeDisabled={busy}>
      <h2 className="text-base font-semibold text-primary mb-3">{title}</h2>
      {message && <div className="text-sm text-secondary mb-3 whitespace-pre-line">{message}</div>}
      <input
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            submit();
          }
        }}
        placeholder={placeholder}
        className="input mb-3"
        maxLength={maxLength}
      />
      {err && <div className="rounded bg-red-50 p-2 text-xs text-red-700 mb-3">{err}</div>}
      <div className="flex gap-2">
        <button type="button" onClick={onClose} disabled={busy} className="btn-secondary flex-1">
          Abbrechen
        </button>
        <button
          type="button"
          disabled={busy || !value.trim()}
          onClick={submit}
          className="btn-primary flex-1"
        >
          {busy ? busyLabel : confirmLabel}
        </button>
      </div>
    </Modal>
  );
}

/** Nicht-blockierender Ersatz für window.alert(). */
export function NoticeModal({
  title = 'Hinweis',
  message,
  confirmLabel = 'OK',
  onClose,
}: {
  title?: string;
  message: ReactNode;
  confirmLabel?: string;
  onClose: () => void;
}) {
  return (
    <Modal title={title} onClose={onClose} maxWidth="max-w-sm">
      <h2 className="text-base font-semibold text-primary mb-2">{title}</h2>
      <div className="text-sm text-secondary mb-4 whitespace-pre-line">{message}</div>
      <div className="flex justify-end">
        <button type="button" autoFocus onClick={onClose} className="btn-primary min-w-24">
          {confirmLabel}
        </button>
      </div>
    </Modal>
  );
}

type ConfirmDialogOptions = {
  title?: string;
  confirmLabel?: string;
  danger?: boolean;
};

type NoticeDialogOptions = {
  title?: string;
  confirmLabel?: string;
};

type PromptDialogOptions = {
  title?: string;
  initialValue?: string;
  placeholder?: string;
  maxLength?: number;
  confirmLabel?: string;
};

/**
 * Rendert einen gemeinsamen App-Dialog für imperative Call-Sites. Das ist vor
 * allem für bestehende Event-Handler gedacht, die bisher die synchronen
 * Browserdialoge verwendet haben. Neue, zustandsreiche UI sollte Modal,
 * ConfirmModal oder InputModal direkt rendern.
 */
function showDialog<T>(
  cancelledValue: T,
  render: (settle: (value: T) => void) => ReactNode,
): Promise<T> {
  if (typeof document === 'undefined') return Promise.resolve(cancelledValue);

  const host = document.createElement('div');
  host.dataset.appDialogHost = 'true';
  document.body.appendChild(host);
  const root: Root = createRoot(host);

  return new Promise<T>((resolve) => {
    let settled = false;
    const settle = (value: T) => {
      if (settled) return;
      settled = true;
      resolve(value);
      queueMicrotask(() => {
        root.unmount();
        host.remove();
      });
    };
    root.render(render(settle));
  });
}

export function confirmDialog(
  message: ReactNode,
  {
    title = 'Bitte bestätigen',
    confirmLabel = 'Bestätigen',
    danger = false,
  }: ConfirmDialogOptions = {},
) {
  return showDialog(false, (settle) => (
    <ConfirmModal
      title={title}
      message={message}
      confirmLabel={confirmLabel}
      danger={danger}
      onClose={() => settle(false)}
      onConfirm={async () => {
        settle(true);
        return { ok: true };
      }}
    />
  ));
}

export function noticeDialog(message: ReactNode, options: NoticeDialogOptions = {}) {
  return showDialog(undefined, (settle) => (
    <NoticeModal {...options} message={message} onClose={() => settle(undefined)} />
  ));
}

export function promptDialog(message: ReactNode, options: PromptDialogOptions = {}) {
  return showDialog<string | null>(null, (settle) => (
    <InputModal
      title={options.title ?? 'Eingabe'}
      message={message}
      initialValue={options.initialValue}
      placeholder={options.placeholder}
      maxLength={options.maxLength}
      confirmLabel={options.confirmLabel}
      onClose={() => settle(null)}
      onSubmit={async (value) => {
        settle(value);
        return { ok: true };
      }}
    />
  ));
}

const confirmedForms = new WeakSet<HTMLFormElement>();

/**
 * Bestätigt ein React-Formular, ohne dessen Server-Action oder nativen
 * Submitter zu umgehen. Beim zweiten, programmatisch ausgelösten Submit wird
 * die zuvor bestätigte Form genau einmal durchgelassen.
 */
export function confirmFormSubmission(
  event: FormEvent<HTMLFormElement>,
  message: ReactNode,
  options?: ConfirmDialogOptions,
) {
  const form = event.currentTarget;
  if (confirmedForms.delete(form)) return;

  event.preventDefault();
  const nativeSubmitter = (event.nativeEvent as SubmitEvent).submitter;
  const submitter =
    nativeSubmitter instanceof HTMLButtonElement || nativeSubmitter instanceof HTMLInputElement
      ? nativeSubmitter
      : undefined;
  void confirmDialog(message, options).then((confirmed) => {
    if (!confirmed || !form.isConnected) return;
    confirmedForms.add(form);
    form.requestSubmit(submitter);
  });
}
