'use client';

// Fehlergrenze unterhalb des Root-Layouts (App Router): deutsche Meldung,
// „Erneut versuchen" lädt Serverdaten neu und setzt die Grenze zurück.
import { ErrorState } from '@/components/error-state';

export default function RootError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <ErrorState error={error} reset={reset} title="Etwas ist schiefgelaufen" layout="page" />;
}
