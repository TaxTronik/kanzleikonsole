// Ergebnis der Aktionen des Bereichs B (TCMS Stufe 3): ActionResult mit einer
// festen Erfolgsmeldung, die die Aktion aus der Antwort des Dienstes baut
// (Codes, Klassen-Labels aus @taxtronik/tcms-domain).
import type { ActionResult } from '@/server/actions/types';

export type TcmsAktionsErgebnis = ActionResult & { meldung?: string };

export type TcmsAktion = (
  vorher: TcmsAktionsErgebnis | null,
  formData: FormData,
) => Promise<TcmsAktionsErgebnis>;
