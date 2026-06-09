'use client';

// Globale Error-Boundary (App Router): fängt ungefangene Fehler unterhalb
// des Root-Layouts ab und bietet einen Recovery-Versuch via reset().
import { useEffect } from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="min-h-[60vh] flex items-center justify-center p-8">
      <div className="card p-10 text-center max-w-md">
        <AlertTriangle className="h-10 w-10 text-amber-500 mx-auto mb-4" />
        <h2 className="text-lg font-semibold text-primary mb-2">
          Etwas ist schiefgelaufen
        </h2>
        <p className="text-sm text-secondary mb-6">
          Ein unerwarteter Fehler ist aufgetreten. Bitte versuchen Sie es erneut.
          {error.digest && (
            <span className="block mt-2 text-xs text-muted">
              Fehler-Code: {error.digest}
            </span>
          )}
        </p>
        <button type="button" onClick={reset} className="btn-primary">
          <RotateCcw className="h-4 w-4" /> Erneut versuchen
        </button>
      </div>
    </div>
  );
}
