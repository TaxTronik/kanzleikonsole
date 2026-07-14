'use client';

// Error-Boundary für den geschützten Staff-Bereich: Sidebar/Layout bleiben
// stehen, nur der Seiteninhalt zeigt den Fehler + Recovery via reset().
import { useEffect } from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';

export default function StaffError({
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
    <div className="p-8 flex items-center justify-center min-h-[50vh]">
      <div className="card p-10 text-center max-w-md">
        <AlertTriangle className="h-10 w-10 text-amber-500 mx-auto mb-4" />
        <h2 className="text-lg font-semibold text-primary mb-2">
          Seite konnte nicht geladen werden
        </h2>
        <p className="text-sm text-secondary mb-6">
          Ein unerwarteter Fehler ist aufgetreten. Bitte versuchen Sie es erneut — bleibt das
          Problem bestehen, wenden Sie sich an den Support.
          {error.digest && (
            <span className="block mt-2 text-xs text-muted">Fehler-Code: {error.digest}</span>
          )}
        </p>
        <button type="button" onClick={reset} className="btn-primary">
          <RotateCcw className="h-4 w-4" /> Erneut versuchen
        </button>
      </div>
    </div>
  );
}
