import { Database } from 'lucide-react';
import { fmtDateTimeMedium, fmtNumber } from '@/lib/fmt';

type SourceState = {
  attemptedAt: Date | null;
  checkedAt: Date | null;
  lastError: string | null;
  snapshot: {
    sourceVersion: string;
    publishedAt: Date;
    importedAt: Date;
    entryCount: number;
    sha256: string;
  } | null;
};

export function ScreeningSourceState({ state }: { state: SourceState | null }) {
  if (!state) {
    return (
      <div className="px-5 py-8 text-center">
        <Database className="mx-auto mb-3 h-8 w-8 text-muted" aria-hidden="true" />
        <h3 className="font-semibold text-primary">Noch kein Abruf gespeichert</h3>
        <p className="mx-auto mt-2 max-w-lg text-sm leading-relaxed text-muted">
          Rufen Sie die offizielle EU-Liste ab, um einen lokalen Datenbestand anzulegen. Danach
          erscheinen hier Quellversion, Umfang und Abrufzeitpunkte.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-5 p-5">
      {state.lastError && (
        <div className="alert-error-sm" role="alert">
          <p className="font-medium">Letzter Abruffehler</p>
          <p className="mt-1 break-words">{state.lastError}</p>
        </div>
      )}
      <dl className="grid gap-4 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-muted">Letzter Abrufversuch</dt>
          <dd className="mt-1 font-medium text-primary">
            {state.attemptedAt ? fmtDateTimeMedium(state.attemptedAt) : 'Nicht gespeichert'}
          </dd>
        </div>
        <div>
          <dt className="text-muted">Zuletzt erfolgreich geprüft</dt>
          <dd className="mt-1 font-medium text-primary">
            {state.checkedAt ? fmtDateTimeMedium(state.checkedAt) : 'Nicht gespeichert'}
          </dd>
        </div>
      </dl>
      {state.snapshot ? (
        <div className="space-y-4 border-t border-default pt-5">
          <h3 className="font-medium text-primary">Gespeicherter Datenbestand</h3>
          <dl className="grid gap-4 text-sm sm:grid-cols-2">
            <div className="min-w-0">
              <dt className="text-muted">Quellversion</dt>
              <dd className="mt-1 break-words font-medium text-primary">
                {state.snapshot.sourceVersion}
              </dd>
            </div>
            <div>
              <dt className="text-muted">Einträge</dt>
              <dd className="mt-1 font-medium text-primary">
                {fmtNumber(state.snapshot.entryCount)}
              </dd>
            </div>
            <div>
              <dt className="text-muted">Veröffentlicht</dt>
              <dd className="mt-1 text-primary">{fmtDateTimeMedium(state.snapshot.publishedAt)}</dd>
            </div>
            <div>
              <dt className="text-muted">Importiert</dt>
              <dd className="mt-1 text-primary">{fmtDateTimeMedium(state.snapshot.importedAt)}</dd>
            </div>
            <div className="min-w-0 sm:col-span-2">
              <dt className="text-muted">Prüfsumme (SHA-256)</dt>
              <dd className="mt-1 break-all font-mono text-xs text-secondary">
                {state.snapshot.sha256}
              </dd>
            </div>
          </dl>
        </div>
      ) : (
        <p className="rounded-lg bg-surface-raised p-4 text-sm text-secondary">
          Noch kein Datenbestand gespeichert.
        </p>
      )}
    </div>
  );
}
