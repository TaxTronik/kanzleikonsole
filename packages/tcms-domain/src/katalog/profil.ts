// =============================================================================
// Geschäftsprofil P1–P12 und deterministischer Risikovorschlag
// (Fachkonzept Abschnitt 4). Keine KI: jeder Vorschlag ist aus dem Profil
// ableitbar und nennt seinen Grund.
// =============================================================================

import { KATALOG_RISIKEN, KERN_RISIKEN } from './risiken';

export const EU_LAENDER: readonly string[] = [
  'AT',
  'BE',
  'BG',
  'CY',
  'CZ',
  'DE',
  'DK',
  'EE',
  'ES',
  'FI',
  'FR',
  'GR',
  'HR',
  'HU',
  'IE',
  'IT',
  'LT',
  'LU',
  'LV',
  'MT',
  'NL',
  'PL',
  'PT',
  'RO',
  'SE',
  'SI',
  'SK',
];

export const LAND_NAME: Record<string, string> = {
  AT: 'Österreich',
  BE: 'Belgien',
  BG: 'Bulgarien',
  CY: 'Zypern',
  CZ: 'Tschechien',
  DE: 'Deutschland',
  DK: 'Dänemark',
  EE: 'Estland',
  ES: 'Spanien',
  FI: 'Finnland',
  FR: 'Frankreich',
  GR: 'Griechenland',
  HR: 'Kroatien',
  HU: 'Ungarn',
  IE: 'Irland',
  IT: 'Italien',
  LT: 'Litauen',
  LU: 'Luxemburg',
  LV: 'Lettland',
  MT: 'Malta',
  NL: 'Niederlande',
  PL: 'Polen',
  PT: 'Portugal',
  RO: 'Rumänien',
  SE: 'Schweden',
  SI: 'Slowenien',
  SK: 'Slowakei',
  CH: 'Schweiz',
  GB: 'Vereinigtes Königreich',
  CN: 'China',
  VN: 'Vietnam',
  US: 'USA',
  TR: 'Türkei',
};

export const MARKTPLAETZE = ['Amazon', 'eBay', 'Kaufland', 'Otto', 'Etsy', 'Sonstige'] as const;
export const ZAHLUNGSWEGE = [
  'PayPal',
  'Stripe',
  'Klarna',
  'Amazon Pay',
  'Vorkasse',
  'Rechnung',
] as const;
export const LAGER_ARTEN = ['EIGEN', 'FBA', 'PAN-EU', 'CEE', '3PL'] as const;
export type LagerArt = (typeof LAGER_ARTEN)[number];

export interface Lager {
  land: string;
  /** Beginn als YYYY-MM. */
  seit: string;
  art: LagerArt;
}

export interface Geschaeftsprofil {
  p1: { eigenerShop: boolean; shopSystem: string; marktplaetze: string[] };
  p2: { eigenversandDE: boolean; lager: Lager[] };
  p3: { laender: string[]; b2bAnteilProzent: number; b2bEU: boolean; b2bInland: boolean };
  p4: { warengruppen: { name: string; abweichenderSatz: boolean }[]; gebrauchtware: boolean };
  p5: { drittlandImport: boolean; laender: string[]; zollabwicklung: string };
  p6: { zahlungswege: string[] };
  p7: { gutscheine: boolean; abos: boolean; bundles: boolean };
  p8: { systeme: { art: string; name: string; version: string }[] };
  p9: { ossSeit: string | null; ioss: boolean; lokaleUstNr: string[]; dauerfrist: boolean };
  p10: {
    vorjahresumsatzEur: number;
    euFernverkaeufeVorjahrEur: number;
    euFernverkaeufeLfdEur: number;
  };
  p11: { vorhanden: boolean; anbieter: string[] };
  p12: { buchhaltung: 'KANZLEI' | 'INTERN' };
}

export const PROFIL_FRAGEN: ReadonlyArray<{
  key: keyof Geschaeftsprofil;
  nr: string;
  titel: string;
  gruppe: string;
}> = [
  { key: 'p1', nr: 'P1', titel: 'Verkaufskanäle', gruppe: 'Kanäle & Fulfillment' },
  { key: 'p2', nr: 'P2', titel: 'Fulfillment und Lagerorte', gruppe: 'Kanäle & Fulfillment' },
  { key: 'p3', nr: 'P3', titel: 'Zielländer und Kundengruppen', gruppe: 'Märkte & Kunden' },
  { key: 'p4', nr: 'P4', titel: 'Sortiment und Steuersätze', gruppe: 'Sortiment & Systeme' },
  { key: 'p5', nr: 'P5', titel: 'Beschaffung aus Drittländern', gruppe: 'Sortiment & Systeme' },
  { key: 'p6', nr: 'P6', titel: 'Zahlungswege', gruppe: 'Märkte & Kunden' },
  { key: 'p7', nr: 'P7', titel: 'Gutscheine, Abos, Bundles', gruppe: 'Märkte & Kunden' },
  { key: 'p8', nr: 'P8', titel: 'Systemlandschaft', gruppe: 'Sortiment & Systeme' },
  { key: 'p9', nr: 'P9', titel: 'Registrierungen', gruppe: 'Organisation' },
  { key: 'p10', nr: 'P10', titel: 'Größenordnung', gruppe: 'Organisation' },
  { key: 'p11', nr: 'P11', titel: 'Ausländische Leistende', gruppe: 'Organisation' },
  { key: 'p12', nr: 'P12', titel: 'Organisation', gruppe: 'Organisation' },
];

export function leeresProfil(): Geschaeftsprofil {
  return {
    p1: { eigenerShop: true, shopSystem: '', marktplaetze: [] },
    p2: { eigenversandDE: true, lager: [] },
    p3: { laender: ['DE'], b2bAnteilProzent: 0, b2bEU: false, b2bInland: false },
    p4: { warengruppen: [], gebrauchtware: false },
    p5: { drittlandImport: false, laender: [], zollabwicklung: '' },
    p6: { zahlungswege: [] },
    p7: { gutscheine: false, abos: false, bundles: false },
    p8: { systeme: [] },
    p9: { ossSeit: null, ioss: false, lokaleUstNr: [], dauerfrist: false },
    p10: { vorjahresumsatzEur: 0, euFernverkaeufeVorjahrEur: 0, euFernverkaeufeLfdEur: 0 },
    p11: { vorhanden: false, anbieter: [] },
    p12: { buchhaltung: 'KANZLEI' },
  };
}

export interface RisikoVorschlag {
  code: string;
  kern: boolean;
  /** z. B. „weil Lager PL seit 03/2025 (P2)". */
  grund: string;
  frage: string;
}

function monat(seit: string): string {
  const [jahr, mon] = seit.split('-');
  return mon && jahr ? `${mon}/${jahr}` : seit;
}

export function istEuAusland(land: string): boolean {
  return land !== 'DE' && EU_LAENDER.includes(land);
}

/** Lagerländer außerhalb Deutschlands. */
export function auslandsLager(p: Geschaeftsprofil): Lager[] {
  return p.p2.lager.filter((l) => l.land !== 'DE');
}

/** Lager im Ausland ohne lokale USt-Registrierung → Feststellungsvorschlag. */
export function lagerOhneRegistrierung(p: Geschaeftsprofil): Lager[] {
  return auslandsLager(p).filter((l) => !p.p9.lokaleUstNr.includes(l.land));
}

/**
 * Leitet die vorzuschlagenden Katalogrisiken aus dem Profil ab. Kernrisiken
 * sind immer aktiv. Reihenfolge wie im Katalog.
 */
export function schlageRisikenVor(p: Geschaeftsprofil): RisikoVorschlag[] {
  const gruende = new Map<string, { grund: string; frage: string }>();
  const setze = (code: string, grund: string, frage: string) => {
    if (!gruende.has(code)) gruende.set(code, { grund, frage });
  };

  const euZiele = p.p3.laender.filter(istEuAusland);
  const euB2C = euZiele.length > 0 && p.p3.b2bAnteilProzent < 100;
  const lagerAusland = auslandsLager(p);
  const ersterLager = lagerAusland[0];
  const fremdlager = p.p2.lager.find((l) => l.art !== 'EIGEN');
  const abweichend = p.p4.warengruppen.find((w) => w.abweichenderSatz);

  if (euB2C) {
    const liste = euZiele.slice(0, 3).join(', ') + (euZiele.length > 3 ? ' …' : '');
    setze('EC-UST-01', `weil EU-B2C nach ${liste} (P3)`, 'P3');
    setze('EC-UST-02', `weil EU-B2C nach ${liste} (P3)`, 'P3');
    if (p.p9.ossSeit) setze('EC-UST-03', `weil OSS seit ${monat(p.p9.ossSeit)} (P9)`, 'P9');
  }
  if (abweichend)
    setze('EC-UST-02', `weil Warengruppe „${abweichend.name}" mit abweichendem Satz (P4)`, 'P4');
  if (euB2C && ersterLager) {
    setze(
      'EC-UST-04',
      `weil EU-B2C und Lager ${ersterLager.land} seit ${monat(ersterLager.seit)} (P2, P3)`,
      'P2',
    );
  }
  if (ersterLager) {
    const grund = `weil Lager ${ersterLager.land} seit ${monat(ersterLager.seit)} (P2)`;
    setze('EC-UST-05', grund, 'P2');
    setze('EC-ERT-03', grund, 'P2');
  }
  if (fremdlager) {
    setze('EC-ERT-01', `weil Fremdlager ${fremdlager.art} ${fremdlager.land} (P2)`, 'P2');
  }
  if (p.p3.b2bEU) setze('EC-UST-06', 'weil EU-B2B-Verkäufe (P3)', 'P3');
  if (p.p3.b2bEU || p.p3.b2bInland) setze('EC-UST-11', 'weil B2B-Verkäufe (P3)', 'P3');
  if (p.p11.vorhanden) {
    const anb = p.p11.anbieter.slice(0, 2).join(', ');
    setze('EC-UST-07', `weil ausländische Leistende${anb ? ` (${anb})` : ''} (P11)`, 'P11');
  }
  if (p.p7.gutscheine) setze('EC-UST-08', 'weil Gutscheine (P7)', 'P7');
  if (p.p7.gutscheine) setze('EC-ERT-02', 'weil Gutscheine (P7)', 'P7');
  if (p.p1.marktplaetze.length > 0) {
    const mp = p.p1.marktplaetze.slice(0, 2).join(', ');
    setze('EC-ERT-02', `weil Marktplatzverkäufe über ${mp} (P1)`, 'P1');
    setze('EC-UST-13', `weil Marktplatzverkäufe über ${mp} (P1)`, 'P1');
  }
  if (p.p5.drittlandImport) {
    setze('EC-UST-12', `weil Import aus ${p.p5.laender.join(', ') || 'Drittland'} (P5)`, 'P5');
  }
  if (p.p4.gebrauchtware) setze('EC-UST-14', 'weil Gebrauchtware im Sortiment (P4)', 'P4');

  return KATALOG_RISIKEN.flatMap((r): RisikoVorschlag[] => {
    if (KERN_RISIKEN.includes(r.code)) {
      return [{ code: r.code, kern: true, grund: 'Kernrisiko – immer aktiv', frage: '–' }];
    }
    const g = gruende.get(r.code);
    return g ? [{ code: r.code, kern: false, grund: g.grund, frage: g.frage }] : [];
  });
}
