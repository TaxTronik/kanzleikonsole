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
};
