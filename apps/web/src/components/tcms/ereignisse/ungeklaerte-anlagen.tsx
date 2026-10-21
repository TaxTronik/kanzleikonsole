// =============================================================================
// Ungeklärte Anlagen aus Portal-Meldungen (kk-tcms-s10nach, TCMS-NACHWEIS-001):
// Anlagen, deren Meldung das Tax-CMS innerhalb des Wiederholungsfensters nicht
// bestätigt hat (bzw. Altbestand ohne Idempotenzschlüssel). Sie bleiben
// gebunden – nie automatisch frei, denn das Ereignis kann existieren – und
// werden hier zur manuellen Klärung gezeigt. Zuordnen dürfen Admins und
// Partner, und nur zu einem Ereignis, das die Anlage laut Tax-CMS enthält.
// kk-tcms-s11 Punkt 3: Freigeben (Pflichtbegründung) dürfen sie, wenn das
// Tax-CMS bestätigt, dass kein Ereignis die Anlage führt (prüft die Aktion).
// =============================================================================

import { Paperclip } from 'lucide-react';
import type { TcmsFormAktion } from '../ergebnis';
import { isoZeitText } from '../format';
import { TCMS_TEXT_ISOLIERT } from '../text';
import { TcmsFormDialog } from './aktionen';
import {
  FREIGABE_BEGRUENDUNG,
  FREIGEBEN_HINWEIS,
  UNGEKLAERT_TEXT,
  ZUORDNEN_NUR_ADMIN,
} from './anlage-texte';

export interface UngeklaerteAnlageAnzeige {
  verknuepfungId: string;
  titel: string;
  /** ISO-Zeitpunkt der Ablage. */
  seit: string;
  /** Name der meldenden Person (kanzleikonsole). */
  von: string;
  /** Gebundene Aktion „Ereignis zuordnen“ (Mandant und Verknüpfung gebunden). */
  zuordnen: TcmsFormAktion;
  /** Gebundene Aktion „Freigeben“ (Mandant und Verknüpfung gebunden). */
  freigeben: TcmsFormAktion;
}

export function UngeklaerteAnlagen({
  anlagen,
  ereignisse,
  darfZuordnen,
}: {
  anlagen: readonly UngeklaerteAnlageAnzeige[];
  /** Ereignisse dieses Mandanten zur Auswahl (Nummer und Titel aus der Antwort). */
  ereignisse: ReadonlyArray<{ id: string; nummer: string; titel: string }>;
  darfZuordnen: boolean;
}) {
  if (anlagen.length === 0) return null;
  return (
    <section className="card mb-4" aria-labelledby="tcms-ungeklaerte-anlagen">
      <div className="card-header">
        <h2 id="tcms-ungeklaerte-anlagen" className="text-sm font-semibold text-primary">
          Ungeklärte Anlagen aus Portal-Meldungen
        </h2>
        <span className="badge-yellow">{anlagen.length}</span>
      </div>
      <div className="p-4 space-y-3">
        <p className="alert-warning text-sm" role="note">
          {UNGEKLAERT_TEXT}
        </p>
        <ul className="space-y-2">
          {anlagen.map((a) => (
            <li key={a.verknuepfungId} className="flex flex-wrap items-center gap-3 text-sm">
              <Paperclip className="h-4 w-4 text-muted" aria-hidden="true" />
              <span className="grow min-w-0">
                <span className="font-medium">{a.titel}</span>
                <span className="block text-xs text-muted">
                  gemeldet von {a.von} · abgelegt am {isoZeitText(a.seit)}
                </span>
              </span>
              <TcmsFormDialog
                aktion={a.zuordnen}
                ausloeser="Ereignis zuordnen"
                titel="Anlage einem Ereignis zuordnen"
                hinweis="Zugeordnet wird nur, wenn das Tax-CMS die Anlage (gleicher SHA-256, gleiches Dokument) für dieses Ereignis führt."
                bestaetigen="Zuordnen"
                gesperrt={
                  !darfZuordnen
                    ? ZUORDNEN_NUR_ADMIN
                    : ereignisse.length === 0
                      ? 'Für diesen Mandanten gibt es keine Ereignisse.'
                      : null
                }
              >
                <label htmlFor={`zuordnen-${a.verknuepfungId}`} className="label-sm">
                  Ereignis
                </label>
                <select
                  id={`zuordnen-${a.verknuepfungId}`}
                  name="ereignisId"
                  className="input"
                  defaultValue=""
                  required
                >
                  <option value="" disabled>
                    Bitte wählen …
                  </option>
                  {ereignisse.map((e) => (
                    <option {...TCMS_TEXT_ISOLIERT} key={e.id} value={e.id}>
                      {e.nummer} · {e.titel}
                    </option>
                  ))}
                </select>
              </TcmsFormDialog>
              <TcmsFormDialog
                aktion={a.freigeben}
                ausloeser="Freigeben"
                titel="Anlage ohne Ereignis freigeben"
                hinweis={FREIGEBEN_HINWEIS}
                bestaetigen="Freigeben"
                gefahr
                begruendung={{ min: FREIGABE_BEGRUENDUNG.min, max: FREIGABE_BEGRUENDUNG.max }}
                gesperrt={darfZuordnen ? null : ZUORDNEN_NUR_ADMIN}
              />
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
