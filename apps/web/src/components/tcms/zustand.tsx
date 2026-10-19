// =============================================================================
// Hinweis statt Daten (TCMS Stufe 3): Darstellung der Seitenzustände aus
// server/tcms/zustand.ts. Nur feste Texte; die requestId des Dienstes hilft
// dem Support beim Zuordnen im Log des Dienstes und verrät nichts über Daten.
// =============================================================================

import Link from 'next/link';
import { CloudOff, Lock, PlugZap, TriangleAlert, type LucideIcon } from 'lucide-react';
import {
  TCMS_NEU_ANMELDEN,
  TCMS_SEITEN_TEXTE,
  type TcmsSeitenZustand,
} from '@/server/tcms/zustand';

const ICON: Readonly<Record<TcmsSeitenZustand['art'], LucideIcon>> = {
  NICHT_KONFIGURIERT: PlugZap,
  KEIN_ZUGRIFF: Lock,
  NICHT_ERREICHBAR: CloudOff,
  ANFRAGE_UNGUELTIG: TriangleAlert,
};

export function TcmsZustand({
  zustand,
  zurueck,
}: {
  zustand: TcmsSeitenZustand;
  /** Optionaler Weg zurück (z. B. Mandantenakte oder Portfolio). */
  zurueck?: { href: string; label: string };
}) {
  const Icon = ICON[zustand.art];
  const { titel, text } = TCMS_SEITEN_TEXTE[zustand.art];
  const requestId =
    zustand.art === 'NICHT_ERREICHBAR' || zustand.art === 'ANFRAGE_UNGUELTIG'
      ? zustand.requestId
      : null;
  return (
    <div className="card p-8 text-center max-w-xl mx-auto my-8" role="status">
      <Icon className="h-10 w-10 text-muted mx-auto mb-4" aria-hidden="true" />
      <h2 className="text-lg font-semibold text-primary mb-2">{titel}</h2>
      <p className="text-sm text-secondary">{text}</p>
      {zustand.art === 'KEIN_ZUGRIFF' && zustand.neuAnmelden ? (
        <p className="text-sm text-secondary mt-2">{TCMS_NEU_ANMELDEN}</p>
      ) : null}
      {requestId ? (
        <p className="text-xs text-muted mt-3">
          Vorgangsnummer für den Support: <span className="font-mono">{requestId}</span>
        </p>
      ) : null}
      {zurueck ? (
        <div className="mt-6">
          <Link href={zurueck.href} className="btn-secondary">
            {zurueck.label}
          </Link>
        </div>
      ) : null}
    </div>
  );
}
