'use server';

// =============================================================================
// CMS-Beschreibung des Tax-CMS (TCMS Stufe 3, Bereich A; Demo
// server/actions/beschreibung.ts): Version anlegen, Abschnitt speichern, zur
// Kanzlei-Review geben, Review abschließen bzw. zurückweisen, Freigabe beim
// Mandanten anfordern.
//
// Status, Vier-Augen-Prinzip der Review, Sperren eingefrorener Versionen und
// den Snapshot (SHA-256) entscheidet der Dienst. Die kanzleikonsole liefert:
//   - den Empfänger der Freigabe nur als Kontakt genau dieses Mandanten
//     (server/tcms/personen.ts; die Rolle „gesetzliche Vertretung“ prüft der
//     Dienst),
//   - Zuständigkeit (Baustein VERANTWORTUNG) und Namen für den eingefrorenen
//     Inhalt aus ihren eigenen Daten (server/tcms/programm/zustaendigkeit.ts),
//     nie aus dem Formular.
// =============================================================================

import { redirect } from 'next/navigation';
import { z } from 'zod';
import {
  AbschnittSpeichernBodySchema,
  BESCHREIBUNG_BAUSTEIN_ARTEN,
  BeschreibungAbschnittKeySchema,
  ENDPUNKTE,
  parseJsonStrikt,
  REVIEW_MIN_BEGRUENDUNG,
} from '@taxtronik/tcms-contract';
import { BAUSTEIN_LABEL, type BausteinArt } from '@taxtronik/tcms-domain';
import type { TcmsAktionsErgebnis } from '@/components/tcms/programm/dialog';
import type { ActionParseResult } from '@/server/actions/action-runner';
import { formList, formOptional, parseFormData } from '@/server/actions/form-data';
import { tcmsKanzleiAktion } from '@/server/tcms/aktion';
import { mandantKontakteTx } from '@/server/tcms/personen';
import { freigabeNamenTx, tcmsZustaendigkeitTx } from '@/server/tcms/programm/zustaendigkeit';

const VERSION_ID = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'Ungültige Auswahl.');
const VersionFormular = z.object({ versionId: VERSION_ID });

function beschreibungHref(mandantId: string, query: Record<string, string>): string {
  const q = new URLSearchParams(query).toString();
  return `/staff/clients/${encodeURIComponent(mandantId)}/tcms/beschreibung${q ? `?${q}` : ''}`;
}

// ---------------------------------------------------------------------------
// Neue Version
// ---------------------------------------------------------------------------

export async function versionAnlegenAction(
  mandantId: string,
  _vorher: TcmsAktionsErgebnis | null,
  _formData: FormData,
): Promise<TcmsAktionsErgebnis> {
  const ergebnis = await tcmsKanzleiAktion({
    mandantId,
    keinRecht: 'BEARBEITEN',
    aufruf: async (dienst) => {
      const { daten } = await dienst.rufe(ENDPUNKTE.beschreibungsversionAnlegen);
      return { versionId: daten.versionId, meldung: `Version ${daten.nummer} angelegt.` };
    },
  });
  if (ergebnis.ok) redirect(beschreibungHref(mandantId, { version: ergebnis.versionId }));
  return ergebnis;
}

// ---------------------------------------------------------------------------
// Abschnitt im Entwurf speichern
// ---------------------------------------------------------------------------

const BAUSTEINE = BESCHREIBUNG_BAUSTEIN_ARTEN;

/** Aufbau des Abschnitts beim Öffnen des Editors (ordnet Textfelder und Entfernen-Haken zu). */
const StrukturSchema = z
  .array(
    z.discriminatedUnion('typ', [
      z.object({ typ: z.literal('text') }).strict(),
      z.object({ typ: z.literal('baustein'), art: z.enum(BAUSTEINE) }).strict(),
    ]),
  )
  .max(40);

const AbschnittFormular = z.object({
  versionId: VERSION_ID,
  key: BeschreibungAbschnittKeySchema,
  struktur: z.string().min(2).max(10_000),
  text: formList(z.array(z.string()).max(40)),
  entfernen: formList(z.array(z.string().regex(/^\d{1,2}$/)).max(40)),
  textNeu: formOptional(z.string().optional()),
  neuerBaustein: formOptional(z.enum(BAUSTEINE).or(z.literal('')).optional()),
});

type Abschnitt = z.output<typeof AbschnittSpeichernBodySchema> & { versionId: string };

function abschnittAus(formData: FormData): ActionParseResult<Abschnitt> {
  const f = parseFormData(AbschnittFormular, formData, {
    repeatable: ['text', 'entfernen'],
    absentAsNull: true,
  });
  if (!f.ok) return f;
  const json = parseJsonStrikt(new TextEncoder().encode(f.data.struktur));
  const struktur = json.ok ? StrukturSchema.safeParse(json.wert) : null;
  if (!struktur?.success) {
    return {
      ok: false,
      error: 'Der Abschnitt konnte nicht gelesen werden. Bitte laden Sie die Seite neu.',
      errorCode: 'VALIDATION_ERROR',
    };
  }
  const texte = [...f.data.text];
  const entfernen = new Set(f.data.entfernen.map(Number));
  const bloecke: Abschnitt['bloecke'] = [];
  struktur.data.forEach((b, i) => {
    if (b.typ === 'text') bloecke.push({ typ: 'text', text: texte.shift() ?? '' });
    else if (!entfernen.has(i)) bloecke.push({ typ: 'baustein', art: b.art });
  });
  const neu = f.data.textNeu ?? '';
  if (neu.trim() && !bloecke.some((b) => b.typ === 'text'))
    bloecke.unshift({ typ: 'text', text: neu });
  const art = f.data.neuerBaustein || null;
  if (art) {
    if (bloecke.some((b) => b.typ === 'baustein' && b.art === art)) {
      return {
        ok: false,
        error: `Der Baustein „${BAUSTEIN_LABEL[art as BausteinArt]}“ ist in diesem Abschnitt bereits enthalten.`,
        errorCode: 'VALIDATION_ERROR',
        fieldErrors: { neuerBaustein: ['Dieser Baustein ist bereits enthalten.'] },
      };
    }
    bloecke.push({ typ: 'baustein', art });
  }
  if (bloecke.length === 0) bloecke.push({ typ: 'text', text: '' });
  const body = AbschnittSpeichernBodySchema.safeParse({ key: f.data.key, bloecke });
  if (!body.success) {
    return {
      ok: false,
      error:
        'Ein Textblock darf höchstens 20.000 Zeichen haben; ein Abschnitt höchstens 20 Blöcke.',
      errorCode: 'VALIDATION_ERROR',
      fieldErrors: { text: ['Bitte kürzen Sie den Text.'] },
    };
  }
  return { ok: true, data: { ...body.data, versionId: f.data.versionId } };
}

export async function abschnittSpeichernAction(
  mandantId: string,
  _vorher: TcmsAktionsErgebnis | null,
  formData: FormData,
): Promise<TcmsAktionsErgebnis> {
  return tcmsKanzleiAktion({
    mandantId,
    keinRecht: 'BEARBEITEN',
    felder: { bloecke: 'text', key: 'text' },
    parse: () => abschnittAus(formData),
    aufruf: async (dienst, a) => {
      const { daten } = await dienst.rufe(ENDPUNKTE.beschreibungsabschnittSpeichern, {
        params: { versionId: a.versionId },
        body: { key: a.key, bloecke: a.bloecke },
      });
      return {
        meldung: daten.geaendert
          ? `Abschnitt in Version ${daten.nummer} gespeichert.`
          : 'Keine Änderungen.',
      };
    },
  });
}

// ---------------------------------------------------------------------------
// Kanzlei-Review
// ---------------------------------------------------------------------------

export async function zurReviewAction(
  mandantId: string,
  _vorher: TcmsAktionsErgebnis | null,
  formData: FormData,
): Promise<TcmsAktionsErgebnis> {
  return tcmsKanzleiAktion({
    mandantId,
    keinRecht: 'BEARBEITEN',
    parse: () => parseFormData(VersionFormular, formData),
    aufruf: async (dienst, { versionId }) => {
      const { daten } = await dienst.rufe(ENDPUNKTE.beschreibungZurReviewGeben, {
        params: { versionId },
      });
      return { meldung: `Version ${daten.nummer} liegt zur Kanzlei-Review vor.` };
    },
  });
}

export async function reviewAbschliessenAction(
  mandantId: string,
  _vorher: TcmsAktionsErgebnis | null,
  formData: FormData,
): Promise<TcmsAktionsErgebnis> {
  return tcmsKanzleiAktion({
    mandantId,
    // 403 hier: Vier-Augen-Prinzip (letzte Bearbeitung) oder fehlendes Recht.
    keinRecht: 'VIER_AUGEN',
    parse: () => parseFormData(VersionFormular, formData),
    aufruf: async (dienst, { versionId }) => {
      const { daten } = await dienst.rufe(ENDPUNKTE.beschreibungsreviewAbschliessen, {
        params: { versionId },
      });
      return { meldung: `Kanzlei-Review für Version ${daten.nummer} abgeschlossen.` };
    },
  });
}

const ZurueckFormular = z.object({
  versionId: VERSION_ID,
  begruendung: z
    .string()
    .trim()
    .min(REVIEW_MIN_BEGRUENDUNG, `Bitte mindestens ${REVIEW_MIN_BEGRUENDUNG} Zeichen angeben.`)
    .max(2000),
});

export async function reviewZurueckweisenAction(
  mandantId: string,
  _vorher: TcmsAktionsErgebnis | null,
  formData: FormData,
): Promise<TcmsAktionsErgebnis> {
  return tcmsKanzleiAktion({
    mandantId,
    keinRecht: 'BEARBEITEN',
    felder: { begruendung: 'begruendung' },
    parse: () => parseFormData(ZurueckFormular, formData, { absentAsNull: true }),
    aufruf: async (dienst, { versionId, begruendung }) => {
      const { daten } = await dienst.rufe(ENDPUNKTE.beschreibungsreviewZurueckweisen, {
        params: { versionId },
        body: { begruendung },
      });
      return { meldung: `Version ${daten.nummer} ist zurück im Entwurf.` };
    },
  });
}

// ---------------------------------------------------------------------------
// Freigabe beim Mandanten anfordern (Snapshot + Bestätigungscode)
// ---------------------------------------------------------------------------

const FreigabeFormular = z.object({
  versionId: VERSION_ID,
  empfaengerId: z.uuid('Bitte wählen Sie die Empfängerin oder den Empfänger.'),
});

export async function freigabeAnfordernAction(
  mandantId: string,
  _vorher: TcmsAktionsErgebnis | null,
  formData: FormData,
): Promise<TcmsAktionsErgebnis> {
  return tcmsKanzleiAktion({
    mandantId,
    keinRecht: 'BEARBEITEN',
    felder: { empfaengerId: 'empfaengerId' },
    parse: () => parseFormData(FreigabeFormular, formData, { absentAsNull: true }),
    vorbereiten: async (tx, k, daten) => {
      const bezug = { tenantId: k.g.tenantId, mandantId };
      // Nur aktive Kontakte genau dieses Mandanten; die Rolle prüft der Dienst.
      const [empfaenger] = await mandantKontakteTx(tx, bezug, [daten.empfaengerId], {
        feld: 'empfaengerId',
      });
      const zust = await tcmsZustaendigkeitTx(tx, bezug);
      const namen = await freigabeNamenTx(tx, bezug);
      return {
        empfaenger: empfaenger!,
        body: {
          empfaengerId: empfaenger!.id,
          verantwortung: { berufstraeger: zust.berufstraeger, bearbeitung: zust.bearbeitung },
          namen,
        },
      };
    },
    aufruf: async (dienst, { versionId }, { empfaenger, body }) => {
      const { daten } = await dienst.rufe(ENDPUNKTE.beschreibungsfreigabeAnfordern, {
        params: { versionId },
        body,
      });
      const zusatz = daten.zurueckgezogen.length
        ? ` Die offene Anforderung für Version ${daten.zurueckgezogen.join(', ')} wurde zurückgezogen.`
        : '';
      return {
        meldung: `Freigabe von Version ${daten.nummer} bei ${empfaenger.name} angefordert; der Inhalt ist eingefroren, der Bestätigungscode geht über den Postausgang.${zusatz}`,
      };
    },
  });
}
