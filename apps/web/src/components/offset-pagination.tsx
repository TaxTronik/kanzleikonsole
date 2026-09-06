// =============================================================================
// Offset-basierte Pagination (Seitenzahlen). Wird genutzt, wo die
// Sortierreihenfolge variabel ist und Cursor-Pagination unpraktisch wäre.
// =============================================================================

import Link from 'next/link';
import { ChevronLeft, ChevronRight } from 'lucide-react';

interface Props {
  basePath: string;
  baseQs: URLSearchParams; // ohne `page`
  page: number; // 1-basiert
  pageSize: number;
  totalCount: number;
}

export function OffsetPagination({ basePath, baseQs, page, pageSize, totalCount }: Props) {
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const safe = Math.min(Math.max(1, page), totalPages);
  const hasPrev = safe > 1;
  const hasNext = safe < totalPages;

  function link(p: number): string {
    const qs = new URLSearchParams(baseQs);
    if (p > 1) qs.set('page', String(p));
    else qs.delete('page');
    const q = qs.toString();
    return q ? `${basePath}?${q}` : basePath;
  }

  const start = (safe - 1) * pageSize + 1;
  const end = Math.min(safe * pageSize, totalCount);

  return (
    <nav
      className="card-footer flex-col items-start gap-2 sm:flex-row sm:items-center"
      aria-label="Seitennavigation"
    >
      <span>
        {totalCount === 0
          ? '0 Treffer'
          : `${start.toLocaleString('de-DE')}–${end.toLocaleString('de-DE')} von ${totalCount.toLocaleString('de-DE')}`}
      </span>
      <div className="flex w-full items-center justify-between gap-3 sm:w-auto sm:justify-start">
        {hasPrev ? (
          <Link
            href={link(safe - 1)}
            className="text-brand-700 hover:underline inline-flex items-center gap-1"
          >
            <ChevronLeft className="h-3 w-3" />
            Zurück
          </Link>
        ) : (
          <span className="text-disabled inline-flex items-center gap-1">
            <ChevronLeft className="h-3 w-3" />
            Zurück
          </span>
        )}
        <span>
          Seite {safe} von {totalPages}
        </span>
        {hasNext ? (
          <Link
            href={link(safe + 1)}
            className="text-brand-700 hover:underline inline-flex items-center gap-1"
          >
            Weiter
            <ChevronRight className="h-3 w-3" />
          </Link>
        ) : (
          <span className="text-disabled inline-flex items-center gap-1">
            Weiter
            <ChevronRight className="h-3 w-3" />
          </span>
        )}
      </div>
    </nav>
  );
}
