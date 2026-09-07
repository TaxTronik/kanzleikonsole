import { GWG_CHECK_STATUS_LABELS } from '@/lib/domain-labels';
export const idTypeLabels: Record<string, string> = {
  PERSONALAUSWEIS: 'Personalausweis',
  REISEPASS: 'Reisepass',
  HANDELSREGISTERAUSZUG: 'Handelsregisterauszug',
  GESELLSCHAFTSVERTRAG: 'Gesellschaftsvertrag',
  VOLLMACHT: 'Vollmacht',
  TRANSPARENZREGISTER_AUSZUG: 'Transparenzregister-Auszug',
  SONSTIGES: 'Sonstiges',
};

export const changeScopeLabels: Record<string, string> = {
  LEGACY_UNKNOWN: 'Historische Prüfung (Anlass unbekannt)',
  INITIAL: 'Erstprüfung',
  CLIENT_MASTER_DATA: 'Änderung der Mandantenstammdaten',
  ROUTINE: 'Turnusprüfung',
  BENEFICIAL_OWNERS: 'Änderung wirtschaftlich Berechtigte',
  REPRESENTATIVES: 'Änderung gesetzliche Vertretung',
  BOTH: 'Änderung Berechtigte und Vertretung',
};

export const checkStatusLabels: Readonly<Record<string, string>> = {
  ...GWG_CHECK_STATUS_LABELS,
  EXPIRED: 'Abgelaufen/ersetzt',
};

export const clientKindLabels: Readonly<Record<string, string>> = {
  NATPERS: 'Natürliche Person',
  JURPERS: 'Juristische Person',
  PERSGES: 'Personengesellschaft',
};

/** Registernachweis-Typen — immer alle als Unterblock (Checklisten-Charakter),
 *  je mit eigener Upload-Fläche (Typ via defaultType voreingestellt). */
export const ENTITY_TYPE_BLOCKS = [
  { value: 'HANDELSREGISTERAUSZUG', label: 'Handelsregisterauszug' },
  { value: 'TRANSPARENZREGISTER_AUSZUG', label: 'Transparenzregister-Auszug' },
  { value: 'GESELLSCHAFTSVERTRAG', label: 'Gesellschaftsvertrag / Gründungsnachweis' },
  { value: 'VOLLMACHT', label: 'Vertretungsvollmacht' },
  { value: 'SONSTIGES', label: 'Sonstiger Rechtsträgernachweis' },
] as const;

/** Prüfverlauf: Status als farbige Pill — jede Stufe mit eigener Farbe
 *  (Verifiziert grün, In Prüfung gelb, Abgelehnt rot, Entwurf blau,
 *  Abgelaufen/ersetzt lila). */
export function historyStatusBadgeClass(status: string): string {
  switch (status) {
    case 'VERIFIED':
      return 'badge badge-green';
    case 'IN_REVIEW':
      return 'badge badge-yellow';
    case 'REJECTED':
      return 'badge badge-red';
    case 'DRAFT':
      return 'badge badge-brand';
    default:
      return 'badge badge-purple';
  }
}

export function isPersonalIdType(type: string): type is 'PERSONALAUSWEIS' | 'REISEPASS' {
  return type === 'PERSONALAUSWEIS' || type === 'REISEPASS';
}
