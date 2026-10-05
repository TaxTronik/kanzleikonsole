'use client';

// Fehler im Root-Layout selbst: ersetzt das ganze Dokument, daher eigenes
// <html>/<body> sowie Styles und Theme (ThemeSync setzt die gespeicherte
// Dark-/Light-Präferenz). Ohne diese Datei erschiene Nexts englische
// Standardseite.
import './globals.css';
import { ErrorState } from '@/components/error-state';
import { ThemeSync } from '@/components/theme-sync';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="de">
      <body>
        <title>Fehler · TaxTronik</title>
        <ThemeSync />
        <main id="main-content">
          <ErrorState
            error={error}
            reset={reset}
            title="Die Anwendung konnte nicht geladen werden"
            layout="page"
          />
        </main>
      </body>
    </html>
  );
}
