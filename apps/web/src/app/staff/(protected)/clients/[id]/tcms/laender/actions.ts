'use server';

// =============================================================================
// Aktionen des Länder-Monitors (TCMS Stufe 3, portiert aus der Demo
// server/actions/laender.ts): neue Länderstände erfassen (einzeln oder
// gesammelt) und ein Land aufnehmen. Jede Erfassung legt im Dienst einen
// neuen Stand an (Historie bleibt); neues Lagerland und Schwellenwechsel
// lösen dort Ereignisse aus. Wer erfassen darf, entscheidet der Dienst
// (kannBearbeiten, TCMS-DIENST-001).
// =============================================================================

import { ENDPUNKTE } from '@taxtronik/tcms-contract';
import { LAND_NAME } from '@taxtronik/tcms-domain';
import { z } from 'zod';
import type { TcmsAktionsErgebnis } from '@/components/tcms/bereich-b/ergebnis';
import { formFlag, parseFormData } from '@/server/actions/form-data';
import { tcmsKanzleiAktion } from '@/server/tcms/aktion';
import { laenderAusFormular } from '@/server/tcms/bereich-b/laender-formular';

/** Feldpfade des Dienstes → Formular (übrige: nur die Sammelmeldung). */
const FELDER = { datenstand: 'datenstand', land: 'land' } as const;

/** Sammelerfassung (`sammel=1`): Felder je Land mit Präfix `<Land>.`. */
const SammelFeld = z.object({ sammel: formFlag('1') });

function ereignisText(ereignisse: readonly string[]): string {
  if (ereignisse.length === 0) return '';
  return ereignisse.length === 1
    ? ` Ereignis ${ereignisse[0]} im Ereigniseingang angelegt.`
    : ` Ereignisse ${ereignisse.join(', ')} im Ereigniseingang angelegt.`;
}

/** Einzel- (Detailbereich) und Sammelerfassung (`sammel=1`, Felder mit Präfix `<Land>.`). */
export async function landStaendeSpeichernAction(
  mandantId: string,
  _vorher: TcmsAktionsErgebnis | null,
  formData: FormData,
): Promise<TcmsAktionsErgebnis> {
  const art = parseFormData(SammelFeld, formData);
  const sammel = art.ok && art.data.sammel;
  return tcmsKanzleiAktion({
    mandantId,
    keinRecht: 'BEARBEITEN',
    felder: FELDER,
    parse: () => laenderAusFormular(formData, { praefix: sammel }),
    aufruf: async (dienst, d) => {
      const { daten } = await dienst.rufe(ENDPUNKTE.landStaendeSpeichern, {
        body: { datenstand: d.datenstand, laender: d.laender },
      });
      const text =
        daten.staende.length === 1
          ? `Neuer Stand für ${daten.staende[0]!.land} gespeichert; der bisherige Stand bleibt in der Historie.`
          : `${daten.staende.length} Länderstände gespeichert; frühere Stände bleiben in der Historie.`;
      return { meldung: `${text}${ereignisText(daten.ereignisse)}` };
    },
  });
}

export async function landHinzufuegenAction(
  mandantId: string,
  _vorher: TcmsAktionsErgebnis | null,
  formData: FormData,
): Promise<TcmsAktionsErgebnis & { land?: string }> {
  return tcmsKanzleiAktion({
    mandantId,
    keinRecht: 'BEARBEITEN',
    felder: FELDER,
    parse: () => laenderAusFormular(formData, { praefix: false }),
    aufruf: async (dienst, d) => {
      const land = d.laender[0]!;
      const { daten } = await dienst.rufe(ENDPUNKTE.landHinzufuegen, {
        body: { datenstand: d.datenstand, land },
      });
      return {
        land: land.land,
        meldung: `${LAND_NAME[land.land] ?? land.land} (${land.land}) in den Monitor aufgenommen.${ereignisText(daten.ereignisse)}`,
      };
    },
  });
}
