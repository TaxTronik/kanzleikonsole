// =============================================================================
// Ereignistypen T-01 bis T-15 (Fachkonzept Abschnitt 7). Jedes Ereignis wird
// triagiert; die vorgeschlagenen Folgen sind Startwerte für die Triage.
// =============================================================================

export type FolgeArt =
  | 'RISIKO_NEU_BEWERTEN'
  | 'RISIKO_AKTIVIEREN'
  | 'KONTROLLE_AUSSERPLANMAESSIG'
  | 'PROFIL_AENDERN'
  | 'FESTSTELLUNG_ANLEGEN'
  | 'HINWEIS';

export const FOLGE_LABEL: Record<FolgeArt, string> = {
  RISIKO_NEU_BEWERTEN: 'Risiko neu bewerten',
  RISIKO_AKTIVIEREN: 'Risiko aktivieren',
  KONTROLLE_AUSSERPLANMAESSIG: 'Kontrolle außerplanmäßig einplanen',
  PROFIL_AENDERN: 'Geschäftsprofil ändern',
  FESTSTELLUNG_ANLEGEN: 'Feststellung anlegen',
  HINWEIS: 'Hinweis an Berufsträger',
};

export interface FolgeVorlage {
  art: FolgeArt;
  /** Risiko- oder Kontrollcode, sofern die Folge ein Objekt betrifft. */
  ziel?: string;
  text: string;
}

export interface Ereignistyp {
  code: string;
  titel: string;
  /** lucide-Iconname, wie im Mockup (S11, P3). */
  icon: string;
  /** Icon-Ring-Ton im Mockup. */
  ton: 'brand' | 'violet' | 'amber' | 'red' | 'green';
  quelleStufe1: string;
  folgeText: string;
  folgen: FolgeVorlage[];
  /** Im Portal meldbar (P3). */
  portal: boolean;
  /** Kachel-Bezeichnung im Portal. */
  portalLabel?: string;
}

export const EREIGNISTYPEN: readonly Ereignistyp[] = [
  {
    code: 'T-01',
    titel: 'Neuer Verkaufskanal oder Marktplatz',
    icon: 'Store',
    ton: 'brand',
    quelleStufe1: 'Portal-Meldung, Profiländerung',
    folgeText: 'Profil aktualisieren, Risiken neu vorschlagen',
    folgen: [
      { art: 'PROFIL_AENDERN', text: 'P1 Verkaufskanäle um den neuen Kanal ergänzen' },
      {
        art: 'RISIKO_NEU_BEWERTEN',
        ziel: 'EC-UST-13',
        text: 'Marktplatz-Nachweise und Plattformmeldungen neu bewerten',
      },
      {
        art: 'KONTROLLE_AUSSERPLANMAESSIG',
        ziel: 'K-EC-02',
        text: 'Steuerregeln des neuen Kanals vor Start prüfen',
      },
    ],
    portal: true,
    portalLabel: 'Neuer Marktplatz',
  },
  {
    code: 'T-02',
    titel: 'Neues Lager- oder Fulfillment-Land',
    icon: 'Warehouse',
    ton: 'amber',
    quelleStufe1: 'Portal-Meldung, K-EC-05',
    folgeText: 'EC-UST-05 neu bewerten, K-EC-06 außerplanmäßig, Betriebsstättenprüfung',
    folgen: [
      {
        art: 'RISIKO_NEU_BEWERTEN',
        ziel: 'EC-UST-05',
        text: 'Ausländisches Lager ohne Registrierung neu bewerten',
      },
      {
        art: 'KONTROLLE_AUSSERPLANMAESSIG',
        ziel: 'K-EC-06',
        text: 'Verbringens- und ZM-Abstimmung außerplanmäßig',
      },
      {
        art: 'KONTROLLE_AUSSERPLANMAESSIG',
        ziel: 'K-EC-24',
        text: 'Risikoaufklärung Betriebsstätte aktualisieren',
      },
      { art: 'PROFIL_AENDERN', text: 'P2 Lagerorte ergänzen' },
    ],
    portal: true,
    portalLabel: 'Neues Lager',
  },
  {
    code: 'T-03',
    titel: 'Versand in neues Zielland',
    icon: 'Globe',
    ton: 'brand',
    quelleStufe1: 'Portal-Meldung',
    folgeText: 'EC-UST-02 neu bewerten, K-EC-02 anlassbezogen',
    folgen: [
      {
        art: 'RISIKO_NEU_BEWERTEN',
        ziel: 'EC-UST-02',
        text: 'Steuersätze des neuen Ziellands neu bewerten',
      },
      {
        art: 'KONTROLLE_AUSSERPLANMAESSIG',
        ziel: 'K-EC-02',
        text: 'Steuerregeln für das neue Zielland prüfen',
      },
    ],
    portal: true,
    portalLabel: 'Neues Zielland',
  },
  {
    code: 'T-04',
    titel: 'Lieferschwelle 80 % oder 100 % erreicht',
    icon: 'Gauge',
    ton: 'red',
    quelleStufe1: 'K-EC-01',
    folgeText: 'Warnung an Berufsträger; bei 100 % Feststellungsvorschlag',
    folgen: [
      { art: 'HINWEIS', text: 'Berufsträger über den Schwellenstand informieren' },
      { art: 'RISIKO_NEU_BEWERTEN', ziel: 'EC-UST-01', text: 'Lieferschwellenrisiko neu bewerten' },
    ],
    portal: false,
  },
  {
    code: 'T-05',
    titel: 'Neue Warengruppe mit abweichendem Satz',
    icon: 'Tag',
    ton: 'amber',
    quelleStufe1: 'Portal-Meldung',
    folgeText: 'K-EC-02 anlassbezogen',
    folgen: [
      {
        art: 'KONTROLLE_AUSSERPLANMAESSIG',
        ziel: 'K-EC-02',
        text: 'Steuerregeln der neuen Warengruppe je Land prüfen',
      },
      { art: 'RISIKO_NEU_BEWERTEN', ziel: 'EC-UST-02', text: 'Steuersatzrisiko neu bewerten' },
      { art: 'PROFIL_AENDERN', text: 'P4 Sortiment um die Warengruppe ergänzen' },
    ],
    portal: true,
    portalLabel: 'Neue Warengruppe',
  },
  {
    code: 'T-06',
    titel: 'Neuer Zahlungsdienstleister',
    icon: 'CreditCard',
    ton: 'brand',
    quelleStufe1: 'Portal-Meldung',
    folgeText: 'K-EC-11 um Clearingkonto erweitern',
    folgen: [
      {
        art: 'KONTROLLE_AUSSERPLANMAESSIG',
        ziel: 'K-EC-11',
        text: 'Dreifach-Abstimmung um das neue Clearingkonto erweitern',
      },
      { art: 'PROFIL_AENDERN', text: 'P6 Zahlungswege ergänzen' },
    ],
    portal: true,
    portalLabel: 'Neuer Zahlungsdienst',
  },
  {
    code: 'T-07',
    titel: 'System- oder Schnittstellenwechsel',
    icon: 'RefreshCw',
    ton: 'violet',
    quelleStufe1: 'Portal-Meldung',
    folgeText: 'K-EC-14 und K-EC-23 anlassbezogen',
    folgen: [
      {
        art: 'KONTROLLE_AUSSERPLANMAESSIG',
        ziel: 'K-EC-14',
        text: 'Change-Management mit Verfahrensdoku-Update',
      },
      {
        art: 'KONTROLLE_AUSSERPLANMAESSIG',
        ziel: 'K-EC-23',
        text: 'Reports vor dem Wechsel exportieren und ablegen',
      },
      { art: 'PROFIL_AENDERN', text: 'P8 Systemlandschaft aktualisieren' },
    ],
    portal: true,
    portalLabel: 'Systemwechsel',
  },
  {
    code: 'T-08',
    titel: 'Neues Gutschein-, Abo- oder Bundle-Modell',
    icon: 'Gift',
    ton: 'violet',
    quelleStufe1: 'Portal-Meldung',
    folgeText: 'K-EC-09 vor Start',
    folgen: [
      {
        art: 'KONTROLLE_AUSSERPLANMAESSIG',
        ziel: 'K-EC-09',
        text: 'Modell vor Start würdigen und freigeben',
      },
      { art: 'PROFIL_AENDERN', text: 'P7 Modelle ergänzen' },
    ],
    portal: true,
    portalLabel: 'Gutschein / Abo',
  },
  {
    code: 'T-09',
    titel: 'Beginn B2B- oder Auslands-B2B-Verkauf',
    icon: 'Briefcase',
    ton: 'brand',
    quelleStufe1: 'Portal-Meldung',
    folgeText: 'EC-UST-06, -11 aktivieren',
    folgen: [
      {
        art: 'RISIKO_AKTIVIEREN',
        ziel: 'EC-UST-06',
        text: 'Ig. B2B-Lieferungen ins Inventar aufnehmen',
      },
      {
        art: 'RISIKO_AKTIVIEREN',
        ziel: 'EC-UST-11',
        text: 'B2B-Rechnungen ins Inventar aufnehmen',
      },
      { art: 'PROFIL_AENDERN', text: 'P3 Kundengruppen anpassen' },
    ],
    portal: true,
    portalLabel: 'B2B-Start',
  },
  {
    code: 'T-10',
    titel: 'Erstmals Import aus Drittland',
    icon: 'Ship',
    ton: 'brand',
    quelleStufe1: 'Portal-Meldung',
    folgeText: 'EC-UST-12 aktivieren',
    folgen: [
      {
        art: 'RISIKO_AKTIVIEREN',
        ziel: 'EC-UST-12',
        text: 'Einfuhrumsatzsteuer ins Inventar aufnehmen',
      },
      { art: 'PROFIL_AENDERN', text: 'P5 Beschaffung ergänzen' },
    ],
    portal: true,
    portalLabel: 'Import',
  },
  {
    code: 'T-11',
    titel: 'Rechts- oder Satzänderung',
    icon: 'Scale',
    ton: 'violet',
    quelleStufe1: 'K-EC-21 (RSS-Reader)',
    folgeText: 'betroffene Risiken und Kontrollen markieren',
    folgen: [
      { art: 'RISIKO_NEU_BEWERTEN', ziel: 'EC-VER-03', text: 'Betroffene Regeln identifizieren' },
      {
        art: 'KONTROLLE_AUSSERPLANMAESSIG',
        ziel: 'K-EC-02',
        text: 'Steuerregeln an die Änderung anpassen',
      },
    ],
    portal: false,
  },
  {
    code: 'T-12',
    titel: 'Wechsel gesetzlicher Vertreter oder Tax-Compliance-Beauftragte:r',
    icon: 'UserRound',
    ton: 'brand',
    quelleStufe1: 'Stammdatenänderung',
    folgeText: 'Verantwortungsmatrix prüfen, Kenntnisnahme K-EC-22 anfordern',
    folgen: [
      {
        art: 'KONTROLLE_AUSSERPLANMAESSIG',
        ziel: 'K-EC-22',
        text: 'Kenntnisnahme der Steuerrichtlinie anfordern',
      },
      { art: 'HINWEIS', text: 'Verantwortungsmatrix prüfen' },
    ],
    portal: false,
  },
  {
    code: 'T-13',
    titel: 'Außenprüfung oder Behördenanfrage angekündigt',
    icon: 'Landmark',
    ton: 'red',
    quelleStufe1: 'manuelle Erfassung, Bescheid-Postfach',
    folgeText: 'Prüfungsakte anlegen, Nachweispaket vorbereiten',
    folgen: [{ art: 'HINWEIS', text: 'Prüfungsakte anlegen und Nachweispaket vorbereiten' }],
    portal: false,
  },
  {
    code: 'T-14',
    titel: 'Feststellung mit steuerlicher Auswirkung',
    icon: 'TriangleAlert',
    ton: 'red',
    quelleStufe1: 'Feststellung',
    folgeText: 'Pflichtschritt §-153-Würdigung (K-EC-20)',
    folgen: [{ art: 'FESTSTELLUNG_ANLEGEN', text: 'Feststellung mit §-153-Pfad anlegen' }],
    portal: false,
  },
  {
    code: 'T-15',
    titel: 'Sperre oder Hinweis eines Marktplatzes',
    icon: 'Ban',
    ton: 'red',
    quelleStufe1: 'Portal-Meldung',
    folgeText: 'EC-UST-13 neu bewerten, K-EC-17 außerplanmäßig',
    folgen: [
      { art: 'RISIKO_NEU_BEWERTEN', ziel: 'EC-UST-13', text: 'Marktplatz-Risiko neu bewerten' },
      {
        art: 'KONTROLLE_AUSSERPLANMAESSIG',
        ziel: 'K-EC-17',
        text: 'Marktplatz-Nachweise außerplanmäßig abgleichen',
      },
    ],
    portal: true,
    portalLabel: 'Marktplatz-Sperre',
  },
];

/** Portal-Kachel „Sonstiges" ohne eigenen Katalogtyp. */
export const PORTAL_SONSTIGES = {
  code: 'SONST',
  titel: 'Sonstiges',
  icon: 'Bell',
  ton: 'brand' as const,
};

export function ereignistyp(code: string): Ereignistyp | undefined {
  return EREIGNISTYPEN.find((t) => t.code === code);
}
