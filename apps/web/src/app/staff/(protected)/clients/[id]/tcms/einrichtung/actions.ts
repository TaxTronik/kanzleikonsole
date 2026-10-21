'use server';

// =============================================================================
// Einrichtungsassistent des Tax-CMS (TCMS Stufe 3, Bereich A; Demo
// server/actions/setup.ts): einen Schritt speichern (`POST …/einrichtung/
// entwurf`) bzw. Version 1 anlegen (`POST …/einrichtung/anlegen`).
//
//   - Mandant aus dem gebundenen Argument, nie aus dem Formular.
//   - Der Schritt kommt als JSON (`daten`), streng gelesen (parseJsonStrikt:
//     keine doppelten Schlüssel) und mit dem Schema des Vertrags geprüft.
//   - Personen der Kanzlei (Berufsträger:in, Bearbeitung, Kanzleipersonen mit
//     Zugriff) bildet die kanzleikonsole aus ihren Daten
//     (server/tcms/programm/zustaendigkeit.ts); Personen aus dem Formular
//     (Empfänger der Zielfreigabe, Zuständigkeiten) prüft sie gegen diesen
//     Mandanten (server/tcms/programm/einrichtung.ts), bevor der Dienst
//     gerufen wird.
//   - Ob der Schritt vollständig ist, ob Version 1 angelegt werden darf und wer
//     bearbeiten darf, entscheidet der Dienst.
//   - Nach Erfolg: „Weiter“/„Zurück“ öffnen den nächsten bzw. vorigen Schritt,
//     „Version 1 anlegen“ die Einrichtungsseite mit dem Ergebnis.
// =============================================================================

import { redirect } from 'next/navigation';
import { z } from 'zod';
import {
  ENDPUNKTE,
  KontrollenSchrittSchema,
  parseJsonStrikt,
  ProfilSchrittSchema,
  RisikenSchrittSchema,
  TeilbereichSchrittSchema,
  ZieleSchrittSchema,
} from '@taxtronik/tcms-contract';
import type { TcmsAktionsErgebnis } from '@/components/tcms/programm/dialog';
import type { ActionParseResult } from '@/server/actions/action-runner';
import { parseActionInput, parseFormData } from '@/server/actions/form-data';
import { tcmsKanzleiAktion } from '@/server/tcms/aktion';
import { TCMS_PERSON_UNZULAESSIG_TEXTE, TcmsPersonUnzulaessig } from '@/server/tcms/personen';
import {
  einrichtungsPersonen,
  pruefeFreigabeEmpfaengerTx,
  pruefeKontrollPersonenTx,
  pruefeZielfreigabeVorAnlegen,
} from '@/server/tcms/programm/einrichtung';
import { tcmsZustaendigkeitTx } from '@/server/tcms/programm/zustaendigkeit';

/** Höchstgröße des serialisierten Schritts (Zeichen; Profil mit allen Listen bleibt weit darunter). */
const MAX_DATEN = 400_000;

const Formular = z.object({
  schritt: z.coerce.number().int().min(1).max(5),
  ziel: z.enum(['speichern', 'weiter', 'zurueck', 'anlegen']),
  daten: z.string().min(2).max(MAX_DATEN),
});

type Teilbereich = z.output<typeof TeilbereichSchrittSchema>;
type Profil = z.output<typeof ProfilSchrittSchema>;
type Ziele = z.output<typeof ZieleSchrittSchema>;
type Risiken = z.output<typeof RisikenSchrittSchema>;
type Kontrollen = z.output<typeof KontrollenSchrittSchema>;

type Schritt =
  | { schritt: 1; daten: Teilbereich }
  | { schritt: 2; daten: Profil }
  | { schritt: 3; daten: Ziele }
  | { schritt: 4; daten: Risiken }
  | { schritt: 5; daten: Kontrollen };

type Eingabe = Schritt & { ziel: 'speichern' | 'weiter' | 'zurueck' | 'anlegen' };

const SCHEMA = {
  1: TeilbereichSchrittSchema,
  2: ProfilSchrittSchema,
  3: ZieleSchrittSchema,
  4: RisikenSchrittSchema,
  5: KontrollenSchrittSchema,
} as const;

function eingabeAus(formData: FormData): ActionParseResult<Eingabe> {
  const basis = parseFormData(Formular, formData);
  if (!basis.ok) return basis;
  const { schritt, ziel, daten } = basis.data;
  if (ziel === 'anlegen' && schritt !== 5) {
    return {
      ok: false,
      error: 'Version 1 wird im letzten Schritt angelegt.',
      errorCode: 'VALIDATION_ERROR',
    };
  }
  const json = parseJsonStrikt(new TextEncoder().encode(daten));
  if (!json.ok) {
    return {
      ok: false,
      error:
        'Die Angaben dieses Schritts konnten nicht gelesen werden. Bitte laden Sie die Seite neu.',
      errorCode: 'VALIDATION_ERROR',
    };
  }
  const geprueft = parseActionInput(SCHEMA[schritt as Schritt['schritt']], json.wert);
  if (!geprueft.ok) return geprueft;
  return { ok: true, data: { schritt, ziel, daten: geprueft.data } as Eingabe };
}

/** Ziel der Weiterleitung nach Erfolg (null: auf der Seite bleiben). */
function zielNachErfolg(
  mandantId: string,
  e: { ziel: Eingabe['ziel']; schritt: number },
): string | null {
  const basis = `/staff/clients/${encodeURIComponent(mandantId)}/tcms/einrichtung`;
  if (e.ziel === 'weiter') return `${basis}?schritt=${Math.min(5, e.schritt + 1)}`;
  if (e.ziel === 'zurueck') return `${basis}?schritt=${Math.max(1, e.schritt - 1)}`;
  if (e.ziel === 'anlegen') return basis;
  return null;
}

export async function einrichtungSpeichernAction(
  mandantId: string,
  _vorher: TcmsAktionsErgebnis | null,
  formData: FormData,
): Promise<TcmsAktionsErgebnis> {
  const ergebnis = await tcmsKanzleiAktion({
    mandantId,
    keinRecht: 'BEARBEITEN',
    // Feldfehler des Dienstes betreffen den ganzen Schritt (z. B. `schritt2`):
    // nur die Sammelmeldung; die offenen Punkte zeigt die Seite (`pruefung`).
    felder: {},
    parse: () => eingabeAus(formData),
    vorbereiten: async (tx, k, e: Eingabe) => {
      const bezug = { tenantId: k.g.tenantId, mandantId };
      const zust = await tcmsZustaendigkeitTx(tx, bezug);
      if (e.schritt === 3) await pruefeFreigabeEmpfaengerTx(tx, bezug, e.daten.freigabe);
      if (e.schritt === 5) await pruefeKontrollPersonenTx(tx, bezug, e.daten.kontrollen);
      return { personen: einrichtungsPersonen(zust), ctx: k.g.ctx, bezug };
    },
    aufruf: async (dienst, e: Eingabe, { personen, ctx, bezug }) => {
      const weiter = { ziel: e.ziel, schritt: e.schritt };
      if (e.ziel === 'anlegen') {
        if (e.schritt !== 5) {
          return {
            ok: false as const,
            error: 'Version 1 wird im letzten Schritt angelegt.',
            errorCode: 'VALIDATION_ERROR' as const,
          };
        }
        // kk-tcms-s11: Mit Version 1 versendet der Dienst die Zielfreigabe aus
        // Schritt 3. Vorher den gespeicherten Empfänger erneut prüfen (Kontakt
        // dieses Mandanten mit aktivem Portalzugang) – er kann seit dem
        // Speichern den Zugang verloren haben.
        const { daten: stand } = await dienst.rufe(ENDPUNKTE.einrichtungLesen, { query: {} });
        const freigabe = stand.entwurf?.freigabe;
        if (freigabe?.anfordern && freigabe.empfaengerId) {
          try {
            await pruefeZielfreigabeVorAnlegen(ctx, bezug, freigabe);
          } catch (fehler) {
            if (!(fehler instanceof TcmsPersonUnzulaessig)) throw fehler;
            return {
              ok: false as const,
              error: `Schritt 3 (Freigabe der Ziele): ${TCMS_PERSON_UNZULAESSIG_TEXTE[fehler.art]}`,
              errorCode: 'VALIDATION_ERROR' as const,
            };
          }
        }
        await dienst.rufe(ENDPUNKTE.programmAnlegen, { body: { daten: e.daten, personen } });
        return { ...weiter, meldung: 'Version 1 des Tax-CMS ist angelegt.' };
      }
      const { daten } = await dienst.rufe(ENDPUNKTE.einrichtungEntwurfSpeichern, {
        body: { schritt: e.schritt, ziel: e.ziel, daten: e.daten, personen } as never,
      });
      return {
        ...weiter,
        meldung: daten.geaendert
          ? 'Entwurf gespeichert.'
          : 'Keine Änderungen – der Entwurf ist unverändert.',
      };
    },
  });
  // Navigation nur nach Erfolg und außerhalb des Fehler-Mappings (action-runner.ts).
  const ziel = ergebnis.ok ? zielNachErfolg(mandantId, ergebnis) : null;
  if (ziel) redirect(ziel);
  return ergebnis;
}
