// =============================================================================
// Sieben Grundelemente (IDW PS 980, vgl. Tz. 27) mit Lückenzählung. Bewusst
// keine Prozente: angezeigt wird „dokumentiert" oder „Lücken (n)".
// =============================================================================

export const GRUNDELEMENTE = [
  { key: 'kultur', titel: 'Compliance-Kultur', icon: 'Landmark' },
  { key: 'ziele', titel: 'Compliance-Ziele', icon: 'Flag' },
  { key: 'risiken', titel: 'Compliance-Risiken', icon: 'TriangleAlert' },
  { key: 'programm', titel: 'Compliance-Programm', icon: 'SquareCheckBig' },
  { key: 'organisation', titel: 'Compliance-Organisation', icon: 'Users' },
  { key: 'kommunikation', titel: 'Compliance-Kommunikation', icon: 'MessagesSquare' },
  { key: 'ueberwachung', titel: 'Überwachung & Verbesserung', icon: 'Route' },
] as const;

export type GrundelementKey = (typeof GRUNDELEMENTE)[number]['key'];

export interface GrundelementFakten {
  /** Abschnittstexte der aktuellen CMS-Beschreibung, je Grundelement leer/gefüllt. */
  abschnittGefuellt: Record<GrundelementKey, boolean>;
  zieleNichtFreigegeben: number;
  risikenOhneBewertung: number;
  risikenNichtFreigegeben: number;
  kontrollenOhneDesign: number;
  durchfuehrungenUeberfaellig: number;
  kontrollenOhneVertretung: number;
  feststellungenOhneMassnahme: number;
  p153Offen: number;
  /** Weitere, serverseitig ermittelte Lücken je Grundelement. */
  zusatz?: Partial<Record<GrundelementKey, string[]>>;
}

export interface GrundelementStatus {
  key: GrundelementKey;
  titel: string;
  icon: string;
  luecken: string[];
}

export function bewerteGrundelemente(f: GrundelementFakten): GrundelementStatus[] {
  const luecken: Record<GrundelementKey, string[]> = {
    kultur: [],
    ziele: [],
    risiken: [],
    programm: [],
    organisation: [],
    kommunikation: [],
    ueberwachung: [],
  };
  for (const ge of GRUNDELEMENTE) {
    if (!f.abschnittGefuellt[ge.key]) luecken[ge.key].push('Abschnitt der CMS-Beschreibung leer');
  }
  if (f.zieleNichtFreigegeben > 0)
    luecken.ziele.push(`${f.zieleNichtFreigegeben} Ziel(e) nicht freigegeben`);
  if (f.risikenOhneBewertung > 0)
    luecken.risiken.push(`${f.risikenOhneBewertung} Risiko(s) ohne Bewertung`);
  if (f.risikenNichtFreigegeben > 0)
    luecken.risiken.push(`${f.risikenNichtFreigegeben} Risiko(s) nicht freigegeben`);
  if (f.kontrollenOhneDesign > 0)
    luecken.programm.push(`${f.kontrollenOhneDesign} Kontrolle(n) ohne Designbeurteilung`);
  if (f.durchfuehrungenUeberfaellig > 0)
    luecken.programm.push(`${f.durchfuehrungenUeberfaellig} Durchführung(en) überfällig`);
  if (f.kontrollenOhneVertretung > 0)
    luecken.organisation.push(`${f.kontrollenOhneVertretung} Kontrolle(n) ohne Vertretung`);
  if (f.feststellungenOhneMassnahme > 0)
    luecken.ueberwachung.push(`${f.feststellungenOhneMassnahme} Feststellung(en) ohne Maßnahme`);
  if (f.p153Offen > 0) luecken.ueberwachung.push(`${f.p153Offen} §-153-Würdigung(en) offen`);
  for (const [key, liste] of Object.entries(f.zusatz ?? {})) {
    luecken[key as GrundelementKey].push(...(liste ?? []));
  }
  return GRUNDELEMENTE.map((ge) => ({
    key: ge.key,
    titel: ge.titel,
    icon: ge.icon,
    luecken: luecken[ge.key],
  }));
}
