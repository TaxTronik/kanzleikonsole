// =============================================================================
// Testdaten der Tax-CMS-Oberflächen (TCMS Stufe 3): Antworten des laufenden
// TCMS-Dienstes mit dessen Demo-Daten (fiktiv, packages/db/seeds/demo.ts im
// TCMS-Repo), gekürzt. Jede Antwort wird beim Laden mit dem Antwortschema
// des vendorten Vertrags geprüft – ändert sich der Vertrag, scheitern die
// Tests mit den Fixtures, statt still veraltete Daten zu rendern.
//
// Abweichungen von der Originalantwort (bewusst, für die Tests):
//   - kontext-talwind.json: Listen gekürzt, Texte gekürzt, `datevNr` null,
//     F-2026-006 so maskiert, wie Nicht-Beteiligte eine vertrauliche
//     Feststellung erhalten (RT-01).
//   - Bereich C (Durchführungen, Nachweise, Feststellungen, Arbeitskorb):
//     ungekürzt aus dem Dienst (Stand d5b6511, Demo-Daten, „heute“ 19.10.2026).
//     durchfuehrung-in-durchfuehrung.json und nachweis-lesen.json nach
//     Beginnen, Speichern und Anhängen eines Testverweises (Dokument-ID
//     c3000000-…-0001, SHA-256 „a…a“) durch Leon Brandt; die Nachweise der
//     Demo-Daten tragen Ablagepfade statt Dokument-IDs (nicht abrufbar).
//     feststellung-maskiert.json und feststellungen-talwind-thomas.json mit
//     F-2026-006 vorübergehend vertraulich, gelesen von Thomas (nicht beteiligt).
//   - einrichtung-bergkamm.json: Entwurf des Einrichtungsassistenten nach
//     Schritt 4 (Live-Antwort des Dienstes mit dem Demo-Akteur, ungekürzt).
//   - beschreibung-talwind.json, profil-talwind.json, freigaben-talwind.json,
//     einrichtung-talwind.json, kontakte-bergkamm.json: ungekürzt.
//   - portal-aufgabe-k23-murat.json (Bereich D): `nachweise[].dokumentId` durch
//     UUIDs ersetzt (die Demo verweist auf Storage-Schlüssel; die
//     kanzleikonsole liefert nur Dokumente mit UUID aus).
//   - portal-freigaben-jana.json (Bereich D): `inhalt` und Abschnitte der
//     Beschreibung gekürzt (snapshotSha256 passt deshalb nicht mehr zum Inhalt).
//   - audit-anna.json (Bereich D): erste Seite mit `vor` (neueste zuerst), limit 5.
//   - Felder aus TCMS s7/s8 (Vendoring 4752652) aus einem Abruf des Dienstes
//     mit frischem Demo-Seed ergänzt, zugeordnet über Codes und Nummern statt
//     IDs (der Seed vergibt IDs je Datenbank neu): `heute` der Einrichtung,
//     Zeitraumzahlen und `pflichtattributeLuecken`, `rechte` der Listen,
//     `bezuege` der Länder (Ereignis-IDs auf die von kontext-talwind-b.json
//     abgebildet, desselben Abrufs wie der Länder-Monitor),
//     `pruefung.kennzahlen`, Rechte der Ereignisse (Anna Roth), `melden`
//     (Jana Weller), `gegenzeichnungMandant` der lebenden Bausteine (K-EC-23
//     dabei ohne die frühere Endung „ (Mandant)“ im Namen, wie der Dienst sie
//     seit s7 lebend liefert).
// Neue Fixtures: Antwort mit dem Demo-Akteur abrufen, kürzen, hier mit dem
// Schema des Endpunkts laden (ENDPUNKTE.<name>.antwortSchema).
// =============================================================================

import { ENDPUNKTE } from '@taxtronik/tcms-contract';
import type { z } from 'zod';
import beschreibungTalwind from './beschreibung-talwind.json';
import einrichtungBergkamm from './einrichtung-bergkamm.json';
import einrichtungTalwind from './einrichtung-talwind.json';
import freigabenTalwind from './freigaben-talwind.json';
import kontakteBergkamm from './kontakte-bergkamm.json';
import kontakteTalwind from './kontakte-talwind.json';
import kontextTalwind from './kontext-talwind.json';
import portalUebersichtJana from './portal-uebersicht-jana.json';
import portfolioDemo from './portfolio-demo.json';
import arbeitskorbAnna from './arbeitskorb-anna.json';
import arbeitskorbLeon from './arbeitskorb-leon.json';
import durchfuehrungFaellig from './durchfuehrung-faellig.json';
import durchfuehrungGegenzeichnung from './durchfuehrung-gegenzeichnung.json';
import durchfuehrungInDurchfuehrung from './durchfuehrung-in-durchfuehrung.json';
import durchfuehrungMitBefund from './durchfuehrung-mit-befund.json';
import feststellungMaskiert from './feststellung-maskiert.json';
import feststellungNachkontrolle from './feststellung-nachkontrolle.json';
import feststellungP153 from './feststellung-p153.json';
import feststellungenTalwind from './feststellungen-talwind.json';
import feststellungenTalwindThomas from './feststellungen-talwind-thomas.json';
import nachweisLesen from './nachweis-lesen.json';
import profilTalwind from './profil-talwind.json';
// Bereich B (Risiken, Kontrollen, Kalender, Prüfung, Länder): ein Abruf
// desselben Dienststands (Demo-Daten plus per API hergestellte Fälle:
// Übersteuerung beantragt von Anna Roth bzw. von Leon Brandt freigegeben,
// EC-GOB-02 von Leon eingereicht, EC-GOB-03 bewertet, Risikoakzeptanz
// EC-VER-01 bei Jana Weller offen, Frequenzabweichung K-EC-02 von Leon
// beantragt, K-EC-08 von Anna beantragt und von Leon freigegeben). Gekürzt
// (Auswahl an Risiken, Kontrollen und Durchführungen, Texte der Beschreibung);
// F-2026-006 so maskiert, wie Nicht-Beteiligte sie erhalten (Kontext und
// Kontrollen), und deshalb nicht in den Feststellungen des Länder-Monitors.
import kontextTalwindB from './kontext-talwind-b.json';
import kontrolleKEc02 from './kontrolle-k-ec-02.json';
import kontrolleKEc08 from './kontrolle-k-ec-08.json';
import kontrollenTalwind from './kontrollen-talwind.json';
import laenderTalwind from './laender-talwind.json';
import risikenTalwind from './risiken-talwind.json';
import risikoEcUst01 from './risiko-ec-ust-01.json';
import risikoEcUst02 from './risiko-ec-ust-02.json';
import risikoEcVer01 from './risiko-ec-ver-01.json';
// Bereich D (Portal, Ereignisse, Audit)
import auditAnna from './audit-anna.json';
import ereignis0329 from './ereignis-0329.json';
import ereignis0345 from './ereignis-0345.json';
import ereignisseTalwind from './ereignisse-talwind.json';
import portalAufgabeK23Murat from './portal-aufgabe-k23-murat.json';
import portalFreigabenJana from './portal-freigaben-jana.json';
import portalMeldungenJana from './portal-meldungen-jana.json';

/** Feste IDs der TCMS-Demo (gleich in der kanzleikonsole-Testdatenbank des Live-Tests). */
export const DEMO = {
  tenant: '7a1e0000-0000-4000-8000-00000000d3e0',
  anna: 'b1000000-0000-4000-8000-000000000001',
  leon: 'b1000000-0000-4000-8000-000000000002',
  thomas: 'b1000000-0000-4000-8000-000000000003',
  jana: 'b1000000-0000-4000-8000-000000000011',
  murat: 'b1000000-0000-4000-8000-000000000012',
  sabine: 'b1000000-0000-4000-8000-000000000013',
  talwind: 'a1000000-0000-4000-8000-000000004711',
  seestern: 'a1000000-0000-4000-8000-000000004720',
  kleinwerk: 'a1000000-0000-4000-8000-000000004733',
  pixelhafen: 'a1000000-0000-4000-8000-000000004698',
  bergkamm: 'a1000000-0000-4000-8000-000000004752',
} as const;

function laden<S extends z.ZodType>(schema: S, roh: unknown): z.output<S> {
  // structuredClone: jeder Test erhält eine eigene, veränderbare Kopie.
  return schema.parse(structuredClone(roh));
}

export const tcmsFixtures = {
  kontextTalwind: () => laden(ENDPUNKTE.kontextLesen.antwortSchema, kontextTalwind),
  kontakteTalwind: () => laden(ENDPUNKTE.kontakteLesen.antwortSchema, kontakteTalwind),
  portfolioDemo: () => laden(ENDPUNKTE.portfolioLesen.antwortSchema, portfolioDemo),
  portalUebersichtJana: () =>
    laden(ENDPUNKTE.portalUebersichtLesen.antwortSchema, portalUebersichtJana),
  // Bereich C
  durchfuehrungFaellig: () =>
    laden(ENDPUNKTE.durchfuehrungLesen.antwortSchema, durchfuehrungFaellig),
  durchfuehrungGegenzeichnung: () =>
    laden(ENDPUNKTE.durchfuehrungLesen.antwortSchema, durchfuehrungGegenzeichnung),
  durchfuehrungInDurchfuehrung: () =>
    laden(ENDPUNKTE.durchfuehrungLesen.antwortSchema, durchfuehrungInDurchfuehrung),
  durchfuehrungMitBefund: () =>
    laden(ENDPUNKTE.durchfuehrungLesen.antwortSchema, durchfuehrungMitBefund),
  nachweisLesen: () => laden(ENDPUNKTE.nachweisLesen.antwortSchema, nachweisLesen),
  feststellungenTalwind: () =>
    laden(ENDPUNKTE.feststellungenLesen.antwortSchema, feststellungenTalwind),
  feststellungenTalwindThomas: () =>
    laden(ENDPUNKTE.feststellungenLesen.antwortSchema, feststellungenTalwindThomas),
  feststellungP153: () => laden(ENDPUNKTE.feststellungLesen.antwortSchema, feststellungP153),
  feststellungNachkontrolle: () =>
    laden(ENDPUNKTE.feststellungLesen.antwortSchema, feststellungNachkontrolle),
  feststellungMaskiert: () =>
    laden(ENDPUNKTE.feststellungLesen.antwortSchema, feststellungMaskiert),
  arbeitskorbAnna: () => laden(ENDPUNKTE.arbeitskorbLesen.antwortSchema, arbeitskorbAnna),
  arbeitskorbLeon: () => laden(ENDPUNKTE.arbeitskorbLesen.antwortSchema, arbeitskorbLeon),
  // Bereich A (Programm & Dokumentation)
  einrichtungBergkamm: () => laden(ENDPUNKTE.einrichtungLesen.antwortSchema, einrichtungBergkamm),
  einrichtungTalwind: () => laden(ENDPUNKTE.einrichtungLesen.antwortSchema, einrichtungTalwind),
  kontakteBergkamm: () => laden(ENDPUNKTE.kontakteLesen.antwortSchema, kontakteBergkamm),
  profilTalwind: () => laden(ENDPUNKTE.profilLesen.antwortSchema, profilTalwind),
  beschreibungTalwind: () => laden(ENDPUNKTE.beschreibungLesen.antwortSchema, beschreibungTalwind),
  freigabenTalwind: () => laden(ENDPUNKTE.freigabenHistorieLesen.antwortSchema, freigabenTalwind),
  // Bereich B
  kontextTalwindB: () => laden(ENDPUNKTE.kontextLesen.antwortSchema, kontextTalwindB),
  risikenTalwind: () => laden(ENDPUNKTE.risikenLesen.antwortSchema, risikenTalwind),
  risikoEcUst01: () => laden(ENDPUNKTE.risikoLesen.antwortSchema, risikoEcUst01),
  risikoEcUst02: () => laden(ENDPUNKTE.risikoLesen.antwortSchema, risikoEcUst02),
  risikoEcVer01: () => laden(ENDPUNKTE.risikoLesen.antwortSchema, risikoEcVer01),
  kontrollenTalwind: () => laden(ENDPUNKTE.kontrollenLesen.antwortSchema, kontrollenTalwind),
  kontrolleKEc02: () => laden(ENDPUNKTE.kontrolleLesen.antwortSchema, kontrolleKEc02),
  kontrolleKEc08: () => laden(ENDPUNKTE.kontrolleLesen.antwortSchema, kontrolleKEc08),
  laenderTalwind: () => laden(ENDPUNKTE.laenderLesen.antwortSchema, laenderTalwind),
  // Bereich D (Portal, Ereignisse, Audit)
  /** K-EC-23 Q3 2026 aus Sicht von Murat (durchführend, IN_DURCHFUEHRUNG, 2 Anlagen). */
  portalAufgabeK23Murat: () =>
    laden(ENDPUNKTE.portalAufgabeLesen.antwortSchema, portalAufgabeK23Murat),
  portalMeldungenJana: () =>
    laden(ENDPUNKTE.portalMeldungenLesen.antwortSchema, portalMeldungenJana),
  /** Kenntnisnahme an Murat (für Jana gesperrt), Beschreibung v1.2 an Jana (Code KEIN). */
  portalFreigabenJana: () =>
    laden(ENDPUNKTE.portalFreigabenLesen.antwortSchema, portalFreigabenJana),
  ereignisseTalwind: () => laden(ENDPUNKTE.ereignisseLesen.antwortSchema, ereignisseTalwind),
  /** 2026-T-0345 (NEU, Portal-Meldung von Murat, 3 Vorschläge). */
  ereignis0345: () => laden(ENDPUNKTE.ereignisLesen.antwortSchema, ereignis0345),
  /** 2026-T-0329 (ERLEDIGT). */
  ereignis0329: () => laden(ENDPUNKTE.ereignisLesen.antwortSchema, ereignis0329),
  auditAnna: () => laden(ENDPUNKTE.auditLesen.antwortSchema, auditAnna),
};
