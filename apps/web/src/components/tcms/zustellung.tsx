// =============================================================================
// Zustellstatus der Nachricht zu einer Freigabe (Integration TCMS Stufe 3,
// Vertrag `bereiche/zustellung.ts`, TCMS s6): Freigabenhistorie
// (Kommunikation), CMS-Beschreibung und Risikoakzeptanz zeigen, ob die
// jüngste Nachricht an den aktuellen Empfänger zugestellt ist. Eine Anzeige
// für alle drei Stellen.
//
// Den Status setzt allein der Dienst (Meldung des Zustell-Workers bzw.
// Verwerfen eines ungültigen Codes); die Antwort nennt nie Inhalte der
// Nachricht. Gescheitert (unzustellbar oder verworfen) heißt: die Person hat
// die Anforderung nicht erhalten – die Seite bietet dann die Neuadressierung
// an (Kommunikation), sofern der Dienst sie erlaubt. Feste Texte je Wert,
// kein Text des Dienstes.
// =============================================================================

import { MailCheck, MailWarning, MailX, Mail } from 'lucide-react';
import type {
  FreigabeZustellung,
  NachrichtUnzustellbarGrund,
  ZustellStatus,
} from '@taxtronik/tcms-contract';
import { isoZeitText } from './format';
import { TcmsText } from '@/components/tcms/text';

export const ZUSTELL_STATUS_ANZEIGE: Readonly<
  Record<ZustellStatus, { label: string; badge: string }>
> = {
  OFFEN: { label: 'Nachricht noch nicht zugestellt', badge: 'badge-gray' },
  ZUGESTELLT: { label: 'Nachricht zugestellt', badge: 'badge-green' },
  UNZUSTELLBAR: { label: 'Nachricht unzustellbar', badge: 'badge-red' },
  VERWORFEN: { label: 'Nachricht nicht ausgeliefert', badge: 'badge-yellow' },
};

export const UNZUSTELLBAR_GRUND_LABEL: Readonly<Record<NachrichtUnzustellbarGrund, string>> = {
  EMPFAENGER_UNGUELTIG: 'Empfänger gehört nicht (mehr) zu diesem Mandanten',
  KEIN_PORTALZUGANG: 'Empfänger hat keinen bestätigten Portalzugang',
  ABGELAUFEN: 'Zustellfrist abgelaufen',
  SONSTIGES: 'sonstiger Grund',
};

export const ZUSTELL_ZWECK_LABEL: Readonly<Record<FreigabeZustellung['zweck'], string>> = {
  FREIGABE_ANGEFORDERT: 'Anforderung',
  FREIGABE_CODE: 'Bestätigungscode',
  FREIGABE_NEU_ADRESSIERT: 'Neuadressierung',
};

/** Die Person hat die Nachricht nicht erhalten (unzustellbar oder verworfen). */
export function zustellungGescheitert(z: FreigabeZustellung | null | undefined): boolean {
  return z?.status === 'UNZUSTELLBAR' || z?.status === 'VERWORFEN';
}

/** Zusatz zum Status: Grund (unzustellbar), Ursache (verworfen) bzw. nichts. */
function zusatz(z: FreigabeZustellung): string | null {
  switch (z.status) {
    case 'UNZUSTELLBAR':
      return UNZUSTELLBAR_GRUND_LABEL[z.grund];
    case 'VERWORFEN':
      return 'Code galt nicht mehr';
    default:
      return null;
  }
}

/** Ein Satz für Hinweise und Sperrgründe, z. B. „Anforderung: Nachricht unzustellbar (…)“. */
export function zustellungText(z: FreigabeZustellung): string {
  const extra = zusatz(z);
  return `${ZUSTELL_ZWECK_LABEL[z.zweck]}: ${ZUSTELL_STATUS_ANZEIGE[z.status].label}${extra ? ` (${extra})` : ''}`;
}

const ICON: Readonly<Record<ZustellStatus, typeof Mail>> = {
  OFFEN: Mail,
  ZUGESTELLT: MailCheck,
  UNZUSTELLBAR: MailX,
  VERWORFEN: MailWarning,
};

/**
 * Zustellstatus als Badge mit Zweck, Zeitpunkt und Grund; nichts ohne
 * Nachricht bzw. im historischen Stand (`null` laut Vertrag).
 */
export function ZustellungAnzeige({ zustellung }: { zustellung: FreigabeZustellung | null }) {
  if (!zustellung) return null;
  const anzeige = ZUSTELL_STATUS_ANZEIGE[zustellung.status];
  const Icon = ICON[zustellung.status];
  const extra = zusatz(zustellung);
  const am = 'am' in zustellung ? zustellung.am : zustellung.erstelltAm;
  return (
    <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted">
      <span className={`${anzeige.badge} gap-1`}>
        <Icon className="h-3 w-3" aria-hidden="true" />
        <TcmsText>{anzeige.label}</TcmsText>
      </span>
      <span>
        {ZUSTELL_ZWECK_LABEL[zustellung.zweck]} · {isoZeitText(am)}
        {extra ? ` · ${extra}` : ''}
      </span>
    </span>
  );
}
