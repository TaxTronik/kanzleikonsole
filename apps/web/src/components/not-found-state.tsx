import Link from 'next/link';
import { SearchX } from 'lucide-react';

export interface NotFoundLink {
  href: string;
  label: string;
}

/**
 * Deutsche 404-Anzeige für `not-found.tsx` (Review F-16). `notFound()` meldet
 * fehlende ebenso wie nicht freigegebene Einträge — der Text unterscheidet das
 * bewusst nicht, damit keine Existenz verraten wird.
 */
export function NotFoundState({
  links,
  layout = 'segment',
}: {
  links: readonly NotFoundLink[];
  /** `page`: ganze Seite (Root), `segment`: Inhalt im Staff-/Portal-Layout. */
  layout?: 'page' | 'segment';
}) {
  return (
    <div
      className={
        layout === 'page'
          ? 'min-h-[60vh] flex items-center justify-center p-8'
          : 'p-8 flex items-center justify-center min-h-[50vh]'
      }
    >
      <div className="card p-10 text-center max-w-md">
        <SearchX className="h-10 w-10 text-disabled mx-auto mb-4" aria-hidden="true" />
        <h1 className="text-lg font-semibold text-primary mb-2">Seite nicht gefunden</h1>
        <p className="text-sm text-secondary mb-6">
          Die Seite oder der Eintrag existiert nicht (mehr) oder ist für Ihr Konto nicht
          freigegeben. Bitte prüfen Sie die Adresse oder wechseln Sie zur Übersicht.
        </p>
        <div className="flex flex-wrap items-center justify-center gap-2">
          {links.map((link, index) => (
            <Link
              key={link.href}
              href={link.href}
              className={index === 0 ? 'btn-primary' : 'btn-secondary'}
            >
              {link.label}
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
