// =============================================================================
// Rahmen der kanzleiweiten Tax-CMS-Verwaltung (TCMS Stufe 3, Bereich D; aus der
// Demo components/admin/teile.tsx). Zugang nur für Admins und Partner – den
// prüft der Seiten-Helfer tcmsAdminSeite (Weiterleitung) bzw. der
// Aktions-Helfer mit `nurAdmin`; hier nur die Darstellung.
// =============================================================================

import Link from 'next/link';
import type { ReactNode } from 'react';
import { ArrowLeft, ChevronRight } from 'lucide-react';

/** Kopf einer Verwaltungsseite mit Rückweg zum Portfolio. */
export function AdminKopf({
  titel,
  unter,
  rechts,
}: {
  titel: string;
  unter: string;
  rechts?: ReactNode;
}) {
  return (
    <>
      <Link href="/staff/tcms" className="back-link">
        <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Zum Tax-CMS-Portfolio
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
        <div>
          <p className="eyebrow">Tax-CMS · Verwaltung</p>
          <h1 className="text-2xl font-bold text-primary">{titel}</h1>
          <p className="text-sm text-muted mt-1">{unter}</p>
        </div>
        {rechts}
      </div>
    </>
  );
}

/** Blättern per Link (Zustand nur in der URL, ohne Client-Logik). */
export function Blaettern({
  neueste,
  aeltere,
}: {
  /** Link zur ersten Seite, null auf der ersten Seite. */
  neueste: string | null;
  /** Link zur nächsten (älteren) Seite, null am Ende. */
  aeltere: string | null;
}) {
  if (!neueste && !aeltere) return null;
  return (
    <nav aria-label="Seiten" className="inline-flex items-center gap-2">
      {neueste ? (
        <Link href={neueste} className="btn-secondary text-xs py-1">
          <ArrowLeft className="h-3 w-3" aria-hidden="true" /> neueste
        </Link>
      ) : null}
      {aeltere ? (
        <Link href={aeltere} className="btn-secondary text-xs py-1">
          ältere <ChevronRight className="h-3 w-3" aria-hidden="true" />
        </Link>
      ) : null}
    </nav>
  );
}
