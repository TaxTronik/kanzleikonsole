// =============================================================================
// Symbol eines Anzeige-Status (TCMS Stufe 3, Kontrollkalender). Die Demo
// zeigt farbige Punkte; hier trägt jedes Symbol zusätzlich eine eigene Form
// (Icon), damit Farbe nicht allein Bedeutung trägt, und ein Label für
// Screenreader. Farben nur aus Tokens der kanzleikonsole.
// =============================================================================

import {
  AlarmClock,
  Ban,
  CircleCheck,
  CircleDashed,
  CircleDot,
  Clock,
  PenLine,
  RotateCcw,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';
import type { AnzeigeStatus } from '@taxtronik/tcms-domain';

const SYMBOL: Readonly<Record<AnzeigeStatus, { icon: LucideIcon; ton: string }>> = {
  GEPLANT: { icon: CircleDashed, ton: 'text-muted' },
  FAELLIG: { icon: Clock, ton: 'text-brand-600' },
  IN_DURCHFUEHRUNG: { icon: CircleDot, ton: 'text-brand-600' },
  ZUR_GEGENZEICHNUNG: { icon: PenLine, ton: 'text-purple-700' },
  ZURUECKGEWIESEN: { icon: RotateCcw, ton: 'text-amber-700' },
  OHNE_BEFUND: { icon: CircleCheck, ton: 'text-emerald-700' },
  MIT_BEFUND: { icon: TriangleAlert, ton: 'text-amber-700' },
  UEBERFAELLIG: { icon: AlarmClock, ton: 'text-red-700' },
  ENTFALLEN: { icon: Ban, ton: 'text-muted' },
};

export function AnzeigeSymbol({
  status,
  ausserplanmaessig,
}: {
  status: AnzeigeStatus;
  ausserplanmaessig?: boolean;
}) {
  const { icon: Icon, ton } = SYMBOL[status];
  return (
    <Icon
      className={`h-4 w-4 ${ton} ${ausserplanmaessig ? 'rounded-full ring-1 ring-offset-1 ring-current' : ''}`}
      aria-hidden="true"
    />
  );
}
