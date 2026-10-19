// =============================================================================
// Feldschemas der Aktionen des Bereichs B (TCMS Stufe 3). Sie prüfen nur die
// Form der Eingaben – so, wie sie der Vertrag ohnehin verlangt – damit ein
// Fehler am Feld erscheint, bevor der Dienst gerufen wird. Fachliche Regeln
// (Vier-Augen, Status, Klassen) prüft der Dienst.
// =============================================================================

import { MIN_BEGRUENDUNG } from '@taxtronik/tcms-domain';
import { z } from 'zod';
import { formEmpty, formFlag } from '@/server/actions/form-data';

/** Höchstlänge wie `MAX_BEGRUENDUNG_ZEICHEN` im Vertrag (risiken-kontrollen). */
export const MAX_BEGRUENDUNG_ZEICHEN = 2000;

/** ID eines Tax-CMS-Objekts wie `ObjektIdSchema` im Vertrag. */
export const ObjektIdFeld = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'Ungültige Auswahl.');

/** Begründung wie `BegruendungSchema` im Vertrag (getrimmt, 30–2000 Zeichen). */
export const BegruendungFeld = z.string().trim().min(MIN_BEGRUENDUNG).max(MAX_BEGRUENDUNG_ZEICHEN);

/** Optionale Begründung (Freigabe ohne, Ablehnung mit); leer → undefined. */
export const OptionaleBegruendungFeld = formEmpty(
  undefined,
  z.string().trim().min(MIN_BEGRUENDUNG).max(MAX_BEGRUENDUNG_ZEICHEN).optional(),
);

/** Kontrollkästchen (`on`) als Wahrheitswert; fehlt es, ist es `false`. */
export const HakenFeld = formFlag();

/** Kalendertag `YYYY-MM-DD` (gültiger Tag). */
export const TagFeld = z.iso.date();
