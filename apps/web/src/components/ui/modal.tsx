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

import {
  useEffect,
  useId,
  useRef,
  useState,
  useTransition,
  type FormEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { X } from 'lucide-react';

/** Gemeinsamer, SSR-sicherer Portal-Ausgang für Overlays und Shell-Ebenen. */
export function AppPortal({
  children,
  target,
}: {
  children: ReactNode;
  target?: Element | DocumentFragment | null;
}) {
  if (typeof document === 'undefined') return null;
  return createPortal(children, target ?? document.body);
}

const dialogStack: Array<{ node: HTMLElement; opener: HTMLElement | null }> = [];
const backgroundStates = new Map<HTMLElement, { hadInert: boolean; ariaHidden: string | null }>();
let bodyObserver: MutationObserver | undefined;

function syncDialogBackground() {
  const active = dialogStack.at(-1)?.node;
  for (const [element, state] of backgroundStates) {
    if (active && element.isConnected && !element.contains(active)) continue;
    if (!state.hadInert) element.removeAttribute('inert');
    if (state.ariaHidden === null) element.removeAttribute('aria-hidden');
    else element.setAttribute('aria-hidden', state.ariaHidden);
    backgroundStates.delete(element);
  }
  if (!active) {
    bodyObserver?.disconnect();
    bodyObserver = undefined;
    return;
  }
  if (!bodyObserver) {
    bodyObserver = new MutationObserver(syncDialogBackground);
    bodyObserver.observe(document.body, { childList: true });
  }
  for (const element of document.body.children) {
    if (
      !(element instanceof HTMLElement) ||
      element.contains(active) ||
      backgroundStates.has(element) ||
      ['SCRIPT', 'STYLE', 'LINK'].includes(element.tagName)
    )
      continue;
    backgroundStates.set(element, {
      hadInert: element.hasAttribute('inert'),
      ariaHidden: element.getAttribute('aria-hidden'),
    });
    element.setAttribute('inert', '');
    element.setAttribute('aria-hidden', 'true');
  }
}

function focusCandidates(node: HTMLElement) {
  return Array.from(
    node.querySelectorAll<HTMLElement>(
      'a[href],button,textarea,input,select,summary,[contenteditable]:not([contenteditable="false"]),[tabindex]',
    ),
  );
}

function isTabStop(element: HTMLElement) {
  return (
    !element.matches(':disabled, input[type="hidden"]') &&
    !(element.hasAttribute('tabindex') && element.tabIndex < 0) &&
    !element.closest('[inert]') &&
    element.getClientRects().length > 0 &&
    getComputedStyle(element).visibility === 'visible'
  );
}

function restoreDialogFocus(entry: (typeof dialogStack)[number]) {
  const at = dialogStack.indexOf(entry);
  if (at === -1) return;
  const next = dialogStack[at + 1];
  if (next?.opener && entry.node.contains(next.opener)) next.opener = entry.opener;
  dialogStack.splice(at, 1);
  syncDialogBackground();
  if (next) return;
  const active = dialogStack.at(-1)?.node;
  if (entry.opener?.isConnected && !entry.opener.closest('[inert]')) entry.opener.focus();
  if (active && !active.contains(document.activeElement)) active.focus();
}

/** Modal-A11y: Esc schließt, Tab bleibt im Dialog gefangen, Initial-Fokus aufs
 *  erste Element (bzw. [autofocus]), beim Schließen kehrt der Fokus zum
 *  Auslöser zurück. */
export function useDialogA11y(onClose: () => void, closeDisabled = false) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  const closeDisabledRef = useRef(closeDisabled);
  // Auslöser vor dem ersten Commit festhalten (B-08-Verhaltenstest, Welle 15):
  // React fokussiert autoFocus-Kinder bereits im Commit und setzt dabei kein
  // autofocus-Attribut. Im Effekt wäre der Auslöser schon verloren, und die
  // Rückgabe zielte auf das dann entfernte Dialogfeld.
  const [prevFocus] = useState(() =>
    typeof document === 'undefined' ? null : (document.activeElement as HTMLElement | null),
  );
  useEffect(() => {
    closeRef.current = onClose;
    closeDisabledRef.current = closeDisabled;
  }, [closeDisabled, onClose]);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const entry = { node, opener: prevFocus };
    dialogStack.push(entry);
    syncDialogBackground();

    // Ein per autoFocus bereits fokussiertes Dialogelement behält den Fokus;
    // sonst [autofocus] (SSR-Markup), das erste sichtbare Element oder der Dialog.
    const focused = document.activeElement;
    if (!(focused instanceof HTMLElement && focused !== node && node.contains(focused))) {
      const auto = node.querySelector<HTMLElement>('[autofocus]');
      (auto ?? focusCandidates(node).find(isTabStop) ?? node).focus();
    }
    const onKey = (e: KeyboardEvent) => {
      if (dialogStack.at(-1) !== entry || e.defaultPrevented) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        if (!closeDisabledRef.current) closeRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const candidates = focusCandidates(node);
      const first = candidates.find(isTabStop);
      const last = first && candidates.reverse().find(isTabStop);
      const edge = e.shiftKey ? first : last;
      const current = document.activeElement;
      if (edge && current !== edge && current !== node && node.contains(current)) return;
      e.preventDefault();
      const next = e.shiftKey ? last : first;
      (next ?? node).focus();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      restoreDialogFocus(entry);
    };
  }, [prevFocus]);
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
  const titleId = useId();
  const modal = (
    // Der Backdrop ist nur eine zusätzliche Zeiger-Abkürzung. Escape und der
    // benannte Schließen-Button stellen die vollständige Tastaturbedienung her.
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions
    <div
      className={`modal-backdrop fixed inset-0 z-[130] flex items-center justify-center ${backdropClassName}`}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !closeDisabled) onClose();
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={`${panelClassName ?? `w-full ${maxWidth} card p-6`} relative z-[1]`}
      >
        <span id={titleId} className="sr-only">
          {title}
        </span>
        {showCloseButton && (
          <button
            type="button"
            onClick={onClose}
            disabled={closeDisabled}
            className="modal-close"
            aria-label="Schließen"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        )}
        {children}
      </div>
    </div>
  );
  return <AppPortal>{modal}</AppPortal>;
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
          onClick={() => {
            // Ein alter Fehler verschwindet sofort (dringend, nicht Teil der
            // Transition, sonst bliebe er bis zum Ende stehen). Nach dem `await`
            // gehören die Updates wieder in eine Transition: Ergebnis und Ende
            // des Wartezustands erscheinen dann in einem Commit.
            setErr(null);
            start(async () => {
              const r = await onConfirm();
              start(() => {
                if (r.ok) onClose();
                else setErr(r.error ?? 'Fehler.');
              });
            });
          }}
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
  inputLabel = 'Eingabe',
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
  inputLabel?: string;
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
  const inputId = useId();
  const messageId = useId();
  const errorId = useId();
  const submit = () => {
    const v = value.trim();
    if (!v || busy) return;
    // Wie ConfirmModal: alter Fehler sofort weg, Ergebnis zusammen mit dem
    // Ende des Wartezustands.
    setErr(null);
    start(async () => {
      const r = await onSubmit(v);
      start(() => {
        if (r.ok) onClose();
        else setErr(r.error ?? 'Fehler.');
      });
    });
  };
  return (
    <Modal title={title} onClose={onClose} maxWidth="max-w-sm" closeDisabled={busy}>
      <h2 className="text-base font-semibold text-primary mb-3">{title}</h2>
      {message && (
        <div id={messageId} className="text-sm text-secondary mb-3 whitespace-pre-line">
          {message}
        </div>
      )}
      <label htmlFor={inputId} className="mb-1 block text-sm font-medium text-primary">
        {inputLabel}
      </label>
      <input
        id={inputId}
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
        aria-invalid={err ? 'true' : undefined}
        aria-describedby={
          [message ? messageId : null, err ? errorId : null].filter(Boolean).join(' ') || undefined
        }
      />
      {err && (
        <div id={errorId} role="alert" className="rounded bg-red-50 p-2 text-xs text-red-700 mb-3">
          {err}
        </div>
      )}
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
  inputLabel?: string;
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
      inputLabel={options.inputLabel}
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
const awaitingConfirmation = new WeakSet<HTMLFormElement>();

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
  if (awaitingConfirmation.has(form)) return;
  awaitingConfirmation.add(form);
  const nativeSubmitter = (event.nativeEvent as SubmitEvent).submitter;
  const submitter =
    nativeSubmitter instanceof HTMLButtonElement || nativeSubmitter instanceof HTMLInputElement
      ? nativeSubmitter
      : undefined;
  void confirmDialog(message, options).then((confirmed) => {
    awaitingConfirmation.delete(form);
    if (!confirmed || !form.isConnected || (submitter && submitter.form !== form)) return;
    confirmedForms.add(form);
    try {
      form.requestSubmit(submitter);
    } finally {
      // Native Validierung kann den synchronen Submit-Event verhindern.
      confirmedForms.delete(form);
    }
  });
}
