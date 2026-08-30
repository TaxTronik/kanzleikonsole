'use client';

import {
  createContext,
  useContext,
  useId,
  useOptimistic,
  useState,
  useTransition,
  type ReactNode,
} from 'react';
import { Accessibility } from 'lucide-react';
import { AccessibleDisplayOptionsForm } from './accessible-display-options';
import {
  DEFAULT_DISPLAY_OPTIONS,
  type AccessibleDisplayOptions,
  type DisplayOptionsPatch,
} from '@/lib/accessible-display-options';

type SaveResult = { ok: true } | { ok: false; error: string };

interface DisplayContext {
  enabled: boolean;
  pending: boolean;
  error: string | null;
  saved: boolean;
  save: (enabled: boolean) => void;
  options: AccessibleDisplayOptions;
  saveOptions: (patch: DisplayOptionsPatch) => void;
}

const AccessibleDisplayContext = createContext<DisplayContext | null>(null);

/** Optionale Komfortfunktionen bleiben außerhalb eines Profilproviders unverändert. */
export function useAccessibleDisplayEnabled(): boolean {
  return useContext(AccessibleDisplayContext)?.enabled ?? false;
}

export function useAccessibleDisplayReducedMotion(): boolean {
  const context = useContext(AccessibleDisplayContext);
  return !!context?.enabled && context.options.reduceMotion;
}

/**
 * Serverstand ist maßgeblich, nicht ein browserweiter Cookie/localStorage-Wert.
 * Der SSR-Marker aktiviert CSS auch vor der Hydration und für Body-Portale.
 * Layouts keyen diesen Provider nach dem authentifizierten Profil: Bei einem
 * Profilwechsel bleiben weder optimistischer Zustand noch Rückmeldungen zurück.
 */
export function AccessibleDisplayProvider({
  initialEnabled,
  initialOptions = DEFAULT_DISPLAY_OPTIONS,
  saveAction,
  saveOptionsAction,
  children,
}: {
  initialEnabled: boolean;
  initialOptions?: AccessibleDisplayOptions;
  saveAction: (enabled: boolean) => Promise<SaveResult>;
  saveOptionsAction?: (patch: DisplayOptionsPatch) => Promise<SaveResult>;
  children: ReactNode;
}) {
  const [enabled, setOptimisticEnabled] = useOptimistic(initialEnabled);
  const [options, setOptimisticOptions] = useOptimistic(initialOptions);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  function save(next: boolean) {
    if (pending) return;
    setError(null);
    setSaved(false);
    startTransition(async () => {
      setOptimisticEnabled(next);
      try {
        const result = await saveAction(next);
        if (result.ok) setSaved(true);
        else setError(result.error);
      } catch {
        setError('Die Anzeigeeinstellung konnte nicht gespeichert werden. Bitte erneut versuchen.');
      }
      // Bei Fehlern setzt useOptimistic auf den unveränderten Serverstand zurück.
      // Bei Erfolg liefert revalidatePath im selben Action-Response den neuen Stand.
    });
  }

  function saveOptions(patch: DisplayOptionsPatch) {
    if (pending || !saveOptionsAction) return;
    const action = saveOptionsAction;
    setError(null);
    setSaved(false);
    startTransition(async () => {
      setOptimisticOptions({ ...options, ...patch });
      try {
        const result = await action(patch);
        if (result.ok) setSaved(true);
        else setError(result.error);
      } catch {
        setError('Die Anzeigeoptionen konnten nicht gespeichert werden. Bitte erneut versuchen.');
      }
    });
  }

  return (
    <AccessibleDisplayContext.Provider
      value={{ enabled, pending, error, saved, save, options, saveOptions }}
    >
      <div
        className="contents"
        data-accessible-display={enabled}
        data-accessible-font-size={options.fontSize}
        data-accessible-spacing={options.spacing}
        data-accessible-contrast={options.contrast}
        data-accessible-reduce-motion={options.reduceMotion}
      >
        {children}
      </div>
    </AccessibleDisplayContext.Provider>
  );
}

/** Gleiche persönliche Einstellung für Mitarbeiter- und Mandantenprofile. */
export function AccessibleDisplaySettings() {
  const context = useContext(AccessibleDisplayContext);
  const id = useId();
  if (!context) throw new Error('AccessibleDisplaySettings requires its profile provider.');
  const { enabled, pending, error, saved, save, options, saveOptions } = context;

  return (
    <section className="card p-6 mb-6" aria-labelledby={`${id}-heading`}>
      <div className="mb-3 flex items-start gap-3">
        <Accessibility className="h-5 w-5 shrink-0 text-brand-accessible" aria-hidden="true" />
        <div>
          <h2 id={`${id}-heading`} className="font-semibold text-primary">
            Barrierearmer Anzeigemodus
          </h2>
          <p className="mt-1 text-sm text-secondary">
            Zusätzliche Lese- und Bedienhilfen für Ihr persönliches Benutzerprofil.
          </p>
        </div>
      </div>

      <label className="flex min-h-11 items-center gap-3 font-medium text-primary">
        <input
          type="checkbox"
          checked={enabled}
          aria-disabled={pending}
          onChange={(event) => save(event.currentTarget.checked)}
          aria-describedby={`${id}-features ${id}-scope`}
          className="h-5 w-5 shrink-0 rounded border-strong"
        />
        <span>Barrierearmen Anzeigemodus aktivieren</span>
      </label>
      <p id={`${id}-features`} className="mt-3 text-sm text-secondary">
        Größere Bedienelemente, deutlichere Links und Fokusrahmen sowie weniger transparente
        Effekte. Schriftgröße, Zeilenabstand, Kontrast und Bewegung können Sie individuell wählen.
        Funktioniert in heller und dunkler Ansicht.
      </p>
      <p id={`${id}-scope`} className="mt-2 text-sm text-muted">
        Wird automatisch für dieses Profil gespeichert, auch für andere Geräte. Andere Profile
        bleiben unverändert. Tastaturbedienung und Screenreader-Unterstützung stehen auch ohne
        diesen Modus zur Verfügung.
      </p>
      <AccessibleDisplayOptionsForm
        id={id}
        options={options}
        pending={pending}
        onSave={saveOptions}
      />
      <p role="status" aria-atomic="true" className="mt-3 text-sm text-secondary">
        {pending
          ? 'Anzeigeeinstellung wird gespeichert …'
          : saved
            ? 'Anzeigeeinstellung gespeichert.'
            : ''}
      </p>
      {error && (
        <p role="alert" className="mt-2 text-sm text-red-700">
          {error}
        </p>
      )}
    </section>
  );
}
