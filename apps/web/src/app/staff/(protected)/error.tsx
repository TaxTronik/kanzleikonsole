'use client';

// Error-Boundary für den geschützten Staff-Bereich: Sidebar/Layout bleiben
// stehen, nur der Seiteninhalt zeigt den Fehler + Neuladen der Serverdaten.
import { ErrorState } from '@/components/error-state';

export default function StaffError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <ErrorState
      error={error}
      reset={reset}
      title="Seite konnte nicht geladen werden"
      contactHint="bleibt das Problem bestehen, wenden Sie sich an den Support."
    />
  );
}
