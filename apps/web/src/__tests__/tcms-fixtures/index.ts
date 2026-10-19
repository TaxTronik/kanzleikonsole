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
// Neue Fixtures: Antwort mit dem Demo-Akteur abrufen, kürzen, hier mit dem
// Schema des Endpunkts laden (ENDPUNKTE.<name>.antwortSchema).
// =============================================================================

import { ENDPUNKTE } from '@taxtronik/tcms-contract';
import type { z } from 'zod';
import kontakteTalwind from './kontakte-talwind.json';
import kontextTalwind from './kontext-talwind.json';
import portalUebersichtJana from './portal-uebersicht-jana.json';
import portfolioDemo from './portfolio-demo.json';

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
};
