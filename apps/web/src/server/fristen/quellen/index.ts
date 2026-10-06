// =============================================================================
// Fristenkontrollbuch — Register der fristenführenden Quellen.
//
// Fachkatalog: TAX-CONTROL-STATUS-001
//
// Die Listenreihenfolge ist die Abfragereihenfolge des Loaders (Klagefristen
// vor internen Prüfterminen). `rang` ist davon unabhängig die bisherige
// Einfügereihenfolge und ordnet Einträge gleicher Fälligkeit.
// =============================================================================

import { anforderungen } from './anforderungen';
import { einspruchsfristen } from './einspruchsfristen';
import { internePrueftermine } from './interne-prueftermine';
import { klagefristen } from './klagefristen';
import { steuertermine } from './steuertermine';
import type { KontrollbuchQuelle } from './typen';
import { wiedervorlagen } from './wiedervorlagen';

export type AnyKontrollbuchQuelle = KontrollbuchQuelle<unknown, unknown, unknown>;

export const KONTROLLBUCH_QUELLEN: readonly AnyKontrollbuchQuelle[] = [
  steuertermine,
  einspruchsfristen,
  klagefristen,
  internePrueftermine,
  anforderungen,
  wiedervorlagen,
];
