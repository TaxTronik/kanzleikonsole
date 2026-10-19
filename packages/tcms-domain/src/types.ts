// =============================================================================
// Grundtypen des Tax-CMS. Reine Daten, keine Laufzeitabhängigkeiten, damit
// Server und Client dieselben Begriffe verwenden.
// =============================================================================

export type Klasse = 'GERING' | 'MITTEL' | 'HOCH' | 'KRITISCH';
export const KLASSEN: readonly Klasse[] = ['GERING', 'MITTEL', 'HOCH', 'KRITISCH'];
export const KLASSE_RANG: Record<Klasse, number> = { GERING: 1, MITTEL: 2, HOCH: 3, KRITISCH: 4 };
export const KLASSE_LABEL: Record<Klasse, string> = {
  GERING: 'gering',
  MITTEL: 'mittel',
  HOCH: 'hoch',
  KRITISCH: 'kritisch',
};
export const KLASSE_BADGE: Record<Klasse, string> = {
  GERING: 'badge-green',
  MITTEL: 'badge-yellow',
  HOCH: 'badge-amber',
  KRITISCH: 'badge-red',
};

/** Schadensintensität (S). */
export type Schaden = 'N' | 'M' | 'H';
export const SCHAEDEN: readonly Schaden[] = ['N', 'M', 'H'];
export const SCHADEN_LABEL: Record<Schaden, string> = { N: 'niedrig', M: 'mittel', H: 'hoch' };

/** Eintrittswahrscheinlichkeit (W). */
export type Wahrscheinlichkeit = 'SELTEN' | 'MOEGLICH' | 'WAHRSCHEINLICH' | 'HAEUFIG';
export const WAHRSCHEINLICHKEITEN: readonly Wahrscheinlichkeit[] = [
  'SELTEN',
  'MOEGLICH',
  'WAHRSCHEINLICH',
  'HAEUFIG',
];
export const WAHRSCHEINLICHKEIT_LABEL: Record<Wahrscheinlichkeit, string> = {
  SELTEN: 'selten',
  MOEGLICH: 'möglich',
  WAHRSCHEINLICH: 'wahrscheinlich',
  HAEUFIG: 'häufig',
};

/** Reichweite (R): 1 ein Prozess, 2 mehrere Erklärungen, 3 mehrere Länder oder Steuerarten. */
export type Reichweite = 1 | 2 | 3;
export const REICHWEITE_LABEL: Record<Reichweite, string> = {
  1: '1 · ein Prozess',
  2: '2 · mehrere Erklärungen',
  3: '3 · mehrere Länder oder Steuerarten',
};

/**
 * Governance-Typ. Steuert den Kontrollzyklus und damit, wie oft wo manuell
 * geprüft wird (Fachkonzept Abschnitt 6). Er verändert die Risikoklasse nicht.
 */
export type GovernanceTyp = 'FP' | 'FF' | 'IN';
export const GOVERNANCE_TYPEN: readonly GovernanceTyp[] = ['FP', 'FF', 'IN'];
export const GOVERNANCE_LABEL: Record<GovernanceTyp, string> = {
  FP: 'FP · periodisch',
  FF: 'FF · laufend',
  IN: 'IN · Aufklärung',
};
export const GOVERNANCE_ERKLAERUNG: Record<GovernanceTyp, string> = {
  FP: 'periodisch an festen Zeitpunkten (Voranmeldung, OSS-Quartal, Jahresabschluss)',
  FF: 'laufend und anlassbezogen über Ereignisse; manuelle Prüfung bei jeder Auslösung',
  IN: 'dokumentierte, gegengezeichnete Aufklärung statt wiederkehrender Kontrolle',
};

export type RisikoGruppe = 'UST' | 'GOB' | 'ERT' | 'VER';
export const GRUPPE_LABEL: Record<RisikoGruppe, string> = {
  UST: 'Umsatzsteuer',
  GOB: 'GoBD / Datenkette',
  ERT: 'Ertragsteuern',
  VER: 'Verfahren',
};

export type KontrollArt = 'P' | 'D' | 'K';
export const KONTROLLART_LABEL: Record<KontrollArt, string> = {
  P: 'präventiv',
  D: 'detektiv',
  K: 'korrigierend',
};

export type Ausfuehrung = 'M' | 'IT' | 'A';
export const AUSFUEHRUNG_LABEL: Record<Ausfuehrung, string> = {
  M: 'manuell',
  IT: 'IT-gestützt',
  A: 'automatisiert',
};

export type Partei = 'KANZLEI' | 'MANDANT';
export const PARTEI_LABEL: Record<Partei, string> = { KANZLEI: 'Kanzlei', MANDANT: 'Mandant' };

/**
 * Rollen der Mandantenseite im Tax-CMS (`MandantKontaktRolle`, ADR 0001 §5).
 * Werte und Reihenfolge wie das Prisma-Enum `MandantRolle` und das Enum im
 * Vertrag (`KontaktRollenBodySchema`); abgeglichen in
 * `packages/service/src/__tests__/mandant-rollen.test.ts`.
 */
export const MANDANT_ROLLEN = [
  'GESETZLICHER_VERTRETER',
  'TAX_COMPLIANCE_BEAUFTRAGTER',
  'MITARBEITER',
] as const;
export type MandantRolle = (typeof MANDANT_ROLLEN)[number];
export const MANDANT_ROLLE_LABEL: Record<MandantRolle, string> = {
  GESETZLICHER_VERTRETER: 'Gesetzliche Vertretung',
  TAX_COMPLIANCE_BEAUFTRAGTER: 'Tax-Compliance-Beauftragte',
  MITARBEITER: 'Mitarbeitende',
};

export type Design = 'ANGEMESSEN' | 'NICHT_BEURTEILT' | 'MANGEL';
export const DESIGN_LABEL: Record<Design, string> = {
  ANGEMESSEN: 'angemessen',
  NICHT_BEURTEILT: 'nicht beurteilt',
  MANGEL: 'Mangel',
};

/** Vertrauensstufe eines Normankers (wie im Subsumtions-Workspace). */
export type NormStufe = 'GEPRUEFT' | 'UNGEPRUEFT' | 'KI_VERMUTUNG';
export const NORMSTUFE_LABEL: Record<NormStufe, string> = {
  GEPRUEFT: 'GEPRÜFT',
  UNGEPRUEFT: 'UNGEPRÜFT',
  KI_VERMUTUNG: 'KI-VERMUTUNG',
};
export const NORMSTUFE_BADGE: Record<NormStufe, string> = {
  GEPRUEFT: 'badge-green',
  UNGEPRUEFT: 'badge-yellow',
  KI_VERMUTUNG: 'badge-purple',
};

export interface Normanker {
  text: string;
  stufe: NormStufe;
}
