// =============================================================================
// Ergebnis einer Tax-CMS-Aktion für die Oberflächen (Integration TCMS Stufe 3):
// `ActionResult` der kanzleikonsole mit einer festen Erfolgsmeldung bzw. einem
// Hinweis, die die Aktion aus der Antwort des Dienstes baut. Eine Definition für
// alle Bereiche (vorher je Bereich gleichlautend in A, B, C und D); Server
// Actions importieren nur den Typ.
// =============================================================================

import type { ActionResult } from '@/server/actions/types';

export type TcmsAktionsErgebnis = ActionResult & {
  /** Feste Erfolgsmeldung der Aktion. */
  meldung?: string;
  /** Erfolg mit Hinweis (z. B. gespeichert, aber noch nicht eingereicht). */
  warnung?: string;
};

/** Server Action eines Formulars (`useActionState`-Signatur). */
export type TcmsFormAktion<E extends TcmsAktionsErgebnis = TcmsAktionsErgebnis> = (
  vorher: E | null,
  formData: FormData,
) => Promise<E>;
