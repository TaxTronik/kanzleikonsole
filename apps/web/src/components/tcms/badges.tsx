// =============================================================================
// Plaketten der Tax-CMS-Oberflächen (TCMS Stufe 3, portiert aus der Demo
// components/ui/badges.tsx). Labels kommen aus @taxtronik/tcms-domain, Farben
// nur aus globals.css (./ton.ts).
// =============================================================================

import { Flame, Lock, Pencil } from 'lucide-react';
import {
  ANZEIGE_BADGE,
  ANZEIGE_LABEL,
  GOVERNANCE_ERKLAERUNG,
  KLASSE_LABEL,
  type AnzeigeStatus,
  type GovernanceTyp,
  type Klasse,
} from '@taxtronik/tcms-domain';
import { badgeKlasse, KLASSE_BADGE_KLASSE } from './ton';

/** Risiko- bzw. Schwereklasse; `uebersteuert` markiert eine freigegebene Übersteuerung. */
export function KlasseBadge({
  klasse,
  title,
  uebersteuert,
}: {
  klasse: Klasse;
  title?: string;
  uebersteuert?: boolean;
}) {
  return (
    <span className={`${KLASSE_BADGE_KLASSE[klasse]} gap-1`} title={title}>
      {uebersteuert ? <Pencil className="h-3 w-3" aria-hidden="true" /> : null}
      {klasse === 'KRITISCH' ? <Flame className="h-3 w-3" aria-hidden="true" /> : null}
      {KLASSE_LABEL[klasse]}
      {uebersteuert ? <span className="sr-only"> (übersteuert)</span> : null}
    </span>
  );
}

/** Anzeige-Status einer Durchführung (aus dem Dienst, nie lokal berechnet). */
export function AnzeigeBadge({ status, title }: { status: AnzeigeStatus; title?: string }) {
  return (
    <span className={badgeKlasse(ANZEIGE_BADGE[status])} title={title}>
      {ANZEIGE_LABEL[status]}
    </span>
  );
}

/** Governance-Typ (FP/FF/IN) mit Erklärung als Tooltip; ohne Typ „—“. */
export function GtBadge({ gt }: { gt: GovernanceTyp | null }) {
  if (!gt) return <span className="text-muted">—</span>;
  return (
    <span className="badge-gray font-mono" title={GOVERNANCE_ERKLAERUNG[gt]}>
      {gt}
    </span>
  );
}

/** Gekürzter SHA-256 (voll im Tooltip und für Screenreader). */
export function HashKurz({ wert }: { wert: string }) {
  const kurz = wert.length > 8 ? `${wert.slice(0, 4)}…${wert.slice(-4)}` : wert;
  return (
    <span className="font-mono" title={wert}>
      <span aria-hidden="true">{kurz}</span>
      <span className="sr-only">{wert}</span>
    </span>
  );
}

/** Kennzeichen einer vertraulichen Feststellung. */
export function VertraulichBadge() {
  return (
    <span className="badge-gray gap-1">
      <Lock className="h-3 w-3" aria-hidden="true" />
      vertraulich
    </span>
  );
}
