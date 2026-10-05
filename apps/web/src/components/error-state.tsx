'use client';

import { useEffect, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, RotateCcw } from 'lucide-react';

export interface ErrorStateProps {
  error: Error & { digest?: string };
  /** `reset` der Next-Fehlergrenze (error.tsx / global-error.tsx). */
  reset: () => void;
  title: string;
  /** Satz nach „Bitte versuchen Sie es erneut", z. B. wen man kontaktiert. */
  contactHint?: string;
  /** `page`: ganze Seite (Root, global-error), `segment`: Inhalt im Layout. */
  layout?: 'page' | 'segment';
}

/**
 * Gemeinsame Anzeige aller Fehlergrenzen (Review F-16).
 *
 * „Erneut versuchen" lädt die Serverdaten neu (`router.refresh()`) und setzt
 * die Fehlergrenze zurück (`reset()`), beides in EINER Transition: Der
 * Neuaufbau erscheint erst mit den frischen Daten. `reset()` allein rendert
 * nur den Client neu und zeigt bei einem Serverfehler (z. B. Pool-Timeout)
 * dieselbe fehlerhafte Antwort wieder. Entspricht dem `retry` von Next 16.3.
 */
export function ErrorState({
  error,
  reset,
  title,
  contactHint,
  layout = 'segment',
}: ErrorStateProps) {
  const router = useRouter();
  const [retrying, startTransition] = useTransition();

  useEffect(() => {
    console.error(error);
  }, [error]);

  function retry() {
    startTransition(() => {
      router.refresh();
      reset();
    });
  }

  return (
    <div
      className={
        layout === 'page'
          ? 'min-h-[60vh] flex items-center justify-center p-8'
          : 'p-8 flex items-center justify-center min-h-[50vh]'
      }
    >
      <div className="card p-10 text-center max-w-md">
        <AlertTriangle className="h-10 w-10 text-amber-500 mx-auto mb-4" aria-hidden="true" />
        <h2 className="text-lg font-semibold text-primary mb-2">{title}</h2>
        <p className="text-sm text-secondary mb-6">
          Ein unerwarteter Fehler ist aufgetreten. Bitte versuchen Sie es erneut
          {contactHint ? ` — ${contactHint}` : '.'}
          {error.digest && (
            <span className="block mt-2 text-xs text-muted">Fehler-Code: {error.digest}</span>
          )}
        </p>
        <button
          type="button"
          onClick={retry}
          disabled={retrying}
          aria-busy={retrying}
          className="btn-primary"
        >
          <RotateCcw className={'h-4 w-4' + (retrying ? ' animate-spin' : '')} aria-hidden="true" />
          {retrying ? 'Wird neu geladen …' : 'Erneut versuchen'}
        </button>
      </div>
    </div>
  );
}
