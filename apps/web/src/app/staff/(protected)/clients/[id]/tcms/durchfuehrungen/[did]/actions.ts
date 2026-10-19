'use server';

// =============================================================================
// Kontrolldurchführung (TCMS Stufe 3, Bereich C; portiert aus der Demo
// server/actions/durchfuehrung.ts). Jede Aktion läuft über tcmsKanzleiAktion:
// Mandant und Durchführung sind gebunden (`aktion.bind(null, mandantId, did)`),
// der Akteur prüft den Mandantenzugriff, der Dienst entscheidet über Rechte,
// Status und Vier-Augen. Meldungen bei Erfolg wie in der Demo; Fehler über die
// feste Abbildung (server/tcms/zustand.ts).
//
// Nachweise (TCMS-NACHWEIS-001): Upload über die Dokumentenpipeline der
// kanzleikonsole, Auswahl nur gescannter Dokumente dieses Mandanten; der
// Verweis an das Tax-CMS entsteht aus der gespeicherten Version
// (server/tcms/durchfuehrung/nachweis-aktion.ts, verweis.ts).
// =============================================================================

import { redirect } from 'next/navigation';
import {
  DF_MAX_BEGRUENDUNG,
  DF_MIN_BEGRUENDUNG,
  DurchfuehrungIdSchema,
  ENDPUNKTE,
  NachweisIdSchema,
} from '@taxtronik/tcms-contract';
import { z } from 'zod';
import { TcmsUngueltig } from '@taxtronik/tcms-client';
import type { TcmsErgebnis } from '@/components/tcms/durchfuehrung/formulare';
import { ActionError } from '@/server/actions/action-error';
import type { ActionFailure } from '@/server/actions/action-runner';
import { parseFormData } from '@/server/actions/form-data';
import { readUploadFile } from '@/server/documents/upload-file';
import { revalidiereTcmsMandant, tcmsKanzleiAktion } from '@/server/tcms/aktion';
import { befundAusFormular, speichernAusFormular } from '@/server/tcms/durchfuehrung/formular';
import {
  nachweisAnhaengenUndBinden,
  nachweisDateiAblegen,
  nachweisDokumentVerknuepfen,
  nachweisEntfernenUndFreigeben,
  nachweisNichtAngehaengt,
  nachweisVorpruefung,
  sha256Hex,
  vorhandenerNachweis,
} from '@/server/tcms/durchfuehrung/nachweis-aktion';
import { nachweisQuelleTx } from '@/server/tcms/durchfuehrung/verweis';

/** Ergebnis eines Dienstaufrufs: feste Erfolgsmeldung oder eigenes Fehlerergebnis. */
type Ausgang = { meldung: string } | ActionFailure;

const BEGRUENDUNG_ZU_KURZ = `Bitte eine Begründung mit mindestens ${DF_MIN_BEGRUENDUNG} Zeichen angeben.`;

const BegruendungFormular = z.object({
  begruendung: z
    .string()
    .trim()
    .min(DF_MIN_BEGRUENDUNG, BEGRUENDUNG_ZU_KURZ)
    .max(DF_MAX_BEGRUENDUNG),
});

const AblehnenFormular = z.object({
  begruendung: z
    .string()
    .trim()
    .max(DF_MAX_BEGRUENDUNG)
    .nullable()
    .transform((wert) => (wert ? wert : null)),
});

/** Gebundene Durchführungs-ID; ungültig → feste Meldung, kein Dienstaufruf. */
function durchfuehrung(id: string): string {
  const geprueft = DurchfuehrungIdSchema.safeParse(id);
  if (!geprueft.success) throw new ActionError('Durchführung nicht gefunden.');
  return geprueft.data;
}

// ---------------------------------------------------------------------------
// Beginnen, Speichern, Einreichen
// ---------------------------------------------------------------------------

/** Fällig → In Durchführung. */
export async function durchfuehrungBeginnenAction(
  mandantId: string,
  durchfuehrungId: string,
  _vorher: TcmsErgebnis | null,
  _formData: FormData,
): Promise<TcmsErgebnis> {
  return tcmsKanzleiAktion({
    mandantId,
    keinRecht: 'DURCHFUEHREN',
    aufruf: async (dienst) => {
      await dienst.rufe(ENDPUNKTE.durchfuehrungBeginnen, {
        params: { durchfuehrungId: durchfuehrung(durchfuehrungId) },
      });
      return { meldung: 'Durchführung begonnen.' };
    },
  });
}

/**
 * Schritte, Werte und Ergebnisvorschlag speichern; mit `absicht=einreichen`
 * danach einreichen (eigener Aufruf: der gespeicherte Entwurf bleibt bei
 * Mängeln erhalten). Die Struktur liest die Aktion aus dem Dienst.
 */
export async function durchfuehrungSpeichernAction(
  mandantId: string,
  durchfuehrungId: string,
  _vorher: TcmsErgebnis | null,
  formData: FormData,
): Promise<TcmsErgebnis> {
  return tcmsKanzleiAktion({
    mandantId,
    keinRecht: 'DURCHFUEHREN',
    felder: {},
    aufruf: async (dienst): Promise<Ausgang> => {
      const id = durchfuehrung(durchfuehrungId);
      const { daten: d } = await dienst.rufe(ENDPUNKTE.durchfuehrungLesen, {
        params: { durchfuehrungId: id },
      });
      const formular = speichernAusFormular(formData, d);
      if (!formular.ok) return formular;
      const { daten: gespeichert } = await dienst.rufe(ENDPUNKTE.durchfuehrungSpeichern, {
        params: { durchfuehrungId: id },
        body: formular.eingabe,
      });
      if (!formular.einreichen) return { meldung: 'Entwurf gespeichert.' };
      try {
        await dienst.rufe(ENDPUNKTE.durchfuehrungEinreichen, { params: { durchfuehrungId: id } });
      } catch (fehler) {
        if (!(fehler instanceof TcmsUngueltig) || fehler.lokal) throw fehler;
        // Gespeichert, aber vom Dienst nicht zum Einreichen angenommen: Mängel aus
        // der Prüfung des gespeicherten Stands (Antwort des Speicherns).
        revalidiereTcmsMandant(mandantId);
        const maengel = gespeichert.pruefung.maengel;
        return {
          ok: false,
          errorCode: 'VALIDATION_ERROR',
          error:
            maengel.length > 0
              ? `Entwurf gespeichert, aber noch nicht eingereicht: ${maengel.join(' · ')}.`
              : 'Entwurf gespeichert, aber noch nicht eingereicht. Bitte prüfen Sie die Voraussetzungen.',
        };
      }
      return { meldung: 'Zur Gegenzeichnung eingereicht. Die Nachweise sind jetzt gesperrt.' };
    },
  });
}

// ---------------------------------------------------------------------------
// Nachweise
// ---------------------------------------------------------------------------

const DateiFormular = z.object({
  datei: z.custom<File>((wert) => wert instanceof File && wert.size > 0, {
    message: 'Bitte eine Datei auswählen.',
  }),
});

/**
 * Datei als Dokument am Mandanten ablegen (Dokumentenpipeline) und als
 * Nachweis anhängen. Vorher: Recht und gleicher Inhalt laut Dienst.
 */
export async function nachweisHochladenAction(
  mandantId: string,
  durchfuehrungId: string,
  _vorher: TcmsErgebnis | null,
  formData: FormData,
): Promise<TcmsErgebnis> {
  return tcmsKanzleiAktion({
    mandantId,
    keinRecht: 'DURCHFUEHREN',
    felder: {},
    parse: () => parseFormData(DateiFormular, formData),
    vorbereiten: async (_tx, k) => ({
      g: k.g,
      bezug: { tenantId: k.g.tenantId, mandantId, staffId: k.g.staffId },
    }),
    aufruf: async (dienst, _daten, v): Promise<Ausgang> => {
      const id = durchfuehrung(durchfuehrungId);
      const datei = await readUploadFile(formData, 'datei', 'tcmsNachweis');
      if (!datei.ok) {
        return {
          ok: false,
          error: datei.error,
          errorCode: 'VALIDATION_ERROR',
          fieldErrors: { datei: [datei.error] },
        };
      }
      const d = await nachweisVorpruefung(dienst, id);
      const doppelt = vorhandenerNachweis(d, { sha256: sha256Hex(datei.bytes) });
      if (doppelt) {
        return {
          ok: false,
          error: `Bereits vorhanden: ${doppelt}.`,
          errorCode: 'CONFLICT',
          fieldErrors: { datei: [`Bereits vorhanden: ${doppelt}.`] },
        };
      }
      const abgelegt = await nachweisDateiAblegen(v.g, v.bezug, id, datei);
      try {
        await nachweisAnhaengenUndBinden(dienst, v.g.ctx, id, abgelegt);
      } catch (fehler) {
        throw nachweisNichtAngehaengt(fehler, ENDPUNKTE.nachweisAnhaengen.name);
      }
      return { meldung: 'Datei hochgeladen und als Nachweis angehängt.' };
    },
  });
}

const AuswahlFormular = z.object({ dokumentId: z.uuid('Bitte ein Dokument auswählen.') });

/** Vorhandenes, gescanntes Dokument dieses Mandanten als Nachweis anhängen. */
export async function nachweisAuswaehlenAction(
  mandantId: string,
  durchfuehrungId: string,
  _vorher: TcmsErgebnis | null,
  formData: FormData,
): Promise<TcmsErgebnis> {
  return tcmsKanzleiAktion({
    mandantId,
    keinRecht: 'DURCHFUEHREN',
    felder: {},
    parse: () => parseFormData(AuswahlFormular, formData),
    vorbereiten: async (tx, k, daten) => {
      const bezug = { tenantId: k.g.tenantId, mandantId, staffId: k.g.staffId };
      // Nur Dokumente dieses Mandanten mit sauber gescannter neuester Version.
      const quelle = await nachweisQuelleTx(tx, bezug, daten.dokumentId);
      return { ctx: k.g.ctx, bezug, dokumentId: quelle.verweis.dokumentId };
    },
    aufruf: async (dienst, _daten, v): Promise<Ausgang> => {
      const id = durchfuehrung(durchfuehrungId);
      const d = await nachweisVorpruefung(dienst, id);
      const doppelt = vorhandenerNachweis(d, { dokumentId: v.dokumentId });
      if (doppelt) {
        return {
          ok: false,
          error: `Bereits als Nachweis angehängt: ${doppelt}.`,
          errorCode: 'CONFLICT',
          fieldErrors: { dokumentId: [`Bereits als Nachweis angehängt: ${doppelt}.`] },
        };
      }
      const verknuepft = await nachweisDokumentVerknuepfen(v.ctx, v.bezug, v.dokumentId, id);
      await nachweisAnhaengenUndBinden(dienst, v.ctx, id, verknuepft);
      return { meldung: 'Dokument als Nachweis angehängt.' };
    },
  });
}

const EntfernenFormular = z.object({ nachweisId: NachweisIdSchema });

/** Ungesperrten Nachweis entfernen; danach endet die Löschsperre des Dokuments. */
export async function nachweisEntfernenAction(
  mandantId: string,
  durchfuehrungId: string,
  _vorher: TcmsErgebnis | null,
  formData: FormData,
): Promise<TcmsErgebnis> {
  return tcmsKanzleiAktion({
    mandantId,
    keinRecht: 'DURCHFUEHREN',
    felder: {},
    parse: () => parseFormData(EntfernenFormular, formData),
    vorbereiten: async (_tx, k) => k.g.ctx,
    aufruf: async (dienst, daten, ctx) => {
      await nachweisEntfernenUndFreigeben(dienst, ctx, {
        mandantId,
        durchfuehrungId: durchfuehrung(durchfuehrungId),
        nachweisId: daten.nachweisId,
      });
      return { meldung: 'Nachweis entfernt.' };
    },
  });
}

// ---------------------------------------------------------------------------
// Prüfung: zurückweisen, gegenzeichnen
// ---------------------------------------------------------------------------

export async function durchfuehrungZurueckweisenAction(
  mandantId: string,
  durchfuehrungId: string,
  _vorher: TcmsErgebnis | null,
  formData: FormData,
): Promise<TcmsErgebnis> {
  return tcmsKanzleiAktion({
    mandantId,
    keinRecht: 'GEGENZEICHNEN',
    felder: { begruendung: 'begruendung' },
    parse: () => parseFormData(BegruendungFormular, formData),
    aufruf: async (dienst, daten) => {
      await dienst.rufe(ENDPUNKTE.durchfuehrungZurueckweisen, {
        params: { durchfuehrungId: durchfuehrung(durchfuehrungId) },
        body: { begruendung: daten.begruendung },
      });
      return {
        meldung:
          'Zurückgewiesen. Die durchführende Person kann die Angaben überarbeiten und erneut einreichen.',
      };
    },
  });
}

/** Gegenzeichnen; bei Befund ohne verknüpfte Feststellung mit Inline-Erfassung (Dialog). */
export async function durchfuehrungGegenzeichnenAction(
  mandantId: string,
  durchfuehrungId: string,
  _vorher: TcmsErgebnis | null,
  formData: FormData,
): Promise<TcmsErgebnis> {
  return tcmsKanzleiAktion({
    mandantId,
    keinRecht: 'GEGENZEICHNEN',
    felder: {},
    parse: () => {
      const befund = befundAusFormular(formData);
      return befund.ok ? { ok: true as const, data: befund.feststellung } : befund;
    },
    aufruf: async (dienst, feststellung) => {
      const { daten } = await dienst.rufe(ENDPUNKTE.durchfuehrungGegenzeichnen, {
        params: { durchfuehrungId: durchfuehrung(durchfuehrungId) },
        body: feststellung ? { feststellung } : {},
      });
      return {
        meldung:
          daten.status === 'MIT_BEFUND'
            ? `Gegengezeichnet – abgeschlossen mit Befund (Feststellung ${daten.feststellung?.nummer ?? '—'}).`
            : 'Gegengezeichnet – abgeschlossen ohne Befund.',
      };
    },
  });
}

// ---------------------------------------------------------------------------
// Entfallen und Nachtrag
// ---------------------------------------------------------------------------

export async function entfallenBeantragenAction(
  mandantId: string,
  durchfuehrungId: string,
  _vorher: TcmsErgebnis | null,
  formData: FormData,
): Promise<TcmsErgebnis> {
  return tcmsKanzleiAktion({
    mandantId,
    keinRecht: 'DURCHFUEHREN',
    felder: { begruendung: 'begruendung' },
    parse: () => parseFormData(BegruendungFormular, formData),
    aufruf: async (dienst, daten) => {
      await dienst.rufe(ENDPUNKTE.entfallenBeantragen, {
        params: { durchfuehrungId: durchfuehrung(durchfuehrungId) },
        body: { begruendung: daten.begruendung },
      });
      return {
        meldung:
          'Entfallen beantragt. Die Freigabe erfolgt durch eine zweite Person (Berufsträger:in).',
      };
    },
  });
}

export async function entfallenFreigebenAction(
  mandantId: string,
  durchfuehrungId: string,
  _vorher: TcmsErgebnis | null,
  _formData: FormData,
): Promise<TcmsErgebnis> {
  return tcmsKanzleiAktion({
    mandantId,
    keinRecht: 'VIER_AUGEN',
    aufruf: async (dienst) => {
      await dienst.rufe(ENDPUNKTE.entfallenFreigeben, {
        params: { durchfuehrungId: durchfuehrung(durchfuehrungId) },
      });
      return { meldung: 'Entfallen freigegeben. Die Durchführung zählt nicht als „ohne Befund“.' };
    },
  });
}

/** Antrag ablehnen (zweite Person, mit Begründung) oder als antragstellende Person zurückziehen. */
export async function entfallenAblehnenAction(
  mandantId: string,
  durchfuehrungId: string,
  _vorher: TcmsErgebnis | null,
  formData: FormData,
): Promise<TcmsErgebnis> {
  return tcmsKanzleiAktion({
    mandantId,
    keinRecht: 'VIER_AUGEN',
    felder: { begruendung: 'begruendung' },
    parse: () => parseFormData(AblehnenFormular, formData, { absentAsNull: true }),
    aufruf: async (dienst, daten) => {
      await dienst.rufe(ENDPUNKTE.entfallenAblehnen, {
        params: { durchfuehrungId: durchfuehrung(durchfuehrungId) },
        body: daten.begruendung ? { begruendung: daten.begruendung } : {},
      });
      return { meldung: daten.begruendung ? 'Antrag abgelehnt.' : 'Antrag zurückgezogen.' };
    },
  });
}

const NachtragFormular = z.object({
  begruendung: z
    .string()
    .trim()
    .min(
      DF_MIN_BEGRUENDUNG,
      `Bitte den Anlass des Nachtrags mit mindestens ${DF_MIN_BEGRUENDUNG} Zeichen begründen.`,
    )
    .max(DF_MAX_BEGRUENDUNG),
});

/** Nachtrag zu einer abgeschlossenen Durchführung; danach zur neuen Durchführung. */
export async function nachtragAnlegenAction(
  mandantId: string,
  durchfuehrungId: string,
  _vorher: TcmsErgebnis | null,
  formData: FormData,
): Promise<TcmsErgebnis> {
  const ergebnis = await tcmsKanzleiAktion({
    mandantId,
    keinRecht: 'DURCHFUEHREN',
    felder: { begruendung: 'begruendung' },
    parse: () => parseFormData(NachtragFormular, formData),
    aufruf: async (dienst, daten) => {
      const { daten: nachtrag } = await dienst.rufe(ENDPUNKTE.nachtragAnlegen, {
        params: { durchfuehrungId: durchfuehrung(durchfuehrungId) },
        body: { begruendung: daten.begruendung },
      });
      return { neu: DurchfuehrungIdSchema.parse(nachtrag.durchfuehrungId) };
    },
  });
  if (!ergebnis.ok) return ergebnis;
  redirect(
    `/staff/clients/${encodeURIComponent(mandantId)}/tcms/durchfuehrungen/${encodeURIComponent(ergebnis.neu)}`,
  );
}
