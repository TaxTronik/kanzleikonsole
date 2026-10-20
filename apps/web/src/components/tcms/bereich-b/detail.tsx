// =============================================================================
// Detailbereich der Seiten des Bereichs B (TCMS Stufe 3). Die Demo öffnet
// Risiko, Kontrolle und Land in einem modalen Drawer über `?risiko=…` usw.;
// hier ist es ein nicht-modaler Bereich neben bzw. unter der Liste: serverseitig
// gerendert, ohne JavaScript bedienbar, per Link teilbar, mit eigener
// Überschrift (h3), die beim Öffnen den Fokus erhält, und einem Link
// „Schließen“. Keine Fokusfalle nötig, weil die Seite bedienbar bleibt.
// =============================================================================

import Link from 'next/link';
import type { ReactNode } from 'react';
import { ChevronRight, X } from 'lucide-react';
import { TCMS_SEITEN_TEXTE, type TcmsSeitenZustand } from '@/server/tcms/zustand';
import { FokusBeimOeffnen } from './fokus';
import { TcmsText } from '@/components/tcms/text';

export function DetailBereich({
  id,
  kennung,
  titel,
  unterzeile,
  schliessenHref,
  plaketten,
  children,
}: {
  /** Eindeutige ID der Überschrift (auch Sprungziel `#<id>`). */
  id: string;
  /** Code vor dem Titel („EC-UST-01 · <Titel>“); der Titel des Dienstes isoliert. */
  kennung?: string;
  titel: string;
  unterzeile?: ReactNode;
  schliessenHref: string;
  plaketten?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="card" aria-labelledby={id}>
      <div className="card-header items-start gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 id={id} tabIndex={-1} className="text-base font-semibold text-primary outline-none">
              {kennung ? `${kennung} · ` : null}
              <TcmsText>{titel}</TcmsText>
            </h3>
            {plaketten}
          </div>
          {unterzeile ? <div className="text-xs text-muted mt-1">{unterzeile}</div> : null}
        </div>
        <Link
          href={schliessenHref}
          scroll={false}
          className="btn-secondary text-xs py-1 shrink-0"
          aria-label={`${kennung ? `${kennung} · ` : ''}${titel} schließen`}
        >
          <X className="h-4 w-4" aria-hidden="true" /> Schließen
        </Link>
      </div>
      <FokusBeimOeffnen ziel={id} />
      <div className="p-4 space-y-3">{children}</div>
    </section>
  );
}

/** Aufklappbarer Abschnitt (Klasse `details-box` der kanzleikonsole). */
export function Abschnitt({
  titel,
  offen,
  rechts,
  children,
}: {
  titel: string;
  offen?: boolean;
  rechts?: ReactNode;
  children: ReactNode;
}) {
  return (
    <details className="details-box" open={offen}>
      <summary>
        <ChevronRight className="h-4 w-4" aria-hidden="true" />
        <span className="grow">{titel}</span>
        {rechts}
      </summary>
      <div className="details-body space-y-3">{children}</div>
    </details>
  );
}

/** Hinweis „nur Lesen“ mit Grund – einmal je Bereich statt nur als Tooltip. */
export function SperrHinweis({ grund }: { grund: string | null }) {
  if (!grund) return null;
  return (
    <p className="alert-info-sm" role="note">
      Nur Lesen: {grund}
    </p>
  );
}

/**
 * Zustand eines Lesezugriffs innerhalb eines Detailbereichs (ohne eigene
 * Überschrift, damit die Gliederung h2 → h3 erhalten bleibt). Feste Texte aus
 * server/tcms/zustand.ts.
 */
export function DetailZustand({ zustand }: { zustand: TcmsSeitenZustand }) {
  const { titel, text } = TCMS_SEITEN_TEXTE[zustand.art];
  const requestId =
    zustand.art === 'NICHT_ERREICHBAR' || zustand.art === 'ANFRAGE_UNGUELTIG'
      ? zustand.requestId
      : null;
  return (
    <div className="alert-warning text-sm" role="status">
      <strong>{titel}.</strong> {text}
      {requestId ? (
        <span className="block text-xs mt-1">
          Vorgangsnummer für den Support: <span className="font-mono">{requestId}</span>
        </span>
      ) : null}
    </div>
  );
}
