// =============================================================================
// Phasen eines Tax-CMS mit festen Gates (Fachkonzept Abschnitt 9). Die Phase
// wird aus den Daten berechnet: aktiv ist die erste Phase mit offenem Gate.
// =============================================================================

export const PHASEN = [
  'Aufbau',
  'Risikoanalyse',
  'Kontrollplanung',
  'Beschreibung',
  'Angemessenheit dokumentiert',
  'Wirksamkeitszeitraum',
  'Prüfung & Regelbetrieb',
] as const;

export interface PhasenFakten {
  teilbereichAbgegrenzt: boolean;
  profilErfasst: boolean;
  zieleGesamt: number;
  zieleFreigegeben: number;
  vorschlaegeOffen: number;
  risikenAktiv: number;
  risikenOhneBewertung: number;
  risikenNichtFreigegeben: number;
  /** Risiken über dem Appetit ohne Kontrolle mit Pflichtattributen und Designbeurteilung. */
  risikenUeberAppetitOhneKontrolle: number;
  kontrollenOhnePflichtattribute: number;
  beschreibungFreigegeben: boolean;
  beschreibungVersion: string | null;
  angemessenheitStichtag: Date | null;
  wirksamAb: Date | null;
  wirksamBis: Date | null;
  durchfuehrungenImZeitraum: number;
  heute: Date;
}

export interface GateBedingung {
  text: string;
  erfuellt: boolean;
  /** Relativer Link innerhalb des Mandanten-TCMS, z. B. „risiken". */
  link?: string;
}

export interface PhasenInfo {
  nr: number;
  name: string;
  bedingungen: GateBedingung[];
  erfuellt: boolean;
}

function fmt(d: Date): string {
  return `${String(d.getUTCDate()).padStart(2, '0')}.${String(d.getUTCMonth() + 1).padStart(2, '0')}.${d.getUTCFullYear()}`;
}

export function bewertePhasen(f: PhasenFakten): { phasen: PhasenInfo[]; aktiv: number } {
  const g: GateBedingung[][] = [
    [
      { text: 'Teilbereich abgegrenzt', erfuellt: f.teilbereichAbgegrenzt, link: 'profil' },
      { text: 'Geschäftsprofil erfasst', erfuellt: f.profilErfasst, link: 'profil' },
      {
        text: `Ziele durch gesetzliche Vertreter freigegeben (${f.zieleFreigegeben} von ${f.zieleGesamt})`,
        erfuellt: f.zieleGesamt > 0 && f.zieleFreigegeben === f.zieleGesamt,
        link: 'profil',
      },
    ],
    [
      {
        text: 'Alle Vorschläge übernommen oder begründet abgelehnt',
        erfuellt: f.vorschlaegeOffen === 0,
        link: 'risiken',
      },
      {
        text: 'Bruttobewertung vollständig',
        erfuellt: f.risikenAktiv > 0 && f.risikenOhneBewertung === 0,
        link: 'risiken',
      },
      {
        text: 'Inventar im Vier-Augen-Prinzip freigegeben',
        erfuellt: f.risikenAktiv > 0 && f.risikenNichtFreigegeben === 0,
        link: 'risiken',
      },
    ],
    [
      {
        text: 'Jedes Risiko über dem Appetit hat eine Kontrolle mit Designbeurteilung',
        erfuellt: f.risikenUeberAppetitOhneKontrolle === 0,
        link: 'kontrollen',
      },
      {
        text: 'Pflichtattribute aller Kontrollen vollständig',
        erfuellt: f.kontrollenOhnePflichtattribute === 0,
        link: 'kontrollen',
      },
    ],
    [
      {
        text: f.beschreibungFreigegeben
          ? `CMS-Beschreibung v${f.beschreibungVersion} durch gesetzliche Vertreter freigegeben`
          : 'CMS-Beschreibung durch gesetzliche Vertreter freigegeben',
        erfuellt: f.beschreibungFreigegeben,
        link: 'beschreibung',
      },
    ],
    [
      {
        text: f.angemessenheitStichtag
          ? `Angemessenheit zum Stichtag ${fmt(f.angemessenheitStichtag)} dokumentiert`
          : 'Nachweispaket zum Stichtag dokumentiert',
        erfuellt: f.angemessenheitStichtag != null,
      },
    ],
    [
      { text: 'Beginn und Ende festgelegt', erfuellt: f.wirksamAb != null && f.wirksamBis != null },
      { text: 'Lückenanalyse aktiv', erfuellt: f.durchfuehrungenImZeitraum > 0 },
      {
        text: 'Abschluss zum Zeitraumende',
        erfuellt: f.wirksamBis != null && f.heute.getTime() > f.wirksamBis.getTime(),
      },
    ],
    [],
  ];
  const phasen: PhasenInfo[] = PHASEN.map((name, i) => {
    const bedingungen = g[i] ?? [];
    return {
      nr: i + 1,
      name,
      bedingungen,
      erfuellt: bedingungen.length > 0 && bedingungen.every((b) => b.erfuellt),
    };
  });
  const offen = phasen.find((p) => p.nr <= 6 && !p.erfuellt);
  return { phasen, aktiv: offen ? offen.nr : 7 };
}
