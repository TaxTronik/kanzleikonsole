// =============================================================================
// Ladezustände für `loading.tsx` (Review-Befund P-07).
//
// Next.js umschließt Seiten unterhalb eines `loading.tsx` mit <Suspense>: Das
// Layout (Sidebar, Kopfleiste) geht sofort an den Browser, der Seiteninhalt
// streamt nach. Bis dahin stehen diese Platzhalter; Screenreader hören einmal
// „Seite wird geladen".
// =============================================================================

const BAR = 'animate-pulse rounded bg-gray-200 dark:bg-gray-700';
const CARD = 'card animate-pulse bg-gray-50 dark:bg-gray-800';

function LoadingStatus() {
  return <span className="sr-only">Seite wird geladen …</span>;
}

/** Allgemeine Seite: Titel, Kennzahlen-Kacheln, Inhaltskarte. */
export function PageSkeleton() {
  return (
    <div className="p-4 sm:p-8" role="status" aria-busy="true">
      <LoadingStatus />
      <div className={`mb-2 h-7 w-56 ${BAR}`} />
      <div className={`mb-6 h-4 w-80 max-w-full ${BAR}`} />
      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <div className={`h-24 ${CARD}`} />
        <div className={`h-24 ${CARD}`} />
        <div className={`h-24 ${CARD}`} />
      </div>
      <div className={`h-64 ${CARD}`} />
    </div>
  );
}
