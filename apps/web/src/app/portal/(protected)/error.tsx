'use client';

// Error-Boundary für das Mandanten-Portal: deutsche Meldung, Layout bleibt
// erhalten, „Erneut versuchen" lädt die Serverdaten neu.
import { ErrorState } from '@/components/error-state';

export default function PortalError({
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
      contactHint="bleibt das Problem bestehen, wenden Sie sich an Ihre Steuerkanzlei."
    />
  );
}
