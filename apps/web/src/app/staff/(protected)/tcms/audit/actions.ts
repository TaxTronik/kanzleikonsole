'use server';

// =============================================================================
// Prüfung der Audit-Hashkette des Tenants (TCMS Stufe 3, Bereich D; aus der
// Demo server/actions/admin.ts). Nur Admins und Partner: Gate `nurAdmin` der
// kanzleikonsole UND Recht im Tax-CMS (kannVerwalten; 403 → fester Text
// VERWALTUNG). Die Kette prüft ausschließlich der Dienst (seitenweise mit
// Zeitbudget, `weiterAb`); die kanzleikonsole rechnet keinen Hash nach. Den
// Grund eines Bruchs zeigt sie nur als festen Text (server/tcms/audit.ts),
// nie den Text des Dienstes (RT3).
// =============================================================================

import { ENDPUNKTE } from '@taxtronik/tcms-contract';
import type { ActionFailure } from '@/server/actions/action-runner';
import type { ActionResult } from '@/server/actions/types';
import { tcmsKanzleiAktion } from '@/server/tcms/aktion';
import { auditBruchText } from '@/server/tcms/audit';

type Ergebnis = ActionResult & { meldung?: string; warnung?: string };
/** Rückgabe des Dienstaufrufs: Fehlerergebnis oder Meldung (Nutzlast). */
type Lauf = ActionFailure | { meldung?: string; warnung?: string };

/** Höchstzahl Fortsetzungen einer abgebrochenen Prüfung (je Aufruf ein Zeitbudget im Dienst). */
const MAX_FORTSETZUNGEN = 50;

export async function auditPruefenAction(
  _vorher: Ergebnis | null,
  _formData: FormData,
): Promise<Ergebnis> {
  return tcmsKanzleiAktion({
    mandantId: null,
    nurAdmin: true,
    keinRecht: 'VERWALTUNG',
    aufruf: async (dienst): Promise<Lauf> => {
      let ab: number | undefined;
      let geprueft = 0;
      for (let i = 0; i < MAX_FORTSETZUNGEN; i++) {
        const { daten: r } = await dienst.rufe(ENDPUNKTE.auditPruefen, {
          body: ab === undefined ? {} : { ab },
        });
        geprueft += r.geprueft;
        if (r.status === 'INTAKT') {
          return {
            meldung: `Hashkette intakt: ${geprueft} Einträge geprüft, jeder Eintrag bindet seinen Vorgänger.`,
          };
        }
        if (r.status === 'GEBROCHEN') {
          return {
            warnung: `Hashkette gebrochen bei Eintrag #${r.bruchBei ?? '?'}: ${auditBruchText(
              r.grund,
            )} Einträge davor sind konsistent. Bitte den Betrieb informieren.`,
          };
        }
        if (r.weiterAb === null) break;
        ab = r.weiterAb;
      }
      return {
        warnung: `Prüfung nach ${geprueft} Einträgen nicht abgeschlossen. Bitte erneut starten.`,
      };
    },
  });
}
