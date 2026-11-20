'use client';

// =============================================================================
// SettingsFormGuard — zentraler Speichern-Flyover für die Settings-Subtree.
//
// Ersetzt die verstreuten, verwirrend vielen Speichern-Buttons pro Abschnitt
// (auf /branding z. B. drei) durch EINEN schwebenden Flyover, der nur bei
// offenen Änderungen erscheint.
//
// Funktionsweise:
//  • Dirty-Erkennung per Serialisierungs-Snapshot: beim ersten Auftauchen eines
//    speicherbaren Formulars wird sein initialer Wert-Hash gemerkt. Eine Änderung
//    macht es "dirty" — und WIEDER rückgängig machen nimmt das zurück (der
//    Snapshot stimmt wieder => Flyover verschwindet). Löst das "Aufforderung
//    bleibt, obwohl Änderung revertiert"-Problem.
//  • "Speichern": reicht bei allen dirty Formularen requestSubmit() ein — jede
//    behält ihre eigene Server-Action. Die Speichern-Buttons der Formulare sind
//    per globals.css in diesem Subtree ausgeblendet (Flyover ist die einzige
//    sichtbare Save-Aktion).
//  • "Verwerfen": lädt die Seite neu — verwirft zuverlässig ALLE offenen
//    Änderungen (auch React-State-gesteuerte Felder wie das Logo).
//  • beforeunload warnt beim Verlassen mit offenen Änderungen.
//
// Speicherbar = Formulare mit Submit-Button, die NICHT data-settings-no-track
// tragen (z. B. SMTP-Testmail oder Autosave-Layouts).
// =============================================================================

import {
  createContext,
  startTransition,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type FormEvent,
} from 'react';
import { Check } from 'lucide-react';
import { confirmDialog } from '@/components/ui/modal';

function serializeData(data: FormData): string {
  const entries = [...data].filter(
    ([name, value]) => typeof value === 'string' && !name.startsWith('$ACTION_'),
  );
  // Ein kontrolliertes Formular kann seine Daten in anderer Reihenfolge bauen.
  return JSON.stringify(entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

function serialize(form: HTMLFormElement): string {
  return serializeData(new FormData(form));
}

const SettingsSaveResult = createContext<
  ((form: HTMLFormElement, snapshot: string | null) => void) | null
>(null);

/** Speichert die bestätigten Werte und bewahrt unkontrollierte Eingaben bei Fehlern. */
export function SettingsForm({
  action,
  result,
  pending,
  children,
  className,
  onSubmit,
  savedData,
}: {
  action: (data: FormData) => void;
  result: { ok: boolean } | null;
  pending: boolean;
  children: ReactNode;
  className: string;
  onSubmit?: (event: FormEvent<HTMLFormElement>) => void;
  /** Einige Integrationen leeren gespeicherte Secrets und setzen Keep-Flags. */
  savedData?: () => FormData;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const submitted = useRef<string | null>(null);
  const settle = useContext(SettingsSaveResult);
  useEffect(() => {
    if (pending || result === null || submitted.current === null) return;
    if (formRef.current) settle?.(formRef.current, result.ok ? submitted.current : null);
    submitted.current = null;
  }, [pending, result, settle]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitted.current !== null || pending) return;
    const form = event.currentTarget;
    submitted.current = savedData ? serializeData(savedData()) : serialize(form);
    if (onSubmit) onSubmit(event);
    else {
      const data = new FormData(form, (event.nativeEvent as SubmitEvent).submitter);
      startTransition(() => action(data));
    }
  }
  return (
    <form
      ref={formRef}
      action={action}
      onSubmit={submit}
      aria-busy={pending || undefined}
      className={className}
    >
      {children}
    </form>
  );
}

function isSaveable(form: HTMLFormElement): boolean {
  if (form.hasAttribute('data-settings-no-track')) return false;
  return !!form.querySelector('button[type="submit"], input[type="submit"]');
}

export function SettingsFormGuard({ children }: { children: ReactNode }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const snapshots = useRef<WeakMap<HTMLFormElement, string>>(new WeakMap());
  const discardConfirmed = useRef(false);
  const [dirtyCount, setDirtyCount] = useState(0);
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const recompute = useCallback(() => {
    const forms = containerRef.current?.querySelectorAll('form');
    let dirty = 0;
    let busy = false;
    for (const form of forms ?? []) {
      if (!isSaveable(form)) continue;
      const value = serialize(form);
      if (!snapshots.current.has(form)) snapshots.current.set(form, value);
      const changed = value !== snapshots.current.get(form);
      form.classList.toggle('settings-dirty', changed);
      if (changed) dirty++;
      if (form.getAttribute('aria-busy') === 'true') busy = true;
    }
    setDirtyCount(dirty);
    setSaving(busy);
  }, []);

  const settle = useCallback(
    (form: HTMLFormElement, snapshot: string | null) => {
      if (snapshot !== null) snapshots.current.set(form, snapshot);
      recompute();
      setJustSaved(snapshot !== null);
    },
    [recompute],
  );

  useEffect(() => {
    if (!justSaved) return;
    const timer = setTimeout(() => setJustSaved(false), 2600);
    return () => clearTimeout(timer);
  }, [justSaved]);

  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;

    function onBeforeUnload(e: BeforeUnloadEvent) {
      if (discardConfirmed.current) {
        discardConfirmed.current = false;
        return;
      }
      const forms = Array.from(root!.querySelectorAll('form'));
      if (forms.some((f) => isSaveable(f) && f.classList.contains('settings-dirty'))) {
        e.preventDefault();
      }
    }

    root.addEventListener('input', recompute);
    root.addEventListener('change', recompute);
    window.addEventListener('beforeunload', onBeforeUnload);
    const mo = new MutationObserver(recompute);
    mo.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['value', 'checked', 'selected', 'aria-busy', 'disabled'],
    });
    recompute();
    return () => {
      root.removeEventListener('input', recompute);
      root.removeEventListener('change', recompute);
      window.removeEventListener('beforeunload', onBeforeUnload);
      mo.disconnect();
    };
  }, [recompute]);

  function saveAll() {
    const root = containerRef.current;
    if (!root || saving) return;
    const forms = Array.from(root.querySelectorAll('form')).filter(
      (f) => isSaveable(f) && f.classList.contains('settings-dirty'),
    );
    if (forms.length === 0) return;
    if (!forms.every((form) => form.reportValidity())) return;
    setJustSaved(false);
    for (const form of forms) form.requestSubmit();
  }

  async function discardAll() {
    if (
      !(await confirmDialog('Alle ungespeicherten Änderungen verwerfen?', {
        title: 'Änderungen verwerfen',
        confirmLabel: 'Verwerfen',
        danger: true,
      }))
    )
      return;
    discardConfirmed.current = true;
    window.location.reload();
  }

  return (
    <div ref={containerRef} className="settings-form-guard min-w-0">
      <SettingsSaveResult.Provider value={settle}>{children}</SettingsSaveResult.Provider>
      <div
        className={
          dirtyCount > 0
            ? 'settings-pill fixed bottom-4 right-4 z-40 flex items-center gap-3 rounded-full py-2 pl-4 pr-2'
            : justSaved
              ? 'settings-pill settings-pill-success fixed bottom-4 right-4 z-40 flex items-center gap-2 rounded-full px-4 py-2 text-[13px] font-medium'
              : 'sr-only'
        }
      >
        <span role="status" aria-atomic="true" className="flex items-center gap-2 text-[13px]">
          {dirtyCount > 0 ? (
            <>
              <span className="settings-pill-dot" aria-hidden />
              <span className="font-medium">
                {dirtyCount}{' '}
                {dirtyCount === 1 ? 'ungespeicherte Änderung' : 'ungespeicherte Änderungen'}
              </span>
            </>
          ) : justSaved ? (
            <>
              <Check className="h-4 w-4" aria-hidden /> Gespeichert
            </>
          ) : null}
        </span>
        {dirtyCount > 0 && (
          <>
            <button
              type="button"
              onClick={discardAll}
              disabled={saving}
              className="settings-pill-ghost"
            >
              Verwerfen
            </button>
            <button
              type="button"
              onClick={saveAll}
              disabled={saving}
              className="settings-pill-save"
            >
              {saving ? 'Speichert …' : 'Speichern'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
