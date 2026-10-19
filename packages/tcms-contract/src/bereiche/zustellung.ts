// =============================================================================
// Vertrag (zod) der Zustellung von Nachrichten (Stufe 4): Gründe, aus denen die
// kanzleikonsole eine Nachricht nicht zustellen konnte, und der Zustellstatus,
// den die Kanzlei an Freigaben und Anforderungen sieht (Freigabenhistorie,
// CMS-Beschreibung, Risikoakzeptanz), damit sie bei einer unzustellbaren
// Anforderung neu adressieren kann.
//
// Eigene Datei, weil zwei Bereiche sie brauchen („programm-beschreibung" und
// „risiken-kontrollen") und `programm-beschreibung` bereits aus
// `risiken-kontrollen` importiert (kein Importzyklus). Hängt nur von zod ab.
//
// Der Zustellstatus nennt nie Inhalte der Nachricht (kein Text, kein Betreff,
// keine Vorlagendaten, kein Code), nur Zweck, Status und Zeitpunkte.
// =============================================================================

import { z } from 'zod';

const isoZeit = z.string().max(40);

/**
 * Gründe einer Unzustellbarkeit (feste Liste, kein Freitext): Empfänger gehört
 * nicht (mehr) zum Mandanten bzw. ist unbekannt, Empfänger hat keinen
 * bestätigten Portalzugang, die Zustellfrist der kanzleikonsole ist
 * abgelaufen, sonstiger Grund.
 */
export const NACHRICHT_UNZUSTELLBAR_GRUENDE = [
  'EMPFAENGER_UNGUELTIG',
  'KEIN_PORTALZUGANG',
  'ABGELAUFEN',
  'SONSTIGES',
] as const;
export const NachrichtUnzustellbarGrundSchema = z.enum(NACHRICHT_UNZUSTELLBAR_GRUENDE);
export type NachrichtUnzustellbarGrund = z.infer<typeof NachrichtUnzustellbarGrundSchema>;

/**
 * Zustellstatus einer Nachricht: noch offen (nicht gemeldet), zugestellt,
 * unzustellbar (mit Grund) oder vom Dienst verworfen (Code galt nicht mehr,
 * nie ausgeliefert). Meldet die kanzleikonsole eine Nachricht nach dem
 * Verwerfen noch als zugestellt bzw. unzustellbar (sie hatte sie vorher
 * abgeholt), gilt die Meldung.
 */
export const ZUSTELL_STATUS = ['OFFEN', 'ZUGESTELLT', 'UNZUSTELLBAR', 'VERWORFEN'] as const;
export type ZustellStatus = (typeof ZUSTELL_STATUS)[number];

/** Zwecke der Nachrichten zu einer Freigabe (Teilmenge von `NACHRICHT_ZWECKE`). */
export const FREIGABE_NACHRICHT_ZWECKE = [
  'FREIGABE_ANGEFORDERT',
  'FREIGABE_CODE',
  'FREIGABE_NEU_ADRESSIERT',
] as const;
const freigabeZweck = z.enum(FREIGABE_NACHRICHT_ZWECKE);

const kopf = { zweck: freigabeZweck, erstelltAm: isoZeit };

/**
 * Zustellung der jüngsten Nachricht zu einer Freigabe an deren aktuellen
 * Empfänger (`null` am Eintrag: keine solche Nachricht oder historischer
 * Stand). `am`: Zeitpunkt der Meldung bzw. des Verwerfens.
 */
export const FreigabeZustellungSchema = z.discriminatedUnion('status', [
  z.object({ ...kopf, status: z.literal('OFFEN') }).strict(),
  z.object({ ...kopf, status: z.literal('ZUGESTELLT'), am: isoZeit }).strict(),
  z
    .object({
      ...kopf,
      status: z.literal('UNZUSTELLBAR'),
      am: isoZeit,
      grund: NachrichtUnzustellbarGrundSchema,
    })
    .strict(),
  z.object({ ...kopf, status: z.literal('VERWORFEN'), am: isoZeit }).strict(),
]);
export type FreigabeZustellung = z.infer<typeof FreigabeZustellungSchema>;
