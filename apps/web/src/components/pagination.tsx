// =============================================================================
// Server Component — Cursor-basierte Pagination-Footer
//
// Erwartet: aktuelle Filter-QueryString + Cursor (für "ältere") + ob es eine
// nächste Seite gibt. Erstes-Seite-Link, falls cursor gesetzt ist.
// =============================================================================

import Link from 'next/link';
import { ChevronLeft, ChevronRight } from 'lucide-react';

interface Props {
  basePath: string; // z. B. "/staff/clients"
  baseQs: URLSearchParams; // alle aktiven Filter ohne `cursor`
  currentCursor: string | null;
  nextCursor: string | null;
  totalCount: number;
  shownCount: number;
  /**
   * Die Treffer sind auf `totalCount` begrenzt (z. B. Posteingangssuche, P-10):
   * „Mehr als …“ statt einer genauen Zahl und am Ende der Hinweis zum
   * Verfeinern statt „Ende“.
   */
  capped?: boolean;
}

export function Pagination({
  basePath,
  baseQs,
  currentCursor,
  nextCursor,
  totalCount,
  shownCount,
  capped = false,
}: Props) {
  const nextQs = new URLSearchParams(baseQs);
  if (nextCursor) nextQs.set('cursor', nextCursor);

  return (
    <div className="card-footer">
      <span>
        {capped ? 'Mehr als ' : ''}
        {totalCount.toLocaleString('de-DE')} Treffer · zeige {shownCount}
      </span>
      <div className="flex items-center gap-4">
        {currentCursor && (
          <Link
            href={`${basePath}${baseQs.toString() ? '?' + baseQs.toString() : ''}`}
            className="text-brand-700 hover:underline flex items-center gap-1"
          >
            <ChevronLeft className="h-3 w-3" />
            Erste Seite
          </Link>
        )}
        {nextCursor ? (
          <Link
            href={`${basePath}?${nextQs.toString()}`}
            className="text-brand-700 hover:underline flex items-center gap-1"
          >
            Ältere
            <ChevronRight className="h-3 w-3" />
          </Link>
        ) : (
          <span className="text-disabled">{capped ? 'Suche verfeinern' : 'Ende'}</span>
        )}
      </div>
    </div>
  );
}
